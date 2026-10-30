# Medcoach

面向医药代表的学术沟通演练与复盘工具，支持语音对话、场景训练、资料检索和复盘重练。

- **练习模式**：医生语音与文字回应，可开启实时教练建议。
- **实战模式**：双向语音对话，结束后统一复盘。
- **训练管理**：维护医生、场景、审核资料与评分标准，查看记录和重练进展。

技术栈：React / Vite / shadcn/ui、FastAPI、AgentScope；支持本地 JSON 或 PostgreSQL 存储。

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

本机开发默认免登录。启用登录时，运行 `uv run --directory backend python -m medvisit.api.auth` 生成密码哈希，在 `backend/.env` 设置 `AUTH_REQUIRED=true`、`ADMIN_USERNAME` 和 `ADMIN_PASSWORD_HASH`。多账号使用 `LOGIN_USERS_JSON` 配置“账号 → 密码哈希”对象，覆盖单账号配置；不提供公开注册。

在两个终端分别启动：

```sh
# 终端 1：后端
npm run dev:api

# 终端 2：前端
npm run dev -- --host 127.0.0.1
```

打开 <http://127.0.0.1:5173>。未配置密钥也可浏览页面；语音演练需要对应服务权限和麦克风。修改密钥后重启后端。

## Docker 部署

先按上文配置 `backend/.env` 和管理员密码哈希，再执行：

```sh
cp -n .env.example .env
# 将根目录 .env 中的 POSTGRES_PASSWORD 改为长随机密码。
docker compose up -d --build --wait
```

打开 <http://127.0.0.1:8080>。Compose 使用 PostgreSQL，并将数据库和检索原文分别保存到命名卷。

升级前按[运维说明](docs/operations.md)备份。旧 API 容器首次迁移到持久卷时，须先导出容器内原文；不要对需要保留的数据执行 `docker compose down -v`。

## 验证

```sh
npm test
npm run test:api
npm run lint
npm run build
```

CI 还会运行真实 PostgreSQL 回归和 Docker Compose 部署、容器重建及数据库故障恢复检查。模拟测试不调用收费服务；真实服务与麦克风、外放效果需单独验收。

## 使用边界

- 账号登录；训练资料共享，个人记录、点评、重练、案例和统计隔离。本机免登录模式不可对外开放。公网部署须启用登录并使用 HTTPS，配置见[服务器与 CI/CD](docs/server-deployment.md)。
- 不保存原始音频；演练音频和文本会发送给配置的语音、模型服务。请勿输入真实患者信息。
- 模型输出需专业复核；语气分析仅覆盖措辞，不代表声音语调或情绪评估。资料来源核对不等于医学审核。

## 文档

- [使用手册](docs/user-manual.md)：配置、演练与常见问题
- [架构与部署](docs/architecture.md)：目录结构、存储与测试
- [单用户部署运维](docs/operations.md)：备份、恢复、升级与排查
- [检索助手](docs/research-agents.md) · [药品资料库](docs/drug-library.md) · [医生角色](docs/doctor-agent.md)
- [训练交付记录](docs/training-delivery.md)：验收范围与已知限制
