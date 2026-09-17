# 私域素材库与肖像素材通路分析

> 日期：2026-09-17
> 用途：记录「含人脸的参考素材」与「方舟私域素材库」两条官方通路，对照本系统现状，列出缺口与待决策项。
> **本文不是当前系统状态**：现状以 [PROJECT_STATUS.md](../PROJECT_STATUS.md) 顶部为准，实施顺序见 [ROADMAP.md](../ROADMAP.md)。
> **本文不构成任何授权**：既不代表已决定实现，也不代表已获得采购或合规批准。文中列出的产品决策未完成前，不得据此开工。

## 0. 结论摘要

- **从 `PRODUCT.md §4.1` 的「八类工作流」清单看没有缺口**：八类均已实现，七条开放且带真实验收记录，单参考图那条已退休并入全模态参考。
- 本文分析的是**另一个维度：素材来源与人脸合规**。
- 合同里**已经记录**这条边界但**没有任何实现**：`contracts/seedance-workflows.v2.json` 的 `media.humanFacePolicy`（第 189 行）写明 `directReferenceUploadSupported: false`，`grep humanFacePolicy` 全仓库只命中四份合同副本（源合同 + Backend/Worker/dist 各一份），**零代码、零测试**读取它。
- 最尖锐的一处冲突：官方「信任模型产物」通路只认**原始产物**，而本系统现有链路会把 provider 产物**下载并重新上传到自己的 OSS**——副本还算不算原始产物，**没有验证过**。这直接决定「多轮改片」能否成立。

## 1. 证据来源

| 来源 | 位置 | 等级 |
| --- | --- | --- |
| 私域虚拟人像素材资产库使用指南 | `docs/arkdocs/私域虚拟人像素材资产库使用指南.md` | A：官方原始文档快照 |
| 私域真人人像素材资产使用指南 | `docs/arkdocs/私域真人人像素材资产使用指南.md` | A：官方原始文档快照 |
| 便利创作含肖像视频（三条官方通路总览） | `docs/arkdocs/Doubao Seedance 便利创作含肖像视频.md` | A：官方原始文档快照 |
| 合同已记录的人脸边界 | `contracts/seedance-workflows.v2.json` → `media.humanFacePolicy` | A：合同字段（无实现） |

## 2. 官方事实

### 2.1 硬约束

**Seedance 2.5 / 2.0 系列不支持直接上传含真人人脸的参考图/视频**。方舟会在生成时对含风险的参考素材输入做拦截。

注意这条与「素材本身合法」无关——即使素材是客户自有版权，含真人人脸的参考图/视频走**直传 URL** 这条路仍然会被拦。

### 2.2 三条官方通路

| 通路 | 素材形态 | 门槛 | 有效期 |
| --- | --- | --- | --- |
| 信任模型产物 | 本账号下近 30 天内由 Seedance 2.5/2.0 生成的含人脸**视频**；对应**尾帧图片**；Seedream 5.0 文生图得到的含人脸图片 | 免费 | 从产物生成时间起 30 天 |
| 预置虚拟人像 | 平台预置库，`asset://<asset ID>` 直取 | 官方描述为**免费**；是否需单独开通待确认 | — |
| 私域虚拟人像库 | 自建 Asset Group + Asset，`asset://<asset ID>` | **Seedance 高级创作权益包**（付费，与真人人像库共享容量） | — |
| 已授权真人库 | H5 活体认证 → GroupId → 上传素材，`asset://<asset ID>` | 权益包 + 真人认证 + **面部一致性比对** | — |

> 表格中「信任模型产物」的生效时间：含人脸视频自 2026-03-11 起，尾帧图片与 Seedream 5.0 图片自 2026-04-16 起。

### 2.3 信任模型产物的四条限制（关键）

1. **仅信任方舟平台产物**，不支持跨平台；
2. **仅信任同账号产物**，不支持跨账号；
3. **仅信任模型原始产物**——二次剪辑或超过有效期后均不可使用；
4. **压缩或转发文件易引发信任失效**，官方建议直接将模型原始产物转存至 TOS。

另：仅对**输入**做信任，输出依然可能命中安全审核而失败。

### 2.4 私域素材库的结构与接口

