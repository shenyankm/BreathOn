# 架构与部署

## 技术栈规范与边界

- 移动端：React + Tauri 2 + SQLite。React 页面使用 TypeScript，Rust 负责 Tauri 原生入口和必要的原生能力；SQLite 承担端内本地持久化。
- Web 端：React + TypeScript + Python + FastAPI + AgentScope + PostgreSQL（pgsql）。React / TypeScript 负责管理界面；Python / FastAPI 负责业务接口；AgentScope 负责服务端 AI 编排；PostgreSQL 负责服务端结构化数据。
- Web 与移动端共用同一套服务端 API、账号权限和 AI 服务。移动端通过 API 访问服务端数据，不直接连接 PostgreSQL；供应商密钥保留在服务端。

移动端通过 Rust `rusqlite`（内置 SQLite）将上次选择的练习方式保存到应用私有目录的 `breathon.sqlite3`，按登录账号区分，重启后恢复。数据库使用 `user_version=1`，升级遇到更高版本会拒绝访问并保留原库。仅开放读取、保存练习偏好两个 Tauri 命令，不接受前端传入 SQL 或文件路径；能力限定为 Android 主窗口的 `https://openwook.cloud/_android/index.html`，debug 构建额外允许本机 HTTP 同一路径。普通远程页面没有这些权限。

SQLite 当前只保存非敏感练习偏好，退出后保留供同账号下次登录恢复，不保存密码、Cookie、转录或录音；不是离线业务或自动同步实现。存储失败会提示用户并允许继续练习。现有后端 `platform.sqlite3` 是本地开发兼容存储，不是移动端数据库。

## 调用关系

```text
React + Tauri 2 Android App（用户端，页面内置 APK）
  ├─ Rust → 端内 SQLite（按账号保存练习方式）
  └─ HTTPS /api HTTP + WSS（登录 Cookie）
服务器 Caddy（原生，React + TypeScript 静态 Web 管理端 /admin）
  └─ 同源 /api HTTP + WebSocket 代理
      └─ Python + FastAPI api/app.py（原生 systemd 单进程）
          ├─ voice/：SeedASR / Seeduplex / TTS
          ├─ services/practice.py：会话、转录修正、取消、重试、复盘
          │   └─ agents/coach.py：独立 AgentScope Agent → DeepSeek → 输出校验
          └─ storage/：PostgreSQL（Docker）或 JSON（本地兼容）
```

Android 是唯一用户端，底部导航为「练习、学习、我的」，拜访日记和复盘记录属于「我的」。服务器只分发 Web 管理端；`/app` 返回 410，`/_android/` 返回 404。APK 的 `WebViewAssetLoader` 在本地提供 `/_android/` 资源，登录、API、附件和 WebSocket 同源连接服务器；应用不内置模型密钥。

`main.py` 配置 HTTP 请求日志并创建 ASGI 应用，配置集中在 `core/config.py`。语音接收与智能体推理分离，保持原有流式语音协议；AgentScope 不接管麦克风和上游 WebSocket。每次模型请求创建独立 Agent，业务层显式提供限定长度的当前会话原文；模型与客户端均关闭自动重试，由现有会话层处理重试和取消。

