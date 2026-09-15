# 工作流 Preview 与 Production 统一需求规范 v2

- 版本：v2.1
- 确认日期：2026-09-15
- 性质：后续重构的强制产品与技术规范，不代表当前代码已实现。
- 取代范围：取代 [v1.1](../../archive/2026-09-14-workflow-preview-production-spec-v1.1.md) 中“预检复用 Preview Task”“单一状态表达工作流成熟度”和客户端重复提交正式内容的设计空间；v1.1 保留为历史需求依据。
- 当前实现与验证：只看 [PROJECT_STATUS](../../PROJECT_STATUS.md)。实施顺序：只看 [ROADMAP](../../ROADMAP.md)。
- 可执行模型合同：[contracts/seedance-workflows.v2.json](../../../contracts/seedance-workflows.v2.json)。
- Production 执行槽决策：[ADR-0001](../../architecture/adr/0001-production-execution-slot.md)。

## 1. 产品目标

新建 ComfyUI 画布默认执行 Preview。用户明确切换到 Production 后，该模式保持不变，不在每轮生成后自动回退，也不增加一次性确认系统。系统只有在当前内容具备匹配的有效预检，并通过正式准入后，才允许上传素材和调用正式 Provider 接口。

如果 Production 模式下当前内容没有有效预检，本次 Queue 自动执行 Preview 并停止；用户查看报告后再次 Queue 才能正式生成。有效预检可以被同一内容的多次顺序生成复用，但每个输出视频仍是独立 Task、独立预占和独立计费。

八类工作流都按完整链路开发，不以“只做 Preview”作为最终状态：

1. 文生视频；
2. 参考图片生视频；
3. 首帧生视频；
4. 首尾帧生视频；
5. 全模态参考生视频；
6. 视频编辑；
7. 视频延长；
8. 音频参考生视频。

普通生成与视频延长在产品层开放明确的整数 `4–30` 秒。视频编辑遵守官方特殊合同：`ratio=adaptive`、`duration=-1`，输出时长跟随待编辑视频，不能把普通 4–30 秒参数强套到编辑请求。

## 2. Preview 的唯一职责

Preview 接收提示词、生成参数以及本地素材描述，返回规范化请求、逐项检查、当时的 Production 准入信息和可解释报价。

Preview 必须：

- 鉴权；
- 检查工作流、提示词、参数、素材角色/顺序/数量和客户端上报的元信息；
- 将“请求是否有效”和“当前能否正式提交”分开报告；
- 生成独立 `PreflightRecord`；
- 返回 `willUploadMedia=false`、`willCallProvider=false`；
- 能可靠估价时返回依据，不能可靠估价时返回 `unavailable` 和缺项。

Preview 禁止：

- 上传文件、缩略图或 Base64；
- 提供让服务器拉取本地素材的 URL；
- 创建 Task、ExecutionAttempt 或预算预占；
- 调用生成 Provider；
- 伪造任务 ID、成片或 0 元价格。

Production 白名单、暂停、额度不足、工作流尚未启用等情况属于 `productionAdmission.blockers`，不能阻止已鉴权用户取得请求检查报告。鉴权失败仍直接拒绝。

## 3. Production 的唯一职责

Production 只接收预检快照引用、稳定执行槽标识和素材映射，不接受第二份可与预检冲突的 Prompt、生成规格、模型、价格或 Provider 字段。

正式提交必须同时满足：

- `PreflightRecord` 存在、属于当前 actor、未过期；
- `contractDigest`、`intentDigest`、`quoteDigest` 与当前请求一致；
- 当前工作流已实现且已启用；
- 当前 actor 通过生产权限、暂停和额度检查；
- 报价可用于预占，不存在未解决的强制计费规则；
- 用户已明确选择 Production，当前 Queue 绑定稳定 `executionSlotId`；
- 上传或复用的 Asset 与每个 `slotId`、角色、实际内容哈希和元信息一致；
- 服务端从实际对象重新识别文件，而不是信任扩展名、声明 MIME 或 OSS 自定义哈希；
- actor 与 `executionSlotId` 下不存在尚未本地交付完成的另一 Task，且本次创建的幂等检查通过。

通过后，服务端在同一原子边界内冻结 execution plan、创建 Task 并预占预算。Worker 只消费冻结快照，经唯一编译器调用火山方舟正式接口：

```text
POST /api/v3/contents/generations/tasks
model = doubao-seedance-2-5-260628
```

## 4. 统一请求合同

