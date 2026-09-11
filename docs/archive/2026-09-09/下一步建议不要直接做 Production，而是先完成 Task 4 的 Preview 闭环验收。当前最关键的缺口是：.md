下一步建议不要直接做 Production，而是先完成 Task 4 的 Preview 闭环验收。当前最关键的缺口是：

  1. 让上传票据真正产生可追踪的 Asset

  现在 upload-ticket 返回的是临时随机 assetId，但没有写入数据库；后续下载接口按 assetId 查询时无法
  找到对应记录。

  应改为：

  - 创建 Asset 记录，保存：
      - ownerId
      - objectKey
      - role=input
      - mimeType
      - sizeBytes
      - inspectionStatus=pending

  - 上传完成后再更新 Asset 状态为 uploaded
  - 下载接口只允许资源所属 actor 访问
  - 永久保存 objectKey，不保存临时签名 URL

  2. 打通图片 Asset 到 Worker

  目前 ComfyUI 会把 assetId 放进任务参数，但 Worker 的 get_params() 和 Seedance adapter 还没有把
  Asset 转换成 Provider 可用的图片 URL。

  需要明确一条链路：

  ComfyUI IMAGE
    -> Backend upload-ticket
    -> OSS 上传
    -> Asset.assetId
    -> POST /api/v1/tasks
    -> Worker 获取 Asset 下载 URL
    -> Seedance Ark image_url

  3. 拆分 Worker 内部状态回写

  当前 Worker 仍通过旧接口一次性更新 Task 和 Attempt。应先拆成：

  - record submission
  - record progress
  - record usage
  - complete
  - fail

  然后切换到已经建立的：

  /api/v1/internal/attempts/*

  并强制使用 X-Worker-Token。

  4. 完成 Preview 无付费验收

  不调用 Ark create，只验证：

  - ComfyUI 节点能安装
  - Token 不出现在日志和节点输出
  - 图片能上传并登记 Asset
  - 相同幂等键不会创建重复 Task
  - 不同 actor 不能读取别人的 Task/Asset
  - OSS 签名 URL 能按需生成
  - Backend 未配置签名器时安全返回 503

  5. 再进入单用户 Production 灰度

  只有 Preview 链路满足以上条件后，才实现：

  - Production 显式确认
  - actor 白名单
  - 日/月额度
  - 预计费用展示
  - 一次真实 Seedance 调用
  - Provider ID、Attempt、Asset、usage、费用状态完整追踪

  推荐当前立即执行的顺序是：

  Asset 持久化
  -> Asset 下载/上传闭环
  -> Worker 获取 Asset URL
  -> Worker 内部状态接口切换
  -> Preview 联调
  -> Production policy

  其中第一优先级是修正 upload-ticket 的 Asset 持久化问题，否则现在的 ComfyUI 上传结果还不能形成可
  靠的数据追踪。