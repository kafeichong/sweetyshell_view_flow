# Seedance 统一调用与创意交付总结

日期：2026-09-10

## 1. 当前目标

让创意同事无需在个人电脑安装或维护 Seedance 模型，也不直接接触火山引擎 Ark 密钥；通过公司统一服务提交视频任务。ComfyUI 仍可作为本地工作流与素材准备层，云端 Seedance 是统一的 Provider。

系统后续将在这条统一链路上逐步增加检测、任务记录、费用统计和权限治理，不需要推倒现有接口。

## 2. 已部署的基础能力

生产服务入口：`https://ai.sweetyshell.com/api/v1`

- Backend：NestJS API，负责凭证、任务创建、任务查询、素材上传凭证及记录。
- Worker：从 Backend 领取任务，调用火山引擎 Ark Seedance，轮询结果、上传生成视频并回写任务状态。
- PostgreSQL：存储任务、调用方、幂等键、状态、视频地址和费用字段。
- OSS：保存输入素材与生成的视频产物。

已观察到真实任务完成 `pending -> running -> completed`，并产生费用记录。Worker 已部署视频地址回写修复；历史任务不会自动回填，下一条新任务需要作为线上验收依据。

## 3. 创意同事的推荐使用方式

推荐使用仓库脚本：`scripts/seedance_cli_smoke.sh`。

管理员为每位同事单独创建一个 actor 身份；脚本通过管理员 token 获取对应的 actor token，再提交任务与轮询结果。这样可以区分任务归属，并为后续按人员、项目、模型或任务类型统计费用保留数据基础。

使用说明：

- [创意同事一键脚本（Seedance）](../../runbooks/creative-one-click-script.md)
- [创意同事统一调用手册（Seedance）](../../runbooks/creative-user-guide.md)

## 4. 接口与字段约定

### 文生视频

无参考图时使用：

```json
{
  "capability": "TEXT_TO_VIDEO",
  "profile": "seedance",
  "params": {
    "prompt": "A premium product hero video",
    "duration": 5
  }
}
```

### 图生视频

有参考图时使用：

```json
{
  "capability": "IMAGE_TO_VIDEO",
  "profile": "seedance",
  "params": {
    "prompt": "Use this product image, smooth studio camera move",
    "duration": 5,
    "image_url": "https://.../reference.png"
  }
}
```

关键约束：

- 图片字段必须是 `params.image_url`，不是 `imageUrl`。
- 每次创建任务必须带 `Idempotency-Key`。
- 同一 actor 使用相同幂等键和完全相同请求体，会返回原任务，避免重复付费。
- 同一幂等键但请求参数不同会返回冲突，不会悄悄新建任务。
- `mode: production` 目前被服务端禁止；不能把预览或普通入口误当成已开放的生产提交模式。

## 5. 本轮修正

此前创意同事脚本和手册将图片字段写为 `imageUrl`。Backend 与 Worker 的实际执行链路识别 `image_url`，旧写法会使参考图不进入 Provider 请求，形成“提交成功但没有按图生成”的隐蔽问题。

现已修正：

- 设置 `IMAGE_URL` 时，脚本自动选择 `IMAGE_TO_VIDEO` 并提交 `params.image_url`。
- 未设置 `IMAGE_URL` 时，脚本自动选择 `TEXT_TO_VIDEO`。
- 文档示例同步到实际字段与能力类型。

## 6. 安全与权限边界

- 火山引擎 Ark 密钥仅部署在 Worker 环境变量中，不向创意同事分发。
- `VIDEO_FLOW_ADMIN_TOKEN` 仅管理员持有；它用于创建或获取 actor token，不应写进脚本、聊天记录或共享素材目录。
- 每位同事应使用独立 actor token；token 泄露时应撤销或轮换该同事凭证，而不是更换全局 Ark 密钥。
- 参考图上传应先申请上传凭证，再将返回的可访问地址写入 `image_url`。

## 7. 当前验收状态与下一步

尚未为了测试创建新的付费 Seedance 任务，因此以下结论需要通过一条真实、受控的创意任务验收：

1. 管理员创建一名测试创意同事的 actor token。
2. 使用脚本提交一条带参考图的 `IMAGE_TO_VIDEO` 任务，并固定 `Idempotency-Key`。
3. 确认任务经历 `pending -> running -> completed`。
4. 确认返回 `videoUrl` 可播放、`cost` 有值、任务归属正确。
5. 用同一幂等键重复执行，确认没有产生第二条付费任务。

通过后，下一迭代优先做：任务列表与筛选、失败原因分类、按 actor/项目/模型维度的费用报表、管理员凭证撤销和调用限额。上述能力都建立在已存在的 actor、任务和费用记录之上，可逐步增加，不需重做当前接口。
