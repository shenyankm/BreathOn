# TypeScript / Pi 迁移

后端默认入口已改为 `backend/src/main.ts`，生产入口为编译后的 `backend/dist/main.js`。业务 API、存储、Agent、公开检索、实时语音、后台任务及恢复路径均由 TypeScript 实现。`backend/parsers/` 保留两个无应用凭据的 Python 文档解析进程；仓库中的 Python 部署验收及备份工具仍属于独立运维工具。

## 本机切换

```sh
npm --prefix backend ci
uv sync --directory backend --locked
npm run build:api
npm run dev:api
```

配置沿用 `backend/.env`。密码哈希与既有数据库兼容；不需要清空数据库或复制业务记录。Node 版本建议与 CI 一致使用 24。系统须提供 ffprobe / ffmpeg，Linux DOC 解析另需 antiword。

Pi 使用固定版本官方 SDK，再注册当前业务需要的工具、角色、预算与输出校验。没有复制 CLI 或维护上游核心 fork。Skills、医学资料及其许可证迁至 `backend/resources/`，旧 Python 实现、测试和历史工具已移出当前源码；需要历史对照时查看 [迁移前版本](https://github.com/shenyankm/BreathOn/tree/0786e225848635de55c2c3a827bb8bd4429818de/backend/).

## 服务器切换

自动生产部署保持关闭，本轮源码修改不会自动改变线上服务。

第一次从 Python 服务切到 Node 服务须在维护窗口手动完成：保留旧 release、旧 systemd 单元与 Caddy 配置；停止服务后验证数据库和记录目录的一致性备份；安装 Node.js 24、npm、文档解析运行时与锁定依赖，准备 Node release 和 Web 工件；安装新的 `deploy/medvisit-coach.service`，执行 daemon-reload 后启动并核对认证、记录、原件、WebSocket 与就绪状态。没有 schema 变更，不应重建数据卷。

`deploy/native-deploy.sh` 当前只接收 Node release，并要求上一版也有 `backend/dist/main.js`，避免把首次跨运行时迁移误当作普通自动升级。受限部署入口由管理员安装，不会被源码上传自动替换。后续 Node release 仍保留文件锁、备份、原子切换与失败回退。

首次迁移失败时，应停止新服务，恢复旧 release 链接及保留的旧 systemd 单元，daemon-reload 后启动旧服务；不要只恢复链接却沿用 Node 专用 ExecStart。数据库和私有目录保持原位。

医学 Wiki 维护入口为 `npm --prefix backend run medical:ingest`，支持原件刷新、竞品或演示包清单、可选 OCR 与 Pi 编译。历史基准脚本和旧 Python 专用评测不进入当前运行时；新研究发现由管理端检索流程处理。

## 验证边界

新后端测试包含 HTTP 路由契约、认证与隔离、事务冲突、文件保全、Pi 实际工具循环、取消与用量、医学凭据撤回、研究检查点恢复和真实 WebSocket 协议。浏览器测试继续使用原有管理流程。历史 Python 测试数量不作为新运行时的验收数量。

真实模型、真实搜索、线上切换和 Android / 设备验收仍须分别记录。测试中的合成模型与语音服务不代表付费供应商兼容性或医学准确率。

## 本轮本地验证（2026-11-05）

- TypeScript 编译通过，启用 strict 与未使用代码检查；101 份输入 schema 均可编译，105 个既有 HTTP 接口及实时端点已注册。
- 后端 23 项通过、无跳过；包括 Node.js 24.22.2 容器与真实隔离 PostgreSQL、Pi 工具循环、实际 STDIO MCP、模拟供应商的练习与实战 WebSocket 链路、文件保全和恢复。
- 前端 192 项通过；管理端构建与 lint 通过，lint 仍有既有警告。浏览器 15 项通过、6 项跳过（5 项真实供应商、1 项 Android CDP）。
- 原生 Node / Caddy 的进程重启、PostgreSQL 断连恢复、登录与记录隔离冒烟通过。Docker 镜像构建通过；UID 10001、只读文件系统、无网络下就绪服务正常，实际解析 67 页 PDF。
- 运行依赖 npm audit 未发现已知漏洞。未运行远程 CI、真实模型/搜索/语音和 Android 设备验收，未对生产数据库副本完成全业务验收，未部署线上。
