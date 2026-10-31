# Android 打包与本机 AVD 验收

Android 用户端位于 `frontend/src-tauri`，应用 ID 为 `cloud.openwook.medvisit`，调试版追加 `.debug`。Web 构建只包含管理后台；用户端页面与主页面导航只打入 APK，不再通过 Web 服务分发。

## 技术栈

移动端统一采用 React + Tauri 2 + SQLite：React 页面使用 TypeScript，Tauri 2 提供原生容器，Rust 使用内置 SQLite 的 `rusqlite` 保存上次选择的练习方式。数据库位于应用私有数据目录的 `breathon.sqlite3`，首次使用时事务建表并设置 `user_version=1`，按登录账号读取和更新；切换账号使用各自偏好，退出后保留，卸载应用会清除。当前不保存凭据、录音或拜访正文，也不提供离线同步。

前端只能调用 `load_training_preference` / `save_training_preference`，不能传入 SQL 或数据库路径。`build.rs` 为命令生成权限，运行时能力与 Rust 页面地址检查共同限制为 Android 主窗口的内置 `/_android/index.html` 地址；debug 构建额外允许 `localhost` / `127.0.0.1` HTTP 同一路径，release 不授权这些地址。Tauri 会将配置的前端来源归为本地，因此原生命令还会独立检查协议、主机、端口与页面路径，阻止同源普通页面访问。数据库错误不会回传文件路径，读写失败提示用户并保留本次练习能力。

存储回归可在具备 Tauri 桌面编译依赖的开发机运行 `cargo test --manifest-path frontend/src-tauri/Cargo.toml --lib --locked`；Android 另需编译和安装验证。验收时选择实战练习、强制停止并重开应用，确认选项恢复，再验证其他账号使用独立选项。

移动端共用 Python + FastAPI + AgentScope 服务端，通过 API 访问 PostgreSQL 中的服务端数据；后端本地开发使用的 SQLite 不属于移动端实现。端内数据库不替代服务端登录、权限校验或记录归属检查。

## 页面与 API

`npm run build:android` 将用户端编译到 `frontend/dist-android`。Android Gradle 工程把该目录作为 APK assets，`MainActivity` 使用已有的 AndroidX `WebViewAssetLoader` 读取资源。生产 WebView 的地址为 `https://openwook.cloud/_android/index.html`，其中 `/_android/` 只从 APK 加载；Web 服务器对该路径返回 404。

`/api`、WebSocket、附件和登录 Cookie 仍使用 `https://openwook.cloud`，保持同源。没有放宽 SameSite Cookie、CORS 或来源校验；上述两个偏好命令仅对内置页面地址授权，普通远程页面不增加 Tauri IPC 权限。原有 Tauri WebViewClient 的导航、加载和安全回调均保留，WebChromeClient 的麦克风和文件选择处理保持不变。 WebView 的四边范围按 Android 系统栏与屏幕缺口的实际 Insets 调整，避免状态栏或导航栏遮挡标题和底部控件。

首次打开时会在原生 WebView 初始化后重新载入一次，确保资源拦截器包在 Tauri 已安装的客户端外层。页面资源可随 APK 离线读取；登录、资料与语音功能仍依赖后端网络。更新用户页面需要重新构建并安装 APK，发布 Web 管理页不会更新用户端。

Python 后端、数据库和服务密钥不打入 APK。Manifest 保留 `RECORD_AUDIO` 与 `MODIFY_AUDIO_SETTINGS`，麦克风由现有 WebView 请求系统权限，无需新增录音插件。

调试版额外允许 `localhost` 与 `127.0.0.1` 的 HTTP 同源地址，供 `adb reverse` 使用；发布版资源拦截只接受生产域名的 HTTPS。

## BREATHON 界面与功能入口

Android 采用青绿、米白、柔黄背景，暖橙色主按钮、浅青色次按钮；主题仅由 Android 入口加载，不改变 Web 管理后台。底部为「首页 / 训练 / 教练 / 我的」。首页的课程进度和有效训练分数来自接口，暂无结果时不填示例数字。

L1–L4 展示已发布课程，个人计划与完成标记持久化。医生 IP 可从首页、L3 和教练进入；教练当前使用玛仕度肽目录和自由练习重点，不提供评分场景选择器，历史绑定场景的重练仍保留。完整用户操作见[使用手册](user-manual.md)。

旧 `#practice` 映射到教练，`#scenarios` 映射到训练。原生返回先处理键盘和弹窗，再按 `frontend/src/bp/route.ts` 的 `backTarget` 返回上级；会话返回教练不等于结束演练。

AVD 页面、交互和样式验收见[Android UI review](android-ui-review.md)；测试数量只代表报告对应版本，不替代新提交的 CI 或真机验收。

## 药品与医生科室匹配

