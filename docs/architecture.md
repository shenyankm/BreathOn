# 架构与部署

当前源码采用 TypeScript 全栈：React / Vite 管理端、React / Tauri 2 Android 用户端，以及 Node.js / Fastify 后端。Agent 运行在 Pi SDK 上，生产 Python 子进程仅用于 PDF / Word 文档解析。旧 Python 业务实现、测试和历史工具已移出当前源码，仍可从 Git 历史回溯。线上切换仍需单独执行和验收，见[迁移说明](typescript-pi-migration.md)。

## 请求与数据流

```text
React 管理端 / Tauri Android
  → 同源 /api HTTP 与 WebSocket
  → backend/src/app.ts：认证、Origin、请求边界、路由
    ├─ catalog / platform / operations：目录、审核、课程、案例、重练、校准
    ├─ sessions / live / voice-protocol：实时识别、医生对话、语音与复盘
    ├─ agents：Pi Agent / Pi AI → DeepSeek，限定工具与调用预算
    ├─ research / archive：公开资料搜索、不可变原件、版本与任务恢复
    ├─ medical：审核凭据、逐句核验、独立复核与引用校验
    ├─ store：PostgreSQL；本机兼容 SQLite + JSON
    └─ documents → 无应用凭据的 Python 文档解析子进程
```

Android 只包含「练习、记录、设置」。APK 内置用户页面，密钥由服务器保存。Caddy 提供 Web 管理后台，`/app` 返回 410，`/_android/` 返回 404；APK 的 WebViewAssetLoader 在本地提供 Android 资源。后端继续使用原有 HTTP 路径、JSON 字段及实时语音事件，契约基线在 `backend/resources/api-contract.json`。

## Agent 与语音

使用固定版本 `@earendil-works/pi-agent-core` 和 `@earendil-works/pi-ai`，通过组合和受限业务工具完成定制。Pi 不获得 Bash、任意文件读写、数据库或系统管理工具。

每次医生与教练请求建立独立 Agent；二者并发读取同一份学员原始记录。医生不接收教练生成内容或教练专用参考资料，完整 JSON 和当前资料版本校验通过后即可启动朗读，教练完成后关联补发。ASR 修正、取消或退出会取消旧推理及旧语音。

技能位于 `backend/resources/skills/`。完整 Markdown 按角色和场景显式加载，保留来源及许可证；不得用技能覆盖原话引用、医学证据或结构化输出规则。单次普通轮次最多读取最近 16 条、每条 4000 字符、总计 64000 字符；整场复盘使用相同字符边界。模型上下文容量声明为 1,000,000 tokens，不等于业务字符预算。

教练最多 3 轮推理、2 次 Search/Fetch，医生最多 1 轮。模型 SDK 自动重试关闭；应用仅对可恢复状态或连接失败重试一次，客户端超时和取消不重试。已知用量累加，未完整返回的调用保持不完整标记。更多约定见[Agent 可靠性](agent-reliability.md)。

实时语音仍使用 SeedASR、豆包 TTS 2.0 和 Seeduplex 原有协议。客户端只可发送 20ms / 640 字节 PCM 帧，分别限制音频及控制消息速率。麦克风原始音频不进入练习记录，语调保持“未评估”；播放重叠不能证明学员插话。

## 存储与认证

`backend/migrations/001_sessions.sql` 与 `002_platform.sql` 沿用既有表，不迁移或清空用户数据。PostgreSQL 使用连接池及按工作区的事务锁；本机 SQLite 保持 WAL、FULL 同步与 CAS 版本更新。写事务提交后才能确认保存成功。

scrypt 密码哈希、账号环境变量和 Cookie 名保持兼容。服务端仅保存随机会话令牌的摘要；会话最长 8 小时，Cookie 为 HttpOnly / SameSite=Strict，公网使用 Secure。退出撤销令牌，重启清空会话。登录验证串行且每分钟最多 10 次。API 和 WebSocket 验证登录，写入校验完整 Origin；管理员访问代表记录保留审计。

