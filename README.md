# 医访练 · MedVisit Coach

医药代表学术沟通演练与复盘工具。React / Vite / shadcn/ui Maia + FastAPI + AgentScope，支持 PostgreSQL 和 Docker Compose 部署。

日常操作、首次配置与常见问题见[使用手册](docs/user-manual.md)。

| 入口 | 能力 | 服务 |
| --- | --- | --- |
| 练习模式 | 口述回答、实时转录、医生语音与文字追问、实时教练 | SeedASR + DeepSeek Flash + 豆包 TTS 2.0 |
| 实战模式 | 双向语音、自然打断、静音，结束后统一 AI 复盘 | Seeduplex + SeedASR + DeepSeek Flash |

练习模式由 SeedASR 转写语音，VAD 停顿形成完整发言后，由 DeepSeek Flash 结合对话生成医生文字回应和教练建议（关注点、回答观察、回应顺序、参考话术及核实风险）。医生开场白和后续回复由豆包双向流式 TTS 朗读，教练内容不朗读。TTS 使用云舟 2.0 音色和 24 kHz 单声道 PCM，按播放速度发送，避免浏览器积压。新发言或转录修正会取消过时的生成任务与朗读，重复识别快照不会重复回复。生成失败可重试，语音识别仍继续。

默认打开演练入口，优先推荐已发布的首访场景，核对资料后可直接点击「开始练习」。默认带教练练习；演练方式可展开切换为独立练习或实战演练，训练环节与资料依据按需展开。桌面左侧导航突出「开始演练、复盘记录、学习资料」，「训练管理、服务设置」放在底部；手机改用菜单。切换页面不会中断当前演练。复盘页先显示最近 50 次记录和待重练项，训练变化与服务用量折叠在记录之后；重练自动沿用原场景、环节及演练方式。偏好用于下一次演练，保留在当前页面内存中；服务检测仅由手动刷新触发，并保留上次结果。

学习资料分为药品文档、医药代表技能、医生医院文档、政策文档。药品文档按信达生物官网清单补齐 20 款上市产品，卡片展示图片、通用名、商品名及“概述 / 详细文档”入口；概述在当前页预览，原文在新标签页打开，特殊资料类型明确标注，来源与版本说明见[药品资料库](docs/drug-library.md)。医药代表技能收录钰兔科技《优秀医药代表必备知识与技能》（2022-02-24），提供本地要点导览和外部原文链接，作为培训参考。政策文档支持发布层级和 8 个主题分类联合筛选、匹配数量与一键清除；国家、省、市、区县分别列出，医院院内制度单列，转载按原发布机关分级。卡片等宽等高并标注来源、实施时间、适用范围与原文链接；医生医院分类显示空状态。

「训练管理 → 内容准备 → 资料检索」提供政策、医生公开资料、同类药品三个 AgentScope 助手，分别配置 Skill，共用项目内 STDIO MCP。点击检索后保存原始 HTML/PDF/Word、HTML 阅读副本、文件版本与真实引文；支持显式开启每日重搜和来源复查，访问失败保留旧版，结果核对后再用于训练。配置、用量边界、接口和真实验收见[检索助手说明](docs/research-agents.md)。

两种模式使用同一模型、同一教练分析标准（语气措辞、连贯性、逻辑、轮次与插话），不区分基础或进阶模型。实战期间不调用分析模型：麦克风音频同时发给 Seeduplex 实时对话和 SeedASR 转录，学员原文以 SeedASR 为准，医生文字来自 Seeduplex。停止后等待两路最终事件，再由 DeepSeek 统一复盘；分析和原文一同保存。独立练习保留医生语音与文字回复，隐藏实时教练建议。未绑定场景时不评分；选择已发布场景后，使用已审核资料检索与版本化量表评价。模型生成内容仍需专业复核。

语气分析目前仅覆盖措辞，不代表声音语调或情绪评估。后台只记录每个识别片段的时长、采集音量和客户端播放重叠等摘要，不保存原始音频。设备增益、回声、ASR 分句和播放排队均有局限：重叠不等同于插话，分句间隔不等同于犹豫；证据不足时模型须明确说明。真正的声音语调评估仍需音频理解模型。

## 演练与复盘

主线是选择场景、与医生演练、查看有原话和资料依据的复盘，再按薄弱点重练。