```ts
export type MediaRole = 'reference_image' | 'first_frame' | 'last_frame'
  | 'reference_video' | 'reference_audio';

export type MediaDescriptor = {
  slotId: string;
  role: MediaRole;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  metadata: {
    kind: 'image' | 'video' | 'audio';
    width?: number;
    height?: number;
    durationSeconds?: number;
    frameRate?: number;
    videoCodec?: string;
    audioCodec?: string;
  };
};

export type WorkflowIntent = {
  contractVersion: 2;
  workflowKey: string;
  prompt: { positive: string };
  generation: {
    duration: number;
    ratio: string;
    resolution: string;
    generateAudio: boolean;
    watermark: boolean;
    outputFormat: 'mp4' | 'mov';
  };
  media: MediaDescriptor[];
};

export type ProductionSubmission = {
  preflightId: string;
  executionSlotId: string;
  media: Array<{ slotId: string; assetId: string }>;
};
```

模型、`omni_reference_task_type` 等 Provider 字段由服务端合同解析，客户端不得任意指定。`slotId` 是一次意图内稳定的素材槽位，不等于 Asset ID；正式上传后用 `slotId → assetId` 映射。

影响产物或费用的字段必须全部进入 `intentDigest`。`executionSlotId`、对象 key、签名 URL、画布节点位置和报告展示文本不进入创作意图摘要；执行槽负责恢复和顺序控制，不属于创作内容。

## 5. 独立预检记录与报告

新增不可执行的 `PreflightRecord`：

| 字段 | 含义 |
| --- | --- |
| `id`、`actorId`、`createdAt`、`expiresAt` | 身份与有效期 |
| `contractVersion`、`workflowVersion` | 请求和工作流版本 |
| `contractDigest` | 会影响 Worker 执行的不可变规则摘要，不只哈希工作流名称；不包含当前准入、开发状态、验收记录、展示文本或价格 |
| `intentDigest` | 规范化生效请求摘要 |
| `quoteDigest` | 报价输入、价格和适用条件摘要 |
| `effectiveRequest` | 服务端唯一规范化请求 |
| `report` | 请求检查与准入阻止项 |
| `quoteSnapshot` | 本次报价和缺项 |

`PreflightRecord` 不使用 Task 状态，不可被 Worker claim，不创建 Attempt，不产生预算预占。历史 Preview Task 只保留只读查询，不可转换成 v2 正式凭证。

同一 `PreflightRecord` 可用于多次顺序 Production，但每次提交都必须重新检查：记录仍有效、三个摘要与当前内容一致、当时的准入和额度成立。内容、合同规则、报价输入或报价内容变化后，该记录不能用于新 Task；在 Production 模式下应先自动执行一次 Preview 并停止，而不是自动创建任务。

工作流目录另返回完整 `catalogDigest`，用于证明发布目录字节级状态；它可以随 `implementation`、`admission`、验收记录或价格变化。`contractDigest` 只覆盖模型、官方能力状态、工作流媒体角色、生成参数和 Provider 字段等执行规则。Worker 执行合法创建的 Task 时校验冻结 `contractDigest`、模型、工作流能力和参数，不重新读取当前 `admission.enabled` 或 `implementation`。执行规则升级时，旧摘要对应的 Worker 合同版本必须保留到旧 Task 排空，不能只保留最新目录后让历史 Task 失去执行依据。

`PreflightReport` 至少包含：

```ts
type PreflightReport = {
  preflightId: string;
  expiresAt: string;
  requestCheck: {
    status: 'passed' | 'failed' | 'incomplete';
    items: CheckItem[];
  };
  productionAdmission: {
    canSubmit: boolean;
    blockers: CheckItem[];
  };
  effectiveRequest: WorkflowIntent;
  model: string;
  workflowVersion: string;
  contractDigest: string;
  intentDigest: string;
  quote: Quote;
  willUploadMedia: false;
  willCallProvider: false;
};
```

接口职责：

- `POST /api/v1/tasks/preflight`：创建/复用独立预检记录并返回完整报告；
- `GET /api/v1/tasks/preflight/:id/check`：复验记录、报价和当前新任务准入，仍返回双结果；
- `POST /api/v1/tasks`：只创建 Production 新任务；旧 `mode=preview` 创建语义返回明确升级错误；
- `GET /api/v1/tasks/:id` 及结果接口：查询和恢复已有任务，不参与新任务准入。

## 6. 报价、预占和结算

官方公开估算公式：

