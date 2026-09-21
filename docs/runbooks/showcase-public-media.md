# 案例广场公开素材接口

> 当前实现状态以 [PROJECT_STATUS.md](../PROJECT_STATUS.md) 为准。本手册记录公开案例接口的调用与验收方式。

## 公开范围

案例详情接口公开返回生成结果，以及任务冻结执行计划中引用的输入图片和输入视频。参考音频不返回。该公开范围是产品决策；调用方不得把接口返回理解为任务所有权证明。

后端只按 `Task.executionPlan.media[].assetId` 查询 `role=input` 的资产，不扫描用户素材库。数据库中已经缺失的历史输入资产会被跳过，案例详情仍正常返回。

## 接口

```http
GET /api/v1/tasks/showcase/tasks/{taskId}
```

无需认证。响应中的 `inputAssets` 按冻结执行计划顺序排列：

```json
{
  "inputAssets": [
    {
      "id": "asset UUID",
      "role": "reference_image",
      "mimeType": "image/png",
      "sizeBytes": 12345,
      "metadata": {
        "kind": "image",
        "width": 1280,
        "height": 720
      },
      "downloadUrl": "临时签名 URL",
      "expiresIn": 900
    }
  ]
}
```

`downloadUrl` 是临时地址，不得写入数据库、文档或长期缓存。需要重新访问时应再次请求案例详情。

## 本地验收

```bash
curl -fsS http://127.0.0.1:3100/api/v1/tasks/showcase/tasks/{taskId}
```

通过标准：

- `inputAssets` 只包含 `image/*` 和 `video/*`；
- 顺序与任务 `executionPlan.media` 一致；
- 图片在案例详情中显示缩略图；
- 视频显示原生播放控件；
- 没有输入图片或视频时不显示“参考素材”区块；
- 缺失的历史 Asset 不导致接口 500。
