# UI 调研与分期方案

> 日期：2026-09-15。本文是**调研与方案记录**，不是需求规范，也不代表方案已被批准。
> 当前事实见 [PROJECT_STATUS](../PROJECT_STATUS.md)；计划与阶段出口只在 [ROADMAP](../ROADMAP.md) 维护。
> 本文涉及的界面范围变更**尚未**写入 `PRODUCT.md`，按 `PRODUCT.md:234` 在动工前必须先完成那一步。

## 1. 为什么调研

系统已跑通真实付费链路（R8 文生视频 4 秒已在生产验收），但**没有任何面向人的界面**：

- 创意同事拿到的使用手册让他们**在终端跑 curl 看 JSON**（`docs/runbooks/creative-user-guide.md` §4–5）。他们看不到自己的额度还剩多少、跑过什么、产物丢了不能重下。
- 管理员建身份 / 改额度 / 暂停闸门**只能 SSH 到服务器敲命令，或开 SSH 隧道用 Swagger**。

用户已明确：**使用者两者都要、分两期做；载体是独立网页；登录用粘贴 token**。

## 2. 后端接口面（现状）

### 2.1 actor 端（`ApiCredentialGuard`，`Authorization: Bearer <vf_ token>`）

| 方法 / 路径 | 返回 |
| --- | --- |
| `GET /api/v1/tasks/workflows` | 工作流目录（不读 actor） |
| `POST /api/v1/tasks/preflight` | `PreflightReport` + `preflightId` |
| `GET /api/v1/tasks/preflight/:id/check` | 复验报告（按 actorId 过滤） |
| `POST /api/v1/tasks` | 创建正式任务（需 `Idempotency-Key`） |
| `GET /api/v1/tasks/slots/:slotId/current` | 槽内当前任务 |
| `POST /api/v1/tasks/:id/client-delivery` | 客户端交付确认 |
| `GET /api/v1/tasks/:id` | 单条任务摘要（非本人 404） |
| `GET /api/v1/assets/tasks/:taskId/result` | 短期 `downloadUrl`（300s） |
| `POST /api/v1/assets/upload-ticket`、`POST /api/v1/assets/:id/complete`、`GET /api/v1/assets/:id/download` | 素材上传与取回 |

**鉴权语义**（`auth/api-credential.guard.ts`）：未带凭证 **401**；凭证无效/已吊销 **403**。区别很重要——401 是无凭证，403 说明这份 token 已经不能用，两者都要清本地 token 重来。

### 2.2 管理端（`AdminTokenGuard`，`x-admin-token`，任何失败一律 401）

`POST/PATCH /api/v1/admin/credentials*`（签发 token **只返回一次**，库里只存 sha256）、`PATCH .../limits`、`GET /api/v1/admin/operations/health`、`PATCH .../production-gate`、`GET /api/v1/admin/tasks/:id/report`、`POST .../resume-delivery`、`PATCH .../budget-review`。

### 2.3 `GET /api/v1/tasks/:id` 的返回结构要点

`tasks.service.ts:138-191` 构造：`{...task, execution, delivery, costSummary}`。

- **`...task` 展开了整行**，连带 `actorId`、`clientRequestId`、`requestSnapshot`（完整 prompt）、`imageUrl`，以及 `include` 进来的原始关系 `executionAttempts` / `budgetReservation`。
- 金额在 `costSummary` 里是**字符串**（`Number(...).toFixed(6)`），与原始关系里的 Decimal 序列化格式**不一致**。前端应以 `costSummary` 为准。
- `delivery.assetId` 只在 `deliveryStatus === 'ready'` 时才有；要下载必须另外调 `/assets/tasks/:taskId/result`。

## 3. 三个能力缺口（第 1 期的直接动机）

### 3.1 actor 无法列出自己的任务

全仓库唯一的列表端点是 legacy `GET /api/tasks`（`tasks.controller.ts:45-52`），挂 Admin token，过滤参数只有 `{status, createdBy}`，**没有 actorId 维度**。`v1/tasks` 下只有单条查询。数据库层面 `Task.actorId` 有索引，数据在，只是没出口。

### 3.2 actor 无法查自己的额度 / 已用 / 剩余

