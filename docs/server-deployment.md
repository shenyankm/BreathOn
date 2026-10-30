# 服务器与 CI/CD

`https://openwook.cloud` 由主机 Caddy 终止 TLS，再转发到 `127.0.0.1:8080`。主域名和 `www` 只提供 Web 管理后台与同源 API，避免旧站点的永久重定向缓存形成循环；普通用户页面内置于 React + Tauri 2 Android APK，Web `/app` 返回 410、`/_android/` 返回 404。IP 地址不直接提供应用。API 和 PostgreSQL 不发布到公网端口；仅 SSH、HTTP 和 HTTPS 需要入站访问。

## 账号登录

服务支持预配置账号，不提供公开注册或成员管理。训练资料、医生角色、场景和量表共享；代表之间的演练与拜访记录按账号隔离，管理员可按授权查看和审核代表记录。公网配置必须设置 `AUTH_REQUIRED=true`、`ADMIN_USERNAME`、`ADMIN_PASSWORD_HASH`；多账号则通过 `LOGIN_USERS_JSON` 指定“账号 → scrypt 哈希”对象，覆盖单账号配置，并用 `ADMIN_USERS_JSON` 明确管理员账号，其余账号为普通代表。允许来源为 `https://openwook.cloud,https://www.openwook.cloud`。使用下列命令交互生成 scrypt 哈希，原始密码不写入服务配置：

```sh
uv run --directory backend python -m medvisit.api.auth
```

会话使用随机令牌，服务端仅保存令牌摘要；Cookie 为 HttpOnly、SameSite=Strict，HTTPS 下附加 Secure。会话最长 8 小时，退出即撤销当前令牌；重启或部署会清除全部会话，需重新登录。全站登录限为每分钟 10 次，密码校验串行执行。每个账号同时运行 1 场演练，全站上限由 `VOICE_MAX_SESSIONS` 控制、默认 10 场，HTTP 与各账号会话可以并发使用。写入仍检查 Origin，API 和 WebSocket 都检查登录，存活和就绪探针保持匿名但不返回业务数据。

Web 本机开发未配置登录时可沿用免登录方式；Android 用户端始终要求服务器启用账号登录。它不适合对外开放；生产部署脚本强制检查启用登录、固定的 HTTPS Origin 和匿名业务访问返回 401。

## 自动部署

`.github/workflows/ci.yml` 同时用于 Pull Request 和推送检查，分为四个任务：

- `frontend`：安装 npm 锁定依赖，运行前端测试与 lint，分别构建 Web 管理后台和 Android 用户资源。Vite 检查实际分块的模块图，拒绝两类入口或动态页面互相混入。
- `backend`：运行完整 Python 测试与真实 PostgreSQL 回归，并要求测试报告中没有跳过项。
- `android`：在固定的 Ubuntu 24.04 环境中使用 Node 24、JDK 25、Rust 1.98.1、SDK 37.0、Build-Tools 36.0.0 与 NDK 28.2.13676358，按 `Cargo.lock` 编译真正的 ARM64 debug APK。检查包内原生库、用户资源和签名文件边界后，上传 `BreathOn-android-arm64-debug-<commit>` 工件，保留 14 天；不上传私钥或发布 keystore。
- `deployment`：等待以上三个任务全部成功，运行隔离 Compose 栈的路由、缓存、上传边界、容器重建持久化及数据库故障恢复检查，再启用认证，验证管理员和两个普通代表的 Cookie 登录、角色限制、记录读写隔离、跨账号拒绝与退出后的旧 Cookie 撤销。

认证 smoke 只在显式标记的可丢弃本机栈运行。三个临时账号使用随机密码，凭据和哈希只写入私有临时文件，检查后删除，不使用生产账号或调用模型服务。临时数据库和音频卷在任务结束时清除。`deploy/check-stack.py` 要求旧 Web 用户入口为 410、Android 资源路径为 404；`deploy/check-auth.py` 验证实际 HTTP 与登录 Cookie，而非只检查配置开关。

仅当 `deployment` 内的所有检查也通过，且事件为推送 `main` 时，才执行后续生产部署步骤。Pull Request 不部署；Android 编译或身份隔离检查失败也会阻止部署。主分支流水线不自动取消正在运行的部署，主机文件锁避免同时更新。

GitHub 通过固定主机密钥的 SSH 传输 `git archive` 源码，服务器构建镜像并按提交 SHA 标记。主机 Docker 配置腾讯云官方镜像缓存 `https://mirror.ccs.tencentyun.com`，避免大镜像经跨境 SSH 传输；主机 `compose.env` 同时设置 `DEBIAN_MIRROR=https://mirrors.cloud.tencent.com` 和 `PIP_INDEX_URL=https://mirrors.cloud.tencent.com/pypi/simple`；Node 与 Python 依赖仍按锁文件安装。`PYPI_DOWNLOAD_BASE=https://mirrors.cloud.tencent.com/pypi` 仅替换构建时的下载地址，保留所有版本和 SHA-256 校验，安装后恢复镜像内原始锁文件。服务器无需 GitHub 令牌。GitHub 仓库配置：

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| Variable | `DEPLOY_HOST` | 服务器地址 |
| Variable | `DEPLOY_USER` | 专用 `medvisit-deploy` 用户 |
| Secret | `DEPLOY_SSH_KEY` | 专用部署私钥 |
| Secret | `DEPLOY_KNOWN_HOSTS` | 已核对的 SSH 主机公钥 |

专用 SSH 密钥使用 `restrict` 和强制命令，仅可调用 root 所有的 `/usr/local/sbin/medvisit-deploy`。该脚本对应仓库的 `deploy/server-deploy.sh`；更新脚本时，需由服务器管理员重新安装到该位置。密钥不能获得交互 shell、转发端口或执行任意 SSH 命令。

部署前构建新镜像，并对既有应用完整备份数据库和检索原文。新服务通过健康和登录检查后，才切换 `current` 并重载 Caddy；失败尝试恢复上一版镜像与代理配置，不自动回滚数据库。涉及不兼容的数据迁移时，应先停止自动部署并按恢复流程验证。

## 主机路径

- `/srv/medvisit-coach/current`：当前版本的符号链接；`releases/` 保存发布源码。
- `/etc/medvisit-coach/compose.env`：数据库和来源配置。
- `/etc/medvisit-coach/backend.env`：语音、模型密钥与管理员密码哈希。
- `/var/backups/medvisit-coach/`：升级前的数据库和原文备份。
- `/etc/caddy/Caddyfile`：仓库 `deploy/Caddyfile` 的已部署副本。

配置和备份目录仅 root 可读。数据库与原文仍位于 `medvisit-coach` 项目的命名卷。部署前会短暂停止 API 做一致性备份，正在进行的演练会中断，应安排在无演练时发布。旧版本镜像、源码和本机备份需按容量安排清理和异机保留；单机部署不提供高可用。

```sh
sudo readlink -f /srv/medvisit-coach/current
sudo docker compose --project-name medvisit-coach --project-directory /srv/medvisit-coach/current ps
sudo journalctl -u caddy --since '15 minutes ago' --no-pager
```

重置密码时，用交互命令生成新哈希，安全修改 `backend.env` 中对应账号的哈希后重建 API；不要把原密码或哈希写入命令历史、Git 或 CI 日志。模型密钥也只在主机配置中维护。
