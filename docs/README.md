# docs/ 文档索引（唯一入口）

> 最后整理：2026-09-15
> 本文件是 `docs/` 的唯一入口。新增或修改文档前请先读本文件末尾的【文档规则】。

---

## 1. 先看哪一份？

| 你的问题 | 看这里 |
| --- | --- |
| 这个产品为谁解决什么问题、范围和非目标是什么？ | **[PRODUCT.md](./PRODUCT.md)** |
| 代码现在到底能做什么、不能做什么？ | **[PROJECT_STATUS.md](./PROJECT_STATUS.md)** |
| 接下来做什么、什么时候做、怎么验收？ | **[ROADMAP.md](./ROADMAP.md)** |
| 一项工作从讨论到完成必须经过什么流程？ | **[DEVELOPMENT_WORKFLOW.md](./DEVELOPMENT_WORKFLOW.md)** |
| 所有工作流必须遵循什么开发规范？ | [Preview 与 Production 统一需求规范 v2](./requirements/2026-09-15/workflow-preview-production-spec-v2.md) |
| 系统边界和技术约束是什么？ | [architecture/seedance-integration-baseline.md](./architecture/seedance-integration-baseline.md) |
| Production 如何防重复、恢复和顺序生成下一版？ | [ADR-0001：Production 执行槽](./architecture/adr/0001-production-execution-slot.md) |
| 怎么部署、怎么回滚？ | [runbooks/deploy-and-rollback.md](./runbooks/deploy-and-rollback.md) |
| 创意同事怎么用？ | [runbooks/creative-user-guide.md](./runbooks/creative-user-guide.md) |
| 历史上都分析过什么？ | [archive/README.md](./archive/README.md) |

本轮 Creative MVP T00–T01 的实施与验证快照见：[2026-09-11-creative-mvp-T00-T01-summary.md](./archive/2026-09-11-creative-mvp-T00-T01-summary.md)。

最新 T04–T07 实施与验证快照见：[2026-09-11-creative-mvp-T04-T07-summary.md](./archive/2026-09-11-creative-mvp-T04-T07-summary.md)。

**只有两份文档描述"当前事实"和"当前计划"：`PROJECT_STATUS.md` 与 `ROADMAP.md`。其余文档一律是参考材料或历史记录，不得作为现状依据。**

---

## 2. 权威文档（Living Documents）

这两份文档随代码演进而更新，任何与其冲突的说法都以其为准。

| 文档 | 作用 | 更新时机 |
| --- | --- | --- |
| [PROJECT_STATUS.md](./PROJECT_STATUS.md) | 唯一权威现状：已完成能力、已知缺口、风险登记册、验证命令 | 每次合并到 `main` 后；发现文档与代码不符时 |
| [ROADMAP.md](./ROADMAP.md) | 唯一权威计划：阶段目标、任务、出口门禁、里程碑、度量指标 | 每阶段开始/结束时；范围变更时 |

## 3. 需求规范与参考文档

### 产品定义

- [Video Flow 产品定义](./PRODUCT.md)：规定目标用户、核心场景、本期范围、非目标、产品原则和完成判断；未形成结论的产品问题单独列为待讨论事项，不代表实现或排期。

### 工程流程规范

- [Video Flow 开发工作流](./DEVELOPMENT_WORKFLOW.md)：规定产品探索、需求固化、代码库探索、技术决策、垂直切片、验证先行、Agent 分步实现、独立审查、集成验证和经验沉淀的统一门禁；不描述当前实现或具体排期。

### 强制需求规范

- [工作流 Preview 与 Production 统一需求规范 v2](./requirements/2026-09-15/workflow-preview-production-spec-v2.md)：所有新增与改造工作流的当前需求依据；规定独立预检记录、双结果报告、实际参数报价、四维工作流状态、正式快照和原任务恢复边界。此文档描述应达到的行为，不代表已实现。
- [ADR-0001：Production 执行槽与重复生成](./architecture/adr/0001-production-execution-slot.md)：记录持久 Production 模式、稳定执行槽、一版一个 Task、本地交付完成边界和失败恢复规则；属于已接受的目标架构决策，不代表代码已实现。
- [工作流统一规范 v1.1 历史快照](./archive/2026-09-14-workflow-preview-production-spec-v1.1.md)：保留 2026-09-14 原始需求，已被 v2 取代。

### 职责讨论归档

- [Preview 与 Production 职责界定（2026-09-15）](./2026-09-15/Preview与Production职责界定.md)：保存两种模式的功能边界、预检与确认、估算与结算、所有工作流的开发目标及完成定义；属于讨论结论，不代表已实现，也不直接修改既有强制规范或生产开放配置。
- [Preview 与 Production 代码符合性评审（2026-09-15）](./2026-09-15/Preview与Production代码符合性评审.md)：保存逐项规则判断、F01–F15发现、代码依据与当日复现/测试范围；固定日期快照，修复后不回填。
- [Seedance 2.5 工作流与计费合同证据（2026-09-15）](./2026-09-15/Seedance-2.5工作流与计费合同证据.md)：保存 R0 官方模型、八类工作流、4–30 秒、媒体与计费取证；不代表代码已实现。
- [Preview / Production 旧设计替换清单（2026-09-15）](./2026-09-15/Preview-Production旧设计替换清单.md)：保存旧入口、调用者、数据兼容边界和 F01–F15 新责任映射。
- 当前修正顺序见 [ROADMAP R0–R8](./ROADMAP.md)：先重整职责与合同，再逐个完成八类工作流；已取代固定规格MVP和仅Preview扩展计划。实施结果只在PROJECT_STATUS维护。

### 架构与约束

