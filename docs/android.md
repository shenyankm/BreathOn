# Android 打包（Tauri 2）

Android 客户端位于 `frontend/src-tauri`，应用 ID 为 `cloud.openwook.medvisit`，调试版追加 `.debug`，可与发布版并存。Android Studio 工程已纳入版本控制，通常不必重新执行 `android:init`；重新生成时须保留 Manifest 中的麦克风权限与禁用备份设置。

## 运行方式

安装版在线加载 `https://openwook.cloud`（`tauri.conf.json` 的 `build.frontendDist`），沿用站点的登录 Cookie、HTTP API、WebSocket 和文件地址。Python 后端、数据库和服务密钥不打入 APK，网页更新通过现有服务器发布流程生效。离线或服务器不可达时无法使用。

没有授予远程网页 Tauri 原生 IPC 权限。麦克风使用现有 `getUserMedia`，由 Android WebView 请求系统录音权限；Manifest 声明 `RECORD_AUDIO` 和 `MODIFY_AUDIO_SETTINGS`，无需另装录音插件。发布版不允许明文 HTTP。

## 构建环境

沿用项目的 Node.js 环境，另外安装 [Rust](https://rustup.rs/) 和 [Android Studio](https://developer.android.com/studio)。按 [Tauri Android 前置要求](https://v2.tauri.app/start/prerequisites/#android) 安装 SDK Platform、Build-Tools、Platform-Tools、Command-line Tools 和 NDK（Side by side）。当前生成工程使用 Android SDK 37、Gradle 9.6.1 和 Android Gradle Plugin 9.3.1；首次构建需要下载 Maven、Gradle 与 Cargo 依赖。

macOS 示例，NDK 版本改为本机安装的版本；其他系统使用各自 SDK 路径：

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
npm --prefix frontend ci
```

最低安装版本为 Android 7（API 24），但语音功能还需要支持 AudioWorklet 等 API 的新版 Android System WebView；旧系统能安装不代表能完成语音演练。

## 生成可安装的调试 APK

在项目根目录执行：

```sh
# ARM64 手机；使用调试签名，但加载正式 HTTPS 站点。
npm run android:build -- --debug --apk --target aarch64
```

APK 输出在 `frontend/src-tauri/gen/android/app/build/outputs/apk/` 下。`--debug` 的构建产物仍加载 `frontendDist`；只有 `android:dev` 才使用本地 Vite 的 `devUrl`。

```sh
# 查看产物
find frontend/src-tauri/gen/android/app/build/outputs/apk -name '*.apk'
# 用上一步的实际路径安装
adb install -r /absolute/path/to/app-debug.apk
```

其他部署地址可以通过 Tauri 配置覆盖，必须是启用现有账号登录的 HTTPS 站点，且同站点提供前端和 `/api`：

```sh
npm run android:build -- --debug --apk --target aarch64 --config '{"build":{"frontendDist":"https://your-domain.example"}}'
```

## 本机 USB 调试

手机打开 USB 调试并授权电脑，确认 `adb devices` 显示设备。通过 USB 端口反向转发使用回环地址，Vite 和免登录后端均无需暴露到局域网：

```sh
# 终端 1
npm run dev:api

# 终端 2；android:dev 会启动 Vite，不必另外运行 npm run dev。
adb reverse tcp:5173 tcp:5173
npm run android:dev
```

模拟器也可采用相同方式；多设备时，用 `adb -s DEVICE_SERIAL reverse ...` 并将目标设备名传给 `npm run android:dev -- DEVICE_NAME`。若 5173 已被已有 Vite 占用，先停掉该进程。断开后可用 `adb reverse --remove tcp:5173` 清理转发。

## 发布与签名

```sh
# 默认编译所有 ABI；可加 --target aarch64 限定设备。
npm run android:build -- --apk
npm run android:build -- --aab
```

APK 和 AAB 分别输出在 Android 工程的 `app/build/outputs/apk/` 与 `app/build/outputs/bundle/`。仓库未配置发布密钥，release 产物需要使用自己的密钥签名后才能分发或上传；debug 签名只用于开发验收。按 [Tauri Android 签名说明](https://v2.tauri.app/distribute/sign/android/) 在本机创建密钥与 `gen/android/keystore.properties`，并在 `app/build.gradle.kts` 配置 release 的 signingConfig 后，继续使用上述 CLI 命令构建。

签名密钥、密码与 `keystore.properties` 不得提交。升级发行时保持同一签名密钥，并提高 `tauri.conf.json` 的 `version`（Android versionCode 从版本号推导）；应用标识发布后不要随意更换。

## 验收

每次发布前在真实设备检查：登录/退出与会话过期；首次允许、拒绝录音权限及重新授权；练习和实战的收音、外放、打断、结束复盘；断网与切换前后台；PDF/JSON 下载和资料上传。外部网页、附件下载的 Android WebView 行为需要单独验收。不要用模拟测试代替麦克风、扬声器或蓝牙耳机验收，也不要在无意调用收费服务时执行服务状态刷新。

常规前端检查仍为 `npm test`、`npm run lint` 和 `npm run build`；Android 编译使用上面的 APK 命令，现有 Web CI 不会构建 Android。