- 结构：`Asset Group`（组合）⊃ `Asset`（单个素材文件，支持图像/视频/音频）。
- 创建接口：`CreateAssetGroup`、`CreateAsset`（**异步**，需轮询 `GetAsset` 直到 `Status` 为 `Active`，`Failed` 即失败）。
- 管理接口：`ListAssetGroups`、`ListAssets`、`GetAsset`、`GetAssetGroup`、`UpdateAsset`、`UpdateAssetGroup`、`DeleteAsset`、`DeleteAssetGroup`。
- **鉴权用 Access Key（AK/SK）**，不是视频生成的 API Key；需 IAM 权限（`ark:*Asset*`）。
- **ProjectName 隔离**：Asset 所属 ProjectName 必须与调用视频生成接口时 API Key 所属 ProjectName 一致，否则素材用不了或查不到。默认值 `default`。
- 图像素材格式要求：宽高比 (0.4, 2.5)、宽高 300–6000 px、单张 <30 MB。
- 人像入库最佳实践：全身正面竖版图 + 正面无表情肩部以上特写（面部占画面 2/3）。

### 2.5 真人人像库的额外流程

1. `CreateVisualValidateSession` 拉起 H5 活体认证页（H5Link）；
2. 终端用户**在手机上**完成认证，回调 URL 带 `resultCode`（`10000` 为通过）与 `bytedToken`；
3. `GetVisualValidateResult` 用 BytedToken 换 `GroupId`（**BytedToken 有效期 30 分钟**；认证失败则 H5 链接失效，需重新生成）；
4. 上传素材时系统做**与认证基准图的面部特征一致性比对**，非同一人物无法入库；**检测到多个人脸时无法入库**；
5. 一个 Asset Group 唯一绑定一个真人；同一人新增妆造只需往同组追加素材，**无需重复认证**。

### 2.6 用法约定

- 视频生成请求里用 `asset://<asset ID>` 填入 `content.<模态>_url.url`；
- **提示词中必须用「图片1 / 视频1 / 音频1」指代**，序号为请求体中同类素材的排序；**禁止在提示词里写 Asset ID**。

## 3. 本系统现状（可复核）

### 3.1 现有素材链路是唯一一条

```
创意本地文件 → 客户端 SHA-256/ffprobe 检查 → 上传本系统自己的 OSS
   → Worker 提交前向 Backend 换取签名 URL → 作为 image_url/video_url/audio_url 传给方舟
```

代码位置：

- `packages/worker/executor.py:935`——把 `executionPlan.media` 展开成 `media_urls`；
- `packages/worker/executor.py:728-737`——`resolve_asset_url()` 通过 Backend 内部接口换取 `downloadUrl`（我方 OSS 签名地址）；
- `packages/worker/providers/seedance_execution_policy.py:38-42`——角色到 URL 字段的映射（`reference_image → image_url` 等）。

链路里**没有任何一处能产生 `asset://` 形态的 URL**。

### 3.2 客户端素材入口全部是本地文件

`packages/comfyui-video-flow-client/preflight_nodes.py` 的 `_file_choices()` 从 ComfyUI input 目录列举文件，**没有「从素材库选」的入口**。

### 3.3 合同已记录边界但未实现

`contracts/seedance-workflows.v2.json`：

```json
"humanFacePolicy": {
  "directReferenceUploadSupported": false,
  "note": "Use an officially permitted model output, virtual-person asset, or separately verified authorized-person asset. A Video Flow assetId is not an Ark authorization asset."
}
```

已明确「Video Flow 的 assetId **不是**方舟的授权素材」——即我方 Asset 记录与方舟 Asset ID 是两套东西，不能互相冒充。

### 3.4 直接后果

创意若往参考图槽位放一张真人照片：客户端与 Backend **都不会提前识别**，预检报告也不会提示；任务会提交到方舟后在**输入审核**环节被拦。

## 4. 缺口清单

| 编号 | 缺口 | 性质 |
| --- | --- | --- |
| G1 | 无法产生/传递 `asset://` 形态的素材 URL | 技术：素材来源扩展 |
| G2 | 客户端无「从素材库选素材」入口，只能选本地文件 | 技术：客户端 |
| G3 | Backend 无法校验方舟 asset 的归属与 `Status=Active` | 技术：服务端校验 |
| G4 | 无素材库管理能力（建组/上传/轮询/检索/删除/容量） | 技术：新子系统 |
| G5 | AK/SK 签名、IAM 权限、ProjectName 一致性均未接触 | 技术 + 密钥管理 |
| G6 | 缺**异步**素材状态机（`Processing → Active/Failed`）；现有校验是同步的 SHA-256 + ffprobe | 技术：模型差异 |
| G7 | 缺真人 H5 活体认证流程（本系统内完全空白） | 产品流程 + 合规 |
| G8 | 产物归档后能否作为「信任模型产物」复用，未验证 | **待验证的关键未知** |
| G9 | 素材库素材没有留存/生命周期策略（30 天信任期、容量共享、`LastInferenceTime` 清理） | 产品决策 |