`RECORDS_DIR` 保存归档、检查点和恢复文件。文件采用私有权限、临时文件、同步落盘与原子替换。数据库保存失败后尝试写入 `recovery/`，仅在副本确实写入后报告 `recovery_saved=true`。恢复导入使用 TypeScript CLI，详见[运维说明](operations.md)。

API 启动及运行期间每 30 秒收尾遗留检查点和恢复副本，跳过仍在执行或结束中的会话。未完成检查点按文件最后修改时间归档为中断记录，不重放模型、语音或评分；已有正式记录优先，不用旧检查点覆盖。练习保存和重训计划完成分别确认：收尾失败保留恢复文件，成功后才清理副本。启动时还会补齐历史有效练习遗漏的重训完成标记；重复收尾不改写已完成计划。

重训创建、HTTP 下一步、WebSocket 启动及结果比较共用训练指纹：场景和医生版本、量表 ID 与维度内容、资料版本与哈希、药品及政策版本。量表的校准标记和管理版本不改变训练条件；环节、模式、评分模型及评价器另行比较。医生朗读重试返回 `retry_speech_result` 接受或拒绝确认，客户端仅在收到 `tts_state=speaking` 后进入朗读状态。

拜访录音及原始转写在独立私有目录保存。上传经 ffprobe 校验，转码仅使用受限协议的 ffmpeg；第三方取音频使用短期随机令牌及固定任务 ID。提交响应不确定时仅查询原任务，不重复提交付费转写。保留期限仍为上传后 30 天或确认后 7 天中较早者。

## 证据与后台任务

原话、学员角色、引用片段、来源版本和页码由业务代码核验；缺依据记 null，不让模型自行批准医学内容或计算最终总分。医学核验先检索当前有效审核原文，再执行逐句核验及独立适用性复核；审核撤回或来源变化后旧结论失效。公开搜索结果与 Wiki 摘要不能直接代替审核证据。

公开检索保留原件、SHA-256、HTML 阅读副本、搜索记录、实际返回的 evidence_id 和模型用量。下载固定已验证的公网地址并保留 Host / TLS SNI，逐跳验证重定向，禁止私网、任意端口和凭据 URL。文档解析使用超时、大小、页数与资源限制，并且不继承应用密钥。

研究与校准任务由进程内工作器执行；关闭时取消并排空，再关闭存储。研究检查点可在重新核验后恢复收尾，未完成的付费模型调用不自动重放。每日追踪只对使用者明确启用的主题执行。

当前任务执行器由单个 API 进程持有。活跃校准执行器不会因租约到期被判为中断；租约用于清理没有执行器的残留状态。启动时将遗留的执行中任务收尾为中断、取消中任务收尾为已取消；周期恢复及列表、详情使用相同规则。没有执行器的取消请求立即终结，终态不接受迟到结果覆盖。

## 构建与验证

需要 Node.js 24、Python 3.12+（仅文档解析）、ffmpeg / ffprobe，Linux 读取 DOC 另需 antiword。前后端各自使用 npm 锁文件，文档解析单独使用 uv 锁文件。

```sh
npm --prefix backend ci
uv sync --directory backend --locked
npm run dev:api
npm run build:api
npm run test:api
npm --prefix frontend test
npm --prefix frontend run test:e2e
```

设置 `TEST_DATABASE_URL` 后，后端测试会在指定回环 PostgreSQL 上创建并清理自己的临时数据库。`deploy/check-native.py` 是运维验收脚本，启动编译后的 Node 服务和 Caddy，检查重启、数据库断连恢复及账号隔离，不启动 Python 业务服务。

自动生产部署仍关闭。测试、模拟供应商、浏览器验收、真实模型、Android 安装、真实麦克风和医学专家校准是不同证据层，不能互相替代。
