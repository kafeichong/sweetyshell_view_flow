# docs/archive —— 历史归档

> 建立于 2026-09-11
> **归档文档一律不再维护，也不代表当前事实。** 现状看 [../PROJECT_STATUS.md](../PROJECT_STATUS.md)，计划看 [../ROADMAP.md](../ROADMAP.md)，索引看 [../README.md](../README.md)。

## 为什么保留而不是删除

这些文档记录了**决策过程**（为什么选这个架构、否掉了哪些方案、评审发现了什么）。半年后回看"当初为什么这么做"时，它们比结论更有价值。因此归档而非删除。

如果确认不再需要追溯，整个 `archive/` 目录可以安全删除，不影响任何代码与运行。

---

## 归档清单

### 2026-09-09 —— 立项与方案探索期

当时的结论是"基础设施完成约 70%、尚未端到端跑通"，并规划了 6–8 周 MVP。**该时间线与范围已被实际进展取代**（3 天内已跑通真实出片）。

| 文件 | 归档原因 | 现状在哪 |
| --- | --- | --- |
| `INDEX.md` | 09-09 文档总入口，已被 `docs/README.md` 取代 | `docs/README.md` |
| `可行性分析报告.md` | 立项期可行性评估（评分 4.2/5），结论已落地 | `PROJECT_STATUS.md` |
| `需求澄清与架构分析.md` | 需求与架构的早期澄清 | `architecture/seedance-integration-baseline.md` |
| `迁移vs重写决策分析.md` | 决策记录：最终选择重写 | 同上 |
| `旧项目流程分析与推荐方案.md` | 旧系统流程分析（历史输入） | `PROJECT_STATUS.md` |
| `旧项目可借用资产清单.md` | 旧代码复用清单（当时估 60–70% 可借用） | 同上 |
| `迁移指南.md` | **迁移方案已废弃**：当前仓库是重写实现，且文中引用了已不存在的旧项目路径与 `workflows/` | — |
| `MVP开发计划.md` | 6–8 周计划已被 `ROADMAP.md` 取代 | `ROADMAP.md` |
| `MVP快速跑起来方案.md` | 早期跑通方案，已被实际部署取代 | `runbooks/deploy-and-rollback.md` |
| `部署前讨论清单.md` | 上线前讨论项，已并入现行 runbook 与安全门禁 | `runbooks/deploy-and-rollback.md` §3 |
| `创意人员快速上手方案.md` | 被 09-10 调用手册取代 | `runbooks/creative-user-guide.md` |
| `域名配置方案-ai.sweetyshell.com.md` | 596 行配置教程，**其中把 Worker `/health` 代理到公网，违反安全边界**；现行事实已提炼 | `runbooks/domain-and-https.md` |
| `服务器部署可行性分析报告.md` | 部署可行性评估，现已实际部署 | `PROJECT_STATUS.md` §3.4 |
| `服务器登录与环境分析完整文档.md` | 服务器环境勘察记录 | 同上 |
| `服务器环境检查报告.md` | 环境检查快照（含旧端口方案） | `runbooks/deploy-and-rollback.md` |
| `API能力验证报告.md` | 火山/Seedance API 早期验证记录 | `PROJECT_STATUS.md` |
| `基于实际业务的文件哈希方案.md` | 素材去重方案输入 | `architecture/seedance-integration-baseline.md` §6 |
| `文件哈希性能优化方案.md` | 同上 | 同上 |
| `文件相同性判断技术方案.md` | 同上 | 同上 |
| `素材去重与引用管理方案.md` | 同上，已实现为 Asset 内容寻址 | `PROJECT_STATUS.md` §3.1 |
| `完整数据追踪架构设计.md` | 追溯架构设计，已实现为 Task/ExecutionAttempt/Asset | `architecture/seedance-integration-baseline.md` §3 |
| `下一步建议…Preview 闭环验收….md` | **结论已过时**：该文主张"不要做 Production"，此后已完成真实 Production 出片 | `ROADMAP.md` |
| `Day1完成总结.md`、`Day1完成总结.md`、`Day2本地测试总结.md`、`🎉Day2完成总结.md` | 开发日志，含重复版本 | — |
| `deployment-summary.md`（原 `docs/deployment-summary-20260909.md`） | 09-09 部署总结，修复描述与当前代码不一致 | `PROJECT_STATUS.md` |

