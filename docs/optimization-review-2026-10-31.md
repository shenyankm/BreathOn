# 持续优化验收记录 · 2026-10-31

基线为 `b8e766dda312f56690efc7cc4b9e0d094dfb8775`，初始 `main` 与 `origin/main` 一致且工作区干净。独立分支 `sheny/optimize-20261031`；不合并 main、不部署生产。当前基线的远程 CI [41094354090](https://github.com/shenyankm/BreathOn/actions/runs/41094354090) 成功，这不替代后续提交的 CI。

环境：macOS ARM64，Node 22.23.2、uv 0.12.13，仓库锁定依赖；隔离 PostgreSQL 17 Alpine 容器 `breathon-opt-20261031`，仅绑定 loopback、使用测试账号。保留已有 8000/5173 服务和其他项目容器。原始日志与临时产物在忽略目录 `backend/data/validation/optimization-20261031/`。未读取业务记录或将服务密钥写入结果。

## 检查范围与队列

| 方向 | 检查和验收范围 | 状态 |
| --- | --- | --- |
| 性能 | 当前 API、存储/聚合、导入导出、构建；区分测试耗时和业务响应 | 基线建立中 |
| 响应速度 | 真实本机 HTTP 的冷启动及热运行 p50/p95，登录、目录、历史记录；语音单独标记验证边界 | 待测量 |
| 稳定性 | 登录取消、会话/后台任务取消、超时、断线、数据库故障与恢复 | 已复现登录并发限制失效，优先修复 |
| 资源占用 | 密码工作线程、连接/任务、音频生命周期、空闲与重复请求、构建包体积 | 登录取消导致重叠工作线程；其余待检查 |
| 工程规范 | CONTRIBUTING、CI、类型、错误契约、锁文件、隔离及已有回归 | 基线后端 818、前端 99 通过；lint 与两种页面构建通过 |

关键流程：管理员登录/退出、目录与医学资料维护，代表登录及账号隔离、练习/实战收尾、日记与复盘、后台研究恢复；原生 API/Caddy 重启与 PostgreSQL 故障恢复。已有文档的旧验收不充当当前结果。每项完成后重新检查最新代码；目前尚不满足“三轮无新增有效优化”或 goal 完成条件。

## 1. 取消登录后仍占用密码校验槽位

**问题和原因（改动前）**：`Authentication.login` 在 `Semaphore(1)` 中直接等待 `asyncio.to_thread(scrypt)`。取消协程会退出信号量，但不能停止工作线程。请求取消/服务器取消后，后续密码校验与原工作线程重叠，削弱现有高内存密码计算的资源限制。保持现有 scrypt 参数、限流、账号校验、Cookie 与权限边界。

**范围与调用方**：`api/auth.py` 的 `/api/auth/login`；由 `api/app.py` 注册，`core/config.py` 使用密码格式校验，测试中的 HTTP/账号隔离及原生部署登录链路继续回归。不改 hash 格式、配置、前端或数据库格式。

**复现与预先确定的验收标准**：

```sh
uv run --directory backend pytest -q tests/test_auth.py -k 'cancelled_login or password_worker_failure'
```

故障注入阻塞密码线程，取消首个请求两次，再发第二个请求；要求首个协程在工作线程完成前持续持有槽位，峰值工作线程从 **2 降到 1**，取消请求不创建会话，后续请求成功，线程异常后可再次登录且槽位释放。测试注入的是校验器，不用模拟线程计数声称实际 RSS 下降。改动前结果 **1 failed、1 passed**，失败值 `(first.done(), peak) == (True, 2)`，预期 `(False, 1)`；日志 `auth-before.log`。

采用仓库已有的 shield + 等待线程结束再传播取消的模式。代价是取消后需等待已开始的 scrypt 结束；不重试计算、不降低密码计算强度。回退使用本项提交的 `git revert <SHA>`，不会改写用户数据。

修改后相关回归：**26 passed、0 skipped，13.12 秒**，包含真实 PostgreSQL 账号隔离；新故障用例验证峰值工作线程为 **1**、重复取消、取消不创建会话、后续登录成功、工作线程异常后释放槽位。`git diff --check` 通过。

真实本机原生部署检查通过：`deploy/check-native.py` 实际启动 Uvicorn 与 Caddy，执行 Cookie 登录/退出和账号隔离、API 重启、数据库停机时 live=200 / ready=503、数据库重启后恢复。只使用隔离测试数据，无上游模型或语音调用。可复现环境变量：`NATIVE_DISPOSABLE=1`、`NATIVE_DATABASE_URL` 指向一次性 PostgreSQL、`NATIVE_DB_CONTAINER` 为其完整容器 ID、`NATIVE_CADDY_BIN` 指向已校验 Caddy，命令为 `uv run --directory backend --locked python ../deploy/check-native.py`。第一次尝试失败：Docker Desktop 将随机发布的端口在容器重启后重新分配；已保留 `auth-native-first.log`，改为固定 `127.0.0.1:65097:5432` 后重跑通过（`auth-native.log`），不将首次失败计为通过。

基线全量：后端 **818 passed、0 skipped，81.85 秒**（Python 3.13.15、隔离 PostgreSQL）；前端 **99 passed、0 skipped**；lint 成功，原有 3 条 UI Fast Refresh 警告；Web 和 Android Vite/类型构建成功。新代码的本项必要验收为上述 26 项及真实原生部署检查；最终版本仍须完整回归。无 Android 原生或界面改动，本项不重复 APK 安装；远程 CI 仍须执行所有四个非生产 job。

提交、推送与对应远程 CI 在提交后记录；未完成前不关闭本项。