医生/教练通过 AgentScope `LocalSkillLoader` 加载 `backend/medvisit/agents/skills/humanizer/SKILL.md`，在各自的请求中注入完整写作规则。使用 embedded mode，只润色中文措辞；引用原话、医学证据约束、风险提示和 JSON 格式优先，草稿不对外输出。技能随 `medvisit/` 打包进后端发布源码，无额外工具调用，也不在运行时下载。原版来自 [blader/humanizer](https://github.com/blader/humanizer/tree/8c307f367c91bd974002f10f2be2965d642c13df)，版本 3.1.0，固定提交 `8c307f367c91bd974002f10f2be2965d642c13df`，保留 MIT 许可证。完整规则会增加每次请求的输入 token；更新时同时替换技能和许可证并运行后端测试。

DeepSeek 适配器显式设置 `context_size=1_000_000`，覆盖通用 OpenAI 适配器的128K默认值，供 AgentScope 上下文管理使用；它不是发送给上游的请求字段。模型容量依据 [DeepSeek 官方模型说明](https://api-docs.deepseek.com/quick_start/pricing/)。业务层仍保留每条4000字符、每次64000字符的转录上限，练习取最近16条、复盘取全部可容纳记录；字符预算不等于 token 容量。默认输出限制2000 tokens，已配置场景的结构化评分最多4000 tokens。

三个医药代表技能按场景注入AgentScope请求：基础拜访技能常驻，研究数据线索补充循证技能，利益交换、个人信息及疑似不良反应等线索补充合规技能。练习以可见记录中最后一条医生与最后一条学员消息分流，复盘扫描全部可见记录；多个场景可同时加载。关键词分流不额外调用模型，可能漏掉未覆盖的隐晦表达，新增词需带路由回归用例。来源取舍见 [技能研究说明](medical-rep-skill-research.md)，真实模型验收见 [指导效果验证](coaching-live-validation.md)。

对话作为单份JSON数据传入，`transcript[].speaker`区分医生与学员，`interaction_events`单独保存采集事件，避免把事件或医生消息误作学员话轮。练习由两个独立Agent并发读取相同原始记录：教练先评价原文再写参考话术，医生不接收生成的教练答案；复盘只调用教练。两个请求共享本次SDK客户端、各自持有独立上下文，取消时一并取消，结束时关闭客户端；usage累加实际调用。使用temperature=0，关闭无关的运行时状态提醒。返回业务JSON字段保持原样，按钮次数和采集结束状态由代码生成，文字语气字段保留“声音语调未评估”，不让模型编造这些采集事实。练习会增加一次上游请求及相应输入用量，并发不代表没有延迟波动。

数据库调用在线程中执行，不阻塞 ASGI 事件循环。连接池随 FastAPI 启停，启动时运行幂等的 `backend/migrations/001_sessions.sql` 和 `002_platform.sql`。`sessions` 以 UUID 为主键，JSONB 保留原有记录格式，`saved_at` 索引用于最近 50 条摘要。摘要不返回对话正文；保存事务提交后才发送 `ended.saved=true`。数据库不可用时返回通用错误，不向客户端暴露连接信息。

当前只有首次建表脚本；后续修改既有字段时新增有版本的迁移，并在部署前执行，不要依赖 `CREATE TABLE IF NOT EXISTS` 修改已有表结构。

## 平台存储与账号访问

`platform/`处理版本化目录、医学审核、校准、点评与重练。生产API复用PostgreSQL连接池和`platform_entities`表；未配置数据库时，演练仍存JSON，平台元数据存`records/platform.sqlite3`（权限0600）。写操作使用事务与版本CAS；PostgreSQL用事务锁，SQLite用`BEGIN IMMEDIATE`及WAL，让读取快照不阻塞其他请求提交，保持`FULL`同步。本地备份应停止API后复制整个记录目录，包含尚未合并的WAL文件。PDF原件作为同一库内的资产保存，单文件20MB、最多200页，只解析文字层，不做OCR；解析在限时子进程内执行。大规模资料库需在实测后迁移对象存储与语义索引。

服务器使用预配置账号，不开放注册。Android 始终要求启用登录；仅 Web 本机开发兼容免登录。HTTP 和 WebSocket 校验 Cookie 会话，写入校验 Origin；Cookie 使用 HttpOnly、SameSite=Strict，HTTPS 下附加 Secure。退出会撤销当前会话，服务重启会清除会话。账号切换会卸载原用户页面，避免沿用原会话的内存数据。

管理员维护共享药品、医生、场景和审核资料；代表只能读取允许用于训练的内容。个人演练、点评、重练、经验案例、拜访日记与统计按账号归属隔离，后端逐次校验，不能依靠隐藏前端入口代替权限检查。管理员通过专用管理接口访问代表记录并留存审计。医学改分仍须有本次有效资料的逐字依据；资料标记为审核通过不等于专业医学审核。认证配置见[服务器与 CI/CD](server-deployment.md)。

## 评价与同版本重练

已发布场景绑定医生、量表和审核资料，启动时采集当前医生资料及量表、资料版本；每次推理前后检查资料仍有效。已发布医生须先创建草稿，核对并发布后更新原稳定身份；历史会话保留开始时的医生快照。删除医生会保留删除标记，阻止启动时重新生成默认医生；仍被场景引用时不可删除。检索对中文二元词与英文词做有界词法排序，最多10段，每段1300字。模型评分必须引用实际学员原话和检索片段，代码核对角色、原文、页码及整数分值；独立适用性审核Agent只能撤除缺乏医学依据的评分。未观察记null，全部维度有依据才形成总分。当前评价版本为3。

评分校准保留，用于检验量表与模型的一致性。校准任务需各维度至少5份专家有效标注，工程阈值为MAE≤0.5且相差不超过1档的比例≥90%；合成样本不授予专家校准。后台任务有进度、取消和过期中断状态，重启不自动重放收费请求。真实适用性与阈值仍需专业团队确认。

人工点评可定位原话并单独保存分数调整，原AI结果不覆盖。医学调整必须有本次有效资料的逐字引用。正式审批和申诉入口已删除，已有点评及历史回应继续可读。

记录页集中创建、启动和查看重练。`/remediations/{id}/next`返回明确的`remediation_id`，WebSocket据此锁定原场景、环节和关注维度，并把新记录与原记录关联。只有完整、引用校验通过的演练标记重练完成；前后比较采用同量表指纹、模型与评价版本的原始AI分数，不能比较的项目明确留空。

课程、分配任务、考核次数、认证、榜单/徽章/目标、团队统计和独立资料助手均已删除对应模型、接口与前端页面，不保留功能开关。通用平台存储不做破坏性迁移，历史实体和原始会话保留；旧课程启动参数明确拒绝。

## 医生训练角色

`agents/doctor.py`集中维护“李小英（训练模拟）”的公开专业背景、来源、训练行为和开场白。练习通过独立的`li_xiaoying_doctor` Agent使用该提示；实战的Seeduplex `session_config`复用同一提示。`GET /api/doctor`只返回公开画像，前端据此展示姓名、来源和模拟说明。创建会话时把医生id、画像版本与显示名写入原有JSON/JSONB记录；历史记录未含身份元数据时只显示“医生（历史训练）”，不追溯改名。

画像依据DeepSeek原生Search/Fetch返回的官方资料人工核对后编写，运行时不下载网页，也不把原始网页当系统提示。专业背景与训练设计分开，不推断真人性格、产品态度或处方偏好。来源与真实模型验证见[医生 agent 说明](doctor-agent.md)。

## 网络检索与DeepSeek限流

教练通过AgentScope `FunctionTool`按需调用DeepSeek原生Search/Fetch接口，医生请求不使用搜索。搜索启用时，教练最多3次模型推理、2次网页工具尝试，整体等待上限默认45秒（`DEEPSEEK_TIMEOUT_SECONDS`加25秒）；关闭时保持单次教练推理，默认25秒（该值加5秒）。可恢复的服务端错误（408/429/5xx、连接错误）每次模型调用最多重试一次；客户端超时不重试。多轮工具调用的模型token用量会累加。普通沟通和已有数字的算术练习不要求联网。

开发配置见`backend/.env`及`backend/.env.example`；生产由systemd加载私有环境文件，路径见[服务器与CI/CD](server-deployment.md)。以下为配置项及示例值，不替代供应商实时额度：

| 变量 | 示例值 | 含义 |
| --- | --- | --- |
| `DEEPSEEK_SEARCH_ENABLED` | `true` | 给教练注册搜索与抓取工具 |
| `DEEPSEEK_MAX_CONCURRENCY` | `2500` | 当前进程所有对话/Agent共享的模型请求信号量；当前Flash标准额度2500，切换Pro时改为500，定制额度按实际配置 |
| `DEEPSEEK_SEARCH_QPS` | `100` | Search请求平滑限速，独立于模型并发 |
| `DEEPSEEK_TIMEOUT_SECONDS` | `20` | 单次教练/医生模型请求的客户端超时，同时决定一轮的总等待上限 |
| `SUMMARY_TIMEOUT_SECONDS` | `30` | 拜访评分卡等单次JSON补全的总超时 |
| `DEEPSEEK_REVIEW_MODEL` | 空 | 资料适用性复核所用模型；空表示沿用评分模型，填不同模型可降低同源错误 |
| `RESEARCH_MAX_CONCURRENCY` | `4` | 同时运行的检索任务数，每个任务启动一个MCP子进程，超出的排队 |
| `CALIBRATION_MIN_SAMPLES` | `5` | 每个维度判定“已校准”所需的最少专家样本 |
| `CALIBRATION_REPEATS` | `0` | 校准时每个样本额外重复运行的次数（0至3），用于测量运行间稳定性；会增加付费调用 |
| `DEEPSEEK_FETCH_QPS` | `25` | Fetch请求平滑限速，独立于Search及模型并发 |

这些是当前进程的保护上限，不能控制同账号其他应用或其他worker的请求；账号实际超限仍可能收到429。它们不改变本机的2个语音会话上限，也不代表系统已通过2500并发压测。额度依据[模型价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)和[限速说明](https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit/)，搜索/抓取依据[搜索指南](https://api-docs.deepseek.com/zh-cn/guides/search/)。

查询只发送通用公开关键词，不自动发送完整转录；工具拒绝常见手机、身份证、邮箱及密钥模式。Fetch只接受搜索实际返回的公开URL，拒绝本地/内网IP、凭据和敏感查询参数。网页内容是外部数据，不是指令，也不视为经产品医学审核。错误只回传通用状态，取消会关闭本次SDK客户端，不增加自动重试。

`coach.sources`由真实工具结果生成并随现有记录保存，不采用模型自编链接；前端展示“检索来源”，来源日期按浏览器本地时区显示。`usage.search_requests`和`fetch_requests`统计尝试次数，并不等同成功计费次数。运行验证和费用说明见[搜索验收记录](web-search-validation.md)。

## 运行方式

| 场景 | 命令 | 数据存储 |
| --- | --- | --- |
| 本地 Web 管理端 | `npm run dev -- --host 127.0.0.1` | 通过 Vite 代理 API |
| Android App | `npm run android:build -- --debug --apk --target aarch64` | APK 内置页面，数据保存在服务器 |
| 本地 API | `npm run dev:api` | `DATABASE_URL` 为空时使用原 JSON |
| 生产 API / Web 管理端 | `medvisit-coach.service` 与 Caddy 原生服务，见[部署说明](server-deployment.md) | PostgreSQL 与主机私有文件目录 |
| 生产数据库 | `deploy/database.compose.yaml`（仅 PostgreSQL） | 数据库命名卷 |
| 可选旧组合验证 | `docker compose up -d --build --wait`，仅在一次性隔离项目运行 | 临时 PostgreSQL / 文件卷，不连接生产数据 |

所有命令均从项目根目录执行。Node 依赖与锁文件均归 `frontend/`：从根目录执行 `npm --prefix frontend ci`，或进入 `frontend/` 后执行 `npm ci`。根目录 `package.json` 仅转发开发命令，不声明 workspace，也不安装依赖。Python 使用 `uv sync --directory backend --locked`，依赖声明与锁文件不一致时直接失败，不修改锁文件。

本地开发的服务密钥放在 `backend/.env`。生产数据库配置、systemd 环境文件及 Caddy 配置独立于发布目录，按[原生部署说明](server-deployment.md)维护；不要用旧完整 Compose 项目替代原生 API / Web 服务。发布包携带后端源码和 CI 构建的管理端静态文件，服务器仅按 Python 锁文件安装依赖，不运行 npm 构建。

本机免登录模式保持绑定本机；公网必须启用登录并使用 HTTPS。API 使用单进程，每账号至多一场演练，总并发由 `VOICE_MAX_SESSIONS` 控制（默认 10）；增加 worker 前需先实现共享限流和后台任务执行器。

## 导入旧 JSON

先完成 PostgreSQL 启动，在原生 API 相同的环境配置和权限下运行 `python -m medvisit.storage.import_records <旧记录目录>`。本地开发可从项目根目录执行：

```sh
uv run --directory backend python -m medvisit.storage.import_records data/sessions
```

命令先校验全部记录，再在一个事务中导入；保持原文件修改时间对应的列表顺序。UUID 已存在时跳过，不覆盖数据库的新版本。原 JSON 保留在原处；遇到损坏或非法文件会失败，不提交部分记录。仅本机免登录兼容模式可读取旧匿名记录及关联点评，不更改其归属字段；服务器账号不能因此越过记录归属检查。已有平台资料沿用首次初始化的工作区；其他旧工作区资料和重练保留在原库中，但不会自动合并。

## 备份与停止

生产备份通过 `deploy/native-backup.py` 的 `backup` / `verify` 接口，同时覆盖 PostgreSQL 与 `RECORDS_DIR`，排除私有 `visit-audio`。备份前停止原生 API；该工具不会代为启动服务，也没有原地生产恢复命令。具体参数、恢复边界及旧 Compose 工具的适用范围见[运维说明](operations.md)。

API 用 `systemctl` 停止，不使用 `docker compose down` 停止应用。数据库卷和私有文件目录须成套保护；`down -v` 会删除数据。首次从旧容器迁移时，尚在容器可写层的原文必须先导出，再按[原生部署说明](server-deployment.md)迁移，不能先重建或删除旧容器。改变初始化密码环境变量不会自动修改已有数据库角色密码。

## 运行探针与故障定位

`GET /api/live` 只检查进程响应；`GET /api/ready` 有限时地检查数据库连接、平台表及文件目录写入，失败返回 503。原生部署在启动 API 后检查就绪状态，再验证 Caddy 的公开入口。`GET /api/health` 保留原有配置摘要；这三个接口都不验证付费供应商可用性，实际服务检测仍由用户点击刷新触发。

HTTP 请求使用独立的请求 ID，在响应头 `X-Request-ID` 与结构化日志中关联。日志只保存方法、路由模板、状态、耗时及异常类型和代码位置，不写入异常原文、请求正文、查询参数或 API Key；验证错误不回显被拒绝的输入。语音会话通过已保存的会话 ID 定位。API 日志通过 systemd journal 查看，代理由原生 Caddy 管理；不要在排查中输出私有环境文件或请求正文。旧 Nginx 日志配置仅用于隔离 Compose 验证。

API 在解析前限制实际请求体大小和接收等待时间，保留 Origin 校验。JSON 最多 8 MB，PDF 最多 20 MB；Caddy 的请求体限制应与应用支持的上传类型一致。错误响应禁止缓存，HTML 每次重新验证，带内容哈希的构建资源长期缓存；不存在的资源返回 404，避免把 HTML 当成脚本。

会话和检索文件使用唯一临时文件、0600 权限、原子替换及文件和目录同步；检索任务的启动、取消、关闭串行协调，关闭等待最终落盘。后台任务失败保留任务状态和类型日志；重启恢复中断状态，不自动重放模型请求。应用生命周期按逆序释放后台任务和连接池，即使一项清理失败也继续关闭存储。

部署保持单进程，当前会话限流与后台调度不支持多副本共享；增加 worker 需要先设计共享执行和并发控制。请求中间件采用[Starlette 的纯 ASGI 方式](https://starlette.dev/middleware/)，进程关闭时间由[Uvicorn 的 graceful shutdown 设置](https://uvicorn.dev/settings/)控制。

## 验证

```sh
npm test
npm run test:api
npm run build
npm run lint
```

默认后端测试隔离 `DATABASE_URL`，使用临时 JSON 目录；完整 PostgreSQL 测试需要明确设置 `TEST_DATABASE_URL`，会创建并仅删除自己生成的临时数据库，连接用户需具有 `CREATEDB` 权限。在完整仓库中执行：

```sh
TEST_DATABASE_URL='postgresql://测试用户:测试密码@127.0.0.1:测试端口/postgres' \
  uv run --directory backend --locked pytest -q
```

测试需要完整仓库中的 `deploy/` 与 `backend/tools/`。CI 提供独立 PostgreSQL并拒绝跳过数据库测试；部署集成任务使用原生 Uvicorn / Caddy 与一次性数据库，验证健康、上传、缓存、服务重启后的文件保留及数据库断连恢复。完整 `compose.yaml` 仅作为可选兼容验证，不能据其通过宣称原生生产已验收。测试覆盖数据库往返、导入幂等、失败不部分写入、异常请求、配置校验、任务取消恢复及备份恢复边界。AgentScope 测试使用模拟传输，不调用收费服务。

实现参考：[AgentScope 源码与文档](https://github.com/agentscope-ai/agentscope)、[Psycopg 连接池](https://www.psycopg.org/psycopg3/docs/advanced/pool.html)、[Compose 健康依赖](https://docs.docker.com/compose/how-tos/startup-order/)。
