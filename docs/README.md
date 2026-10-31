# 文档索引

当前文档核对日期：2026-10-31。先按用途选择入口；测试数量、截图和某次发布结果只说明对应版本。代码行为有变更时，同步更新下面的现行指南，不用历史验收报告替代操作说明。

## 现行指南

| 用途 | 文档 |
| --- | --- |
| 安装与开始使用、App 导航、练习和复盘 | [使用手册](user-manual.md) |
| 已有能力、未接入能力与兼容边界 | [当前功能范围](platform-completion.md) |
| 管理设置、课程发布、多人审核、健康观察授权与撤回 | [管理后台说明](admin-management.md) |
| Android 构建、隔离 AVD 验收、签名与 APK 更新 | [Android 开发与验收](android.md) |
| 服务边界、账号隔离、存储、模型与接口协作 | [架构](architecture.md) |
| 生产账号、CI/CD、版本与健康确认 | [服务器与 CI/CD](server-deployment.md) |
| 备份、恢复、副本导入和排障 | [部署运维](operations.md) |
| 可恢复错误、指标、评分校准与评测边界 | [Agent 可靠性](agent-reliability.md) |
| 医生/药品检索、来源归档与可选追踪 | [检索助手](research-agents.md) |
| 产品资料与来源类型 | [药品资料库](drug-library.md) |
| 知识条目、审核及导入 | [医学 Wiki](medical-wiki.md) |
| 公开背景与模拟行为的区分 | [医生训练角色](doctor-agent.md) |
| 玛仕度肽资料维护与演示边界 | [玛仕度肽演示](mazdutide-demo.md) |
| 无真实数据的旧容器栈验证 | [旧 Compose 兼容验证](legacy-compose.md) |

本地依赖、配置与启动命令统一在[贡献指南](../CONTRIBUTING.md#本地开发)；[项目 README](../README.md)面向产品介绍。

## 需求与研究依据

这些文档保留需求及来源，不是上线清单。涉及外部来源时，应查看文中核对日期，医学或政策内容使用前仍需重新核实。

- [产品需求](medcoach-prd.md)、[重构方案](medcoach-refactor-plan.md)、[培训需求取舍](sales-training-requirements.md)
- [医药代表技能研究](medical-rep-skill-research.md)、[比赛评分依据](hackathon-scoring-criteria.md)

## 历史验收与设计记录

以下保留版本依据和已知限制，避免删除证据。文中的单用户模式、旧 Web `/app`、旧导航、测试数量或“尚未部署”仅适用于当时；当前操作以上方指南为准。本机 `backend/data/validation/`、截图和临时工件通常被 Git 忽略，不保证在干净克隆可用。

| 类别 | 记录 |
| --- | --- |
| App | [体验调整](app-experience-2026-10-31.md)、[稳定性](app-stability-review-2026-10-31.md)、[原型及 AVD 验收](android-ui-review.md) |
| 训练与模型 | [训练交付](training-delivery.md)、[真实模型验证](coaching-live-validation.md)、[网页搜索验证](web-search-validation.md)、[复盘预览设计](visit-summary-preview.md) |
| 研究 | [医生研究验收](doctor-research-acceptance.md) |
| 稳定性 | [恢复初查](recovery-review-2026-10-30.md)、[恢复复查](stability-recovery-review-2026-10-30.md)、[工程稳定性](engineering-stability-2026-10-30.md) |
| 性能与优化 | [10-29 优化](optimization-review-2026-10-29.md)、[10-30 性能](performance-20-rounds-2026-10-30.md)、[10-31 优化](optimization-review-2026-10-31.md)、[10-31 新增 30 轮](performance-30-rounds-2026-10-31.md) |

## 维护约定

- 页面入口变化：更新使用手册和 Android 指南；权限、接口边界变化：更新架构与管理说明。
- 部署、签名和备份命令分别由服务器、Android、运维文档维护；其他文档引用它们。
- 验收记录注明提交/日期、真实与模拟输入、已执行和未验证范围；不把 CI 通过写成医学审核或真机语音通过。
- 发布确认核对实际部署 SHA；App 内置资源需安装同一版本 APK，服务器部署不推送客户端资源。
