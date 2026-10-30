# 服务器与 CI/CD

`https://openwook.cloud` 由原生 Caddy 终止 TLS、直接提供预构建的 Web 管理页面，并将 `/api/*` 转发到 systemd 管理的原生 FastAPI（`127.0.0.1:8000`）。只有 PostgreSQL 保留 Docker，数据库端口仅绑定 `127.0.0.1:5432`。主域名和 `www` 只提供 Web 管理后台与同源 API，避免旧站点的永久重定向缓存形成循环；普通用户页面内置于 React + Tauri 2 Android APK，Web `/app` 返回 410、`/_android/` 返回 404。IP 地址不直接提供应用。API 和 PostgreSQL 不发布到公网端口；仅 SSH、HTTP 和 HTTPS 需要入站访问。

## 账号登录

服务支持预配置账号，不提供公开注册或成员管理。训练资料、医生角色、场景和量表共享；代表之间的演练与拜访记录按账号隔离，管理员可按授权查看和审核代表记录。公网配置必须设置 `AUTH_REQUIRED=true`、`ADMIN_USERNAME`、`ADMIN_PASSWORD_HASH`；多账号则通过 `LOGIN_USERS_JSON` 指定“账号 → scrypt 哈希”对象，覆盖单账号配置，并用 `ADMIN_USERS_JSON` 明确管理员账号，其余账号为普通代表。允许来源为 `https://openwook.cloud,https://www.openwook.cloud`。使用下列命令交互生成 scrypt 哈希，原始密码不写入服务配置：

```sh
uv run --directory backend python -m medvisit.api.auth
```

会话使用随机令牌，服务端仅保存令牌摘要；Cookie 为 HttpOnly、SameSite=Strict，HTTPS 下附加 Secure。会话最长 8 小时，退出即撤销当前令牌；重启或部署会清除全部会话，需重新登录。全站登录限为每分钟 10 次，密码校验串行执行。每个账号同时运行 1 场演练，全站上限由 `VOICE_MAX_SESSIONS` 控制、默认 10 场，HTTP 与各账号会话可以并发使用。写入仍检查 Origin，API 和 WebSocket 都检查登录，存活和就绪探针保持匿名但不返回业务数据。

Web 本机开发未配置登录时可沿用免登录方式；Android 用户端始终要求服务器启用账号登录。它不适合对外开放；生产部署脚本强制检查启用登录、固定的 HTTPS Origin 和匿名业务访问返回 401。

## 自动部署

`.github/workflows/ci.yml` 同时用于 Pull Request 和推送检查，分为五个任务：

- `frontend`：安装 npm 锁定依赖，运行前端测试与 lint，分别构建 Web 管理后台和 Android 用户资源。Vite 检查实际分块的模块图，拒绝两类入口或动态页面互相混入；管理页面上传为 `BreathOn-admin-dist-<commit>`，供同一次工作流的集成检查和发布下载。
- `backend`：运行完整 Python 测试与真实 PostgreSQL 回归，并要求测试报告中没有跳过项。
- `android`：在固定的 Ubuntu 24.04 环境中使用 Node 24、JDK 25、Rust 1.98.1、SDK 37.0、Build-Tools 36.0.0 与 NDK 28.2.13676358，按 `Cargo.lock` 编译真正的 ARM64 debug APK。检查包内原生库、用户资源和签名文件边界后，上传 `BreathOn-android-arm64-debug-<commit>` 工件，保留 14 天；不上传私钥或发布 keystore。
- `deployment`：等待以上三个任务全部成功，使用独立 PostgreSQL 容器、真实原生 Uvicorn 与经 SHA-256 校验的 Caddy 2.11.7，检查路由、缓存、上传边界、API 进程重启持久化和数据库断连恢复，再验证管理员和两个普通代表的 Cookie 登录、角色限制、记录隔离与退出后的旧 Cookie 撤销。测试结束清理子进程、临时数据和凭据，不构建或启动 API/Web 容器。
- `production`：等待前面四个任务全部成功，仅在推送 `main` 时进入串行部署队列；读取 GitHub 当前 `main` 的 SHA，只有仍为最新提交时才执行原有 SSH 部署，过时提交跳过部署。

认证 smoke 只在显式标记的可丢弃本机栈运行。三个临时账号使用随机密码，凭据和哈希只写入私有临时文件，检查后删除，不使用生产账号或调用模型服务。PostgreSQL 服务容器由 GitHub Actions 在任务结束时清除。`deploy/check-native.py` 启动原生进程并复用 `deploy/check-stack.py`，要求旧 Web 用户入口为 410、Android 资源路径为 404；`deploy/check-auth.py` 验证实际 HTTP 与登录 Cookie，而非只检查配置开关。

不同 `main` 提交的检查可并行运行，不会被正在执行的生产部署阻塞；Pull Request 和其他分支仍按分支取消旧检查。只有 `production` 使用固定并发组串行执行，且不自动取消正在运行的部署，主机文件锁继续避免同时更新。Pull Request 不部署；Android 编译或身份隔离检查失败也会阻止部署。

