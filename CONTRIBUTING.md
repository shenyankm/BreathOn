# 参与贡献

欢迎提交问题和小范围、可验证的改进。开始前先查看已有 Issue；涉及产品流程或架构的较大变更，先说明问题和预期行为。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `frontend/src/` | React 用户界面与 Web 管理后台；优先复用现有 shadcn/ui 组件 |
| `frontend/src-tauri/` | Tauri 2 Android 客户端、原生权限和打包配置 |
| `backend/medvisit/` | FastAPI、语音、训练、资料与存储服务 |
| `frontend/tests/`、`backend/tests/` | 前后端回归测试 |
| `deploy/`、`docs/` | 部署配置与使用、运维文档 |

用户端只通过 Android APK 提供，Web 只提供管理后台，后端在服务器运行。不要恢复 Web 用户端入口，或把服务密钥放进前端和 APK。

## 本地开发

需要 Node.js 22.12+、Python 3.12+ 和 [uv](https://docs.astral.sh/uv/)。在仓库根目录执行：

```sh
npm --prefix frontend ci
uv sync --directory backend --locked
cp -n backend/.env.example backend/.env
```

按 [README](README.md) 配置本地环境，不覆盖已有 `.env`。分别启动后端和 Web 管理后台：

```sh
# 终端 1
npm run dev:api

# 终端 2
npm run dev -- --host 127.0.0.1
```

管理后台地址为 `http://127.0.0.1:5173/admin`。本机免登录模式只用于本地开发，不对外开放。

Android 另需 Rust、JDK、Android SDK/NDK。环境、签名、API 地址覆盖与 AVD 操作见 [Android 开发与验收](docs/android.md)。构建用户页面和调试 APK：

```sh
npm run build:android
npm run android:build -- --debug --apk --target aarch64
```

APK 默认连接已配置的服务器；功能验收请按 Android 文档切换到隔离测试后端，使用独立测试账号。Android 后端必须启用 `AUTH_REQUIRED=true`；代表之间的数据不可互访，管理员访问应遵循既有权限和审计规则。

## 验证变更

```sh
npm test
npm run lint
npm run build
npm run build:android
npm run test:api
```

先运行与变更相关的测试；提交 PR 时列出实际执行的命令、结果及未运行项的原因。涉及 Android 原生代码时，另做 APK 编译与安装验收。模拟测试不能代替真实麦克风、扬声器、权限恢复和弱网测试；真实语音和服务状态刷新可能产生外部服务用量。

## 数据与授权

- 不提交 `.env`、密码哈希、API Token、签名密钥、数据库备份或真实患者数据；日志与截图也需要脱敏。
- 录音必须取得授权。使用虚构或明确可公开的测试资料，不将真实拜访内容混入测试夹具。
- 改动账号、记录查询、附件或导出功能时，验证不同代表之间的隔离及管理员权限，不通过放宽 Cookie、CORS 或来源校验绕过认证。
- 医学来源、第三方代码与图片保留原许可和出处。新增资料应说明来源及使用权限，来源核对不能替代医学审核。

## 提交与 PR

提交信息使用英文 Conventional Commits，例如 `fix(android): Preserve the selected doctor`。标题使用祈使语气、不加句号，并控制在 72 个字符以内；保留原作者和实际共同作者。

PR 说明问题、最终行为、影响平台、实际验证与已知风险。涉及数据结构或部署方式时写明迁移和回退步骤，不勾选未执行的检查，也不把未完成的人工验收写成已通过。

原创代码与文档按 [MIT License](LICENSE) 贡献；第三方材料的边界见 [第三方声明](THIRD_PARTY_NOTICES.md)。