```text
estimatedTokens =
  (全部输入视频实际总时长 + 输出视频时长)
  × 输出宽 × 输出高 × 24 / 1024

estimatedCny = estimatedTokens × applicableRateCnyPerMillion / 1_000_000
```

报价必须使用实际请求参数和已检查素材元信息：

- 多段输入视频时长求和，不能固定写 30 秒；
- 固定比例按官方像素表取宽高；
- `adaptive` 若由首帧或待编辑/延长视频锁定，使用该实际比例对应的已取证计算方法；其他情况使用明确上界或返回未知；
- `duration=-1` 使用已取证边界形成 bounded 报价，否则未知；
- 单价按是否包含输入视频和输出分辨率选择；
- 促销必须带生效区间，并确认当前账户/实际下单是否适用；
- 输入包含视频时必须执行官方最低 Token 规则。最低 Token 表未接入前，这类 Production 报价不得以简单公式值替代，状态为 `unavailable`；
- 金额使用 Decimal，不使用二进制浮点累计。

公开价格只能用于估算。正式任务冻结 `pricingSnapshot` 后按该快照解释 `usage.completion_tokens`；`usage_calculated` 仍不等同于 Provider 已确认账单，账单确认单独记录。Provider 未返回有效 usage 时保留待核查状态，不能回退为固定金额并宣称结算完成。

## 7. 工作流四维状态

每个工作流分别记录：

1. `capability: confirmed | unconfirmed | unsupported`：官方模型是否支持；
2. `implementation: incomplete | ready`：v2 全链代码、模板和合同是否完成；
3. `admission.enabled` 与原因：当前运行配置是否允许新 Production；
4. `validation`：真实账号、模型、参数组合、产物和费用证据。

“官方已确认”不等于“已实现”；“已实现”不等于“已启用”；一次真实成功不覆盖该工作流所有规格。首次真实验收也必须通过同一 Production 服务，不允许专用绕过接口。

R0 冻结时，8 类能力均为官方 `confirmed`；新的 v2 实现均为 `incomplete` 且 `admission.enabled=false`。后续只有达到对应阶段出口才逐项改变，不能直接把旧 `disabled` 改名冒充完成。

## 8. Production 执行槽与恢复边界

每个 Production 节点创建并持久化一个稳定的 `executionSlotId`。复制节点必须生成新槽；修改 Prompt、素材或生成参数不改变原槽。槽的所有权边界为 `actorId + executionSlotId`，同一槽不支持并行生成；需要并行时使用另一个 Production 节点。

Task 表示一个请求输出的视频。同一槽中“再生成一版”创建新 Task，并以 `slotSequence` 排序。ExecutionAttempt 只表示同一 Task 内部的执行、恢复或可控技术重试，不表示用户请求的新版本。

Backend 是槽当前 Task 的权威来源。Task 保存 `clientDeliveryStatus` 和 `clientDeliveredAt`；客户端回执只缓存 `executionSlotId`、Task ID、本地交付状态、本地路径和文件摘要。客户端在下载和校验后必须先持久化回执，再通过鉴权接口确认 client delivery，最后由节点返回本地路径；确认失败时 Task 继续占用槽。回执丢失或更换客户端后，仍须能按 actor 与槽查询并恢复最新未完成 Task。创建新 Task 时，Backend 必须在事务或等效串行化边界内检查该槽是否已有锁定 Task，避免并发 Queue 重复创建。

一轮生成只有在以下条件全部成立后才释放槽以允许下一版：Provider 成功、产物已归档、Backend 交付就绪、客户端下载并校验成功、节点已经返回本地路径。在此之前重复 Queue 必须恢复同一 Task。

下列情况继续锁定并恢复同一 Task：排队或运行中、Provider 创建结果不确定、已有 `providerTaskId` 但查询暂不可用、待人工核查、生成成功但归档中、交付失败、下载地址过期、客户端下载或文件校验失败、客户端等待超时。只有能够证明不会再产生该 Task 的结果时才释放槽，例如 Provider 明确失败且无产物、取消已确认且无产物，或确认 Provider 从未受理。确定发生在 Provider 接收前的限流或网络失败可在同一 Task 内重试；已经接收或状态不确定时不得创建新 Task。

### 8.1 已有任务的新任务准入隔离

查询、等待、下载和交付恢复只要求：有效身份、对原 Task 的访问权限，以及原 Task/Attempt/Asset/Provider 回执。它们不得重新要求：

