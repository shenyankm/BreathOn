# 架构与部署

## 调用关系

```text
React 页面 / use-voice-session
  └─ /api HTTP + WebSocket
      └─ FastAPI api/app.py
          ├─ voice/：SeedASR / Seeduplex / TTS
          ├─ services/practice.py：会话、转录修正、取消、重试、复盘
          │   └─ agents/coach.py：独立 AgentScope Agent → DeepSeek → 输出校验
          └─ storage/：PostgreSQL（Docker）或 JSON（本地兼容）
```

`main.py` 配置 HTTP 请求日志并创建 ASGI 应用，配置集中在 `core/config.py`。语音接收与智能体推理分离，保持原有流式语音协议；AgentScope 不接管麦克风和上游 WebSocket。每次模型请求创建独立 Agent，业务层显式提供限定长度的当前会话原文；模型与客户端均关闭自动重试，由现有会话层处理重试和取消。

医生/教练通过 AgentScope `LocalSkillLoader` 加载 `backend/medvisit/agents/skills/humanizer/SKILL.md`，在各自的请求中注入完整写作规则。使用 embedded mode，只润色中文措辞；引用原话、医学证据约束、风险提示和 JSON 格式优先，草稿不对外输出。技能随 `medvisit/` 打包进后端镜像，无额外工具调用，也不在运行时下载。原版来自 [blader/humanizer](https://github.com/blader/humanizer/tree/8c307f367c91bd974002f10f2be2965d642c13df)，版本 3.1.0，固定提交 `8c307f367c91bd974002f10f2be2965d642c13df`，保留 MIT 许可证。完整规则会增加每次请求的输入 token；更新时同时替换技能和许可证并运行后端测试。

DeepSeek 适配器显式设置 `context_size=1_000_000`，覆盖通用 OpenAI 适配器的128K默认值，供 AgentScope 上下文管理使用；它不是发送给上游的请求字段。模型容量依据 [DeepSeek 官方模型说明](https://api-docs.deepseek.com/quick_start/pricing/)。业务层仍保留每条4000字符、每次64000字符的转录上限，练习取最近16条、复盘取全部可容纳记录；字符预算不等于 token 容量。默认输出限制2000 tokens，已配置场景的结构化评分最多4000 tokens。

三个医药代表技能按场景注入AgentScope请求：基础拜访技能常驻，研究数据线索补充循证技能，利益交换、个人信息及疑似不良反应等线索补充合规技能。练习以可见记录中最后一条医生与最后一条学员消息分流，复盘扫描全部可见记录；多个场景可同时加载。关键词分流不额外调用模型，可能漏掉未覆盖的隐晦表达，新增词需带路由回归用例。来源取舍见 [技能研究说明](medical-rep-skill-research.md)，真实模型验收见 [指导效果验证](coaching-live-validation.md)。

对话作为单份JSON数据传入，`transcript[].speaker`区分医生与学员，`interaction_events`单独保存采集事件，避免把事件或医生消息误作学员话轮。练习由两个独立Agent并发读取相同原始记录：教练先评价原文再写参考话术，医生不接收生成的教练答案；复盘只调用教练。两个请求共享本次SDK客户端、各自持有独立上下文，取消时一并取消，结束时关闭客户端；usage累加实际调用。使用temperature=0，关闭无关的运行时状态提醒。返回业务JSON字段保持原样，按钮次数和采集结束状态由代码生成，文字语气字段保留“声音语调未评估”，不让模型编造这些采集事实。练习会增加一次上游请求及相应输入用量，并发不代表没有延迟波动。

数据库调用在线程中执行，不阻塞 ASGI 事件循环。连接池随 FastAPI 启停，启动时运行幂等的 `backend/migrations/001_sessions.sql` 和 `002_platform.sql`。`sessions` 以 UUID 为主键，JSONB 保留原有记录格式，`saved_at` 索引用于最近 50 条摘要。摘要不返回对话正文；保存事务提交后才发送 `ended.saved=true`。数据库不可用时返回通用错误，不向客户端暴露连接信息。

当前只有首次建表脚本；后续修改既有字段时新增有版本的迁移，并在部署前执行，不要依赖 `CREATE TABLE IF NOT EXISTS` 修改已有表结构。

## 平台存储与账号访问

`platform/`处理版本化目录、医学审核、校准、点评与重练。Compose复用PostgreSQL连接池和`platform_entities`表；未配置数据库时，演练仍存JSON，平台元数据存`records/platform.sqlite3`（权限0600）。写操作使用事务与版本CAS；PostgreSQL用事务锁，SQLite用`BEGIN IMMEDIATE`及WAL，让读取快照不阻塞其他请求提交，保持`FULL`同步。本地备份应停止API后复制整个记录目录，包含尚未合并的WAL文件。PDF原件作为同一库内的资产保存，单文件20MB、最多200页，只解析文字层，不做OCR；解析在限时子进程内执行。大规模资料库需在实测后迁移对象存储与语义索引。

本机开发默认免登录；公网部署启用按账号区分的 Cookie 会话，HTTP 和 WebSocket 均检查登录，写入继续校验 Origin，详见[服务器与 CI/CD](server-deployment.md)。登录账号可提交、审核共享资料；演练记录、点评、重练、案例和统计仅本人可访问；医学改分仍须有本次有效资料的逐字依据。资料被标记为审核通过不代表已由独立医学专家审核。仅提供本地上传与批量JSON草稿导入。

## 评价与同版本重练

已发布场景绑定医生、量表和审核资料，启动时采集当前医生资料及量表、资料版本；每次推理前后检查资料仍有效。医生资料在同一ID上直接更新，不复制新版本；会话快照保留开始时的医生资料。删除医生会保留删除标记，阻止启动时重新生成默认医生；仍被场景引用时不可删除。检索对中文二元词与英文词做有界词法排序，最多10段，每段1300字。模型评分必须引用实际学员原话和检索片段，代码核对角色、原文、页码及整数分值；独立适用性审核Agent只能撤除缺乏医学依据的评分。未观察记null，全部维度有依据才形成总分。当前评价版本为3。

评分校准保留，用于检验量表与模型的一致性。校准任务需各维度至少5份专家有效标注，工程阈值为MAE≤0.5且相差不超过1档的比例≥90%；合成样本不授予专家校准。后台任务有进度、取消和过期中断状态，重启不自动重放收费请求。真实适用性与阈值仍需专业团队确认。

人工点评可定位原话并单独保存分数调整，原AI结果不覆盖。医学调整必须有本次有效资料的逐字引用。正式审批和申诉入口已删除，已有点评及历史回应继续可读。

记录页集中创建、启动和查看重练。`/remediations/{id}/next`返回明确的`remediation_id`，WebSocket据此锁定原场景、环节和关注维度，并把新记录与原记录关联。只有完整、引用校验通过的演练标记重练完成；前后比较采用同量表指纹、模型与评价版本的原始AI分数，不能比较的项目明确留空。

课程、分配任务、考核次数、认证、榜单/徽章/目标、团队统计和独立资料助手均已删除对应模型、接口与前端页面，不保留功能开关。通用平台存储不做破坏性迁移，历史实体和原始会话保留；旧课程启动参数明确拒绝。

## 医生训练角色

`agents/doctor.py`集中维护“李小英（训练模拟）”的公开专业背景、来源、训练行为和开场白。练习通过独立的`li_xiaoying_doctor` Agent使用该提示；实战的Seeduplex `session_config`复用同一提示。`GET /api/doctor`只返回公开画像，前端据此展示姓名、来源和模拟说明。创建会话时把医生id、画像版本与显示名写入原有JSON/JSONB记录；历史记录未含身份元数据时只显示“医生（历史训练）”，不追溯改名。

画像依据DeepSeek原生Search/Fetch返回的官方资料人工核对后编写，运行时不下载网页，也不把原始网页当系统提示。专业背景与训练设计分开，不推断真人性格、产品态度或处方偏好。来源与真实模型验证见[医生 agent 说明](doctor-agent.md)。

## 网络检索与DeepSeek限流

教练通过AgentScope `FunctionTool`按需调用DeepSeek原生Search/Fetch接口，医生请求不使用搜索。搜索启用时，教练最多3次模型推理、2次网页工具尝试，整体等待上限45秒；关闭时保持单次教练推理、25秒上限。多轮工具调用的模型token用量会累加。普通沟通和已有数字的算术练习不要求联网。

`backend/.env`及`backend/.env.example`中的配置如下；Compose已通过`env_file`读取该文件：

| 变量 | 当前值 | 含义 |
| --- | --- | --- |
| `DEEPSEEK_SEARCH_ENABLED` | `true` | 给教练注册搜索与抓取工具 |
| `DEEPSEEK_MAX_CONCURRENCY` | `2500` | 当前进程所有对话/Agent共享的模型请求信号量；当前Flash标准额度2500，切换Pro时改为500，定制额度按实际配置 |
| `DEEPSEEK_SEARCH_QPS` | `100` | Search请求平滑限速，独立于模型并发 |
| `DEEPSEEK_FETCH_QPS` | `25` | Fetch请求平滑限速，独立于Search及模型并发 |

这些是当前进程的保护上限，不能控制同账号其他应用或其他worker的请求；账号实际超限仍可能收到429。它们不改变本机的2个语音会话上限，也不代表系统已通过2500并发压测。额度依据[模型价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)和[限速说明](https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit/)，搜索/抓取依据[搜索指南](https://api-docs.deepseek.com/zh-cn/guides/search/)。

查询只发送通用公开关键词，不自动发送完整转录；工具拒绝常见手机、身份证、邮箱及密钥模式。Fetch只接受搜索实际返回的公开URL，拒绝本地/内网IP、凭据和敏感查询参数。网页内容是外部数据，不是指令，也不视为经产品医学审核。错误只回传通用状态，取消会关闭本次SDK客户端，不增加自动重试。

`coach.sources`由真实工具结果生成并随现有记录保存，不采用模型自编链接；前端展示“检索来源”，来源日期按浏览器本地时区显示。`usage.search_requests`和`fetch_requests`统计尝试次数，并不等同成功计费次数。运行验证和费用说明见[搜索验收记录](web-search-validation.md)。

## 运行方式

| 场景 | 命令 | 数据存储 |
| --- | --- | --- |
| 本地前端 | `npm run dev -- --host 127.0.0.1` | 通过 Vite 代理 API |
| 本地 API | `npm run dev:api` | `DATABASE_URL` 为空时使用原 JSON |
| Docker | `docker compose up -d --build --wait` | PostgreSQL 命名卷 |

所有命令均从项目根目录执行。Node 依赖与锁文件均归 `frontend/`：从根目录执行 `npm --prefix frontend ci`，或进入 `frontend/` 后执行 `npm ci`。根目录 `package.json` 仅转发开发命令，不声明 workspace，也不安装依赖。Python 使用 `uv sync --directory backend --locked`，依赖声明与锁文件不一致时直接失败，不修改锁文件。

根目录 `.env` 管理数据库用户名、密码、网页端口和允许的 Origin；`backend/.env` 管理模型与语音密钥。Compose 使用 `PGHOST` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` 连接数据库，避免密码中的 URI 特殊字符造成解析错误。密钥、历史数据、虚拟环境及构建缓存都由 `.dockerignore` 排除；前端镜像只含静态构建产物。

修改 `WEB_PORT` 时也要修改 `ALLOWED_ORIGINS`，例如 `http://127.0.0.1:8090,http://localhost:8090`。免登录模式保持绑定本机；公网必须启用登录并使用 HTTPS。API 维持单进程的 2 会话限制；增加 worker 前需先实现共享限流和后台任务执行器。

## 导入旧 JSON

先完成 PostgreSQL 启动，再执行：

```sh
docker compose run --rm --no-deps --user root \
  -v "$PWD/backend/data/sessions:/legacy:ro" \
  api python -m medvisit.storage.import_records /legacy
```

命令先校验全部记录，再在一个事务中导入；保持原文件修改时间对应的列表顺序。UUID 已存在时跳过，不覆盖数据库的新版本。原 JSON 以只读方式挂载并保留在原处；遇到损坏或非法文件会失败，不提交部分记录。单用户模式可读取旧匿名记录、已有记录及关联点评，不更改其归属字段。已有平台资料沿用首次初始化的工作区；其他旧工作区资料和重练保留在原库中，但不会自动合并，避免标识及引用冲突。

本地 API 连接自行管理的 PostgreSQL 时，可在 `backend/.env` 中设置 `DATABASE_URL`，再执行 `uv run --directory backend python -m medvisit.storage.import_records`。连接串中的密码需按 PostgreSQL URI 规则编码。

## 备份与停止

数据库与检索原文需要成套备份。在维护窗口结束演练后运行：

```sh
python3 deploy/backup.py backup /安全目录/medvisit-20261029
python3 deploy/backup.py verify /安全目录/medvisit-20261029
docker compose down
```

数据库和文件卷在普通 `down` 和重新构建后保留；`down -v` 会删除数据。旧版没有文件卷，首次升级前必须从旧容器备份原文，恢复到全新项目验证后再切换，不能先重建旧容器。备份文件含对话正文，应按本地记录同等保护；完整的恢复与回退流程见[运维说明](operations.md)。改变初始化密码环境变量不会自动修改已有数据库角色密码，需用 PostgreSQL 的密码修改命令同步更新。

## 运行探针与故障定位

`GET /api/live` 只检查进程响应；`GET /api/ready` 有限时地检查数据库连接、平台表及文件目录写入，失败返回 503。Compose 通过就绪探针启动依赖服务。`GET /api/health` 保留原有配置摘要；这三个接口都不验证付费供应商可用性，实际服务检测仍由用户点击刷新触发。

HTTP 请求使用独立的请求 ID，在响应头 `X-Request-ID` 与结构化日志中关联。日志只保存方法、路由模板、状态、耗时及异常类型和代码位置，不写入异常原文、请求正文、查询参数或 API Key；验证错误不回显被拒绝的输入。语音会话通过已保存的会话 ID 定位。Nginx 日志使用 URI 路径，不记录查询字符串，容器日志每份最多 10 MB、保留 3 份。

API 在解析前限制实际请求体大小和接收等待时间，保留 Origin 校验。JSON 最多 8 MB，PDF 最多 20 MB；Nginx 的上传上限同步调整，避免默认 1 MB 阻断应用支持的上传。错误响应禁止缓存，HTML 每次重新验证，带内容哈希的构建资源长期缓存；不存在的资源返回 404，避免把 HTML 当成脚本。

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

测试需要仓库中的 `deploy/` 与 `backend/tools/`，仅挂载 tests 到生产镜像不能运行完整套件。CI 自动提供独立 PostgreSQL，并拒绝跳过数据库测试；部署任务使用无密钥的独立 Compose 项目验证健康、上传、缓存及重建后的文件保留。测试覆盖数据库往返、导入幂等、失败不部分写入、异常请求、配置校验、任务取消恢复及备份恢复边界。AgentScope 测试使用模拟传输，不调用收费服务。

实现参考：[AgentScope 源码与文档](https://github.com/agentscope-ai/agentscope)、[Psycopg 连接池](https://www.psycopg.org/psycopg3/docs/advanced/pool.html)、[Compose 健康依赖](https://docs.docker.com/compose/how-tos/startup-order/)。
