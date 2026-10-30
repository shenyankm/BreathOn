# 持续优化验收记录 · 2026-10-31

基线为 `b8e766dda312f56690efc7cc4b9e0d094dfb8775`，初始 `main` 与 `origin/main` 一致且工作区干净。起始独立分支 `sheny/optimize-20261031`；后续独立优化从已提交版本继续使用新分支，避免 CI 的按分支取消机制取消上一项未完成的验收。管理员列表分支为 `sheny/optimize-admin-history-20261031`，包含第一项登录修复。不合并 main、不部署生产。当前基线的远程 CI [41094354090](https://github.com/shenyankm/BreathOn/actions/runs/41094354090) 成功，这不替代后续提交的 CI。

环境：macOS ARM64，Node 22.23.2、uv 0.12.13，仓库锁定依赖；隔离 PostgreSQL 17 Alpine 容器 `breathon-opt-20261031`，仅绑定 loopback、使用测试账号。保留已有 8000/5173 服务和其他项目容器。原始日志与临时产物在忽略目录 `backend/data/validation/optimization-20261031/`。未读取业务记录或将服务密钥写入结果。

## 检查范围与队列

| 方向 | 检查和验收范围 | 状态 |
| --- | --- | --- |
| 性能 | 当前 API、存储/聚合、导入导出、构建；区分测试耗时和业务响应 | 管理员列表已实测改进；导入导出、调度仍需复查 |
| 响应速度 | 真实本机 HTTP 的冷启动及热运行 p50/p95，登录、目录、历史记录；语音单独标记验证边界 | 六个接口、串行/10 并发基线已测；真实语音端到端待验收 |
| 稳定性 | 登录取消、会话/后台任务取消、超时、断线、数据库故障与恢复 | 登录修复本地通过；转写任务连接池耗尽阻塞事件循环约 5 秒已复现 |
| 资源占用 | 密码工作线程、连接/任务、音频生命周期、空闲与重复请求、构建包体积 | 登录槽位与管理员列表分配峰值已验收；音频和长期生命周期待检查 |
| 工程规范 | CONTRIBUTING、CI、类型、错误契约、锁文件、隔离及已有回归 | 基线后端 818、前端 99 通过；lint 与两种页面构建通过 |

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

只有摘要查询与调用方改动，无前端/Android 原生、医学资料或依赖改动。diff 已审查，`git diff --check` 成功。提交 `fba107995f2e82f22b852f0fc5b0ff944fde9d6f` 已推送，`git ls-remote` 确认远程精确包含该 SHA。[对应 CI 41100857013](https://github.com/shenyankm/BreathOn/actions/runs/41100857013) 的 frontend、backend、android 已成功，deployment 仍运行中（`admin-checks.json`）；四项远程 CI 完成前仍不关闭本项。

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

第 3 项已提交为 `e01bb8f1113ae4da02932900f8ab4465d072df0f` 并推送到 `sheny/optimize-transcription-io-20261031`，远程 ref 精确匹配，包含前两项保留改动。[对应 CI 41102447430](https://github.com/shenyankm/BreathOn/actions/runs/41102447430) 排队中，尚待验证（`visits-checks.json`）。

手动执行现有 `check_services` **一次**：四类配置完整的提供商探针各一次、每类 20 秒上限；3.188 秒完成，ASR、TTS、analysis、practice、combat 五个状态均正常（`live-services-once.json`）。practice/combat 为组合状态，实际探针为 SeedASR、TTS、DeepSeek、Seeduplex 四类。使用仓库内的合成音频和简短状态文本，可能产生服务用量；未重复收费压测，不把单次状态检测当延迟分布、医学输出质量或麦克风/扬声器验收。

当前仅检测到正在使用的 `emulator-5554`（已有 `cloud.openwook.medvisit.debug`），未覆盖安装、清空数据或改变连接目标，以保护已有工作。已询问可用的隔离真机环境；尚未完成真实麦克风、扬声器与真机端到端验收，goal 仍 active。

## 待核实/处理候选

### 4. 原生部署就绪探针重试截断状态行（改动前标准）

`check-native.py::wait_ready` 在四处启动/重启等待中复用。当前只捕获 OSError/URLError，`BadStatusLine` 属于 `http.client.HTTPException`，初次响应被截断时会跳过现有 90 秒重试期限而直接失败。`check-stack.py` 已有相同类别处理；只补齐原生探针这一处，不改变后续业务断言。

改动前先验证：`uv run --directory backend pytest -q tests/test_native_smoke.py -k readiness_`。预定标准：真实本机 HTTP 首次截断、随后 200 时恰好两次请求并成功；持续截断时在短测试期限后抛出既有 SmokeError，不吞永久故障；进程已退出时在访问 HTTP 前失败。保持既有连接、总等待和退出策略。再运行原生/部署相关测试和完整隔离原生部署检查，审查 diff，通过后单独提交/推送并等待当前 SHA CI。回退 `git revert <本项 SHA>`，无业务数据变化。

改动前 **2 failed、1 passed**：两种截断情况均抛出 BadStatusLine，退出进程的原检查通过。仅增加标准库异常导入与就绪等待中的捕获。修改后相关套件 **64 passed、16 skipped，9.82 秒**（该次未设置测试 DB）；随后完整后端使用隔离 PG **829 passed、0 skipped，77.71 秒**，补齐全部 PG 检查。没有把 skipped 写成通过。

新建独立 PG 数据库的原生部署验收再次通过：实际 Caddy 路由、Uvicorn 重启、PG 停机与恢复、Cookie/权限/账号隔离（`native-ready-integration.log`）；临时数据库、进程和目录均清理，保留公共的一次性测试容器供后续工作。diff 审查和 `git diff --check` 通过；无前端或 Android 原生改动，沿用第三项同一前端树的 99 项、lint、Web 和 Android 页面构建结果。远程仍须验证本项提交的四个 job，不复用旧 SHA 的绿色状态。

- 原生部署 `wait_ready` 在收到截断状态行后抛出 `BadStatusLine`，没有继续等待就绪。真实本机 HTTP 服务器第一次发送 `HTTP/1.1 20`，第二次应返回 200；当前只请求一次就失败（`native-probe-before.json`）。需独立修复并验证有限重试与进程退出行为。
- 日记转写任务在协程内直接调用同步数据库事务。真实隔离 PG 占满 4 个连接后运行现有 `visit_run_job`，20 ms 事件循环心跳实际延迟 **5006.999 ms**，直到连接池超时才恢复（`visit-pool-before.json`）。没有调用上游服务；这是实际 PG 加进程内心跳测量，尚不是网络 HTTP 时延验收。需独立修复数据库阻塞与取消收尾，并检查任务在数据库恢复后的状态。
- 个人进度列表也读完整会话以核算历史费用与中断状态。当前这些字段对正确核算有用，不能直接删除正文读取；后续需要测量和完整等价性证据才能改。
