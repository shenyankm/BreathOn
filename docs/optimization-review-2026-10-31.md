# 持续优化验收记录 · 2026-10-31

基线为 `b8e766dda312f56690efc7cc4b9e0d094dfb8775`，初始 `main` 与 `origin/main` 一致且工作区干净。起始独立分支 `sheny/optimize-20261031`；后续独立优化从已提交版本继续使用新分支，避免 CI 的按分支取消机制取消上一项未完成的验收。管理员列表分支为 `sheny/optimize-admin-history-20261031`，包含第一项登录修复。初始范围不合并 main、不部署生产；用户后续明确授权合并和现有自动部署，并要求清理冗余分支，以下逐项记录该授权后的结果。初始基线的远程 CI [41094354090](https://github.com/shenyankm/BreathOn/actions/runs/41094354090) 成功，这不替代后续提交的 CI。

环境：macOS ARM64，Node 22.23.2、uv 0.12.13，仓库锁定依赖；隔离 PostgreSQL 17 Alpine 容器 `breathon-opt-20261031`，仅绑定 loopback、使用测试账号。保留已有 8000/5173 服务和其他项目容器。原始日志与临时产物在忽略目录 `backend/data/validation/optimization-20261031/`。未读取业务记录或将服务密钥写入结果。

## 检查范围与队列

| 方向 | 检查和验收范围 | 状态 |
| --- | --- | --- |
| 性能 | 当前 API、存储/聚合、导入导出、构建；区分测试耗时和业务响应 | 管理员列表和医学审核收据已实测改进；导入导出、调度仍需复查 |
| 响应速度 | 真实本机 HTTP 的冷启动及热运行 p50/p95，登录、目录、历史记录；语音单独标记验证边界 | 管理列表、医学列表、转写后台/入队和上传故障时延已测；真实语音端到端待验收 |
| 稳定性 | 登录取消、会话/后台任务取消、超时、断线、数据库故障与恢复 | 登录、转写后台/入队/上传取消与提交后文件保护已验收；日记刷新在独立 AVD 通过；定时清理恢复本地验收通过、远程待验证 |
| 资源占用 | 密码工作线程、连接/任务、音频生命周期、空闲与重复请求、构建包体积 | 登录槽位与管理员分配峰值已验收；定时附件清理恢复本地已验，崩溃孤儿文件及执行中关停仍待检查 |
| 工程规范 | CONTRIBUTING、CI、类型、错误契约、锁文件、隔离及已有回归 | 当前后端 866、前端同一树 100 通过；lint 与两种页面构建通过；第九项 main CI/生产成功，第十项远程待验 |

关键流程：管理员登录/退出、目录与医学资料维护，代表登录及账号隔离、练习/实战收尾、日记与复盘、后台研究恢复；原生 API/Caddy 重启与 PostgreSQL 故障恢复。已有文档的旧验收不充当当前结果。每项完成后重新检查最新代码；目前尚不满足“三轮无新增有效优化”或 goal 完成条件。

## 1. 取消登录后仍占用密码校验槽位

**问题和原因（改动前）**：`Authentication.login` 在 `Semaphore(1)` 中直接等待 `asyncio.to_thread(scrypt)`。取消协程会退出信号量，但不能停止工作线程。请求取消/服务器取消后，后续密码校验与原工作线程重叠，削弱现有高内存密码计算的资源限制。保持现有 scrypt 参数、限流、账号校验、Cookie 与权限边界。

**范围与调用方**：`api/auth.py` 的 `/api/auth/login`；由 `api/app.py` 注册，`core/config.py` 使用密码格式校验，测试中的 HTTP/账号隔离及原生部署登录链路继续回归。不改 hash 格式、配置、前端或数据库格式。

**复现与预先确定的验收标准**：

```sh
uv run --directory backend pytest -q tests/test_auth.py -k 'cancelled_login or password_worker_failure'
```

故障注入阻塞密码线程，取消首个请求两次，再发第二个请求；要求首个协程在工作线程完成前持续持有槽位，峰值工作线程从 **2 降到 1**，取消请求不创建会话，后续请求成功，线程异常后可再次登录且槽位释放。测试注入的是校验器，不用模拟线程计数声称实际 RSS 下降。改动前结果 **1 failed、1 passed**，失败值 `(first.done(), peak) == (True, 2)`，预期 `(False, 1)`；日志 `auth-before.log`。

采用仓库已有的 shield + 等待线程结束再传播取消的模式。代价是取消后需等待已开始的 scrypt 结束；不重试计算、不降低密码计算强度。回退使用本项提交的 `git revert <SHA>`，不会改写用户数据。

修改后相关回归：**26 passed、0 skipped，13.12 秒**，包含真实 PostgreSQL 账号隔离；新故障用例验证峰值工作线程为 **1**、重复取消、取消不创建会话、后续登录成功、工作线程异常后释放槽位。`git diff --check` 通过。

真实本机原生部署检查通过：`deploy/check-native.py` 实际启动 Uvicorn 与 Caddy，执行 Cookie 登录/退出和账号隔离、API 重启、数据库停机时 live=200 / ready=503、数据库重启后恢复。只使用隔离测试数据，无上游模型或语音调用。可复现环境变量：`NATIVE_DISPOSABLE=1`、`NATIVE_DATABASE_URL` 指向一次性 PostgreSQL、`NATIVE_DB_CONTAINER` 为其完整容器 ID、`NATIVE_CADDY_BIN` 指向已校验 Caddy，命令为 `uv run --directory backend --locked python ../deploy/check-native.py`。第一次尝试失败：Docker Desktop 将随机发布的端口在容器重启后重新分配；已保留 `auth-native-first.log`，改为固定 `127.0.0.1:65097:5432` 后重跑通过（`auth-native.log`），不将首次失败计为通过。

基线全量：后端 **818 passed、0 skipped，81.85 秒**（Python 3.13.15、隔离 PostgreSQL）；前端 **99 passed、0 skipped**；lint 成功，原有 3 条 UI Fast Refresh 警告；Web 和 Android Vite/类型构建成功。新代码的本项必要验收为上述 26 项及真实原生部署检查；最终版本仍须完整回归。无 Android 原生或界面改动，本项不重复 APK 安装；远程 CI 仍须执行所有四个非生产 job。

提交 `fd2c1e4f6822cc498f30a9f5f82f5e5a01966285` 已推送，`git ls-remote` 确认远程分支精确包含该 SHA。[对应 CI 41098845307](https://github.com/shenyankm/BreathOn/actions/runs/41098845307) 的 frontend、backend、android、deployment **全部成功**，production 按分支规则 skipped。逐条检查 `auth-checks.json` 中的 `head_sha`、GitHub Actions app 与四项结论，不拿其他提交的绿色检查替代；本项验收完成。

## 2. 管理员历史列表避免加载全部正文（验收前标准）

**问题与影响**：`admin_records.list_sessions` 先查摘要，再以所有 ID `get_many` 读取完整会话，仅使用其中的 `owner_id`。历史对话越长，第二步越多消耗查询传输、JSON 解码、内存和文件 I/O；管理员仍需全部列表和逐次审计，不能通过限量、少返回记录或去掉审计改善指标。

**基线复现**：临时目录/临时 PostgreSQL 数据库，300 条会话、每条 40 条消息、每条 152 个汉字字符，3 个虚构代表；不含模型调用。启动独立 Uvicorn，用同一持久 HTTP 客户端测量；进程启动 3 次，每路由首请求单独记录，5 次预热后每次 60 个串行请求，10 并发每次 100 个请求。初步发现 PostgreSQL 管理列表 p50 为 58.25–58.53 ms，10 并发 p95 为 427.41–449.61 ms；文件模式分别为 39.28–40.02 ms、545.96–587.40 ms。这批探索测量使用等长随机 ID；正式对比另用固定 UUID、时间戳和完全一致的正文。测试同时跟踪 live、目录、个人历史、进度和日记列表，使用 `ps` 记录进程 CPU 累计时间和 RSS，退出时确认子进程释放。

本机可重复脚本：`backend/data/validation/optimization-20261031/http_probe_pg.py`。文件模式用 `uv run --directory backend python data/validation/optimization-20261031/http_probe_pg.py`；PG 模式设置 `OPT_TEST_DATABASE_URL` 为一次性数据库管理地址后执行同一命令。脚本自动创建、断言并删除独立 PG 数据库和本机数据目录；不会读取业务目录。`http-*-before-fixed.json` / `http-*-after-fixed.json` 保存正式对比，原始探索结果为 `http-baseline.json` 和 `http-pg-baseline.json`。禁止将该脚本指向业务数据库账号。

**改动前确定的标准**：

- 文件与 PostgreSQL 两种存储，管理员列表在串行和 10 并发下的三轮 p50、p95 中位数均降低至少 **20%**。
- 同样输入的管理员返回 JSON、排序、归属及记录数量保持一致；正常个人摘要不新增归属字段；跨工作区过滤、代表拒绝访问、列表/详情审计继续通过。
- 对同一列表函数进行三次 `tracemalloc`，局部分配峰值至少降低 **30%**，不将其当作进程 RSS 或设备内存。
- 其他基线路由的三轮 p50 中位数不得出现同时超过 **10% 和 1 ms** 的退化；不引入缓存、依赖、迁移或后台任务。
- 两种存储、API、权限与完整后端回归通过；实际 Web 管理列表可打开详情。保留原有用户摘要接口与数据格式。

**范围**：`storage/records.py`、`storage/postgres.py` 的摘要查询和唯一需要归属的管理员调用方；回归 `test_admin_access.py`、`test_storage.py` 及现有存储/隔离/性能测试。通过现有摘要接口显式请求归属，不读取正文。回退 `git revert <本项 SHA>`，无数据迁移。

改动前回归要求管理员列表不读取正文，两种存储均失败（`get_many` 各调用一次），`admin-before.log`：**2 failed**。

正式对比（每种存储、每个版本 3 次进程启动；每轮串行 60 个热请求、10 并发 100 个请求；表中为三轮对应分位数的中位数，不是合并样本分位数）：

| 指标 | 文件模式：前 → 后 | PostgreSQL：前 → 后 |
| --- | --- | --- |
| 串行 p50 / ms | 40.103 → 21.279（-46.94%） | 58.883 → 23.438（-60.20%） |
| 串行 p95 / ms | 48.011 → 22.560（-53.01%） | 67.478 → 26.030（-61.42%） |
| 10 并发 p50 / ms | 529.763 → 256.674（-51.55%） | 391.417 → 75.121（-80.81%） |
| 10 并发 p95 / ms | 583.965 → 274.881（-52.93%） | 430.703 → 87.976（-79.57%） |
| 列表局部分配峰值 / 字节 | 9,037,340 → 329,486（-96.35%） | 9,021,876 → 230,135（-97.45%） |

波动：文件模式串行 p50 前 38.204–40.579、后 21.205–21.447 ms；PG 前 58.503–61.265、后 23.335–23.448 ms。10 并发 p95 文件模式前 566.711–592.379、后 272.118–391.360 ms；PG 前 427.849–485.322、后 84.870–90.396 ms。各轮原值和 min/max 在原始 JSON 中。收益超过这些波动，且所有预先标准通过（`admin-comparison-summary.json`）。六组管理员响应均为同一 SHA-256 `0a15958c4ba3d9efe117012521f3b05631e0f64bccecbcc212384268d368f62c`，文件和 PG 的摘要输出也一致。

完整相同工作负载后的服务进程 CPU 累计时间中位数：文件模式 28.02 → 20.53 秒，PG 9.55 → 6.32 秒。进程启动中位数：文件 993.618 → 813.166 ms，PG 1021.446 → 1008.357 ms；启动依赖导入与文件缓存存在波动，不将启动差异计入本项收益。负载结束 1 秒后的 RSS 只作为快照记录（文件三轮前 214128–217232、后 186624–203632 KiB；PG 前 353392–403040、后 256864–259952 KiB），不等同峰值或长期内存泄漏验收。

行为验收：相关测试 **54 passed、0 skipped，11.69 秒**；完整后端含隔离真实 PG **821 passed、0 skipped，80.72 秒**。默认个人列表仍不返回 `owner_id`，历史无归属记录为 null，管理员列表/详情审计与角色拒绝访问通过。浏览器在独立 `127.0.0.1:5178` / `8006` 上实际执行三条合成记录列表、按代表搜索、打开详情原文、关闭与刷新；截图为 `admin-browser.jpg`。测试完成已关闭临时页面和两个服务；原有 8000/5173 及 AVD 未修改。

只有摘要查询与调用方改动，无前端/Android 原生、医学资料或依赖改动。diff 已审查，`git diff --check` 成功。提交 `fba107995f2e82f22b852f0fc5b0ff944fde9d6f` 已推送，`git ls-remote` 确认远程精确包含该 SHA。[对应 CI 41100857013](https://github.com/shenyankm/BreathOn/actions/runs/41100857013) 的 frontend、backend、android、deployment **全部成功**，production 按规则 skipped；`admin-checks-latest.json` 逐条校验 head_sha 与四个 job。本项验收完成。

## 3. 转写后台事务移出事件循环（改动前标准）

**问题**：`run_job` 在协程中同步读取、提交和写入私有转写文件。真实 PG 的 4 个连接占满时，首次查询让 20 ms 的事件循环心跳延迟 5006.999 ms。这使无数据库依赖的存活请求和语音消息也无法调度。初始读取、提交任务、轮询读取、保存成功结果、失败及超时收尾必须一起处理，不能只移动首个查询。

**范围与回退**：仅 `visits/api.py` 的后台 `run_job`，其 `launch`、启动恢复和测试入口保持接口。复用现有 `to_thread` + shield 排空线程模式，事务和文件清理整体在线程内执行，现有单任务信号量在工作线程收尾前不释放。新增等待点允许取消/重建交错，提交前核对 job ID，避免旧任务推进新任务。该交错也在改动前复现：旧任务尝试发起收费 submit（模拟拦截，`visit-stale-before.log`），修复后不提交旧任务，替换任务保持 queued。保留原始音频、私有文本、提供商参数、720 次轮询上限、15 秒等待及不自动重发收费 submit 的规则。无依赖或数据迁移；`git revert <本项 SHA>` 回退。

修改前调用链已检查：HTTP transcription → launch → run_job，启动 recover → launch → run_job；现有 `test_provider_fetch_token_and_transcription` 和重启查询回归。上传和入队接口中的同步事务是相邻候选，取消时存在附件与已提交 job 的一致性要求，另行复现/处理；本项不把它们计为已解决。

**复现/预设验收**：

- `uv run --directory backend pytest -q tests/test_visits.py -k 'provider_fetch_token_and_transcription or transcription_cancellation'`：初始读、提交、轮询及结果保存全部不得在事件循环线程执行；重复取消仍等待提交/回滚完成，正常提交不丢私有转写文件，提交失败清理新文件并传播错误，下一任务可进入。
- `uv run --directory backend python data/validation/optimization-20261031/visit_http_probe.py`：真实 Uvicorn + 新建隔离 PG 数据库，主动占满 4 个连接。3 个各 6.2 秒的故障窗口中，在 0.25/1.25/3.25 秒各发 10 个并发 `/api/live` 请求，总计 90 样本；修复后 p95 必须 **<100 ms**。故障仍按原有 5 秒池超时报 `PoolTimeout`，不能通过吞错误或提前释放故障连接改善指标；释放连接后每轮 10 次存活请求恢复，退出时排空任务并关闭服务与数据库。
- 相关单测、完整含真实 PG 回归、必要原生部署检查通过。提供商使用模拟响应；HTTP/PG 故障检查使用空模型、ASR、TTS 凭据，外部调用为 0，不声称真实 ASR、麦克风或扬声器已验收。

改动前针对性回归 **3 failed**（`visit-workers-before.log`），旧任务交错另 **1 failed**。修改后初步针对性 **5 passed**，随后补齐真实 PG 提交/回滚；最终完整后端 **826 passed、0 skipped，77.93 秒**，包含两种存储的重复取消、提交失败、状态和私有文件一致性、槽位释放及下一任务进入。前端 **99 passed**；lint 和 Web / Android 页面构建通过，仍有 3 条既有 Fast Refresh 警告。没有 Android 原生改动，本项不改 APK 参数或原生录音行为。

真实 PG + Uvicorn 网络测量（同脚本、同故障窗口、均无上游调用）：

| `/api/live` | 修改前 p50 / p95 / ms | 修改后 p50 / p95 / ms |
| --- | --- | --- |
| 正常，10 次 | 0.350 / 0.403 | 0.443 / 0.636 |
| 池耗尽，90 次 | 3921.659 / 4920.399 | 6.430 / 8.449 |
| 恢复，30 次 | 2.009 / 2.527 | 1.041 / 1.578 |

故障样本前 min/max 1922.804/4922.944 ms、后 0.797/9.232 ms，超过噪声且满足预定 p95 <100 ms。每个窗口中的后台任务仍得到真实 `PoolTimeout`，没有提前释放连接或掩盖错误。完整应用 lifespan 退出后写入关闭标记并验证进程结束；Uvicorn 正常处理 SIGTERM 后会重新发出该信号，因此允许退出码 0 或 -15，并要求关闭标记存在。最初脚本误将 -15 作为失败，已根据已安装 Uvicorn 源码修正并增加关闭标记，之后重新采集完整前后结果，不将首次脚本失败计为通过。

原生部署在新建隔离数据库再次通过：Caddy / Uvicorn 路由、重启、真实 PG 停机及恢复、Cookie 与账号隔离（`visit-native.log`）。这证明本机集成，不代表生产部署、强制断电或 SIGKILL 恢复。三个故障窗口是重复验收，不算 goal 的三轮独立复查。提交与远程 CI 完成前不关闭本项。

## 当前真实服务与设备边界

第 3 项已提交为 `e01bb8f1113ae4da02932900f8ab4465d072df0f` 并推送到 `sheny/optimize-transcription-io-20261031`，远程 ref 精确匹配，包含前两项保留改动。[对应 CI 41102447430](https://github.com/shenyankm/BreathOn/actions/runs/41102447430) 的四项非生产 job **全部成功**（`visits-checks-latest.json` 逐条校验 head_sha），production skipped；本项验收完成。

手动执行现有 `check_services` **一次**：四类配置完整的提供商探针各一次、每类 20 秒上限；3.188 秒完成，ASR、TTS、analysis、practice、combat 五个状态均正常（`live-services-once.json`）。practice/combat 为组合状态，实际探针为 SeedASR、TTS、DeepSeek、Seeduplex 四类。使用仓库内的合成音频和简短状态文本，可能产生服务用量；未重复收费压测，不把单次状态检测当延迟分布、医学输出质量或麦克风/扬声器验收。

初次检测到正在使用的 `emulator-5554`（已有 `cloud.openwook.medvisit.debug`），未覆盖安装、清空数据或改变连接目标，以保护已有工作。用户确认“暂时无真机，先完成其他验收”；真实麦克风、扬声器与真机端到端保留待验收，goal 仍 active。正准备独立 AVD 做基础 UI 验收；首次启动因默认 userdata 需要 12288 MB、本机可用 12114.80 MB 失败，未清理用户文件或改变旧 AVD。

## 待核实/处理候选

### 5. 单次审核快照复用资料收据（改动前标准）

`MedicalCorpus.approval_snapshot` 已在每份有效资料的第一遍中计算页内容 SHA-256，但为每个匹配的来源页面重新序列化整份资料再哈希。合成代表负载为 3 份各 20 页、每页正文 1500 字：每次 **63 次**序列化/哈希；3 批各 50 次的 p50 为 6.99646–7.12662 ms。cProfile 的 10 次快照中，630 次 JSON 序列化、编码和 SHA-256 约占总 73 ms 中的 60 ms。

调用方为医学列表/来源权限、`search`、`MedicalVerifier.check` 的推理前后核对及撤销校验。只在同一次调用内复用已计算的收据，不缓存审核结果、不跨请求复用 hash，不改资料有效性、来源 URL/逐字页匹配、相同来源的确定性选取和返回字段。变更仅在 `knowledge/corpus.py` 与 `test_medical.py`，无依赖、配置、导出或资料原文修改。回退 `git revert <本项 SHA>`。

预设标准：代表与较大负载的函数 p50/p95 中位数均降低至少 **50%**；单页及不匹配对照不得出现同时超过 **10% 和 0.01 ms** 的 p50 退化。真实 HTTP `/api/medical` 用隔离文件/PG 数据、真实 Cookie 代表登录、3 份 20 页纯合成软件文本，每模式 3 次进程启动，每轮预热 5 次后串行 60 次、10 并发 100 次；四类 p50/p95 中位数均须降低至少 **20%**，响应 JSON 的 SHA-256 完全一致。默认方法每次重新读取审核状态，版本/页内容改变或撤销必须立即反映；完整相关行为/权限/版本回归与最终完整检查通过。

修改前 HTTP：文件模式串行 p50/p95 中位数 **8.9804/9.3845 ms**，10 并发 **74.6611/80.1629 ms**；PG 分别 **11.5897/14.9750 ms**、**88.1749/102.4312 ms**。两种模式所有基线响应 SHA 均为 `17af641dc2ad39b4cfccf054c1c754aa173f8921d48220b1012253c17cb52dfe`。脚本和原始结果为 `medical_approval_probe.py`、`medical_http_probe.py`、`medical-approval-before.json`、`medical-http-before.json`，均在本次忽略的验收目录；不含临床证据、真实资料、外部请求或模型调用。

改动前新回归 **1 failed**（3 页资料实际哈希 4 次，要求 1 次）；修改后整个医学模块 **16 passed**，随后完整后端含隔离 PG **830 passed、0 skipped，90.92 秒**。新增回归验证收据字段、改变页内容/版本后下一次立即重新核对、已返回收据不被修改、撤销后无可用收据。已有逐字引用、OCR/不明确版本降级、推理前后变更与账号权限回归继续通过。

| 指标（三轮中位数） | 修改前 → 修改后 | 改善 |
| --- | --- | --- |
| 3 份×20 页快照 p50 / ms | 7.11404 → 1.43217 | 79.87% |
| 6 份×40 页快照 p50 / ms | 34.31517 → 3.97187 | 88.43% |
| 文件 HTTP 串行 p50 / p95 / ms | 8.9804 / 9.3845 → 3.3007 / 3.5406 | 63.25% / 62.27% |
| 文件 HTTP 10 并发 p50 / p95 / ms | 74.6611 / 80.1629 → 25.6613 / 33.4539 | 65.63% / 58.27% |
| PG HTTP 串行 p50 / p95 / ms | 11.5897 / 14.9750 → 5.6468 / 8.5489 | 51.28% / 42.91% |
| PG HTTP 10 并发 p50 / p95 / ms | 88.1749 / 102.4312 → 36.2939 / 48.9930 | 58.84% / 52.17% |

代表函数 3 批各 50 次、较大负载各 30 次；小页各 300 次、不匹配各 100 次对照均未退化，后者约 0.29 ms 的差异在噪声内。每模式 HTTP 180 个热串行、300 个 10 并发样本；PG 10 并发 p95 各轮前 99.6916–104.2522、后 43.2715–50.9240 ms，收益超过波动。首请求另列，PG 三轮前 21.9143–24.4553、后 16.4864–17.4187 ms；未清系统文件缓存，不将此当磁盘完全冷读指标。前后全部响应 SHA 保持上述值，所有预设标准通过（`medical-comparison-summary.json`）。无前端或 Android 原生变更，不将本项写成设备或真实医学输出质量验收。diff 已审查、`git diff --check` 成功；提交后仍须对应 SHA 远程 CI 通过。

### 4. 原生部署就绪探针重试截断状态行（改动前标准）

`check-native.py::wait_ready` 在四处启动/重启等待中复用。当前只捕获 OSError/URLError，`BadStatusLine` 属于 `http.client.HTTPException`，初次响应被截断时会跳过现有 90 秒重试期限而直接失败。`check-stack.py` 已有相同类别处理；只补齐原生探针这一处，不改变后续业务断言。

改动前先验证：`uv run --directory backend pytest -q tests/test_native_smoke.py -k readiness_`。预定标准：真实本机 HTTP 首次截断、随后 200 时恰好两次请求并成功；持续截断时在短测试期限后抛出既有 SmokeError，不吞永久故障；进程已退出时在访问 HTTP 前失败。保持既有连接、总等待和退出策略。再运行原生/部署相关测试和完整隔离原生部署检查，审查 diff，通过后单独提交/推送并等待当前 SHA CI。回退 `git revert <本项 SHA>`，无业务数据变化。

改动前 **2 failed、1 passed**：两种截断情况均抛出 BadStatusLine，退出进程的原检查通过。仅增加标准库异常导入与就绪等待中的捕获。修改后相关套件 **64 passed、16 skipped，9.82 秒**（该次未设置测试 DB）；随后完整后端使用隔离 PG **829 passed、0 skipped，77.71 秒**，补齐全部 PG 检查。没有把 skipped 写成通过。

新建独立 PG 数据库的原生部署验收再次通过：实际 Caddy 路由、Uvicorn 重启、PG 停机与恢复、Cookie/权限/账号隔离（`native-ready-integration.log`）；临时数据库、进程和目录均清理，保留公共的一次性测试容器供后续工作。diff 审查和 `git diff --check` 通过；无前端或 Android 原生改动，沿用第三项同一前端树的 99 项、lint、Web 和 Android 页面构建结果。远程仍须验证本项提交的四个 job，不复用旧 SHA 的绿色状态。

本项提交 `17ca719f4f22281a1a115d025e309ee564c18026` 已推送到 `sheny/optimize-readiness-20261031`。[对应 CI 41103531410](https://github.com/shenyankm/BreathOn/actions/runs/41103531410) 的四项非生产 job **全部成功**（`readiness-checks-latest.json` 逐条校验 head_sha），production skipped；本项验收完成。

- 原生部署 `wait_ready` 在收到截断状态行后抛出 `BadStatusLine`，没有继续等待就绪。真实本机 HTTP 服务器第一次发送 `HTTP/1.1 20`，第二次应返回 200；当前只请求一次就失败（`native-probe-before.json`）。需独立修复并验证有限重试与进程退出行为。
- 日记转写任务在协程内直接调用同步数据库事务。真实隔离 PG 占满 4 个连接后运行现有 `visit_run_job`，20 ms 事件循环心跳实际延迟 **5006.999 ms**，直到连接池超时才恢复（`visit-pool-before.json`）。没有调用上游服务；这是实际 PG 加进程内心跳测量，尚不是网络 HTTP 时延验收。需独立修复数据库阻塞与取消收尾，并检查任务在数据库恢复后的状态。
- 个人进度列表也读完整会话以核算历史费用与中断状态。当前这些字段对正确核算有用，不能直接删除正文读取；后续需要测量和完整等价性证据才能改。

## 6. 转写入队事务的异步隔离（改动前标准）

`POST /api/visits/{id}/transcription` 仍在 async 处理器内同步提交事务；即使后台 run_job 已修复，启动转写时的连接池等待仍可能阻塞存活和语音消息。先用 `visit_admission_probe.py`（复用第三项真实 Uvicorn/PG 故障脚本，仅切换到实际入队处理器）建立基线；3 个 6.2 秒池耗尽窗口、90 个并发存活样本、正常 10 个与恢复 30 个。故障必须仍为真实 PoolTimeout，任何上游调用为 0。

预设标准：故障期 live p95 <100 ms，正常/恢复不得同时退化 >10% 且 >1 ms；事务在事件循环以外执行。保留身份、所有权、保留期、状态校验、事务审计和单任务槽位，不重发不确定的收费 submit。重复取消必须等待提交/回滚；已提交且客户端取消的入队明确标记中断并清除提供商令牌，不启动付费后台；回滚不产生 job。并发重复提交只能一个成功，其他 409；关闭与入队互斥并排空，关闭后不得创建新任务。文件/真实 PG 回归与部署集成必须通过。仅本路由生命周期/入队及必要回归；上传文件是独立候选，不在本项声称解决。无依赖或迁移，回退 git revert 本项 SHA。

第六项改动前文件/PG 针对性回归 **2 failed**；故障期真实 HTTP p50/p95 **3919.432/4926.358 ms**，修改后 **3.533/9.739 ms**（90 样本，三窗口，min/max 前 1919.412/4928.995、后 0.680/10.921 ms）。正常 10 次 p50/p95 0.391/0.492 → 0.458/0.520 ms；恢复 30 次 2.527/3.406 → 0.881/1.700 ms，均满足预设标准（`visit-admission-comparison.json`）。不是收费提供商延迟或正常 ASR 首包指标。

原生部署故障验收通过（`visit-admission-native.log`）。首次误与全量 PG 回归重叠，导致持久管理员连接 AdminShutdown、测试数据库清理失败，结果 **838 passed、1 error** 不计为通过；已保存 `visit-admission-full-overlap.log`，仅删除该次遗留的一次性数据库，恢复后顺序重跑全量。新取消测试首次漏按 object_id 筛选本用例审计，PG 模块内其他测试审计导致断言失败；改为只验证当前记录的审计，没有删改产品校验或放宽本记录断言。

单独重跑完整后端使用隔离真实 PG：**840 passed、0 skipped，80.37 秒**。包含文件/PG 的事务线程校验、重复取消等待提交/回滚、取消后令牌清除及状态恢复、再次发起成功、并发重复提交一成功一 409、关闭等待及关闭后 503；HTTP 202、所有权 403/404、保留期 409、敏感路径/令牌不出响应继续通过。复用已有 work 排空 helper，增加的生命周期互斥沿用 ResearchService 模式，保证关闭不越过未完成入队；没有增加后台重试或提供商调用。前端树与第五项相同，本项无页面或 Android 原生行为改动。diff 审查与 git diff --check 通过，提交推送后须验证本项精确 SHA 的四个 CI job。

第五项提交 `edf32c2f12192de12f518291266442b4df354341` 已推送到 `sheny/optimize-medical-receipts-20261031`，远程分支精确匹配。[CI 41106221710](https://github.com/shenyankm/BreathOn/actions/runs/41106221710) 的 frontend、backend、android、deployment 全部成功（`medical-checks-latest.json` 校验各 job 的 head_sha），production skipped；第五项验收完成。

## 7. 日记列表重试成功后清除旧错误（改动前标准）

独立 Android AVD 实际发现：日记列表 GET 返回临时 HTTP 503 后显示错误，解除故障再点击刷新，数据请求成功但旧的“临时服务不可用”仍持续显示。`65-retry-before-fix.png` 为恢复后截图。`reload` 只更新 rows、不清 error；仅用于刷新按钮，原有加载、编辑/草稿和审核流程另有错误处理。

预设验收：连续两次失败各自显示最新错误，第三次成功刷新后旧错误消失且列表完整；请求数量不增加，真实失败不被吞掉，不清理或丢失未保存内容、账号和审核状态。先在现有 VisitsPage 测试工具复现失败，再最小修改；完整前端测试、lint、Web/Android 页面构建通过，并在独立 AVD 实际重复 503→重试成功，复查导航/草稿/隔离。无样式、原生录音、模型、接口或依赖变更；回退 git revert 本项 SHA。

此故障为隔离 QA 服务的显式 HTTP 503 注入，经过真实 Android WebView/网络/客户端状态处理；不是上游服务或真实 PG 宕机，后者已由部署集成单独覆盖。之前 API 进程重启按当前内存会话设计使 Cookie 失效，UI 正确要求重新登录，未将其认定为缺陷。初次测试输入脚本使用键盘展开前旧坐标，导致随机隔离密码被填进用户名并进入本地输出；已轮换仅本次测试凭据、遮盖所有 XML 输入值，并改为键盘变化后重新获取树，不涉及真实账号、录音或服务密钥。

改动前组件回归 **2 passed、1 failed**，成功后仍存在旧 Alert；修改仅一行 `setError('')`，在 GET 成功且 rows 更新后执行，不改变失败 catch。测试复用现有 VM/组件夹具，显式共享 Error 构造器以模拟浏览器同一 realm 的 Error，检查两次不同错误、成功后无旧 Alert、两条记录仍在、总共仅 4 次列表请求。没有断言代码文本或只复述实现。

完整前端 **100 passed、0 skipped**；lint 通过（3 条原有 Fast Refresh 警告），`npm run build` 与 `npm run build:android` 通过。后端树与第六项 840 项及原生部署验收完全相同，本项不重复数据库停机检查。真实 Android 客户端重新注入 503，错误仍正常显示（`67-retry-after-fix-failure.png`）；解除故障并刷新后错误消失（`69-retry-after-fix-success.png`）。换回 qa-rep 后原草稿仍在并可打开，qa-other 未显示该草稿。源 diff 和 `git diff --check` 通过；本项提交后仍须自己的远程 CI。

## 独立 Android 基础流程验收

新建仅本次使用的 `BreathOnOptimization_20261031`，API 35 ARM64、WebView 124、Pixel 7，serial `emulator-5556`。原有 `emulator-5554`、已安装用户 APK 和原服务 8000/5173 未操作。首次默认 10G userdata 因磁盘不足无法启动，改为该新 AVD 的 2G 后成功，未删除用户文件或缓存。使用 JDK 25、NDK 28.2.13676358、锁定 Rust 依赖构建 ARM64 debug APK，验证测试 URL 为本机 5179 后只安装到新 AVD；接口为独立 8007，三个虚构账号和独立 SQLite，ASR/模型/TTS 凭据为空。

实际执行错误密码、正常登录、退出取消与确认退出、首页后台/恢复、选择药品、独立选择医生、展开评分场景及详情、学习概述/返回、我的/空复盘列表、日记缺少必填校验/保存草稿/打开详情/返回、换账号隔离、HTTP 503 失败/恢复、原草稿保留。场景详情明确显示“评分标准尚未完成专家校准，仅作练习反馈”；产品/医生/资料均为标注虚构的软件文本，未提升医学或校准状态。截图/XML 在忽略验收目录，全部输入框值已遮盖；截图只含合成记录。

AVD 以 `-no-audio` 启动，未点击开始练习、语音输入或录音；本节不等同真实麦克风、扬声器、声学中断、真机延迟或真人训练质量验收。用户确认暂时无真机，继续保留这些必需待验项。未进行合格的三轮最终无新增优化复查，goal 未完成。测试 APK 单独标记为 QA 产物；正在恢复默认原生构建配置及原来的两份 APK，并清理本次 AVD 和服务，完成后再记录结果。

收尾结果：默认配置 ARM64 APK 编译成功，验证原生库包含默认 `https://openwook.cloud/_android/index.html` 且无测试 5179 URL，另存验证产物后按原 SHA-256 完全恢复两份原 APK（`android/apk-restore.json`）。仅本次 AVD/emulator-5556、8007/5179 服务已停止并删除 AVD，原 emulator-5554 保留；`android/cleanup.json` 验证清理。未安装或运行默认生产 URL 的验证 APK，未部署服务器。

用户后续要求将优化合并 main，并明确回复“允许合并并自动部署”，更新了最初的范围。七项 [PR #6](https://github.com/shenyankm/BreathOn/pull/6) 的全部 CI 通过后已合并为 `ddb3af82165ce6296fb3ec7dbb348250b4419fd9`，本地 main 也已 fast-forward。远端实际采用 squash；合并树与验收 head `b5430dbfa1c41e8b0a03ea96d1b6b2987c26a73d` 完全一致，原七个独立提交和验收仍保留在优化分支。正文引用历史提交的共同作者行，最终 trailer 块经 `git interpret-trailers --parse` 核对恰好一条 Codex；不改写已发布历史。该 main 的 [CI/自动部署 41114733710](https://github.com/shenyankm/BreathOn/actions/runs/41114733710) 尚待全部完成，不能写成部署通过。

## 8. 提交后的文件错误不能删除已提交附件（改动前标准）

实际故障注入复现：编辑录音原文时，新转写文件已随数据库事务提交，随后旧文件 unlink 抛 OSError；外层回滚清理仍删除 replacement。SQLite/隔离真实 PG 均 **2 failed**，数据库 version 已为 2，但所引用的新文件不存在（`private-file-commit-probe-before.log`）。此控制流已存在于初始 main；前面移出线程的改动保留了原逻辑，没有把它当作已解决。

调用方检查覆盖本模块所有 `private_write`/`private_delete`：创建和编辑返回 public、上传后的 public、后台 persist 的旧文件/提供商临时文件收尾均发生在 commit 之后，应退出回滚清理的 try 范围；真正事务/写入失败仍清理新文件。recover/到期删除/短期提供商转码不采用该回滚控制流，不做无关改动。最小改动只移动提交后的响应/清理到 except 之后，不新增抽象、重试、依赖、迁移或吞异常。回退 git revert 本项 SHA。

预设验收：四种路径的提交后读取或清理故障仍以原 HTTP 409 或 OSError 报错，数据库已引用的附件必须存在、内容正确且可在故障解除后读取；遗留旧文件由现有 cleanup 删除，新引用文件保留。创建/编辑/上传提交前失败时，数据库和文件集合保持原值，不留下新文件；文件/真实 PG 两种模式均覆盖。后台取消/提交回滚、权限、保留期和令牌回归继续通过；完整后端与隔离真实原生部署集成通过。仅合成隔离文件与数据库，提供商响应模拟，外部请求为 0；不声称真实麦克风/扬声器或服务端到端验收。

正式改动前回归 **8 failed、6 passed**，四种路径的两种存储均出现提交后文件被删，真正提交前失败的清理已正确。仅将 7 行提交后响应/清理移出回滚 except 的范围。修改后整个日记模块 **40 passed**；另补充上传响应丢失后的重复操作断言 **4 passed**：返回已有录音 409 且文件集合不变。故障仍明确返回 409 或抛出原 OSError，不以隐藏异常制造成功。

完整仓库后端含隔离 PG **854 passed、0 skipped，81.07 秒**。首次全量 **856 passed** 中包含忽略目录的两个本地探针用例，已改探针文件名以免默认收集并重跑正式 854 项；保留首次日志，不将临时探针数量计为仓库回归。随后单独执行隔离原生部署检查通过（`private-files-native.log`）：实际 Caddy、Uvicorn、PG 停机/重启、Cookie 与账号隔离，未与全量回归重叠。前端和原生树与第七项完全相同，沿用其 100 项、lint、Web/Android 页面和实际 APK 编译结果，不重复无关测试。diff 已检查，本项提交推送后仍需自己的精确 SHA CI。

前七项全部完成各自远程 CI：第六项 [41110086049](https://github.com/shenyankm/BreathOn/actions/runs/41110086049) 与第七项 [41110922966](https://github.com/shenyankm/BreathOn/actions/runs/41110922966) 的四项 job 均 success，逐项核对 head_sha（`admission-jobs-final.json`、`visit-retry-jobs-final.json`）。[PR #6 的合并验证 41111414851](https://github.com/shenyankm/BreathOn/actions/runs/41111414851) 四项也全部 success，head 为 b5430db、base 为 b8e766d；该分支生产 job 按规则 skipped。获得自动部署授权后才执行上述合并。

本项初始提交 `682af8f1232b92ac99c29557cb7c1c5e52bf082f` 已推送。其 [首次 CI 41112965869](https://github.com/shenyankm/BreathOn/actions/runs/41112965869) 前端/后端成功、Android 失败，deployment 因依赖失败跳过，未关闭本项。日志显示 buildSrc 的 Kotlin 2.3.21 依赖在 Gradle Plugin Portal 未找到；当前同一 POM 在原仓库及 Maven Central 均恢复为 HTTP 200、SHA-256 相同，已仅重跑失败 job，尚待完整结果。未降低版本或跳过构建。为后续顺序合并，已将本项相同代码/测试原样整理到最新 main 的独立分支；保留原提交和失败证据，最终新 head 仍须自己的 CI 全绿。

## 9. 上传事务及取消收尾（改动前标准）

上传接口的初次读取和最终写入仍直接运行同步事务，连接池耗尽会阻塞整个事件循环。此前发现期的 90 个真实 Uvicorn 存活请求 p95 为 4920.953 ms（`visit-upload-fault-discovery.json`）；正式对比使用当前 e553d13 与相同 `visit_upload_fault_probe.py`，三次 6.2 秒窗口，仍须按 5 秒真实 PoolTimeout 失败。最小方案复用现有 work 排空 helper，把读取、提交/响应读取放在线程；验证器取消也须等待已开始的线程结束。已提交标志必须在事务退出后设置，取消不能删除数据库已引用的录音。

调用方已检查：日记导入与 SelfReportRecorder 都向同一 audio 路由发送授权头，120 秒客户端超时；格式、大小、保留期、所有权、原文私有化及手动启动转写保持。范围仅本路由和必要回归，无新配置、依赖或并发机制；流式写入和 100 MB/30 分钟限制保持。回退 git revert 本项 SHA。

预设标准：池耗尽时 live p95 <100 ms，正常/恢复的 p50/p95 不得同时退化 >10% 且 >1 ms。文件/真实 PG 上传读取、提交与响应私有文本读取均不得占用事件循环；重复取消验证和提交时等待线程收尾，回滚无新文件，已提交即保留文件，重试/并发重复上传只有一个成功且无额外临时录音。已有提交后故障保护、授权、保留期与完整回归继续通过。

正常上传正式基线：真实 Cookie 代表账号、原生 ffprobe、单声道 16 kHz PCM16 合成静音 WAV，160 秒/5,120,044 字节与 1600 秒/51,200,044 字节；每种存储 3 次进程启动，首上传分列、预热 3 次后每类各 10 次，总计每类每模式 30 样本。每轮另做大文件上传期间 live 探针（每轮仅 3–4 个样本，不据此声称稳定分位），最终回读两类原文件核对全部字节和 no-store/nosniff。正式脚本 `audio_upload_probe.py`，前后相同工具/参数；未清系统文件缓存，不称完全冷读。

三轮 p50/p95 中位数（ms）：文件 5 MB **12.413/12.734**、51 MB **36.404/45.177**；PG 分别 **16.605/17.827**、**40.319/44.685**。预设正常回归界限：两种存储各类 p50/p95 不得同时增加 >10% 且 >2 ms（5 MB）或 >5 ms（51 MB）；字节与元数据必须一致。较大文件 p95 各轮文件 41.684–45.364、PG 44.249–51.951 ms，保留各轮与原始样本，不按个别更快运行宣称收益。

最初真实上传测量因本机无 ffprobe 返回 503，未计为通过；测试账号第一次还缺少必需管理员配置，配置校验正确拒绝。已从 [FFmpeg 官方](https://ffmpeg.org/download.html) 下载 9.0.2 源码，在本次容器的独立公钥目录核对官方指纹并通过 PGP 验签，源码 SHA-256 为 `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`；仅在忽略的验收目录以 2 个编译任务构建原生 ffprobe，基线/对比使用相同 PATH。没有安装全局包或改项目依赖；不是生产 ffmpeg、麦克风或扬声器验收。

改动前针对性回归 **4 failed**：两种存储都同步占用事件循环，取消也会立即放弃仍在验证的工作线程。改后日记模块 **50 passed**，完整仓库后端含真实 PG **864 passed、0 skipped，81.88 秒**。覆盖验证/提交的重复取消、真实事务提交/回滚、正确身份上下文、响应私有文件读取、后续重试、两个并发上传仅一个成功及无额外录音。只有两个事务/响应读取改为现有 work，验证器复用其取消排空；提交成功标志在事务退出后设置，确认已提交的文件不随取消删除。

三次真实 PG 池耗尽窗口的 90 个 live 样本：p50/p95 **3916.461/4927.044 → 6.504/9.321 ms**；min/max 前 1910.748/4929.860、后 1.294/10.260 ms。正常 10 次 p50/p95 **0.345/0.383 → 0.357/0.488 ms**，恢复 30 次 **2.242/3.063 → 1.180/1.740 ms**。仍得到真实 PoolTimeout，无上游调用，全部故障时延标准通过（`upload-fault-comparison.json`）。

相同 HTTP/输入/原生 ffprobe 的正常上传对比（各模式每类 30 个热样本，三轮分位数中位数，ms）：

| 存储/输入 | p50 前→后 | p95 前→后 |
| --- | --- | --- |
| 文件 5 MB | 12.413→13.275 | 12.734→13.726 |
| 文件 51 MB | 36.404→40.730 | 45.177→44.583 |
| PG 5 MB | 16.605→16.354 | 17.827→17.537 |
| PG 51 MB | 40.319→36.442 | 44.685→45.556 |

全部预设正常回归界限通过；文件大输入 p50 增加 4.326 ms（11.9%，未超过预设 5 ms 绝对界限），不隐去该代价，也不把其他正常差异写成稳定收益。回读原字节保持不变：5 MB SHA-256 `68100cab8c16c5bf79ae85146d6570e61586891f2105bb81477f03e4d7491d66`，51 MB `87b952be7a2f4a96c8b83ffddfbae7c3f1485130f386877b70a9800820e08a0c`；状态、时长、私有字段和缓存安全头一致。首请求、各轮原值/波动均保存在 `audio-upload-before/after.json`，`audio-upload-comparison.json` 判定全部标准。

全量结束后单独运行隔离原生部署集成通过（`upload-native.log`），实际 Caddy/Uvicorn、PG 停机恢复、Cookie 和账号隔离均通过；未与全量回归重叠。无前端/Android 原生树变化，沿用第七项同一树的 100 项、lint、两种页面构建及 APK 编译，不把模拟验证当真机/麦克风验收。diff 审查和 git diff --check 通过，本项仍须提交推送与当前 SHA CI。

合并进展：`ddb3af8` 的 main CI 五项（含真实 production 部署步骤）全部 success，对外 live/ready 均 HTTP 200（`main-production-health.json`）。附件修复原 SHA 682af8f 仅重跑后四项 CI 全部成功，保留首次失败日志；最新 main 基底提交 `e553d1322672558567c530e5b580800035ac7ad8` 的 push [41115527885](https://github.com/shenyankm/BreathOn/actions/runs/41115527885) 与 PR [41115648424](https://github.com/shenyankm/BreathOn/actions/runs/41115648424) 四项分别全部 success，均核对 head_sha。依授权已将 [PR #7](https://github.com/shenyankm/BreathOn/pull/7) 快进到 main，保留该独立提交及恰好一次共同作者 footer；未强推。该 main 的新 CI/自动部署仍待验证，不复用上一提交的 production 结果。

后续结果：e553d13 的 main [41117996488](https://github.com/shenyankm/BreathOn/actions/runs/41117996488) 五项成功。第九项提交 `80de4af2c15a6b282a3c0bfde4d69ef0545b5b30` 的分支 [41118693282](https://github.com/shenyankm/BreathOn/actions/runs/41118693282) 四项通过后，依用户新指示快进 main；该 main [41120227737](https://github.com/shenyankm/BreathOn/actions/runs/41120227737) 五项全部成功，生产日志确认同一 SHA 实际部署，外部 live/ready 均 200。用户要求清理已合并分支，已按祖先关系、PR #6 squash 树和第八项代码/测试等价性逐个核对，删除 11 个本地及 10 个远程冗余分支；当时两端只剩 main，原用户 stash 完整保留（`branch-cleanup-final-result.json`）。后续每项仍按独立分支验收、CI、合并及自动部署顺序推进。

## 10. 定时附件清理的故障恢复（改动前标准）

应用每小时执行一次 visit_cleanup；当前循环未处理工作线程异常，一次数据库连接池超时或文件错误就使任务永久退出，存储恢复后也不再执行到期附件删除。启动时清理保留严格失败行为，不将未成功启动写成 ready；本项仅处理已运行应用的周期任务，不改保留期限、账号范围、文件格式或手动删除流程。

预设验收：使用现有生命周期与真实隔离 PG，把 4 个池连接占满直到原有 5 秒 PoolTimeout；文件模式注入一次 OSError。失败后任务必须继续等待原有 3600 秒周期，不能忙重试、增加后台任务或把失败计为成功；日志只记录异常类型，不含路径、内容或数据库凭据。释放连接/文件故障后，下个周期实际清理到期音频和转写文件、更新 deleted 状态，其他账号未到期记录及附件字节完全不变。仅测试调度时钟由事件推进，数据库、事务与文件操作是真实实现；不冒充完整网络服务或真机验证。等待周期中的关闭取消后不得再执行清理；执行中线程的关停排空是独立的已知候选，另做故障证明，不混入此项。

修改范围限定 api/app.py 的周期循环及有效回归，复用 ResearchService 现有“记录错误类型、等待下周期”的模式，无新依赖或配置。日记/运行时回归、带真实 PG 的完整后端、真实 Caddy/Uvicorn/PG 原生部署集成必须通过；前端和 Android 树不变，保留现有验收并由新 SHA CI 完整重跑。回退 git revert 本项 SHA。完成后再提交推送、验证当前分支四项 CI，按已授权顺序合入 main 并验证该 main 五项（含实际生产步骤）。

修改前新回归 **2 failed，5.82 秒**，分别确认任务以 OSError 和真实 PoolTimeout 终止。初次夹具遗漏 storage 参数导致收集失败，修正后才取得上述基线，初次日志另存 `cleanup-recovery-initial-collection-error.log`。生产改动仅为周期调用增加 try/except 并记录异常类型；修改后针对性回归 **2 passed，5.81 秒**，完整仓库后端含真实隔离 PG **866 passed、0 skipped，84.33 秒**（`cleanup-recovery-before/after/full.log`）。验证故障后不忙重试、下周期实际删除两类到期文件、更新数据库状态、另一账号未到期数据逐字节保留，以及等待周期中取消后不再执行。恢复后仍最多等待原有一小时周期，未声称立即清理。

全量测试结束后单独执行原生部署集成通过（`cleanup-recovery-native.log`）：实际 Caddy/Uvicorn、进程重启、PG 停机恢复、Cookie/账号隔离；临时数据库、进程及目录已清理，自己的公共测试容器继续保留。没有并行停止全量测试所用 PG。前端及原生树未变，沿用同一树的 100 项、lint、Web/Android 页面构建及 APK 编译；本项新 SHA 仍须自己的完整远程 CI。本地 diff 已审查，未把模拟时钟或已有真机缺项写成真实语音验收。

复查发现另一个部署候选：native-deploy.sh 的初始就绪轮询未捕获 HTTPException。提取真实生产轮询代码，接实际本机 HTTP 服务器，临时只缩短测试等待并改本机端口；“首次截断后恢复”3/3 提前 BadStatusLine，永久截断也 3/3 只请求一次，503 后恢复对照 3/3 正常两次请求。证据 `native-deploy-readiness-discovery.json`。未修改该源脚本：文档明确 `/usr/local/sbin/medvisit-deploy` 需管理员重新安装，普通自动发布不会更新受限入口。真实安装/运行验收尚缺管理员路径，先完成可推进项；不能把新发布包携带脚本当作已更新生产入口。
