# 本地端到端测试

本套测试使用真实浏览器、真实 HTTP/WebSocket 服务和独立数据目录。管理端运行在 Chrome，用户端测试连接已安装的 Android 调试 WebView，不恢复 Web 用户入口。默认不调用付费供应商；设置 `E2E_LIVE=1` 才运行真实语音、模型和搜索。

## 运行

需要 Node.js、uv、Google Chrome 和可执行的 `ffprobe`。`ffprobe` 必须在后端进程继承的 PATH 中，录音测试使用实际媒体解析，不替换校验函数。先按贡献指南安装依赖：

```sh
npm --prefix frontend ci
uv sync --directory backend --locked
npm run test:e2e
```

命令自动启动隔离后端 `127.0.0.1:8187` 和管理端代理 `127.0.0.1:5187`。端口被占用时直接失败，不复用或停止其他服务。默认资料/录音目录位于 `backend/data/validation/e2e/<时间戳>/sessions`，使用 SQLite 和文件记录，不读取正常的 `RECORDS_DIR`、`DATABASE_URL`。

要覆盖生产使用的 PostgreSQL，可创建**新的独立测试数据库**，设置：

```sh
E2E_DATABASE_URL=postgresql://postgres@127.0.0.1:TEST_PORT/breathon_e2e npm run test:e2e
```

测试服务器拒绝非本机地址及名称不以 `breathon_e2e` 开头的数据库。不要指向真实业务数据库；该测试会创建、修改、发布、停用和删除测试记录。五个测试账号固定为 `e2e-admin`、`e2e-medical`、`e2e-compliance`、`e2e-a`、`e2e-b`，口令仅用于此隔离服务。服务器只绑定环回地址，不能作为生产入口使用。

测试准备通过正常登录与发布 API 创建独立测试药品，保证用户端有可练习的已发布玛仕度肽条目。课程、资料、医生、量表和场景均只写入隔离数据。新库里未发布药品时开始按钮禁用属于业务规则，不通过修改客户端绕过。

### 真实供应商

后端沿用本机 `backend/.env` 的供应商配置，密钥不会传入浏览器或 APK。以下测试会产生实际用量，使用合成对话，不使用真实患者资料：

```sh
E2E_LIVE=1 npm run test:e2e
```

覆盖 SeedASR、TTS、Seeduplex、DeepSeek、场景生成、合成样本校准、医生/药品公开检索及来源归档。输入语音只生成一次并供测试复用。费率为明确标记的合成测试费率，验证用量计算，不表示供应商报价或实际账单。合成校准不得变成“专家校准通过”。

### Android 安装包

按 [Android 指南](android.md)配置 JDK、SDK/NDK。使用独立后缀，保留原应用及数据：

```sh
npm run android:build -- --debug --apk --target aarch64 --config '{"bundle":{"android":{"debugApplicationIdSuffix":".e2e"}},"build":{"frontendDist":"http://127.0.0.1:5187/_android/index.html"}}'
adb -s emulator-5554 install -r frontend/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb -s emulator-5554 reverse tcp:5187 tcp:5187
adb -s emulator-5554 shell am start -n cloud.openwook.medvisit.e2e/cloud.openwook.medvisit.MainActivity
adb -s emulator-5554 shell pidof cloud.openwook.medvisit.e2e
# 用上一步真实 PID 替换 PID：
adb -s emulator-5554 forward tcp:9227 localabstract:webview_devtools_remote_PID
E2E_ANDROID_CDP=http://127.0.0.1:9227 E2E_ADB=/absolute/path/to/adb E2E_SERIAL=emulator-5554 E2E_LIVE=1 npm run test:e2e
```

APK 路径以实际构建输出为准。Tauri 本机覆盖可能把 `build.gradle.kts` 的 debug 后缀改为 `.e2e`，构建后只还原本次后缀改动，保留其他本地修改；不要提交测试 API 地址或后缀。测试仅附加 `127.0.0.1:5187/_android/index.html` 的 WebView，避免误操作生产包。

Android 用例会重置这两个**测试账号**的端内偏好、切换账号、操作返回键，并对专用 `.e2e` 包测试拒绝麦克风权限。语音正向测试只替换设备输入为合成 MediaStream，实际执行 WebAudio、AudioWorklet、播放调度、控件、WebSocket、真实后端及供应商；它不是物理麦克风、扬声器或人工听感验收。

## 覆盖与证据

浏览器/Android 点击覆盖登录、导航、资料表单审核、课程完成、语音控制、复盘入口和退出；其余管理写操作主要通过真实 HTTP API 验证业务流转、持久化和权限。导航检查验证页面能加载且无脚本错误，不代表每个页面的所有表单状态均完成了 UI 自动化。

