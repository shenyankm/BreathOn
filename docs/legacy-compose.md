# 旧完整 Compose 兼容验证

仅用于隔离验证，不是当前生产运维入口。生产操作见[部署运维](operations.md)。

以下保留旧 API / Web / PostgreSQL 容器组合的备份恢复接口，供无真实数据的临时项目验证历史 format 1 备份，不作为原生生产部署、升级或恢复建议。需要旧组合时，使用下方的 `medvisit-disposable` 独立项目，并在整个验证期间保持相同的无密钥环境配置；不要将下文项目、端口或卷指向生产数据。

## 启动隔离验证环境

在仓库根目录执行，保持无真实数据和服务密钥：

```sh
COMPOSE_PROJECT_NAME=medvisit-disposable BACKEND_ENV_FILE=/dev/null \
  POSTGRES_PASSWORD=ci-only-password AUTH_REQUIRED=false WEB_PORT=18080 \
  ALLOWED_ORIGINS=http://127.0.0.1:18080 docker compose up -d --build --wait
```

验证页面仅绑定本机 `http://127.0.0.1:18080`。不要对需保留的数据执行 `docker compose down -v`；生产备份与恢复按[部署运维](operations.md)执行。

### 旧组合的一致性备份

需要 Linux 或 macOS、Python 3.9+ 和 Docker Compose，无需在主机安装 PostgreSQL 客户端。先结束正在进行的演练；备份会短暂停止 API，待数据库和文件复制完成后恢复原来正在运行的 API，并等待健康检查。原来已停止的 API 保持停止。

```sh
python3 deploy/backup.py --project medvisit-disposable backup /安全目录/medvisit-20261029
python3 deploy/backup.py verify /安全目录/medvisit-20261029
```

目标目录必须不存在。脚本在权限 `0700` 的临时目录中生成 `database.dump`、`files.tar` 和 `manifest.json`，文件权限为 `0600`；检查成功后才发布备份目录。写入失败会清理本次未完成的目录，并尝试恢复原 API。如果两份数据已经完整采集但 API 恢复失败，脚本仍校验并保留备份目录，输出保留位置，再以原恢复异常退出；非零退出不一定表示备份不存在。失败后检查 `docker compose -p medvisit-disposable ps`；如需恢复临时 API，仅在原无密钥配置下执行 `docker compose -p medvisit-disposable up -d --no-deps --no-recreate --wait --wait-timeout 90 api`。

`database.dump` 使用 PostgreSQL 自定义格式，`files.tar` 从已停止的原 API 容器复制，覆盖真实文件数据。清单包含时间、来源项目名、数据库主版本、两张应用表的行数，以及归档和每个文件的 SHA-256；不包含连接密码或服务密钥。验证同时拒绝不完整包、篡改、压缩伪装、路径越界、符号链接、硬链接、设备文件和环境配置文件。

应用停止是数据库与文件的一致性边界，备份期间不要从外部工具直接写数据库或共享数据目录。同一主机、同一用户、同一项目的备份与恢复通过文件锁串行执行。备份未压缩的文件 TAR 便于检查，容量至少需要数据库转储和文件目录大小的总和。

备份含演练原话和归档内容，按原始记录同等保护。根据可接受的数据丢失窗口定期执行，保留多个日期，并将验证后的副本保存到独立存储；命令完成不等于已具备异机副本。

### 恢复到一次性验证项目

仅恢复自己可信的备份。哈希检查能发现损坏，不能认证来源；数据库转储恢复时会执行其中的数据库对象定义。使用与备份匹配的代码和 PostgreSQL 主版本，只在全新的临时项目恢复验证，不切换原生生产部署。

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

保持无服务密钥与本机 Origin，使用独立网页端口，按需显式启动临时 API 和网页验证健康、记录及 HTML 原文。不要把此验证项目切换为生产服务；只清理已确认的一次性项目。