- 「训练管理」按训练内容、内容准备、使用成本分组，维护医生角色、训练场景、审核资料和评分标准。资料支持正文/PDF及本地JSON导入、审核、版本与失效检查；分享和批量导入入口位于列表之后。
- 「AI 生成拜访场景」依据选定资料、医生和目标生成可编辑草稿，覆盖首访、复访、时间紧张和证据质疑；保留来源版本、引文、模型用量和生成耗时，核对后手动发布。
- 医生资料直接编辑覆盖同一条记录，已发布医生保存后保持发布状态，不再复制新版本。医生支持删除；仍被场景引用时会阻止删除，历史演练快照保留。
- 「复盘记录」保存原话、引用页码、原始AI评价与人工点评，可建立同版本重练；待重练入口与前后对比集中在记录页。
- 从记录中选择学员原话可提炼经验案例，编辑并确认边界后用于新场景。案例及完整场景模板支持 JSON 导出导入；外来素材进入草稿，重新核对资料和发布，不继承审核或专家校准状态。
- 在复盘记录中展开「查看训练变化与服务用量」，按相同医生、场景、资料、环节、模式和评价版本比较反馈，显示次数、已记录时长及服务用量。计价依据按次保存快照，币种分别累计，缺失用量或价格明确显示未完整计价。
- 单用户无需登录；医学引用核对和专家校准继续保留。资料不足或未观察项不算零分；模型输出仍需专业复核。

课程任务、考核认证、目标徽章/排行榜、团队趋势看板及正式申诉/成绩审批流程已移除。旧记录与元数据保留；旧课程链接不能作为普通演练继续启动。训练范围保持核心闭环和 P1，P2 不实现；三个检索助手为后续明确追加的资料准备能力。操作步骤及测试、真实服务结果见 [训练交付记录](docs/training-delivery.md)，此前精简记录见 [功能验收](docs/platform-completion.md)。

## 项目结构

```text
medvisit-coach/
├── frontend/                  # React 应用，独立管理 Node 依赖
│   ├── src/
│   │   ├── assets/library/     # 随构建发布的药品资料
│   │   ├── components/        # 复用业务组件与 ui/ 基础组件
│   │   ├── hooks/             # 会话 Hook
│   │   ├── lib/               # 转录及 audio/ 浏览器音频
│   │   ├── pages/             # 文档库、记录等页面
│   │   └── styles/            # 全局样式
│   ├── public/                # 无需打包处理的静态资源
│   ├── tests/                 # 前端逻辑测试
│   ├── package.json           # 前端依赖及构建脚本
│   └── package-lock.json      # 前端依赖锁文件
├── backend/
│   ├── medvisit/
│   │   ├── api/               # HTTP / WebSocket 接口和应用生命周期
│   │   ├── agents/            # AgentScope 医生与教练、提示词、输出校验
│   │   ├── core/              # 环境配置
│   │   ├── research/          # 政策、医生与药品检索、MCP、原文归档及追踪
│   │   ├── services/          # 练习与复盘会话编排
│   │   ├── storage/           # PostgreSQL、JSON 兼容存储及导入命令
│   │   ├── voice/             # ASR、TTS、语音协议与采集证据
│   │   └── main.py            # ASGI 入口
│   ├── migrations/            # 数据库建表脚本
│   ├── tests/                 # 后端测试及 PostgreSQL 集成测试
│   ├── data/                  # 既有本地记录，不提交、不打入镜像
│   └── pyproject.toml         # Python 依赖，uv.lock 锁定版本
├── deploy/                    # Dockerfile 与 Nginx 代理配置
├── docs/                      # 架构与部署说明
├── compose.yaml               # web + api + db
└── package.json               # 统一开发命令，不安装 Node 依赖
```

页面放在 `frontend/src/pages/`，复用组件放在 `components/`，通用 UI 保留 `components/ui/`；业务资料属于 `assets/library/`，项目说明属于 `docs/`。前端与后端各自维护依赖，根目录保留统一命令。详细调用关系与部署步骤见 [架构与部署](docs/architecture.md)。

## 本地运行