当前 App 通过医生 IP 卡片选择角色，药品由 `frontend/src/lib/app-drugs.ts` 限定为已发布玛仕度肽，不再提供旧的左右药品／医生双选卡片。选择医生后仍执行服务端科室匹配：一个药品可关联多个科室，未配置科室或组合失效时不能开始。医生 IP 图片用于模拟角色展示，不代表真人。

后端目录返回药品 `practice_departments` 和医生归一后的 `practice_department`，前端只负责筛选；自由练习预览、WebSocket 启动和绑定了药品的评分场景均在服务端校验。既有记录不重写。后台药品草稿中可编辑多个对口科室，发布后生效；显式空清单表示不开放该药品的科室匹配。

内置20种药品的默认科室在 `backend/medvisit/platform/departments.py`；旧目录缺少此字段时按通用名读取默认值，未知药品不会自动匹配全部医生。科室别名统一处理，例如“心内科／心血管代谢中心”和“血液科／白血病诊疗中心”。这里只表示模拟练习的科室领域对口，不判断个人处方权、医院准入或具体患者适用性。药品来源入口沿用 `catalog_seed.json`，医生专业来源沿用 `doctor_profiles.json`。

本次更新需先部署后端及管理端，再更新用户 APK；旧后端未提供科室字段时，新版用户端不会放行未经匹配的组合。

## 构建环境

