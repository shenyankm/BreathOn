# 单用户部署运维

服务使用单个 API 进程。本机免登录模式仅供本机访问；公网须启用管理员登录并通过 Caddy 提供 HTTPS，见[服务器与 CI/CD](server-deployment.md)。PostgreSQL 保存演练与平台元数据，`research_data` 保存 `/app/data/sessions` 下的检索原件、HTML 阅读副本与任务文件；备份和恢复必须同时覆盖两者。不要对需要保留的数据执行 `docker compose down -v`。

## 启动与排查

从仓库根目录运行 `docker compose up -d --build --wait`。正常 `down`、容器重建和镜像升级保留命名卷。模型与语音密钥放在 `backend/.env`，数据库配置放在根目录 `.env`；升级前单独、安全地保留这些配置，备份包不包含它们。

```sh
docker compose ps
docker compose logs --since 15m --tail 200 api
docker compose logs --since 15m --tail 100 db
```

`/api/live` 表示 API 进程可响应，`/api/ready` 检查数据库、平台存储及文件目录。它们不会探测付费模型或语音服务。服务可用性检测仍只由用户点击「刷新」触发。API 或数据库异常时先查看健康状态与日志，不要通过删除卷重新初始化。

健康状态变为 unhealthy 不会让 Compose 自动重启容器。先恢复数据库或文件存储，检查 `/api/ready`；只有确认需要时再重启 API。请求排查可将响应头 `X-Request-ID` 与 API、代理日志对应，日志无需包含请求正文或查询参数。

## 演练保存失败后的恢复

PostgreSQL 保存演练失败时，后端会尝试把完整记录原子写入 `RECORDS_DIR/recovery/<会话 UUID>.json`，目录权限 `0700`、文件权限 `0600`。只有写入成功才发送 `recovery_saved=true`；`saved` 仍为 `false`，页面不会把本机副本当作数据库保存成功。如果数据库和本机文件同时无法写入，页面提示保存未确认，请先保留当前原话。

数据库恢复、`/api/ready` 正常后，可使用现有导入命令恢复副本。在 Compose 中执行：

```sh
docker compose exec -T api python -m medvisit.storage.import_records /app/data/sessions/recovery
```

本地开发使用 PostgreSQL 且保持默认记录目录时，从项目根目录执行：

```sh
uv run --directory backend python -m medvisit.storage.import_records data/sessions/recovery
```

若设置了 `RECORDS_DIR`，传入其 `recovery` 子目录。导入先验证所有文件，再在事务中写入；重复运行不覆盖已有数据库记录，也不删除恢复副本。核对记录详情后再按原始资料的要求备份或清理副本。该命令恢复演练记录，不会重新调用模型，也不会自动重放重练任务状态变更。JSON 本地存储模式写入失败仍需修复目录权限或磁盘问题。

## 一致性备份

需要 Linux 或 macOS、Python 3.9+ 和 Docker Compose，无需在主机安装 PostgreSQL 客户端。先结束正在进行的演练；备份会短暂停止 API，待数据库和文件复制完成后恢复原来正在运行的 API，并等待健康检查。原来已停止的 API 保持停止。

```sh
python3 deploy/backup.py --project medvisit-coach backup /安全目录/medvisit-20261029
python3 deploy/backup.py verify /安全目录/medvisit-20261029
```

目标目录必须不存在。脚本在权限 `0700` 的临时目录中生成 `database.dump`、`files.tar` 和 `manifest.json`，文件权限为 `0600`；检查成功后才发布备份目录。写入失败会清理本次未完成的目录，并尝试恢复原 API。如果两份数据已经完整采集但 API 恢复失败，脚本仍校验并保留备份目录，输出保留位置，再以原恢复异常退出；非零退出不一定表示备份不存在。失败后检查 `docker compose ps`；如果 API 未恢复，查看日志并执行 `docker compose up -d --no-deps --no-recreate --wait --wait-timeout 90 api`。

`database.dump` 使用 PostgreSQL 自定义格式，`files.tar` 从已停止的原 API 容器复制，覆盖真实文件数据。清单包含时间、来源项目名、数据库主版本、两张应用表的行数，以及归档和每个文件的 SHA-256；不包含连接密码或服务密钥。验证同时拒绝不完整包、篡改、压缩伪装、路径越界、符号链接、硬链接、设备文件和环境配置文件。

应用停止是数据库与文件的一致性边界，备份期间不要从外部工具直接写数据库或共享数据目录。同一主机、同一用户、同一项目的备份与恢复通过文件锁串行执行。备份未压缩的文件 TAR 便于检查，容量至少需要数据库转储和文件目录大小的总和。

备份含演练原话和归档内容，按原始记录同等保护。根据可接受的数据丢失窗口定期执行，保留多个日期，并将验证后的副本保存到独立存储；命令完成不等于已具备异机副本。

## 恢复到全新项目

仅恢复自己可信的备份。哈希检查能发现损坏，不能认证来源；数据库转储恢复时会执行其中的数据库对象定义。使用与备份匹配的代码和 PostgreSQL 主版本，先在独立项目恢复验证，再切换原部署。

```sh
python3 deploy/backup.py verify /安全目录/medvisit-20261029
python3 deploy/backup.py --project medvisit-recovery-20261029 restore /安全目录/medvisit-20261029
docker compose -p medvisit-recovery-20261029 ps -a
```

