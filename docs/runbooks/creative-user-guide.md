# 创意同事使用说明（v2 重构期间）

> 更新日期：2026-09-15。
> 当前状态：新的 v2 Preview 正在本地开发，v2 Production 尚未实现和部署。本手册当前只提供凭证安全及已有任务的查询/取片方法，不提供新生成操作。
> 事实依据：[PROJECT_STATUS](../PROJECT_STATUS.md)。产品目标见 [PRODUCT](../PRODUCT.md)，后续实施见 [ROADMAP](../ROADMAP.md)。

## 1. 当前能做什么

在持有有效个人凭证且对原任务具有访问权限时，可以：

- 查询自己的已有 Task；
- 查看任务当前状态；
- 对已经交付完成的任务重新申请下载地址；
- 凭 `taskId` 向管理员或开发人员报告问题。

这些操作只读取原任务，不创建新的 Provider 请求，也不要求原预检仍有效、新任务额度充足或当前工作流仍启用。

## 2. 当前不要做什么

v2 重构和完整验收完成前，不要：

- 使用旧 `Seedance Preview` 节点。该节点仍可能在 Preview 阶段上传素材；
- 使用旧 `Seedance Production`、OneClick 或旧工作流模板创建新任务；
- 向 `POST /api/v1/tasks` 发送旧 `mode=preview` 请求；
- 将旧 Preview Task 当成 v2 预检记录；
- 因等待、下载或客户端重启失败而重新提交一次生成；
- 把本地测试、Fake Provider 或历史样片理解为当前版本已经可用；
- 自行开启 Production 白名单或修改 `generation_version` 试错。

当前本地 R1 代码会拒绝旧 Preview Task 创建；v2 Production 在 R4 完成前保持关闭。不要部署 R1 中间态供创意同事创建新任务。

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