计算逻辑**已经存在**于 `task-budget.service.ts:341-420`（`dailyUsed` / `monthlyUsed`），但算完只用于返回 `{canProceed:false, reason}`，**数值被丢弃**。额度只能由管理员 `PATCH .../limits` 写入、响应里才带。actor 目前只能通过提交被拒时的 429 reason 间接感知。**拿不到"还剩多少钱"这个数。**

### 3.3 actor 无法列自己的历史产物

只能按 taskId 查。`AssetsService.findByTask`（`assets.service.ts:215-228`）**没有 owner 过滤且未暴露**——它现在没到 HTTP 层，但新增接口时"最省事的实现就是复用它"，那会一次性泄漏全部用户的产物。**点名禁止。**

## 4. 探查中发现的既有隐患（比缺口本身更值得先处理）

### 4.1 列表接口若照抄 `...task` 展开会泄漏内部字段

见 2.3。列表接口必须走**显式 `select`**，并加一条断言"响应里不含 `actorId` / `requestSnapshot` / `prompt` / `imageUrl`"。这是第 1 期的一等风险。

### 4.2 legacy `findAll` 存在 Prisma 操作符注入面

`tasks.service.ts:193-198` 的 `where: filters` 是**把 query 对象直接透传给 Prisma**。今天它只被 Admin token 保护，风险有限；但**一旦为了"让 actor 也能列任务"给它加参数而不做白名单，`?actorId[not]=x` 就是真实的操作符注入**。第 1 期**不碰这个端点**，另写 `findPageForActor`。

### 4.3 额度口径：日/月预占查询没有日期条件

`task-budget.service.ts:353-372` 的 `dailyReservations` / `monthlyReservations` 两次查询**都只按 `actorId + state` 过滤，没有 `dayKey` / `monthKey` 条件**。所以"今日已用"的预占部分实际是"全部未结算预占"，`dailyUsed` 与 `monthlyUsed` 在预占项上恒等。

这是**既有行为**（方向保守，不是安全事故），但它直接决定页面上"剩余额度"这个数字的含义。接口必须**如实标注**，不能显示成"今天的"。

## 5. 客户端界面的现状

`packages/comfyui-video-flow-client` 只有 **3 个 `app.registerExtension`**，全部围绕单节点状态，**没有任何侧边栏、面板、Tab 或菜单注册**：

| 文件 | 作用 |
| --- | --- |
| `web/preflight_report.js` | 在预检/提交/下载节点上挂一个**只读多行文本框**"检查报告"，内容是**服务端报告的 JSON 原文** |
| `web/execution_slot.js` | 给执行槽生成 uuid 并设为只读；复制节点时换新槽 |
| `web/js/video_flow_status.js` | 用 toast 提示"任务 id / 存哪了 / 费用是否核实" |

**没有额度、历史、费用汇总界面**（客户端内 grep `额度|余额|history|汇总|dashboard` 零命中）。服务端其实已有做汇总所需的数据，客户端一个都没展示。

另外：唯一真正可见的产物反馈是 `VideoFlowPolicyPreview` 的 `ui.images + animated`（注释说明 `ui.videos` 在 0.35.x 前端不渲染）。费用信息 `cost_note()` 只 print 到 Python 控制台。

## 6. 发现的现有缺陷（已修，第 0 期）

`web/js/video_flow_status.js` 的 toast 在 v2 链路上**从未出现过**。根因有两半，**是同一个 bug 的两面**：

1. **ComfyUI 只在节点返回 `ui` 键时才发 `executed` 事件**（源码 `execution.py:563`），而 `CreateTask` 的生产成功路径返回**裸 tuple**（`preflight_nodes.py:580-585`），事件根本不发。**实测还发现恢复路径（沿用槽内已有任务）有完全相同的缺口**——那是实现过程中由测试抓出来的。
2. 前端读的 `output.task_id` / `local_path` / `cost_status` 三个键，**这些节点从来没发过**。

后果：**用户看不到 taskId**，而报障、查询和重新取片都要用它。附带症状：下载节点的本地路径错位地显示进了"检查报告"框（它在该框的监听集合里）。