需要 Node.js、[Rust](https://rustup.rs/) 和 [Android Studio](https://developer.android.com/studio) 的 SDK、Build-Tools、Platform-Tools、NDK，安装要求见 [Tauri Android 前置要求](https://v2.tauri.app/start/prerequisites/#android)。当前工程使用 SDK 37、Gradle 9.6.1 和 Android Gradle Plugin 9.3.1，最低 API 24。旧系统能够安装，不代表其 WebView 支持语音所需的 AudioWorklet。

macOS 示例，NDK 版本以本机安装为准：

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
npm --prefix frontend ci
```

Android Studio 工程已保留在 `frontend/src-tauri/gen/android`，通常无需再次执行 `android:init`。重新生成时必须保留 Manifest 的录音权限、禁用备份设置、MainActivity 的资源拦截器，以及 Gradle 的 `dist-android` assets 来源。

## 构建 APK

在项目根目录执行：

```sh
# ARM64 手机或 ARM64 AVD；自动先构建 Android 用户页面。
npm run android:build -- --debug --apk --target aarch64
```

APK 位于 `frontend/src-tauri/gen/android/app/build/outputs/apk/`。调试签名只供安装验收，不是正式发布签名。默认 APK 连接真实服务器 `https://openwook.cloud`，不需要 `adb reverse` 或本机代理。连接真实服务器的可安装验收包使用上面的命令，**不要附加本机验收用的 `--config` 覆盖**。调试签名不改变 API 地址，也不关闭 HTTPS 校验；正式 release 则需要自己的发布签名。

生产服务器启用了账号认证：匿名 `/api/auth/session` 返回 `enabled: true`、`authenticated: false`；`/api/health` 返回 401，`/api/live` 和 `/api/ready` 是可匿名读取的存活与就绪探针。App 使用服务器预配置的已有账号登录，没有公开注册。页面由 APK 提供，登录 Cookie、API 和 WebSocket 同源连接服务器，不需要放宽 Cookie 或 CORS。构建不会创建账号、修改生产数据或部署后端。

需要隔离数据验收时，才使用下面的本机覆盖配置；不要将该覆盖包当作连接真实服务器的交付包。

## 使用本机 AVD 验收

先用 `emulator -list-avds` 和 `adb devices` 选择本机 AVD；未启动时用 `emulator -avd AVD_NAME` 启动。每个 adb 命令都应指定实际模拟器序列号。

本机 Android 验收后端也必须设置 `AUTH_REQUIRED=true`，并配置仅用于隔离验收的一次性账号。使用 `uv run --directory backend python -m medvisit.api.auth` 交互生成密码哈希，再通过后端环境配置指定账号；凭据不要写进源码或提交 Git。Android 检测到 `enabled: false` 会显示“服务器未启用账号登录”，不会沿用 Web 的本机免登录入口。

启动已启用认证的本机后端与一个前端 API 代理。例如前端监听 `127.0.0.1:5176`，Vite 的 `API_TARGET` 指向本机后端：

```sh
# 前端目录；API_TARGET 可指向隔离测试后端，避免修改真实数据。
API_TARGET=http://127.0.0.1:8001 npm run dev -- --host 127.0.0.1 --port 5176

# 项目根目录；此地址的 /_android/ 仍由 APK 读取，只有 /api 发给本机代理。
adb -s emulator-5554 reverse tcp:5176 tcp:5176
npm run android:build -- --debug --apk --target aarch64 --config '{"build":{"frontendDist":"http://127.0.0.1:5176/_android/index.html"}}'
```

选择构建日志中的实际 APK 路径安装并启动：

```sh
adb -s emulator-5554 install -r /absolute/path/to/app-debug.apk
adb -s emulator-5554 shell cmd package resolve-activity --brief cloud.openwook.medvisit.debug
adb -s emulator-5554 shell am start -n cloud.openwook.medvisit.debug/cloud.openwook.medvisit.MainActivity
adb -s emulator-5554 exec-out uiautomator dump /dev/tty > /tmp/breathon-ui.xml
adb -s emulator-5554 exec-out screencap -p > /tmp/breathon-avd.png
adb -s emulator-5554 logcat -b crash -d
```

验收首页、训练、教练、我的，以及医生详情、课程计划/完成、资料、记录、拜访表单、健康观察和弹窗。检查空数据、加载失败重试、辅助/实战切换、原生返回、键盘、窄屏与横屏。返回层级以 `frontend/src/bp/route.ts` 为准；活跃语音、复盘保存和前后台切换需要单独执行完整会话验收。普通浏览器访问 `/_android/index.html` 必须返回 404，APK 应能显示内置页面。仅在明确验收真实语音时开始录音或调用外部服务，服务状态刷新和语音调用可能产生用量。

`android:dev` 也先构建用户资源，再启动本机 Vite 代理；其 `devUrl` 为 `http://localhost:5173/_android/index.html`。它不使用网页热更新，页面改动后仍需重新构建和安装。已有 5173 服务时不要直接停止他人的进程，应使用独立端口和覆盖配置。

结束隔离测试后可移除该次反向转发：

```sh
adb -s emulator-5554 reverse --remove tcp:5176
```

## CI 可安装工件

每次 Pull Request 和推送都会运行真实 ARM64 debug APK 编译，不只构建 Vite 页面。CI 使用与本机验收对应的 JDK 25、Rust 1.98.1、SDK `platforms;android-37.0`、Build-Tools `36.0.0`、NDK `28.2.13676358`，沿用仓库的 Gradle wrapper 和 Rust 锁文件：

```sh
npm run android:build -- --debug --apk --target aarch64 --ci -- --locked
```

GitHub Actions 的工件 `BreathOn-android-arm64-debug-<commit>` 中只上传可安装 APK，保留 14 天。它使用调试签名，用户页面来自 APK，默认连接真实服务器的 HTTPS API；安装后仍须使用服务器已有的合法账号登录。私钥、发布 keystore 和 CI 认证测试账号不会进入工件。Web 和 Android 两次构建都会检查实际模块图，阻止管理页面与用户页面交叉打包。

该编译任务是生产 CD 的前置条件，编译失败会阻止 Web 管理后台和后端部署。CI 不会自动安装到用户手机或发布应用商店，也不能代替 AVD 与真实设备的操作验收。

## 发布与验证边界

正式构建使用独立的 release 签名，应用标识为 `cloud.openwook.medvisit`，可与 `.debug` 预览版共存。Gradle 从被 Git 忽略的 `frontend/src-tauri/gen/android/keystore.properties` 读取签名信息，字段与 [Tauri Android 签名说明](https://v2.tauri.app/distribute/sign/android/) 一致：

```properties
storeFile=/absolute/private/path/breathon-release.keystore
keyAlias=breathon-release
password=<keystore-and-key-password>
```

密钥与密码文件应限制为本人可读，并在仓库外安全备份；`keystore.properties` 可链接到私有目录中的配置。缺少签名配置时 release 构建会失败，debug 构建不需要正式密钥。后续升级必须保留应用标识和签名，并同步提高 `tauri.conf.json`、`Cargo.toml` 及 `Cargo.lock` 中的应用版本。

```sh
# 前端目录；ARM64 正式签名 APK，默认连接线上 HTTPS 服务。
npm run android:build -- --apk --target aarch64 --ci -- --locked
```

APK 和 AAB 分别位于 Android 工程的 `app/build/outputs/apk/` 与 `app/build/outputs/bundle/`。发布前使用 Android SDK 的 `apksigner verify --verbose --print-certs` 校验签名，并核对应用标识、版本、非 debuggable 状态和 HTTPS 服务地址；GitHub Release 附 APK 与 SHA-256 校验文件。密钥、密码和 `keystore.properties` 不得提交或加入安装包。

APK 构建不会部署远程后端或 Web 管理页面。AVD 安装和界面验收也不能代替真实麦克风、扬声器、蓝牙耳机、权限拒绝后的恢复与实际弱网验收。前端基础检查为 `npm test`、`npm run lint`、`npm run build`、`npm run build:android`；CI 另外执行上面的原生 APK 编译，安装与设备验收仍需单独进行。