恢复目标必须与备份来源项目名不同，且没有任何已有容器或卷。脚本先验证完整性，再启动新的数据库，拒绝非空数据库，恢复两份数据并核对数据库版本、表行数和每个文件的哈希；没有清空或覆盖旧项目的命令。恢复失败时保留这个新项目，API 保持停止，先排查原因。

恢复成功也不会启动 API 或网页。数据库中的每日追踪状态原样保留；启动前核对是否需要继续运行，避免到期主题立即发起付费请求。如需在恢复副本中暂停全部主题，可在 API 停止期间执行：

```sh
docker compose -p medvisit-recovery-20261029 exec -T db sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
UPDATE platform_entities
SET document = jsonb_set(document::jsonb, '{enabled}', 'false'::jsonb)::text
WHERE kind = 'research_watch';
SQL
```

核对密钥、端口及允许的 Origin 后，再显式启动这个新项目的 API 和网页；若原项目仍运行，新项目需使用不同网页端口及对应 Origin。验证健康、历史记录和 HTML 原文后再切换使用，保留旧项目作为回退依据。

## 首次增加文件持久卷的升级

旧版 Compose 仅持久化 PostgreSQL，检索原件可能仍在旧 API 容器的可写层。**必须在重建旧 API 容器之前执行完整备份**。`deploy/backup.py` 使用 `docker cp` 读取旧容器，因此即使当前 Compose 文件已经增加命名卷，仍能取得旧容器中的原件；不要先运行会重建 API 的 `up --build`。

备份后按上一节恢复到全新项目，新镜像会创建归属应用用户 `10001:10001` 的文件卷，恢复文件不继承旧用户编号。核对数据后再切换部署。仅备份数据库会留下能查到元数据、却无法打开原件的记录。

本地开发未使用 PostgreSQL 时，演练 JSON、`platform.sqlite3` 和 `research/` 都位于 `backend/data/sessions`。SQLite 使用 WAL；停止本地 API 后备份整个目录，包括仍存在的 `platform.sqlite3-wal` 和 `platform.sqlite3-shm`，并在空的新目录验证恢复；不能只复制数据库或只复制 JSON。

## 验证边界

普通测试不调用真实模型。备份脚本有 12 项归档安全、哈希、私有权限、失败恢复、同项目锁和已有目标拒绝测试。2026-10-29 在隔离 Compose 项目实际完成备份与全新项目恢复：1 条演练、3 条平台实体、5 个文件的计数与哈希一致；来源 API 恢复健康，新项目 API 保持停止，未调用付费服务。原容器停止后的可写层导出也单独验证通过。[验收记录](../backend/data/validation/backup-recovery/summary.json)保存在本机忽略目录。

定期使用独立项目做完整恢复演练，确认数据库与 HTML 原件都可读取。单机命名卷和本机备份仍不提供高可用、异地容灾或专业医学审核。

数据库转储格式与恢复行为依据 [PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) 和 [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)。

## 依赖与持续集成

前端使用 `npm --prefix frontend ci`，后端使用 `uv sync --directory backend --locked` 安装锁定版本；依赖声明与锁文件不一致时，CI 和镜像构建都会失败，不会静默使用旧依赖或修改锁文件。GitHub Actions 检查前端测试、lint、构建，使用独立 PostgreSQL 跑后端测试并拒绝跳过，最后在无服务密钥的独立 Compose 项目验证部署、容器替换和数据库断连恢复。工作流使用只读权限和固定的官方 Action 提交，测试完成后清理专用项目。

页面仅需要 shadcn 的 CSS，不需要在运行依赖中携带其 CLI。原版样式固定在 `frontend/src/styles/vendor/shadcn-4.22.1.css`，完整 MIT 许可证和来源信息随 `frontend/public/licenses/` 发布。升级样式时同步保留来源、许可证，并比较构建后的 CSS；不要通过强制降级来清除依赖审计提示。

## 本轮验收记录

2026-10-29 本地验证结果如下；原始报告保留在 Git 忽略的 `backend/data/validation/`，不把测试状态当成已完成生产切换。

| 检查 | 结果 |
| --- | --- |
| 后端 | [398 项通过、无跳过](../backend/data/validation/engineering/backend.xml)，含 SQLite 与真实临时 PostgreSQL |
| 前端 | 20 项测试、构建通过；lint 仅原有 3 条 Fast Refresh 提示 |
| 依赖 | 移除 292 个未使用的 CLI 传递包；npm audit 为 0；[编译 CSS 逐字节相同](../backend/data/validation/engineering/frontend-dependency-cleanup.json) |
| 部署 | [镜像构建与 Compose 检查](../backend/data/validation/engineering/deployment.json)通过；非 root 文件写入、容器替换后保留、代理缓存/上传、数据库断连和恢复均验证 |
| 备份恢复 | [真实独立恢复](../backend/data/validation/backup-recovery/summary.json)通过；1 条演练、3 条平台实体、5 个文件及其哈希一致，恢复项目未启动付费追踪 |
| 主项目 | 保持原有本机服务，未切换已有 Docker 部署，未写入合成验收历史或开启追踪 |

GitHub 工作流已配置，本轮未推送或运行远端 CI；也未执行真实断电、长时间负载、异机灾备或多副本验收。收费服务与真人音频链路未在本轮重新调用。当前部署仍是单机单用户范围，上公网需要另行完成认证、访问控制与相应验收。