**已修**（提交 `854cfda`）：两条提交路径都改回 `ui.text`——与 `RequestPreview` / `DownloadResult` 既有一致；前端改读 `ui.text`，映射逻辑抽成可直测的 `web/video_flow_status_state.mjs`；下载节点移出报告框的监听集合。摘要遵守任务报表的**默认脱敏**：只有 taskId、执行槽、预占金额。

**仍存在的已知限制**：`VideoFlowPolicyWait` 返回裸 tuple，**默认 1200 秒等待期间无提示**。补 `ui.text` 也要等结束才显示、毫无帮助；真正的修法是长任务进度上报（`comfy.utils.ProgressBar` 已核实可用），留待后续。

## 7. 项目自身的约束（方案不得违反）

| 约束 | 出处 |
| --- | --- |
| 不新增"**大型后台**" | `ROADMAP.md:22` |
| "**完整的** Web 管理后台"属当前非目标；进入开发须重新探索与架构决策 | `PRODUCT.md:130-144` |
| 待讨论项"**时间体验**"，触发时机是"界面体验设计**前**" | `PRODUCT.md:205` |
| 待讨论项"**管理体验**"，触发时机是"管理操作开始阻碍试点时" | `PRODUCT.md:211` |
| 待讨论项"**首批用户和规模**"，触发时机是"R8 发布和扩大准入前" | `PRODUCT.md:205` |
| 待讨论项"**预算目标**"，触发时机是"正式开放和额度产品化前" | `PRODUCT.md:205` |
| "任何产品范围变化先更新或确认本文" | `PRODUCT.md:234` |
| 用户只能访问自己的任务和素材；三类身份权限边界分离 | `PRODUCT.md:127` |
| 界面只允许 Preview / Production 两模式，不新增第三种模式或一次性确认系统 | `ROADMAP.md:30`、`职责界定.md:28` |
| 只读、默认脱敏、证据读不到要显式说明 | `scripts/video_flow_task_report.py` 文档字符串 |
| 判定与副作用分离；只自动暂停绝不自动解除 | `scripts/video_flow_monitor.py` 文档字符串 |
| Swagger 的 `/docs` 不进 Nginx、生产默认关闭；创意自助需"另外的表单界面" | `deploy-and-rollback.md:216` |

**部署现状**（决定网页放哪）：Backend **没有静态托管**；`@nestjs/serve-static` 未安装，但 `@nestjs/platform-express` 在，可用 `useStaticAssets()` **不加新依赖**。生产 nginx 只 `location /api/` → `127.0.0.1:3100`，`location = /` 返回固定文案、`location /` 返回 404。

## 8. 分期方案

### 第 0 期：修客户端反馈 —— 已完成（`854cfda`）

见第 6 节。它是任何新界面的地基，且不依赖任何产品决策。

### 第 1 期：创意同事自助网页（**只读 + 重新取片**）

**范围刻意做小**：不新建任务、不上传素材、不切换模式、不做统计、不做多用户管理。

新增三个**只读**接口（都从 `@CurrentActor()` 取身份，**绝不接受客户端传 actorId**）：

| 接口 | 要点 |
| --- | --- |
| `GET /api/v1/tasks` | **必须声明在 `@Get(':id')`（`v1-tasks.controller.ts:118`）之前**，否则被 `:id` 吃掉。新写 `findPageForActor`（显式 `select`，**不碰 legacy `findAll`**），cursor 分页 |
| `GET /api/v1/tasks/usage` | 把 `task-budget.service.ts:341-420` 里被丢弃的数值抽成只读方法，**并让 `checkBudgetAvailability` 改为调用它**——抽取的唯一目的是消除两份算法漂移。额度未配置等状态返回 200 放在 body 里，不用 4xx 压平 |
| `GET /api/v1/assets/results` | 新增带 owner 过滤的 `findResultsForOwner`，where 条件复用 `findLatestOwnedOutputForTask`（`assets.service.ts:270-281`），**禁用 `findByTask`**。列表**不签下载 URL**，点击时再调已有的下载接口 |

**网页**：放 `packages/backend/public/`，`main.ts` 改 `NestExpressApplication` + `useStaticAssets(webRoot, {prefix:'/app/'})`；`process.cwd()/public` 在本地与容器**都成立**，零配置改动；全部 `Cache-Control: no-store`（零构建没有内容哈希文件名，版本错配极难排查）。nginx 加一条 `location /app/ { proxy_pass http://127.0.0.1:3100; }`。

