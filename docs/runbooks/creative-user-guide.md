# 创意同事使用说明

> 更新日期：2026-09-16。
> 当前状态：v2 已上线，客户端进入**受控测试期交付**（版本 `2026-09-16.1`），四条工作流开放且都已带真实验收记录。**能做什么以 [PROJECT_STATUS](../PROJECT_STATUS.md) 的当前结论为准**，本手册只讲操作。
> 产品目标见 [PRODUCT](../PRODUCT.md)，后续实施见 [ROADMAP](../ROADMAP.md)。

## 0. 拿到客户端后怎么装（macOS）

1. 把交付目录整个放到本机任意位置（**别只拷其中几个文件**）；
2. **双击 `install_creative.command`**；
3. 按提示选择 ComfyUI 根目录（脚本会自动找 `~/ComfyUI`、`~/Documents/ComfyUI`、`/Volumes/lvmac/ai/ComfyUI/ComfyUI`，找不到会让你手动选）；
4. 在弹出的隐藏输入框里粘贴**你自己的**个人凭证；
5. 看到"已安装完成（版本 …）"后，**完全退出并重启 ComfyUI**，然后搜索 `Video Flow` 导入模板。

安装器会覆盖 `custom_nodes/video_flow_client` 并把旧版本备份到 `ComfyUI/.video-flow-backups/`；它**只动这一个目录**，不碰你别的自定义节点。升级就是重跑一次这个安装器。

## 1. 当前能做什么

已经开放、可以正式生成的四条工作流（**其余四类仍是关闭的**，提交会被服务端拒绝）：

| 模板文件（在 `custom_nodes/video_flow_client/workflows/` 里） | 用途 | 素材要求 | 720p / 5 秒的预占参考 |
| --- | --- | --- | --- |
| `seedance-text-to-video-preflight-v1.comfy.json` | 文生视频 | 无 | 7.623000 元 |
| `seedance-first-frame-to-video-preflight-v1.comfy.json` | 首帧 | 1 张图 | 7.623000 元（首帧比例若不在标准比例内会更高） |
| `seedance-first-last-frame-to-video-preflight-v1.comfy.json` | 首尾帧 | 2 张图（首帧决定画幅） | 同上 |
| `seedance-multi-reference-preflight-v1.comfy.json` | 全模态参考——**产品图 / 参考图也用它** | 图 ≤30、视频 ≤10、音频 ≤10，**合计 ≤50**，**至少 1 个** | 纯图/图+音 7.623000 元；**含输入视频 8.164800 元起**（视频秒数计入计费，越长越贵） |

> ⚠️ **产品图别用 `seedance-product-preflight-v1.comfy.json`**：它对应的入口尚未开放，提交会被服务端拒绝。产品图/参考图一律用**多模态参考**那个模板——只放图、其余槽位留在「（不给素材）」即可，服务端收到的是同一类任务。

**Preview 不花钱**：第一次 Queue 只做服务端预检（不上传素材、不生成），看过报价后**再 Queue 一次**才正式提交并计费。

**全模态参考模板的槽位可以留空**：模板预置了 4 个图、2 个视频、1 个音频槽位，每个下拉的第一项是「（不给素材）」——想用哪个就点开选文件，**不用的就留着别动，不需要删连线、也不需要旁路节点**。整套至少要选 1 个素材（官方要求）；一个都没选时节点会直接提示怎么改。要加更多素材，就把输入节点多摆几个、按 `reference_media` 串起来即可（图最多 30、视频最多 10、音频最多 10、合计最多 50）。

另外，在持有有效个人凭证且对原任务具有访问权限时，可以：

- 查询自己的已有 Task；
- 查看任务当前状态；
- 对已经交付完成的任务重新申请下载地址；
- 凭 `taskId` 向管理员或开发人员报告问题。

这些操作只读取原任务，不创建新的 Provider 请求，也不要求原预检仍有效、新任务额度充足或当前工作流仍启用。

## 2. 当前不要做什么

- 使用旧 `Seedance Preview` / `Seedance Production` / OneClick 节点或它们的旧模板——新节点在同名分类 `Video Flow` 下，旧节点一律不用；
- 提交**未开放的四类工作流**（参考图、多模态以外的编辑/延长、音频参考等）——服务端会拒，别靠改参数试探；
- 因等待超时、下载失败或客户端重启而**重复提交同一次生成**——先查原任务（见第 4、5 节），重跑一次就是再花一次钱；
- 把 Prompt 写成"**把视频里的 X 换成 Y**""**延长 N 秒**"这类编辑/延长措辞——全模态参考模板提交的是"参考生视频"，模型按提示词判定成编辑/延长时，任务会在提交**成功之后**异步失败（钱不白花，但白等一场；要编辑/延长请等对应模板开放）；
- 自行开启 Production 白名单、修改 `generation_version` 或额度试错。

