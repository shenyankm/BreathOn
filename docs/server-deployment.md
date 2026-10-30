# 服务器与 CI/CD

`https://openwook.cloud` 由主机 Caddy 终止 TLS，再转发到 `127.0.0.1:8080`。主域名和 `www` 均直接提供应用，避免旧站点的永久重定向缓存形成循环，IP 地址不直接提供应用。API 和 PostgreSQL 不发布到公网端口；仅 SSH、HTTP 和 HTTPS 需要入站访问。

## 管理员登录

服务保持单管理员，不提供注册、成员管理或多租户。公网配置必须设置 `AUTH_REQUIRED=true`、`ADMIN_USERNAME`、`ADMIN_PASSWORD_HASH`，允许来源为 `https://openwook.cloud,https://www.openwook.cloud`。使用下列命令交互生成 scrypt 哈希，原始密码不写入服务配置：

```sh
uv run --directory backend python -m medvisit.api.auth
```

会话使用随机令牌，服务端仅保存令牌摘要；Cookie 为 HttpOnly、SameSite=Strict，HTTPS 下附加 Secure。会话最长 8 小时，退出即撤销当前令牌；重启或部署会清除全部会话，需重新登录。登录限为每分钟 10 次，密码校验串行执行。写入仍检查 Origin，API 和 WebSocket 都检查登录，存活和就绪探针保持匿名但不返回业务数据。

本机开发未配置登录时可沿用免登录方式。它不适合对外开放；生产部署脚本强制检查启用登录、固定的 HTTPS Origin 和匿名业务访问返回 401。

## 自动部署

推送 `main` 后，GitHub Actions 依次完成前后端检查、真实 PostgreSQL 回归和独立 Compose 故障恢复测试，再部署生产。Pull Request 不部署。主分支流水线不自动取消正在运行的部署，主机文件锁避免同时更新。

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

重置密码时，用交互命令生成新哈希，安全修改 `backend.env` 后重建 API；不要把原密码或哈希写入命令历史、Git 或 CI 日志。模型密钥也只在主机配置中维护。
