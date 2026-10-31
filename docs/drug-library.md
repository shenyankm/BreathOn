# 信达生物药品资料库

药品页面沿用产品图、通用名、商品名、概述和详细文档的卡片格式。2026-10-29 对照[信达生物官网产品清单](https://www.innoventbio.com/#/product/products)，收录其列出的全部 20 款上市产品；不将研发管线项目混入药品文档。

静态来源索引位于 [drugs.ts](../frontend/src/lib/drugs.ts)，图片位于 `frontend/src/assets/library/innovent/`。概述采用简短的公开资料摘编，保留靶点及治疗领域，不加入疗效排名或剂量推荐。说明书和患者手册链接到官方原文，图片随前端构建发布并按需加载，避免将大体积 PDF 打进应用包。

| 通用名 | 商品名 | 详细文档 |
| --- | --- | --- |
| 信迪利单抗注射液 | 达伯舒 | [说明书 PDF](https://img.innoventbio.com/PackageInsert/sintilimab.pdf) |
| 贝伐珠单抗注射液 | 达攸同 | [说明书 PDF](https://img.innoventbio.com/7.4/new2.pdf) |
| 阿达木单抗注射液 | 苏立信 | [说明书 PDF](https://img.innoventbio.com/adm3.22.pdf) |
| 利妥昔单抗注射液 | 达伯华 | [说明书 PDF](https://img.innoventbio.com/product/HALPRYZAInstructions.pdf) |
| 佩米替尼片 | 达伯坦 | [说明书 PDF](https://img.innoventbio.com/pmtn3.22.pdf) |
| 奥雷巴替尼片 | 耐立克 | [说明书 PDF](https://img.innoventbio.com/5c89f09e539a25191.pdf) |
| 雷莫西尤单抗注射液 | 希冉择 | [说明书 PDF](https://img.innoventbio.com/xrz11.231.pdf) |
| 塞普替尼胶囊 | 睿妥 | [说明书 PDF](https://img.innoventbio.com/rt.pdf) |
| 伊基奥仑赛注射液 | 福可苏 | [患者手册 PDF](https://images.qingtv.com/%E6%82%A3%E8%80%85%E6%89%8B%E5%86%8C%E4%B8%AD%E6%96%87%E7%89%88.pdf) |
| 托莱西单抗注射液 | 信必乐 | [说明书 PDF](https://img.innoventbio.com/tlx3.22.pdf) |
| 氟泽雷塞片 | 达伯特 | [说明书 PDF](https://img.innoventbio.com/fzlsp.pdf) |
| 匹妥布替尼片 | 捷帕力 | [说明书 PDF](https://img.innoventbio.com/product/pirtobrutinib.pdf) |
| 己二酸他雷替尼胶囊 | 达伯乐 | [说明书 PDF](https://img.innoventbio.com/2024.12/dbl.pdf) |
| 利厄替尼片 | 奥壹新 | [说明书 PDF](https://img.innoventbio.com/25.02/Limertinib.pdf) |
| 替妥尤单抗N01注射液 | 信必敏 | [说明书图片](https://img.innoventbio.com/25.03/teprotumumabN01.jpg) |
| 玛仕度肽注射液 | 信尔美 | [说明书 PDF](https://img.innoventbio.com/product/S5LGV8EM_SMS_24mg.pdf) |
| 匹康奇拜单抗注射液 | 信美悦 | [说明书 PDF](https://img.innoventbio.com/product/PECONDLE.pdf) |
| 伊匹木单抗N01注射液 | 达伯欣 | [说明书 PDF](https://img.innoventbio.com/product/Ipilimumab.pdf) |
| 阿贝西利片 | 唯择 | [礼来医学网说明书 PDF](https://www.lillymedical.cn/file/raw/f4e09dab-5cac-445c-91f1-1222ec5bbb93/阿贝西利片说明书.pdf) |
| 盐酸奎扎替尼片 | 维复泰 | [第一三共中国说明书 PDF](https://www.daiichisankyo.com.cn/Portals/0/344_0_奎扎替尼说明书.pdf) |

运行时业务目录由 `/api/catalog/drug` 返回，管理员维护发布状态和版本。App 当前按 `frontend/src/lib/app-drugs.ts` 限定玛仕度肽；下表是 2026-10-29 的来源索引，不表示所有产品都已在当前工作区发布或可在 App 中练习。

## 资料类型和来源

信达官网提供 18 款产品的图片和资料入口。唯择的图片采用[礼来中国](https://lilly.com.cn/medicines/current-medicines)公开品牌标识，维复泰采用真实说明书首页的局部预览，卡片均标明图片类型，没有合成药盒图片。

福可苏详细文档来自[驯鹿生物官方患者平台](https://i-connection.iasobio.com/)，标注为「患者手册（非说明书）」，文件约 74 MB；信必敏标注「说明书（图片）」。唯择的说明书入口取自[礼来医学网](https://www.lillymedical.cn/zh-cn/oncology/Verzenios)，维复泰来自[第一三共中国公开文件列表](https://www.daiichisankyo.com.cn/search)。

信尔美当前官网链接的文件修订日期含占位文本，页面概述中保留版本待核对提示。训练基线继续使用另行核对的成人体重管理说明书，范围与哈希见[训练交付记录](training-delivery.md)。旧的用户概述与本地 PDF 文件保留，资料库条目不会自动替换训练中的审核资料。

核对日期表示本次官网清单与链接的检查时间。公开资料摘编仍待医学审核，具体适应症、联合用药、人群及风险需以对应原文核对。后续版本通过[资料检索助手](research-agents.md)查询，不把网站可访问或文件未变当成版本永久有效。

## 历史页面与验证（2026-10-29）

桌面四列、平板两列、手机单列。卡片保持等宽等高，按钮固定在底部；手机缩短图片区域，让首张卡片的操作更容易出现。概述在当前页预览，详细文档在新标签页打开；资料库作为独立页面分包加载。

前端测试检查 20 款产品清单、唯一标识、所有本地图片的真实文件头、官方文档域名及特殊资料类型。清单原始响应、下载校验和界面截图保存在被 Git 忽略的 `backend/data/validation/innovent/`。

清单与官网公开接口的 20 个上市条目逐项核对，商品名与治疗领域一致。1440、768、390 宽度检查均为 0 FAIL；保留「完整 20 款清单需要滚动」提示，避免为了首屏缩小卡片或隐藏条目。图片在固定比例区域中完整显示，不让说明书长图撑高整行。原生 Chrome 已验证概述弹窗、关闭后焦点返回、PDF 和图片说明书入口，以及末行两款补充资料的展示。