- 登录、匿名访问、代表与管理员权限及跨账号隔离。
- 管理端全部导航分区、训练管理工具；真实表单的资料保存、审核及停用。
- Android 首页/训练/教练/我的及子页面、课程计划/完成、原生返回、SQLite 偏好、退出确认和账号切换。
- 资料/药品/医生/量表/场景/课程/画像/政策及规则；版本、绑定、发布和停用约束。
- PDF 解析和原件保留、Word 政策导入、批量导入幂等及训练模板导出/导入。
- 拜访原文、脱敏、审核、案例提炼/分享/导入；管理员原文访问遵循现有授权与审计，其他代表不能读取。
- 健康观察的私有保存、授权、独立审核、共享及撤回。
- 医学/合规双人发布门槛、服务用量和合成费率计算。
- 辅助/实战真实语音、医生文字/音频、最终分析、记录及人工点评；辅助模式完成同条件重练、任务关闭和评分差异比较，提炼并确认的合成案例再次用于真实场景生成。比较不要求分数提高，也不代表训练效果获证。
- 公开检索、逐字来源、原件哈希、画像草稿确认协议和关闭每日追踪。自动化确认只验证交互协议，不代表人工身份审核；测试草稿不发布。

HTML 报告在 `frontend/playwright-report/index.html`，JSON 在 `frontend/test-results/results.json`，失败时保留截图、trace；Android 用例另保留 UI 树和两种语音模式的事件。测试过程的状态、截图与业务数据都是隔离数据。报告可能含临时测试 Cookie，不提交或公开共享 trace。重跑前可复制这两个目录到 `backend/data/validation/e2e/` 保留本机证据。

```sh
npm --prefix frontend exec -- playwright show-report
```

## 2026-10-31 本机验收

基线为 `aad6521`，测试及修复在 `sheny/local-e2e-20261031` 完成；验收时尚未推送或部署。使用 Chrome、Android ARM64 模拟器、独立 `.e2e` APK、独立 PostgreSQL 17 和真实供应商，不写入生产数据。

后端全量回归 **1263 项通过**（154.37 秒，无失败/跳过），包括 PostgreSQL 和本次新增的隔离环境、延迟回复、取消清理回归。前端回归 **202 项通过**，E2E TypeScript 检查、Web/Android 前端构建通过；lint 通过，保留原有 12 条警告。

最终 E2E 整批 **20/20 通过**（287.72 秒，零失败、零跳过、零自动重试），包含安装包 UI、PostgreSQL、真实语音/模型/公开检索及重练闭环。ASR、TTS、分析、辅助和实战五类服务检测均成功。同条件重练完成并关闭任务，沟通维度为 3 → 3，差异为 0；测试验证比较成立，不据此声称效果提高。

最终批次启动于本地时间 22:26:10；报告保留在上述 HTML/JSON 路径，本机完整证据备份位于 `backend/data/validation/e2e/accepted-20261031/`，后端 JUnit 为 `backend/data/validation/local-e2e-final.xml`。临时 PostgreSQL 在导出测试数据后移除；专用测试 APK 保留，应用已停止，端口转发已移除。

发现并修复了服务检测误报：旧实战探测只发送“你好”及两秒静音后停止供帧，供应商 VAD 有时仍需后续静音才能完成回复。现与正式会话一致，持续供帧并同时收取结果；仍保持 20 秒总期限，仍拒绝空音频和供应商错误，结束或取消时清理发送任务。新增回归覆盖晚于两秒静音的回复及中途取消连接。真实持续供帧诊断收到完整转录和音频回复，用时约 3.12 秒。

初期测试夹具和工具的问题也已修正：新库未发布练习药品、HTTP 探测超时短于服务自身限时、重复运行继承了测试账号的原生偏好和旧记录地址。测试现在通过正常发布接口准备资料，只重置两个专用账号的偏好，并从首页开始；未放宽业务验证、审批或账号隔离。

### 尚未完成，不能列为“全部真实可用”

1. **录音文件的云端转写**：供应商须回取公网 HTTPS 音频。本机没有独立 HTTPS 测试地址，用户已确认不存在该地址。因此只验证真实上传、授权、媒体解析、私有下载和明确的 503 配置提示，未执行完整文件转写。没有为测试写入生产录音接口。
2. **物理设备音频与网络条件**：未验证真人麦克风、扬声器听感、物理手机、弱网、切网、蓝牙及完整前后台/进程强杀组合。模拟器合成输入不能证明这些路径可用。
3. **外部来源和专业审核**：本次医生/药品检索实际均返回 `partial`；部分网站返回 403/412。测试验证有可核对的发现、来源归档和原件哈希，保留了未核实项，不能把部分完成当作所有来源可访问。未进行真人身份、医学内容或专家标注审核，未认定训练效果或医学准确性已经获证。
4. **容量**：本轮未执行十路真实付费语音并发压测；服务器的容量限制仍由现有回归覆盖。