- 当前仍在生产白名单；
- 新任务额度充足；
- 当前价格仍有效；
- 原预检仍未过期；
- 当前工作流仍启用。

全局 Production 暂停可以阻止尚未提交 Provider 的 `pending` Task 被新领取，避免暂停后继续产生付费调用；已经进入 `submitted`、`running` 或 `archiving` 的 Task 仍必须继续查询、归档与交付恢复。工作流 admission 只控制新 Task 创建，不回头否定已经合法冻结的 Task。

凭证失效时仍须重新鉴权，不能匿名取片。恢复只操作原任务；不得因查不到产物、客户端重启、预检过期或下载失败自动创建第二次 Provider 请求。不确定提交优先依据 `providerTaskId` 和提交证据核查。

## 9. 破坏性替换规则

项目尚未上线，冲突的旧新建任务协议直接淘汰：

- 移除独立旧 Preview/Production 节点和上传式 Preview；
- 移除以 Preview Task 充当预检记录；
- 移除固定 `VIDEO_FLOW_PRODUCTION_SPEC_JSON` 作为新任务实际规格或金额来源；
- 移除 `production_verified | preview_only | disabled` 单状态；
- 移除重复 Seedance 编译器，只保留正式执行所用编译路径；
- 移除“先检查新预检/新额度，才能找回旧任务”的客户端顺序。
- 移除将 Production 布尔模式当成一次性提交凭证，或每轮生成后强制改回 Preview 的设计。

不删除或重写历史 Task、Attempt、Asset、Provider ID、usage、预算和交付证据。必要兼容仅存在于授权只读查询和历史费用解释，不进入 v2 新建任务路径。

## 10. 验收基线

v1.1 的 AC-01–AC-07、AC-10–AC-13、AC-15–AC-21 继续适用；其中“必须重新预检”在 v2.1 中由 Production 模式下自动 Preview 并停止一次来完成。v1.1 的 AC-08、AC-09、AC-14 所规定的一次性确认行为被本版 AC-28–AC-34 取代，不再适用。另增加：

- AC-22：8 类工作流目录分别展示能力、实现、启用和验证状态；改变其中一个维度不隐式改变其他维度。
- AC-23：普通工作流的 4 秒、30 秒边界可进入同一正式编译路径；3 秒、31 秒拒绝。编辑只接受 `-1`，延长接受 4–30 秒。
- AC-24：含一段或多段输入视频时按实际总时长报价；最低 Token 规则缺失时 Production 明确阻止，不使用固定金额兜底。
- AC-25：Preview、check 和 Production 使用同一个 `quoteDigest`；过期或变化后，本次 Production Queue 只刷新 Preview 并停止。
- AC-26：Production payload 由冻结快照编译并调用正式接口；Fake Provider 合同覆盖 8 类形状，不使用测试专用生产编译器。
- AC-27：原任务恢复在预检过期、额度不足、工作流关闭后仍可读取授权范围内的原结果，且 Provider create 计数不增加。
- AC-28：新节点默认 Preview；用户切换 Production 后模式保持不变，不自动回退，也不存在一次性确认实体。
- AC-29：Production 当前内容缺少有效预检时，第一次 Queue 只返回 Preview 报告且上传、Task、Attempt、预算预占和 Provider create 均为 0；第二次 Queue 才可正式生成。
- AC-30：同一 actor 与 `executionSlotId` 最多存在一个尚未本地交付完成的 Task；并发 Queue 返回或恢复同一 Task，不创建第二次 Provider 请求。
- AC-31：Prompt、素材或参数变化不改变节点的 `executionSlotId`；复制节点生成新槽。当前 Task 在途时修改内容仍先恢复原 Task，不把新内容提交为第二个任务。
- AC-32：Provider 成功但归档、签名下载、客户端下载、本地校验或 client delivery 确认失败时，重复 Queue 恢复同一 Task；客户端先持久化本地回执再确认交付，节点返回该路径后，下一次 Queue 才创建新的 Task。
- AC-33：同一内容的有效 `PreflightRecord` 可服务多个顺序 Task；每个 Task 独立预占和计费。内容、合同或报价变化时不可复用，Production 下先 Preview 并停止。
- AC-34：Provider 明确无产物终止后槽可创建下一 Task；Provider 是否受理不确定、已有 Provider ID 或待人工核查时槽保持锁定。

真实 Provider 验收逐项单独授权、估价和记录；本规范本身不授权创建付费任务、部署或开放白名单。