**同源** → 第 1 期**完全不需要 CORS**，顺带绕开 `docker-compose.yml` 里 `CORS_ORIGIN=*` 配 `credentials:true` 这个会被浏览器拒绝的坏组合。**绝不在 nginx 加 `Access-Control-Allow-Origin: *`**（`domain-and-https.md:37` 明令禁止）。

**登录**：管理员用已有脚本签发 token，装进链接 `https://ai.sweetyshell.com/app/#t=<token>` 发给同事。页面读 `location.hash` → 存 `sessionStorage` → 立刻 `history.replaceState` 清掉 hash。三个要点：**用 fragment 不用 query**（不进 nginx access log / Referer）、**不写 Cookie**（`Authorization` 头天然免疫 CSRF）、**共用电脑有风险**要在页面上明说。代价如实告知：**链接本身等价于 token**，只适合小规模试点。

**页面三块**：① 我的额度（日/月上限·已用·剩余 + 每个 blocker 配一句人话和下一步）；② 我的任务（三段状态分开显示：任务 / 交付 / 客户端交付；费用四态照服务端原样，`usageCalculatedCny` 旁必须标注"按冻结价格推算，不是 Provider 账单"）；③ 我的产物（点击当场签名，不显示会过期的坏链接；**不提供删除**）。

**不展示** `/v1/admin/*` 的任何内容。

### 第 2 期：管理端

复用第 1 期的静态托管、`api.mjs` 错误映射、sessionStorage 机制与 nginx 变更。增量是把 `deploy-and-rollback.md` §6.2 那批 curl 变成表单：建身份（token 只返回一次，必须显著警告并提供复制）、改额度、吊销、暂停/恢复闸门、任务报表、费用人工核实。

**管理员 token 是单一环境变量、无法安全分发给浏览器** → 第 2 期需先做设备码（1 张表 + 3 个端点），或退一步：管理员本地输入一次存 sessionStorage。

边界：**不是新的管理能力**，是已有接口的表单化；不做审批流、多租户、告警配置。

### 为什么这个方案不违反"不新增大型后台"

1. **零新实体（第 1 期）**：不新增表、不新增权限角色、不新增服务或端口，三个端点都是对已有数据的**只读投影**。
2. **零新写路径**：网页不能创建任务、不能改价格、不能签发 token、不能绕过预检。第 2 期也只有两个已有写端点的表单化。
3. **不新增第三种模式**：网页**不暴露任何模式切换或提交入口**，生成仍只在 ComfyUI 画布上做。
4. **零构建**：纯静态 ESM，无 npm、无打包器、无 CDN。工程形态更接近 `scripts/video_flow_monitor.py` 那种"一条命令的只读工具"。

## 9. 待决产品决策（动工前必须由用户拍板）

| # | 待确认 | 建议 |
| --- | --- | --- |
| 1 | **时间体验**（`PRODUCT.md:205`，界面设计**前**必须答） | Preview ≤ 3s 正常；状态刷新 15–60s、页面隐藏时停；生成等待**必须给进度**不能静默；下载显示字节进度。依据：R8 实测 preflight 亚秒级、4 秒任务约 2 分 49 秒 + 归档 16 秒 |
| 2 | **管理体验**（触发时机：管理操作开始阻碍试点） | 建议登记为"已触发，第 2 期交付"，并给出可观测触发器（如 `requiresReview` 一周内人工处理超 N 次） |
| 3 | **首批用户和规模** | 决定第 1 期选"一次性链接"还是现在就做设备码 |
| 4 | **预算目标** | 页面要显示"剩余额度"，需要 `dailyLimitCny` 的默认值与提额流程。目前只有 `creative-pilot` 的 100 元/日一个数据点 |
| 5 | **产物留存** | 页面会出现"我的产物"，用户一定会问存多久、能不能删。第 1 期不做删除，但要说清留存期 |
| 6 | **预占口径** | R8 实测预占系统性少算一帧（见 PROJECT_STATUS）。建议 (b)：先上页面并显式标注，不阻塞第 1 期，符合 `PRODUCT.md` "费用诚实" |