### 2026-09-10 —— 评审与真实出片期

| 文件 | 归档原因 | 现状在哪 |
| --- | --- | --- |
| `项目代码评审报告.md` | **修复前快照**：所报 P0-1/2/4/6 已修复，且已完成真实出片；该文"当前不可上线"的结论已不适用（其安全清单仍有参考价值） | `PROJECT_STATUS.md` §4 |
| `整体代码审核报告.md` | 同上，评审时点更早；"无鉴权 / 无 Assets 模块"等结论已被推翻 | 同上 |
| `真实出片后链路缺口分析.md` | 前半部分为实施前分析（文中第十四节已自标边界），部分缺口已修复 | 同上 |
| `当前代码已经具备什么.md` | **已被推翻**：文中称"没有真正的身份和鉴权""Backend 中没有 Assets 模块"，两者均已存在 | 同上 |
| `Seedance统一调用与创意交付总结.md` | 交付总结，含"`mode: production` 被服务端禁止"等过时措辞（实为白名单门控） | `runbooks/creative-user-guide.md` |
| `上线检查与回滚记录模板.md` | 旧模板把未鉴权接口当 smoke，已被安全版 runbook 取代 | `runbooks/deploy-and-rollback.md` |

### 2026-09-11 —— 首次现状分析

| 文件 | 归档原因 | 现状在哪 |
| --- | --- | --- |
| `项目现状分析与未来规划.md` | 首版分析的**时间点快照**；内容已拆分并升级为两份 living 文档 | `PROJECT_STATUS.md` + `ROADMAP.md` |

### plans —— 历史实施计划

| 文件 | 归档原因 | 遗留事项去向 |
| --- | --- | --- |
| `2026-09-10-comfyui-unified-seedance-platform.md` | 平台化总计划，主体已实施 | `ROADMAP.md` |
| `2026-09-10-close-attempt-asset-traceability-gaps.md` | 追溯性补齐计划，Task 1/3/4/5 已实施 | `PROJECT_STATUS.md` §3 |
| `2026-09-11-preview-delivery-closure.md` | 执行过程快照；其中客户端、Worker 空 claim、凭证卫生与部署事项已在 2026-09-11 收尾 | `PROJECT_STATUS.md` + `ROADMAP.md` |

---

## 归档文档中的过时结论速查

引用归档文档时，先确认没有踩到以下已被推翻的结论：

1. "当前系统没有鉴权 / 没有 Assets 模块" → 两者都已存在。
2. "当前不可上线，主链路三条 P0 未修" → 已修复并真实出片。
3. "不要做 Production，停留在 Preview" → 已按白名单灰度策略推进。
4. "`mode: production` 被服务端禁止" → 是白名单门控，白名单为空时 403。
5. "必须先有 `params.image_url`" → 现行首选 `params.image_asset_id`。
6. 各类测试数字（29 / 40 / 77 / 30 failed 等）→ 以 `PROJECT_STATUS.md` §5 的实测为准。
7. 旧 `/api/tasks` 的“零鉴权”描述 → 已按 Admin / Worker 用途加 Guard；现行 smoke 见 `runbooks/deploy-and-rollback.md`。

---

## 已知链接问题

- `2026-09-09/迁移指南.md` 中的链接大多指向**旧项目**的文档与目录（如 `参考资料/`、`docs/AI创意生产工作流平台开发文档.md`、`../workflows/README.md`），这些目标在本仓库中**从未存在**，归档前即为失效链接。该文档整体是废弃的迁移方案，无需修复。
- 其余归档文档的相对链接在其目录整体迁移后仍然有效。
