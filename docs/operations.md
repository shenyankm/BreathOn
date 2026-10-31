# 部署运维

生产由单进程 FastAPI / Uvicorn（`medvisit-coach.service`）和原生 Caddy 提供 API、WebSocket 与静态 Web 管理端，只有 PostgreSQL 使用 Docker。Android 用户端为 React + Tauri 2，页面内置 APK。本机免登录模式仅供本机访问；公网须启用账号登录、管理员权限与用户数据隔离，见[服务器与原生 CI/CD](server-deployment.md)。

PostgreSQL 保存演练与平台元数据，`RECORDS_DIR` 保存检索原件、HTML 阅读副本、任务文件及恢复副本。备份和恢复必须覆盖数据库与记录目录；独立私有 `visit-audio` 不纳入长期备份。不要对需要保留的数据执行 `docker compose down -v`。本文描述运行接口，不代表首次原生迁移或生产恢复已经验收。

## 启动与排查

原生初始化、受限 SSH 部署入口、systemd 环境文件与 Caddy 配置按[服务器与 CI/CD](server-deployment.md)维护。部署主流程使用 `deploy/native-deploy.sh` 接收后端源码和 CI 构建的管理端静态文件；服务器只按 Python 锁文件安装依赖，不运行 npm 构建或 API / Web 容器。受限部署入口不是手动执行完整 Compose 的替代命令。

常规只读检查：

```sh
sudo systemctl status medvisit-coach.service caddy --no-pager
sudo journalctl -u medvisit-coach.service -u caddy --since '15 minutes ago' --no-pager
sudo docker compose --env-file /etc/medvisit-coach/compose.env \
  -f /etc/medvisit-coach/database.compose.yaml -p medvisit-coach ps
```

`/api/live` 表示 API 进程可响应，`/api/ready` 检查数据库、平台存储及文件目录。它们不会探测付费模型或语音服务；真实服务检测仍只由 Web 管理端点击「刷新」触发。异常时先恢复数据库或文件存储，再检查就绪状态，不要通过删除卷重新初始化。

请求排查可将响应头 `X-Request-ID` 与 API、代理日志对应；不要输出请求正文、查询参数或私有环境文件。应用由 systemd 管理，数据库容器的健康状态不会代替 API 的就绪检查。

## 演练保存失败后的恢复

PostgreSQL 保存演练失败时，后端会尝试把完整记录原子写入 `RECORDS_DIR/recovery/<会话 UUID>.json`，目录权限 `0700`、文件权限 `0600`。只有写入成功才发送 `recovery_saved=true`；`saved` 仍为 `false`，页面不会把本机副本当作数据库保存成功。如果数据库和本机文件同时无法写入，页面提示保存未确认，请先保留当前原话。

数据库恢复、`/api/ready` 正常后，以原生 API 的运行用户和相同环境配置执行 `python -m medvisit.storage.import_records <RECORDS_DIR的recovery子目录>`；不要启动旧 API 容器做生产导入。本地开发使用 PostgreSQL 且保持默认记录目录时，从项目根目录执行：

```sh
uv run --directory backend python -m medvisit.storage.import_records data/sessions/recovery
```

导入先验证所有文件，再在事务中写入；重复运行不覆盖已有数据库记录，也不删除恢复副本。核对记录详情后再按原始资料的要求备份或清理副本。该命令恢复演练记录，不会重新调用模型，也不会自动重放重练任务状态变更。JSON 本地存储模式写入失败仍需修复目录权限或磁盘问题。

## 原生服务的一致性备份

`deploy/native-backup.py` 当前只提供 `backup` 和 `verify`。它要求指定的 systemd 服务已停止；数据库命令只通过 DB-only Compose 的 `db` 服务执行，记录文件从主机目录读取，不依赖 API 容器。

原生服务通过 systemd `BindPaths` 把已有主机记录卷绑定为进程内的 `RECORDS_DIR`；备份脚本需要主机路径，不能直接使用服务命名空间中的 `/app/data/sessions`。在维护窗口结束演练，确认下例取得的是已有记录目录，再停止 API 执行：

```sh
medvisit_sessions_dir=$(sudo docker volume inspect --format '{{.Mountpoint}}' medvisit-coach_research_data)
sudo systemctl stop medvisit-coach.service
sudo python3 /srv/medvisit-coach/current/deploy/native-backup.py \
  --project medvisit-coach --sessions-dir "$medvisit_sessions_dir" \
  --service medvisit-coach.service backup /安全目录/medvisit-20261031
sudo python3 /srv/medvisit-coach/current/deploy/native-backup.py \
  verify /安全目录/medvisit-20261031
```

默认数据库配置为 `/etc/medvisit-coach/database.compose.yaml` 和 `/etc/medvisit-coach/compose.env`，可用 `--compose-file`、`--env-file` 指定实际路径。目标目录必须不存在；成功生成 `database.dump`、`files.tar` 和 `manifest.json`，复用 format 1 的完整性校验与私有文件权限，排除 `visit-audio`、链接、设备文件及环境配置。环境文件与密钥需另行安全保留，不在备份包中。