另有两条**不改界面但影响实施**：`PRODUCT.md` §5 非目标措辞需补精确边界（"只读查询页不属于'完整后台'"），以及待讨论表补一条"何时允许 Web 写操作"。

## 10. 风险与取舍

| 风险 | 应对 |
| --- | --- |
| **越权** | 三个接口一律从 `@CurrentActor()` 取身份；产物查询必须带 owner 过滤；列表用显式 `select`；越权返回 **404 不返回 403**（不泄漏存在性，与 `GET /v1/tasks/:id` 现有行为一致） |
| **字段越界** | 加测试断言响应 JSON 不含 `actorId` / `requestSnapshot` / `prompt` / `imageUrl` / `tokenHash` |
| **token 在浏览器** | 零构建在这里是安全优势（无 npm/CDN 依赖）；加 `Content-Security-Policy: default-src 'self'; connect-src 'self'`；残余风险（链接=token）如实记录 |
| **范围蔓延（最大合规风险）** | 把"网页只读、写路径只在 ComfyUI 与本机脚本"写进 ADR；第一个"能不能在网页上创建任务"的需求出现时边界就破了 |
| **与 ComfyUI 内界面的关系** | 网页是**补充不是替代**：工作现场仍在 ComfyUI（第 0 期保证那里能看到状态），网页负责"离开工作时"的查询与取片。**不在 ComfyUI 注册侧边栏/面板**——项目已踩过两次宿主前端 API 的坑（`ui.videos` 不渲染、`executed` 与 `result` 分离），把 UI 押在会随小版本变的宿主前端上是长期负担。文案表两边手工同步并加契约测试 |
| **`pending` 计数是全局的** | `task-budget.service.ts:415` 的 `tx.task.count({where:{status:'pending'}})` 没有 actorId 条件，页面文案必须写"全局在途"，不能显示成"我的" |

## 11. 验证方式

- **第 0 期（已完成）**：客户端 `120 passed`；真实 ComfyUI 里 Queue 一次 Production，肉眼确认 toast 出现且含 taskId
- **第 1 期**：后端 `npm run build && npx jest --runInBand`；四类断言（越权 404、路由顺序 `usage` 不被 `:id` 吃掉、字段边界、`checkBudgetAvailability` 既有单测**原样全绿**证明抽取未改变语义）；验收环境端到端（`comfyui_acceptance_env.py start` → 浏览器打开网页 → 粘贴验收 token → 看到额度/历史/重下）
- **第 2 期**：逐项对照 `deploy-and-rollback.md` §6.2 的 curl 语义；"恢复生产闸门"必须验证缺 `evidenceRef` 会被拒
- **部署后门禁**：`curl https://ai.sweetyshell.com/app/` 返回 200；`location = /` 的文案与 `location /` 的 404 **未被改动**；`ss -lntp` 里 3100 仍只监听 `127.0.0.1`

## 12. 关键代码位置索引

| 位置 | 用途 |
| --- | --- |
| `packages/backend/src/v1/tasks/v1-tasks.controller.ts:118` | `@Get(':id')`，新路由必须声明在它之前 |
| `packages/backend/src/tasks/task-budget.service.ts:341-420` | 待抽取的额度计算；`:353-372` 是缺日期条件的预占查询；`:415` 是全局 pending |
| `packages/backend/src/tasks/tasks.service.ts:138-191` | `findSummaryForActor` 的 `...task` 展开（反例） |
| `packages/backend/src/tasks/tasks.service.ts:193-198` | legacy `findAll` 的 `where: filters` 透传（注入面） |
| `packages/backend/src/assets/assets.service.ts:215-228` / `:270-281` | `findByTask`（禁用）/ `findLatestOwnedOutputForTask`（复用模板） |
| `packages/backend/src/main.ts:12-17, 39-49` | Swagger 开关、CORS 逻辑 |
| `packages/comfyui-video-flow-client/preflight_nodes.py:484, :637` | 已验证可行的 `ui.text` 返回形态 |
| `packages/comfyui-video-flow-client/web/preflight_report_state.mjs` | 纯逻辑抽 `.mjs` + `node --eval` 直测的既有先例 |