## 5. 需要做的工作（三类）

### 第一类：素材来源扩展（技术改动，不是新工作流）

让 `asset://` 成为一种合法的 URL 形态：合同 media（roles 不变，多一种 URL 形态）→ Backend 素材校验（asset 归属、状态 `Active`、ProjectName 一致性）→ Worker 直通（不解析、不换成签名 URL）→ 客户端新增「从库选」节点。

### 第二类：产品级入口

| 编号 | 工作流 | 价值 | 前置 |
| --- | --- | --- | --- |
| W1 | **虚拟人像生视频**（预置人像 / 私域虚拟人像库） | 同一形象跨多条视频保持一致——**现在做不到**（每次生成角色随机）；数字人口播是带货标准形态 | 权益包（付费）、AK/SK、ProjectName 一致性 |
| W2 | **授权真人人像生视频** | 真人出镜 | H5 活体认证流程（艺人在手机上完成）；**产品与合规决策未决** |
| W3 | **素材资产库管理**（配套能力，非生成流） | 建组/上传/轮询/检索/删除/容量 | AK/SK 签名；异步状态机 |
| W4 | **信任产物二次创作** | 多轮改片 | 先验证 G8 |

> W1 严格说是**素材来源变体**而非全新的第九类工作流；之所以值得独立入口，是因为素材从「库里选」而非「本地上传」、提示词写法不同（`@图片1` 即虚拟人像）、且「一致性」本身就是卖点。

### 第三类：必须先回答的问题

| # | 问题 | 为什么必须先答 |
| --- | --- | --- |
| Q1 | **成片到底要不要真人出镜？** | 决定 W1/W2 是否值得做；只做产品图/静物则全部白做 |
| Q2 | 要不要买 **Seedance 高级创作权益包**？ | W1（私域库）/W2/W3 的硬前置，是付费采购 |
| Q3 | 若用真人，**谁负责肖像授权与记录、记录到什么程度**？ | `PRODUCT.md §8` 已列为待讨论的产品决策，触发时机写明是「扩大真实素材使用前」——**合规红线，不应由开发自行决定** |
| Q4 | AK/SK 放哪、怎么管？ | 现有边界是「创意电脑不持有任何密钥」；新通路需明确密钥落在 Backend/Worker 而非客户端 |

## 6. 建议顺序

1. **先答第三类问题**，尤其 Q1——其余都是它的下游；
2. **W4 先做一次只读验证**：拿本系统自己生成的一条含人脸视频，尝试作为输入再用一次，确认 G8 是否成立。**成本最低、结论最硬**，且直接决定「多轮改片」能否做；
3. 需要数字人形象则上 **W1**（W3 是它的前置实现）；
4. **W2 最后**，等 Q3 的合规决策落地。

### W4 验证要点（尚未执行）

- 用**原始产物**（非二次剪辑、非转码、30 天内、同账号）作为 `reference_video` 提交；
- 分别验证两条来源：(a) 直取方舟产物地址；(b) 取本系统 OSS 归档副本；
- **(b) 是本次验证的关键**——若副本被判定信任失效，则需改产物留存策略（保留原始引用或转存方式）；
- 记录方舟返回的拦截码与原文，作为合同证据。

## 7. 与现有文档的关系

- `PRODUCT.md §4.1`（八类工作流范围）与 **§8 待讨论的产品决策**（「内容和素材治理」一行）——本文的 Q1–Q3 属于该行，决策前不得把本文内容当作已批准范围；
- `PROJECT_STATUS.md`——本文不改变「当前状态」，实现落地后按规则只更新那里；
- `ROADMAP.md`——本文不含排期；若 Q1–Q3 有结论，先更新 `PRODUCT.md` 再排期；
- `docs/architecture/seedance-2-5-contract-evidence.md`——合同字段的证据摘要，本文的 `humanFacePolicy` 属同一体系。

## 8. 修订记录

| 日期 | 变更 |
| --- | --- |
| 2026-09-17 | 首版：依据三份方舟官方文档快照（私域虚拟人像库 / 私域真人人像库 / 便利创作含肖像视频）与现有链路代码，形成缺口清单与待决策项 |