**费用由服务端算，客户端改不了**：每次正式提交前先看预检报告里的 `reserveCny`，那是这次会先预占的金额；实际结算以 Provider 返回的用量为准（通常与预占相差不到一个 token）。

## 3. 个人凭证安全

每位创意同事使用独立、可撤销的 actor token。

- 不共用凭证；
- 不把 token 写入 Workflow JSON；
- 不把 token 放进截图、文档、聊天或 Git；
- 不使用管理员或临时测试 token；
- token 丢失或怀疑泄漏时，停止使用并联系管理员撤销；
- 创意电脑不保存 Ark、OSS、数据库或 Worker 服务密钥。

客户端支持从安全配置或权限受限的 token 文件读取凭证。实际安装版本和目标 ComfyUI 实例必须由管理员确认，不能仅凭本仓库存在安装脚本就判断已经发布。

## 4. 查询已有任务

以下操作是只读查询。先由管理员提供实际 Backend 地址、个人 token 和原 `taskId`：

```bash
export VIDEO_FLOW_BASE_URL='https://ai.sweetyshell.com'
export VIDEO_FLOW_TOKEN='<个人 Token>'
export VIDEO_FLOW_TASK_ID='<原 taskId>'

curl -sS \
  "$VIDEO_FLOW_BASE_URL/api/v1/tasks/$VIDEO_FLOW_TASK_ID" \
  -H "Authorization: Bearer $VIDEO_FLOW_TOKEN"
```

结果只代表该 Task 当前记录，不会创建新任务。常见情况：

| 返回 | 含义 | 处理 |
| --- | --- | --- |
| `200` | 找到本人任务 | 查看任务状态和错误信息 |
| `401` | 没有有效身份 | 重新取得个人凭证，不要匿名重试 |
| `404` | 任务不存在或不属于当前账号 | 核对 `taskId` 和账号；服务端不会泄露他人任务 |

不要为了“看看任务是否还在”重新执行原生成画布。已有 `taskId` 时直接查询原任务。

## 5. 重新取得已有产物

对已经完成交付的原任务申请新的短期下载地址：

```bash
curl -sS \
  "$VIDEO_FLOW_BASE_URL/api/v1/assets/tasks/$VIDEO_FLOW_TASK_ID/result" \
  -H "Authorization: Bearer $VIDEO_FLOW_TOKEN"
```

常见结果：

| 返回 | 含义 | 处理 |
| --- | --- | --- |
| `200` | 产物已登记并可下载 | 使用返回的短期 `downloadUrl`；过期后重新调用本查询 |
| `401` | 凭证无效 | 联系管理员处理凭证 |
| `404` | 任务不存在或不属于当前账号 | 核对账号和 `taskId` |
| `409 RESULT_NOT_READY` | 原任务尚未形成可交付产物 | 继续查询原任务，不重新生成 |
| `409 RESULT_REQUIRES_REVIEW` | 原任务需要人工核查 | 向管理员提供 `taskId` |
| `409 DELIVERY_FAILED` | Provider 结果与交付状态不一致或归档失败 | 恢复原产物，不重新调用 Provider |

`objectKey` 是永久对象身份，不是可以直接粘贴到浏览器的公开 URL。下载地址过期不代表产物被删除。

## 6. 新 v2 Preview 的开发边界

v2 目标入口为：

```http
POST /api/v1/tasks/preflight
```

它只发送 Prompt、生成参数、素材元信息和内容哈希，不发送素材本体。报告应分别展示请求检查与 Production 准入，并返回 `willUploadMedia=false`、`willCallProvider=false`。

当前接口结构和本地验证方法见 [工作流 Preview v2 接口手册](./product-preflight.md)。该手册描述本地 R1 中间态，不代表线上已经部署，也不授权创建付费任务。

## 7. 什么时候可以恢复新生成操作

只有同时满足以下条件，才更新本手册并重新给出创意人员的新生成步骤：

- R1–R7 的目标实现和故障矩阵完成；
- 旧上传式 Preview、旧 Production 和重复模板已退出交付包；
- 三包回归和隔离跨包合同通过；
- 目标 ComfyUI 完成安装、重启、模板导入、Preview 和原任务恢复验收；
- 对应 Backend、Worker 和客户端版本已经配套部署；
- 管理员明确给出试用账号、工作流、素材、预算和 Production 授权范围；
- 需要真实 Provider 验收时，已单独批准预计费用。

满足条件前，“代码存在”“测试通过”“历史上出过片”都不能作为创意同事开始新生成的依据。

## 8. 报障信息

出现问题时至少提供：

- `taskId`；
- 使用的个人账号标识，不提供明文 token；
- 操作时间；
- 使用的 Backend 和客户端版本；
- ComfyUI 节点或接口返回的错误码；
- 是新生成、等待、查询还是下载阶段；
- 是否已经看到过 Provider Task ID 或产物。

没有明确确认“创建一个新生成意图”时，排障和恢复不得产生第二次 Provider create。