需要 Node.js 22+ 和 [uv](https://docs.astral.sh/uv/getting-started/installation/)。在项目根目录执行以下命令；npm 依赖安装在 `frontend/node_modules/`，uv 按 `backend/uv.lock` 安装 Python 环境和依赖。

```sh
npm --prefix frontend ci
cp backend/.env.example backend/.env
```

将所需配置填入 `backend/.env`：

- 两种模式共用：`SEEDASR_API_KEY`、`DEEPSEEK_API_KEY`，`DEEPSEEK_MODEL` 默认为 `deepseek-flash`。
- 练习模式额外配置：`DOUBAO_TTS_API_KEY`，`DOUBAO_TTS_VOICE` 默认为 `zh_male_m191_uranus_bigtts`（云舟 2.0），使用 `seed-tts-2.0` 资源。
- 实战模式额外配置：`DOUBAO_API_KEY`，可选 `DOUBAO_VOICE`。

只使用一个模式时可仅填写对应配置。密钥仅由后端读取，不要使用 `VITE_` 前缀，不要提交 `.env`。

```sh
# 终端 1
npm run dev:api
# 终端 2
npm run dev -- --host 127.0.0.1
```

打开 http://127.0.0.1:5173 ，无需注册或登录。确认推荐场景后点击「开始练习」；需要调整时再展开演练方式或训练环节。尚无已发布场景时可先做不评分的自由沟通练习。推荐桌面 Chrome；麦克风需要 localhost 或 HTTPS。Vite 将 `/api`（包括 WebSocket）代理至 `127.0.0.1:8000`。修改密钥后重启后端。

未配置密钥时仍可启动页面和后端；演练开始前会检查配置并给出提示，不申请麦克风。

## Docker 部署

已有部署升级前，先按[运维说明](docs/operations.md)完整备份数据库和检索原文。首次增加文件持久卷时，必须在重建旧 API 容器之前导出其容器内文件，再恢复到新项目验证；直接重建会丢失旧容器可写层中的原文。

```sh
cp .env.example .env
# 将根目录 .env 中的 POSTGRES_PASSWORD 换成长随机密码。
# 语音与模型密钥仍填在 backend/.env。
docker compose up -d --build --wait
```

打开 http://127.0.0.1:8080 。Nginx 提供前端并代理 `/api/` 的 HTTP 与 WebSocket；API 与 PostgreSQL 仅在容器网络中可见，Web 端口默认只绑定本机。Compose 等待数据库、API 健康后启动前端。`docker compose down` 停止服务且保留数据库卷；不要对需要保留的数据执行 `down -v`。

Compose 自动启用 PostgreSQL，首次启动创建 `sessions` 与 `platform_entities` 表。未设置 `DATABASE_URL` 的本地开发仍读取原有 JSON，不会自动迁移或删除文件。旧记录导入、备份与测试命令见 [架构与部署](docs/architecture.md)。

部署使用单个非 root API 进程，数据库和原文分别保存到命名卷，容器日志按大小轮转。`/api/live` 检查进程响应，`/api/ready` 检查数据库、平台表和原文目录写入；均不调用收费服务。HTTP 响应附带 `X-Request-ID`，请求日志保留请求 ID、路由模板、状态与耗时，不记录请求正文或查询参数。配置在启动时校验，数据库不可用时就绪探针返回 503，失败写入不会被报告为保存成功。

CI 使用锁文件安装依赖，检查前端测试、构建、lint、真实 PostgreSQL 回归及独立 Compose 冒烟。备份脚本同时保存数据库和原文，校验哈希后才发布备份，恢复只允许全新项目；升级、排查、恢复与回退步骤见[单用户部署运维](docs/operations.md)。

## 数据与运行边界

- 后端仅绑定本机，WebSocket 校验允许的 Origin；默认单进程最多 2 个会话，每次最多 10 分钟。握手、发送、结束等待均有限时，断开后清理上游连接和麦克风。
- 浏览器采集单声道 PCM int16 LE / 16 kHz / 20 ms。两种模式都向 SeedASR 发送 200 ms 二进制 gzip 包；实战同时向 Seeduplex 发送官方 JSON 事件，并播放 24 kHz PCM 回复。
- 结束或断线后，医生与学员文字转录、教练建议及其对应发言、完成状态、可用用量信息在 Docker 中保存到 PostgreSQL 的 `sessions` 表（JSONB）；未设置 `DATABASE_URL` 时保存到 `backend/data/sessions/<UUID>.json`（文件权限 0600）。不保存原始音频；音频会发送给所选火山语音服务。练习按 ASR 分句标识替换修正文本，约 1.5 秒停顿后触发医生/教练；文本生成最多每 3 秒发起一次，25 秒超时。练习发送最近 16 条对话；实战复盘发送整场记录，最多 64000 字符，单条最多 4000 字符。截断或未完整结束时明确标记复盘不完整。模型调用最多 25 秒；实战结束期间页面等待最终转录与分析，最迟 45 秒关闭连接。
- `GET /api/health` 返回语音、统一分析、完整练习和实战链路的配置状态；`GET /api/sessions` 返回最近 50 条记录摘要，`GET /api/sessions/{UUID}` 查看本地记录。复盘显示保存确认链接；异常退出时可能只有部分转录，记录中的 `final` 和 `status` 表示是否完成。
- 单用户模式没有登录和角色隔离；HTTP 写入与 WebSocket 仍校验 Origin。服务仅供本机使用，不要暴露到公网或共享网络。旧演练记录和关联点评仍可查看；已有平台配置沿用首次初始化的工作区。其他工作区的资料和重练不会自动合并，原数据不会删除。
- 自由沟通练习使用“李小英（训练模拟）”：依据中山医院内分泌科李小英教授的公开专业资料构建，不代表本人、真实诊疗意见或产品背书；已发布场景使用绑定的医生角色。公开背景、来源和训练设计在“场景说明”中分别展示，详见[医生 agent 说明](docs/doctor-agent.md)。请勿输入真实患者信息。模型输出尚未经医学审核。文档库保留的 `frontend/src/assets/library/S5LGV8EM_SMS_24mg.pdf` 修订日期含占位文本；本轮训练基线另行采用经来源核对的厂家官网说明书，使用虚构医生，核对范围与医学审核状态见[交付记录](docs/training-delivery.md)。

## 接口

前端与后端使用同源 WebSocket：`/api/realtime?experience=practice` 或 `experience=combat`。

```json
{"type":"start","mode":"assisted"}
{"type":"audio","audio":"base64 编码的 640 字节 PCM"}
{"type":"mute","muted":true}
{"type":"interrupt"}
{"type":"retry"}
{"type":"stop"}
```

先发 `start`，收到 `ready` 后才发实时音频。`mode` 为 `assisted` 或 `independent`；`interrupt` 仅用于实战；`retry` 仅用于练习中失败的医生/教练回复；`retry_speech` 仅重试失败的医生朗读，不重新生成文字或教练建议。客户端不能覆盖医生提示词或传入上游地址。下行事件为 `ready`、`transcript`、`audio`（练习 TTS / 实战语音）、`muted`、`user_started`、`response_started`、`interrupted`、`practice_turn`（医生文字与对应教练建议，原子发布）、`practice_state`（listening/thinking/error）、`coaching`（结束后的整场分析，已配置场景的两种模式共用）、`tts_state`（speaking/done/error）、`notice`、`error`、`ended`。`transcript.final=true` 为最终修正文，练习中 `replace=true` 的部分结果也需整体替换。`ended.saved=true` 后才可读取保存记录；`saved=false,recovery_saved=true` 表示 PostgreSQL 写入失败但本机恢复副本已落盘，恢复方式见[运维说明](docs/operations.md)。收到服务错误后，页面保留原话并最多等待 60 秒接收最终保存确认，未确认时明确提示。

## 验证

2026-10-29 的 17 轮性能与稳定性修复、测量范围及完整验证结果见[优化审查记录](docs/optimization-review-2026-10-29.md)。

2026-10-30 继续完成的 20 轮性能优化，逐轮操作量、微基准和 PostgreSQL 验证见[性能优化记录](docs/performance-20-rounds-2026-10-30.md)。

2026-10-30 的启动关闭、锁文件一致性、备份恢复与文档解析修复见[工程稳定性记录](docs/engineering-stability-2026-10-30.md)。

随后对重复取消、历史数据损坏、原件完整性与前端恢复的全面复查见[稳定性与恢复复查](docs/stability-recovery-review-2026-10-30.md)。

```sh
npm test
npm run test:api
npm run build
npm run lint
```

测试包含 PCM 分帧、静音与设备清理、流式转录修正、协议校验、模拟上游连接、静音/打断/停止、医生文字与教练生成、TTS 协议与 PCM 播放节奏、朗读失败重试、过时任务取消、重复分句去重、失败重试、结构化输出校验和记录落盘。模拟测试不消耗真实服务额度。真实服务需要配置权限后单独验收；真人麦克风、外放回声和听感也需单独检查。

接入依据：[SeedASR 模型](https://console.volcengine.com/ark/region:cn-beijing/model/detail?name=seedasr-streaming)、[流式 ASR 协议](https://docs.volcengine.com/docs/doubao-voice/large-model-streaming-automatic-speech-recognition-api-1?lang=zh)、[Seeduplex 协议](https://docs.volcengine.com/docs/doubao-voice/end-to-end-real-time-voice-full-duplex-version?lang=zh)。ASR 使用 `bigmodel_async` 和 `volc.seedasr.sauc.duration`；Seeduplex 使用 `1.2.6.1`。

文本生成由 AgentScope 2 的独立 `Agent` 调用 DeepSeek：练习中的医生与教练并发读取相同原始记录，各自持有独立上下文；医生不接收生成的教练话术。医生单次推理，教练可按需使用 DeepSeek Search/Fetch，不共享其他会话的记忆；应用继续控制转录修正、取消与重试。依赖由 `backend/uv.lock` 锁定。文本生成依据：[DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion/)、[JSON Output](https://api-docs.deepseek.com/guides/json_mode)。使用 `deepseek-flash`、JSON Object 与 `thinking=disabled`；练习分别生成医生和教练，实战仅在结束后生成教练复盘。

练习医生朗读依据：[双向流式语音合成 WebSocket](https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-text-to-speech-websocket?lang=zh)。每轮独立连接、唯一合成会话 ID，同一次练习共用语音上下文 ID。朗读失败保留文字和教练建议，支持单独重试；结束练习会取消合成并清理播放。不保存合成音频，记录仅保存朗读状态与可用用量。