| 文档 | 说明 |
| --- | --- |
| [architecture/seedance-integration-baseline.md](./architecture/seedance-integration-baseline.md) | 冻结的系统边界、稳定领域模型（Task / ExecutionAttempt / Asset / ActorCredential）、API 兼容规则、执行与计费规则、迁移与回滚原则 |
| [architecture/adr/0001-production-execution-slot.md](./architecture/adr/0001-production-execution-slot.md) | Production 模式、执行槽、顺序生成、Task / Attempt 语义和本地交付完成边界的架构决策 |
| [architecture/video-workflow-interface-research-2026-09-14.md](./architecture/video-workflow-interface-research-2026-09-14.md) | 视频工作流、统一任务接口与媒体角色调研；记录待决策的 Workflow Registry 方向，不描述当前生产能力 |
| [architecture/seedance-2-5-contract-evidence.md](./architecture/seedance-2-5-contract-evidence.md) | 2026-09-14 分阶段取证记录；最新 R0 合同证据看当日快照，不描述当前生产能力 |
| [architecture/seedance-2-5-official-pdf-digest-2026-09-14.md](./architecture/seedance-2-5-official-pdf-digest-2026-09-14.md) | Steven 下载的火山方舟官网 PDF 整理：字段、媒体限制、查询/取消合同与提示词落地规则；不描述当前生产能力 |

### 运行手册（Runbooks）

- [产品参考图预检与正式确认](./runbooks/product-preflight.md)：配套接口、模板及无付费验证；是否发布以 PROJECT_STATUS 为准。

| 文档 | 说明 |
| --- | --- |
| [runbooks/deploy-and-rollback.md](./runbooks/deploy-and-rollback.md) | 上线前检查、上线步骤、Smoke Test、回滚动作与记录模板 |
| [runbooks/preview-acceptance.md](./runbooks/preview-acceptance.md) | Preview 零付费验收清单与 2026-09-11 实测记录 |
| [runbooks/creative-user-guide.md](./runbooks/creative-user-guide.md) | v2 重构期间的创意同事安全边界：凭证保护、已有任务查询/取片、当前禁止的新建任务操作 |
| [runbooks/local-manual-test.md](./runbooks/local-manual-test.md) | ComfyUI 本地隔离验收：一键启动测试 Backend/PostgreSQL/Worker/Fake Provider/Fake OSS，执行真实 Queue、落盘和播放；不构成 Ark 正式验收证据 |
| [runbooks/creative-one-click-script.md](./runbooks/creative-one-click-script.md) | 旧一键脚本的停用状态与恢复条件；当前不得用于创建新任务 |
| [runbooks/domain-and-https.md](./runbooks/domain-and-https.md) | `ai.sweetyshell.com` 域名、Nginx 与证书配置 |

## 4. 历史归档

`archive/` 保存所有被取代的分析、评审与计划快照，**内容一律不再维护**，仅用于追溯决策过程。逐条归档原因见 [archive/README.md](./archive/README.md)。

---

## 5. 历史文档与代码实测的已知矛盾

下表记录本次（2026-09-11）收敛时发现的矛盾。**这些历史说法已经过时，不要再引用。**

| 历史说法 | 出处（已归档） | 实测事实 |
| --- | --- | --- |
| "没有真正的身份和鉴权""Backend 中没有 Assets 模块" | `2026-09-10/当前代码已经具备什么.md` | 鉴权（`src/auth/`）与 Assets 模块（`src/assets/`、`src/v1/assets/`）均已存在 |
| "三条主链路互相不匹配，当前不可上线"（P0-1/2/4/6） | `2026-09-10/项目代码评审报告.md` | 该报告是修复前快照；P0-1/2/4/6 已修复，且 2026-09-10 已真实付费出片成功 |
| "应停留在 Preview，不要直接做 Production" | `2026-09-09/下一步建议…md`、`2026-09-10/当前代码已经具备什么.md` | 已完成一次真实 Production 出片；现行策略是"白名单灰度 + 额度闸门"，见 ROADMAP |
| "`mode: production` 目前被服务端禁止" | `2026-09-10/Seedance统一调用与创意交付总结.md` | 是白名单门控（`VIDEO_FLOW_PRODUCTION_ACTORS`），不是永久禁止；白名单为空时返回 403 |
| "必须有 `params.image_url`" | `2026-09-10/Seedance统一调用与创意交付总结.md` | 任务入口现行使用 `workflowKey` 与 `media[].assetId`；旧 `capability/profile/params` 已不再接受 |
| 测试口径 "Backend 40 / 客户端 8 / Worker 77+26skip"、"Jest 29 / pytest 30 failed" | 多份 09-09/09-10 文档 | 当前数字以 [PROJECT_STATUS](./PROJECT_STATUS.md) 的完整验证结果为准 |
| "旧 `/api/tasks` 零鉴权" | 09-10 与早期 09-11 文档 | 2026-09-11 已按 Admin / Worker 用途加 Guard，并完成公网 401 验收 |

> 如果再次发现文档与代码不符：以代码为准，更新 `PROJECT_STATUS.md`，并把过时文档移入 `archive/`。

---

## 6. 文档规则

1. **事实只有一个出口。** 描述"系统现在是什么样"的内容只写进 `PROJECT_STATUS.md`；其他文档需要现状时用链接引用，不复制。
2. **计划只有一个出口。** 排期、任务、门禁只写进 `ROADMAP.md`。
3. **文档必须带可验证证据。** 现状类结论需给出文件路径（必要时到行号）和验证命令，禁止只写结论。
4. **过期文档进 `archive/`，不删除。** 移动时在 `archive/README.md` 中补一行：为什么归档、被谁取代。
5. **运行手册必须可执行。** 命令、参数、鉴权头、期望返回码要写全，且必须与当前代码一致；接口变更时同步更新。
6. **已归档文档不再修改。** 需要更新的是 living 文档，不是历史快照。
