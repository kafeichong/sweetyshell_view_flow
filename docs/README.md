# docs/ 文档索引（唯一入口）

> 最后整理：2026-09-11
> 本文件是 `docs/` 的唯一入口。新增或修改文档前请先读本文件末尾的【文档规则】。

---

## 1. 先看哪一份？

| 你的问题 | 看这里 |
| --- | --- |
| 代码现在到底能做什么、不能做什么？ | **[PROJECT_STATUS.md](./PROJECT_STATUS.md)** |
| 接下来做什么、什么时候做、怎么验收？ | **[ROADMAP.md](./ROADMAP.md)** |
| 系统边界和技术约束是什么？ | [architecture/seedance-integration-baseline.md](./architecture/seedance-integration-baseline.md) |
| 怎么部署、怎么回滚？ | [runbooks/deploy-and-rollback.md](./runbooks/deploy-and-rollback.md) |
| 创意同事怎么用？ | [runbooks/creative-user-guide.md](./runbooks/creative-user-guide.md) |
| 历史上都分析过什么？ | [archive/README.md](./archive/README.md) |

**只有两份文档描述"当前事实"和"当前计划"：`PROJECT_STATUS.md` 与 `ROADMAP.md`。其余文档一律是参考材料或历史记录，不得作为现状依据。**

---

## 2. 权威文档（Living Documents）

这两份文档随代码演进而更新，任何与其冲突的说法都以其为准。

| 文档 | 作用 | 更新时机 |
| --- | --- | --- |
| [PROJECT_STATUS.md](./PROJECT_STATUS.md) | 唯一权威现状：已完成能力、已知缺口、风险登记册、验证命令 | 每次合并到 `main` 后；发现文档与代码不符时 |
| [ROADMAP.md](./ROADMAP.md) | 唯一权威计划：阶段目标、任务、出口门禁、里程碑、度量指标 | 每阶段开始/结束时；范围变更时 |

## 3. 参考文档

### 架构与约束

| 文档 | 说明 |
| --- | --- |
| [architecture/seedance-integration-baseline.md](./architecture/seedance-integration-baseline.md) | 冻结的系统边界、稳定领域模型（Task / ExecutionAttempt / Asset / ActorCredential）、API 兼容规则、执行与计费规则、迁移与回滚原则 |

### 运行手册（Runbooks）

| 文档 | 说明 |
| --- | --- |
| [runbooks/deploy-and-rollback.md](./runbooks/deploy-and-rollback.md) | 上线前检查、上线步骤、Smoke Test、回滚动作与记录模板 |
| [runbooks/preview-acceptance.md](./runbooks/preview-acceptance.md) | Preview 零付费验收清单与 2026-09-11 实测记录 |
| [runbooks/creative-user-guide.md](./runbooks/creative-user-guide.md) | 创意同事接口手册：签发凭证、上传素材、创建任务、查询结果、常见错误 |
| [runbooks/creative-one-click-script.md](./runbooks/creative-one-click-script.md) | `scripts/seedance_cli_smoke.sh` 的使用说明 |
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
| "必须有 `params.image_url`" | `2026-09-10/Seedance统一调用与创意交付总结.md` | 现行链路是客户端上传素材拿 `asset_id`，服务端用 `params.image_asset_id`（`image_url` 仍兼容） |
| 测试口径 "Backend 40 / 客户端 8 / Worker 77+26skip"、"Jest 29 / pytest 30 failed" | 多份 09-09/09-10 文档 | 2026-09-11 实测：Backend 63 通过（12 套件）；Worker 79 通过 / 26 跳过；客户端 14 通过 |
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
