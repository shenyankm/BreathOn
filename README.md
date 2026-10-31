# BreathOn

面向医药代表的 Android 学术沟通演练与复盘工具，用户通过账号登录，演练与拜访记录按账号隔离。

- **辅助练习**：医生语音与文字回应，对话中提供实时教练建议。
- **实战练习**：双向语音对话，结束后统一复盘。
- **管理后台**：维护药品、医生、政策、场景和审核资料；审核拜访反馈并查看代表记录。
- **拜访日记**：记录访后观察或导入已获授权的录音，确认脱敏后提交审核。

技术栈规范：

| 范围 | 技术栈 | 职责与当前状态 |
| --- | --- | --- |
| 移动端 | React + Tauri 2 + SQLite | React 使用 TypeScript，Tauri 2 提供原生容器；SQLite 按账号保存上次选择的练习方式 |
| Web 前端 | React + TypeScript | 管理后台界面，通过 HTTP / WebSocket 访问服务端 |
| 服务端（Web 与移动端共用） | Python + FastAPI + AgentScope + PostgreSQL（pgsql） | 业务 API、权限、AI 编排与服务端数据存储 |

Vite 和 shadcn/ui Maia 分别用于前端构建与 UI。服务器原生运行 FastAPI（systemd）与 Caddy，只有 PostgreSQL 使用 Docker。后端本地开发保留 JSON / SQLite 兼容存储，与移动端 SQLite 分属不同运行环境。完整边界见[架构与部署](docs/architecture.md)。

Android 客户端使用 Tauri 2，构建、USB 调试和签名见 [Android 打包](docs/android.md)。用户界面内置于 APK，Web 只提供管理后台；后端仍由服务器运行。

| 部分 | 部署与职责 |
| --- | --- |
| Android App | React 页面由 Tauri 2 打包；底栏为「练习、学习、我的」，日记与复盘位于「我的」 |
| Web 管理端 | Caddy 提供 `/admin` 静态构建产物；管理员维护共享训练内容和审核记录，不提供 Web 用户端 |
| 后端服务 | FastAPI 由 `medvisit-coach.service` 原生运行，Caddy 代理同源 API / WebSocket；校验登录、管理员权限及记录归属 |
| 数据库 | PostgreSQL 使用独立 Docker Compose 配置；API 与 Web 管理端不运行在容器中 |

`main` 的原生自动部署在 CI 检查通过后执行，接收同一提交的后端源码与已构建的管理端静态文件；服务器不再构建 API / Web 镜像。首次迁移、部署及回退方式见[服务器与 CI/CD](docs/server-deployment.md)。

## 本地运行

需要 Node.js 22.12+ 和 [uv](https://docs.astral.sh/uv/getting-started/installation/)。在项目根目录执行：

```sh
npm --prefix frontend ci
cp -n backend/.env.example backend/.env
```

编辑 `backend/.env`，按需填写密钥；已有配置不要覆盖。

| 用途 | 配置 |
| --- | --- |
| 两种模式的语音识别与 AI 分析 | `SEEDASR_API_KEY`、`DEEPSEEK_API_KEY` |
| 练习模式的医生朗读 | `DOUBAO_TTS_API_KEY` |
| 实战模式的语音对话 | `DOUBAO_API_KEY` |

默认模型、音色及资源要求见 [`backend/.env.example`](backend/.env.example)。密钥仅由后端读取，不要使用 `VITE_` 前缀或提交 `.env`。

Web 本机开发默认免登录。Android 用户端始终要求服务器启用账号登录；服务器关闭登录时，App 会拒绝进入用户页面。启用登录时，运行 `uv run --directory backend python -m medvisit.api.auth` 生成密码哈希，在 `backend/.env` 设置 `AUTH_REQUIRED=true`、`ADMIN_USERNAME` 和 `ADMIN_PASSWORD_HASH`。多账号使用 `LOGIN_USERS_JSON` 配置“账号 → 密码哈希”对象，`ADMIN_USERS_JSON` 配置管理员账号列表；不提供公开注册。

在两个终端分别启动：

```sh
# 终端 1：后端
npm run dev:api

# 终端 2：前端
npm run dev -- --host 127.0.0.1
```

管理员打开 <http://127.0.0.1:5173/admin>；代表端仅在 Android 客户端提供，不再提供 Web `/app` 页面。未配置密钥也可浏览后台；语音演练需要对应服务权限和麦克风。修改密钥后重启后端。

## 服务器运行与可选隔离验证

生产只将 PostgreSQL 放入 Docker，数据库配置使用 `deploy/database.compose.yaml`；API 由 systemd 管理，Web 管理端由 Caddy 提供。请按[服务器与 CI/CD](docs/server-deployment.md)完成首次原生迁移，升级前按[运维说明](docs/operations.md)备份数据库与检索原文。

旧 `compose.yaml` 的完整 API / Web / 数据库组合仅保留作一次性兼容验证，不作为生产启动方式。需要检查旧组合时，在无真实数据和服务密钥的独立项目执行：

```sh
COMPOSE_PROJECT_NAME=medvisit-disposable BACKEND_ENV_FILE=/dev/null \
  POSTGRES_PASSWORD=ci-only-password AUTH_REQUIRED=false WEB_PORT=18080 \
  ALLOWED_ORIGINS=http://127.0.0.1:18080 docker compose up -d --build --wait
```

该验证页面仅绑定本机 <http://127.0.0.1:18080>。不要对需要保留的数据执行 `docker compose down -v`；生产备份和恢复以原生部署接口为准。

## 验证

```sh
npm test
npm run test:api
npm run lint
npm run build
npm run build:android
```

CI 还会运行真实 PostgreSQL 回归、Android ARM64 APK 编译，以及原生 Uvicorn / Caddy 与 Docker PostgreSQL 的集成、重启持久化、数据库故障恢复和账号隔离检查。模拟测试不调用收费服务；真实服务与麦克风、外放效果需单独验收。

## 使用边界

- 代表之间的记录隔离，管理员可查看所有代表的演练及拜访记录并留下访问审计。本机免登录模式不可对外开放。公网部署须启用登录并使用 HTTPS，配置见[服务器与 CI/CD](docs/server-deployment.md)。
- 演练音频和文本会发送给配置的语音、模型服务。拜访录音及未脱敏转写按私有数据处理；录音保存在独立私有目录，首次确认后 7 天且不超过上传后 30 天清理，`visit-audio` 目录不纳入长期备份。请勿输入未经授权的患者信息。
- 模型输出需专业复核；语气分析仅覆盖措辞，不代表声音语调或情绪评估。资料来源核对不等于医学审核。

## 文档

- [使用手册](docs/user-manual.md)：配置、演练与常见问题
- [架构与部署](docs/architecture.md)：目录结构、存储与测试
- [Agent 可靠性与评分校准](docs/agent-reliability.md)：失败处理、指标、评测与待决事项
- [部署运维](docs/operations.md)：备份、恢复、升级与排查
- [检索助手](docs/research-agents.md) · [药品资料库](docs/drug-library.md) · [医生角色](docs/doctor-agent.md)
- [训练交付记录](docs/training-delivery.md)：验收范围与已知限制
- [医学 Wiki](docs/medical-wiki.md)：产品知识条目、来源缺口、导入与逐句核验

## 贡献与许可

提交改动前请阅读[贡献指南](CONTRIBUTING.md)。问题与功能建议使用仓库的 Issue 模板，PR 请填写验证结果。

原创代码与文档采用 [MIT License](LICENSE)。第三方依赖、技能及医学资料保留各自权利与许可，见[第三方声明](THIRD_PARTY_NOTICES.md)。
