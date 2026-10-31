# DeepSeek网络检索与并发配置验证

> 历史验收／设计记录：只描述文中日期与版本，不作为当前入口、功能清单或生产状态。现行指南见[文档索引](README.md)。其中忽略目录下的日志、截图和报告属于本机证据，干净克隆不一定包含。

日期：2026-10-27。使用项目实际`deepseek-flash`账号完成接口验证，凭据未写入报告。模型上下文仍为1,000,000 tokens，temperature=0。

## 配置与实现

已更新实际`backend/.env`与`backend/.env.example`：

```dotenv
DEEPSEEK_MAX_CONCURRENCY=2500
DEEPSEEK_SEARCH_ENABLED=true
DEEPSEEK_SEARCH_QPS=100
DEEPSEEK_FETCH_QPS=25
```

模型并发使用所有对话共享的异步信号量，每次模型HTTP请求单独占用，工具运行时不占用该信号量。Search与Fetch分别平滑限速，避免初始突发。限制属于当前进程；账号还运行其他应用时，需预留额度或另做共享调度。它们不是语音会话容量，当前语音会话上限仍为2。

标准额度为每账号Flash模型2500、Pro模型500并发；Search为100 QPS、Fetch为25 QPS，各自独立。[模型价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[账号限速](https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit/)、[Search/Fetch说明](https://api-docs.deepseek.com/zh-cn/guides/search/)。

教练注册两个只读工具`search_web`、`fetch_web`，使用相同DeepSeek Bearer凭据。每次指导最多2次网页请求、3次模型推理，总等待上限45秒；医生仍独立生成且无网页工具。失败不暴露供应商正文/密钥，不把失败或空内容写成已核实。网页检索工具本身不重试；教练与医生的模型调用在408、429、5xx或连接错误时重试一次，客户端超时不重试。查询不自动附带完整会话，手机号（含空格或短横线分隔）、身份证号、邮箱、密钥以及病历/住院号/床号、“患者加姓氏”、“性别加年龄”等模式在发送前被拒绝（见[Agent 可靠性](agent-reliability.md)）；未被搜索返回的URL、内网地址和带凭据的URL不能抓取。

来源由工具实际结果生成`coach.sources`，随现有JSON/PostgreSQL记录保存，前端以可点击标题展示并注明未经产品医学审核。来源是检索记录，不代表每个页面都支持全部结论或已被人工审核。网页文本作为不可信数据输入，不是系统指令。

## 真实接口结果

完整实测记录（本机证据：`backend/data/validation/web-search-20261027-161038.json`）：

- 直接调用Search：公开查询DeepSeek搜索/抓取接口，返回3条来源。
- 直接调用Fetch：成功读取搜索结果中的官方指南，返回6405字符正文。
- AgentScope原生工具流程：在“核对现行医药代表管理办法”的合成场景中自主调用Search两次；最终保留5条真实来源，返回原有医生/教练结构。该场景未调用Fetch，不能把它说成已抓取全部原文；结果也注明仍需核对官方原文。
- 此次AgentScope调用累计输入30469、输出625 tokens，usage记录`search_requests=2`、`fetch_requests=0`。查询实际尝试次数不等于计费成功次数。

启用工具后的两项非搜索回归（本机证据：`backend/data/validation/coaching-live-20261027-161423.json`）：购物卡场景正确停止利益交换；另一组两年算术场景正确给出绝对下降10个百分点、相对下降50%、NNT=10。两者均未发起网页请求，说明工具可用不等于每次必须联网。

## 本地检查

最终后端回归为72通过、5项真实PostgreSQL测试因未提供测试数据库而跳过；前端6项测试与生产构建通过。

后端测试新增覆盖：实际AgentScope搜索→抓取→回答循环、来源只来自工具实际结果、模型自编链接被丢弃、参数与公开URL校验、错误脱敏、两次请求预算、共享模型并发、独立QPS节拍、等待取消与搜索中途取消关闭客户端。原有医生/教练独立上下文、usage累计及业务回归保留。

前端构建与测试检查来源字段兼容旧记录；lint有原有UI组件Fast Refresh提示，无新增错误。没有为小幅链接展示新增依赖。

## 费用与未验证范围

官方文档列Search和Fetch分别按每1000次成功且有结果的请求收取5元；应用直接调用独立接口，不将Harness/Codex服务端工具的临时优惠当作本应用免费承诺。[计费说明](https://api-docs.deepseek.com/zh-cn/guides/search/#24)。模型多轮推理另计tokens。

未做2500并发/100或25 QPS的真实压测、跨worker/跨应用额度协调、浏览器完整演练及医学人工审核。关键词/正则隐私检查不是全面去标识化，使用者仍不应输入真实患者身份信息；网页结果也可能过期、错误或包含恶意指令，不能替代原始研究与有效说明书核对。
