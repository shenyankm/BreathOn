BREATHON User Android 0.1.1 — 离线交互演示

来源：用户提供的 breathon-user-interactive-package-v2/breathon-user-interactive.html。
保留原型页面与示例内容，增加 Tauri 2 Android 容器、系统栏适配、原生返回、再次检测入口和明确的演示提示。
包名 cloud.openwook.breathon.user，与营销端 cloud.openwook.medvisit 可同时安装。
未接入蓝牙、真实检测、AI、网络上传或记录持久化；健康与文献文案均为未验证的原型内容。

构建：安装 Node.js、Rust、JDK 25、Android SDK 37、Build Tools 36 和 NDK 28.2.13676358。
设置 JAVA_HOME、ANDROID_HOME、NDK_HOME；rustup target add aarch64-linux-android。
在 user-app 目录运行 npm ci。无需发布密钥的调试包：
  npm run android:build -- --debug --ci -- --locked
正式签名包：
  npm run android:build -- --ci -- --locked
也可从仓库根目录运行 npm run android:user:build -- --debug --ci -- --locked。
正式签名配置放置在 src-tauri/gen/android/keystore.properties（不包含在源码包）：
  storeFile=/absolute/private/path/release.keystore
  keyAlias=your-alias
  password=your-secret
签名文件及口令须自行安全保存，后续升级须沿用包名与签名。

检查：先运行 npx playwright install chromium，再运行 npm test；也可用本机 Chrome：PLAYWRIGHT_CHANNEL=chrome npm test。
Android 实机/模拟器安装 APK 后检查五个页面、检测与弹窗、系统返回。

Logo 由用户提供，原图保存在 www/logo.png。Android 图标使用 npm run tauri -- icon www/logo.png --fit contain 生成；不裁切原图。