GitHub 只下载本次工作流、同一提交的已验证管理页面工件，通过固定主机密钥的 SSH 发送三个普通文件：`REVISION`、`source.tar`（gzip 压缩的 backend、deploy 与许可证）和 `web.tar.gz`（预构建管理页面）。受限接收端校验 40 位提交 SHA、文件集合与大小上限，拒绝路径穿越、链接、重复路径及环境文件，再展开到独立 release。服务器不安装 npm、不构建前端，也不构建 API/Web 镜像；仅使用已有系统 Python 3.12+ 和 `/usr/local/bin/uv` 按 `backend/uv.lock` 安装 Python 依赖。下载可沿用 root 所有 `compose.env` 中的 `PYPI_DOWNLOAD_BASE`：仅暂时替换锁文件的 wheel 下载地址，保留所有版本与哈希，安装结束或失败时还原原锁文件；不全局升级 uv。当前 wheel 下载基址为 `https://mirrors.cloud.tencent.com`，pip 索引为 `https://mirrors.cloud.tencent.com/pypi/simple`，符合[腾讯云官方镜像说明](https://cloud.tencent.com/document/product/213/8623)。主机已有腾讯云 APT 源（`http://mirrors.tencentyun.com/ubuntu`）和 Docker registry 缓存（`https://mirror.ccs.tencentyun.com`）继续沿用，不重启 Docker、不更改全局 uv 配置；服务器不安装 npm。服务器无需 GitHub 令牌。

GitHub 仓库配置：

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| Variable | `DEPLOY_HOST` | 服务器地址 |
| Variable | `DEPLOY_USER` | 专用 `medvisit-deploy` 用户 |
| Secret | `DEPLOY_SSH_KEY` | 专用部署私钥 |
| Secret | `DEPLOY_KNOWN_HOSTS` | 已核对的 SSH 主机公钥 |

专用 SSH 密钥使用 `restrict` 和强制命令，仅可调用 root 所有的 `/usr/local/sbin/medvisit-deploy`。原生部署入口对应仓库的 `deploy/native-deploy.sh`；更新脚本时，需由服务器管理员重新安装到该位置。密钥不能获得交互 shell、转发端口或执行任意 SSH 命令。

首次从旧容器版迁移由服务器管理员完成：创建 `medvisit` 用户（UID 10001）、安装 `deploy/medvisit-coach.service` 与 `deploy/database.compose.yaml`、绑定既有持久卷并建立首个原生 `current`，然后安装新的受限入口。UID 10001 与 Caddy 需要对 `/srv/medvisit-coach`、`releases` 具备目录穿越权限；`/app`、`/app/data` 同样须允许服务用户穿越。私有环境文件仍保持 root 所有、0600，数据目录仍仅 UID 10001 可读写。Caddy 访问日志须由 `caddy:caddy` 所有、0600；首次以 root 校验配置可能创建日志文件，启用前须校正其属主。自动 CD 只处理原生版本之间的升级，不会重新启动旧 API/Web 容器。

后续发布先在运行中服务之外接收源码与工件、安装锁定依赖并校验 Caddy。所有准备完成后短暂停止 API，调用 `deploy/native-backup.py` 验证备份，再原子切换 `current`、重启 API 并重载 Caddy。匿名就绪、登录开关、业务接口 401 及 Web 路由检查均通过才确认发布。失败或收到 TERM/HUP/INT 时恢复上一版链接、Caddy 配置并重启旧 API；接收、依赖安装、备份和健康检查均有超时。备份沿用格式 1，包含 PostgreSQL 与 sessions 原文，不包含 visit-audio 卷；不自动回滚数据库。涉及不兼容的数据迁移时，应先停止自动部署并按恢复流程验证。

## 主机路径

- `/srv/medvisit-coach/current`：当前版本的符号链接；`releases/` 保存发布源码。
- `/etc/medvisit-coach/compose.env` 与 `database.compose.yaml`：仅 PostgreSQL 的容器配置，沿用既有外部数据库卷。
- `/etc/medvisit-coach/backend.env`：语音、模型密钥与管理员密码哈希。
- `/etc/medvisit-coach/native.env`：systemd 使用的 PostgreSQL 连接配置，由管理员从既有数据库配置生成，权限为 0600。
- `/var/backups/medvisit-coach/`：升级前的数据库和原文备份。
- `/etc/systemd/system/medvisit-coach.service`：原生 API 单元，使用非 root 用户运行，并将既有数据卷绑定到历史 `/app/data/` 路径。
- `/etc/caddy/Caddyfile`：仓库 `deploy/Caddyfile.native` 的已部署副本。

配置和备份目录仅 root 可读。数据库与原文仍位于 `medvisit-coach` 项目的命名卷。部署前会短暂停止 API 做一致性备份，正在进行的演练会中断，应安排在无演练时发布。旧版本源码、虚拟环境和本机备份需按容量安排清理和异机保留；单机部署不提供高可用。

```sh
sudo readlink -f /srv/medvisit-coach/current
sudo systemctl status medvisit-coach.service caddy
sudo docker compose --project-name medvisit-coach --env-file /etc/medvisit-coach/compose.env -f /etc/medvisit-coach/database.compose.yaml ps
sudo journalctl -u caddy --since '15 minutes ago' --no-pager
```

重置密码时，用交互命令生成新哈希，安全修改 `backend.env` 中对应账号的哈希后重启 `medvisit-coach.service`；不要把原密码或哈希写入命令历史、Git 或 CI 日志。模型密钥也只在主机配置中维护。

源码与管理页面均在暂停 API 前完成 gzip 接收；Android 原生工程与用户页面不进入服务器发布包。旧 `deploy/server-deploy.sh`、Dockerfile 和整栈 Compose 配置仅供旧版本恢复参考，不属于当前生产 CD。