备份工具不会启动或恢复 API。无论命令是否成功，先检查备份结果与现场状态，再恢复原先运行的服务并确认 `/api/ready`；生产部署脚本负责其部署过程中的服务恢复。备份期间不要从外部工具写数据库或共享记录目录。根据可接受的数据丢失窗口保留多个日期，并把校验后的备份保存到独立存储；完成本机备份不代表已有异机副本。

## 原生恢复与旧数据迁移

当前原生备份接口没有原地 `restore` 命令，不应将旧 `deploy/backup.py restore` 当作生产恢复步骤。仅使用可信备份，先在隔离的数据库和记录目录验证完整性、版本、表行数和文件哈希，再按[原生部署说明](server-deployment.md)安排维护与切换。数据库转储会执行对象定义，哈希只能发现损坏，不能认证备份来源。当前生产恢复是否通过验收，应以实际恢复演练结果为准。

恢复后先核对每日追踪状态，再启动 API，避免到期主题立即触发付费请求。涉及不兼容数据库迁移时，不能仅切换旧代码宣称已经回滚数据库。

首次从旧完整 Compose 部署迁移时，若检索原文还在旧 API 容器可写层，必须先完整导出；不要先重建或删除旧容器。原生 API 继续使用实际记录目录；数据库与文件必须一并核对，不能只保留数据库元数据。

本地开发未使用 PostgreSQL 时，演练 JSON、`platform.sqlite3` 和 `research/` 位于 `backend/data/sessions`。SQLite 使用 WAL；停止本地 API 后备份整个目录，包括仍存在的 `platform.sqlite3-wal` 和 `platform.sqlite3-shm`，并在空的新目录验证恢复。

## 旧完整 Compose 兼容验证

旧 API / Web / PostgreSQL 组合的备份恢复命令已集中到[兼容验证说明](legacy-compose.md)，仅用于无真实数据的临时项目，不作为生产操作。

## 依赖与持续集成

前端使用 `npm --prefix frontend ci`，后端使用 `uv sync --directory backend --locked` 安装锁定版本。CI 配置检查前端测试、lint 与两端模块边界，使用独立 PostgreSQL 跑后端测试并拒绝跳过，编译真实 Android ARM64 APK；部署集成使用原生 Uvicorn / Caddy 和 Docker PostgreSQL，覆盖服务重启持久化、数据库断连恢复与账号隔离。生产作业串行执行并检查最新 `main` SHA，接收同次 CI 的管理端静态构建产物；完整流程见[服务器与 CI/CD](server-deployment.md)。这些检查与原生生产迁移、真实语音或恢复演练应分别确认。

原生发布沿用管理员维护的 `/etc/medvisit-coach/compose.env` 中的 `PYPI_DOWNLOAD_BASE` 下载源；仅替换锁文件中的下载地址，保留版本和 SHA-256 校验，安装完成后恢复原始锁文件。腾讯官方源的具体配置由服务器部署说明维护，不在文档中复制私有环境文件。

页面仅需要 shadcn 的 CSS，不需要在运行依赖中携带其 CLI。原版样式固定在 `frontend/src/styles/vendor/shadcn-4.22.1.css`，完整 MIT 许可证和来源信息随 `frontend/public/licenses/` 发布。升级样式时同步保留来源、许可证，并比较构建后的 CSS；不要通过强制降级来清除依赖审计提示。

## 历史本地验收记录（2026-10-29）

2026-10-29 本地验证结果如下；原始报告保留在 Git 忽略的 `backend/data/validation/`，不把测试状态当成已完成生产切换。

| 检查 | 结果 |
| --- | --- |
| 后端 | 398 项通过、无跳过，含 SQLite 与真实临时 PostgreSQL |
| 前端 | 20 项测试、构建通过；lint 仅原有 3 条 Fast Refresh 提示 |
| 依赖 | 移除 292 个未使用的 CLI 传递包；npm audit 为 0；编译 CSS 逐字节相同 |
| 部署 | 镜像构建与 Compose 检查通过；非 root 文件写入、容器替换后保留、代理缓存/上传、数据库断连和恢复均验证 |
| 备份恢复 | 真实独立恢复通过；1 条演练、3 条平台实体、5 个文件及其哈希一致，恢复项目未启动付费追踪 |
| 主项目 | 保持原有本机服务，未切换已有 Docker 部署，未写入合成验收历史或开启追踪 |

以上仅描述当时的本地验收，不能代表当前版本或生产状态。当前架构为 Android 用户端、原生 Caddy Web 管理端及 systemd 后端，只有 PostgreSQL 使用 Docker；支持多账号登录和记录隔离。当前 CI/CD 配置与部署要求见[服务器与 CI/CD](server-deployment.md)。真实语音、长时间负载、灾备和多副本能力仍需单独验收。
