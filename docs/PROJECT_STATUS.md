# Video Flow 项目现状（权威）

> 最后核验：2026-09-15
> 本轮核验方式：本地源码评审、三包回归、合同资源校验、隔离 PostgreSQL 全新/历史迁移、真实 Nest HTTP/数据库合同，Comfy Desktop + Fake Provider/Fake OSS 的实际 Queue、下载、落盘和播放，以及 R8 在生产环境、真实火山账号上的受控付费验收与收口（真实调用 Provider、真实产生费用，见下）。
> 本文是**唯一**描述"系统现在是什么样"的文档。任何历史文档与本文冲突时，以本文为准；如果本文与代码冲突，以代码为准并立即更新本文。

---

## 0. 本轮交付判断

### 2026-09-16：新增创意人员账号 `creative-zhuyang`（朱阳），并加入生产白名单

授权人 kafeichong 要求为创意同事朱阳开一个独立账号用于客户端真实操作验收。

| 项 | 值 |
| --- | --- |
| Actor ID | `creative-zhuyang`（沿用 `creative-pilot` 的 `creative-*` 命名） |
| 显示名 | 朱阳 |
| 状态 | `active` |
| 额度 | `dailyLimitCny = 300`、`monthlyLimitCny = 3000`（服务端强制） |
| 生产白名单 | `VIDEO_FLOW_PRODUCTION_ACTORS=creative-pilot,creative-zhuyang`（生产 `.env`，改前备份 `.env.bak-20260916105757`，后端已 `--force-recreate` 重建） |
| 创建方式 | `POST /api/v1/admin/credentials` + `PATCH .../limits`（Admin Guard） |
| 开通自检 | 新 token 调目录接口 **200**；免费预检 `requestCheck=passed`、**`canSubmit=true` 且无 blockers**（说明白名单已生效，不会被 `PRODUCTION_NOT_ALLOWED` 拦） |

**token 不写入任何仓库文件**：接口只在创建时返回一次明文（库里只存哈希），已按 600 权限存到操作机 `~/.video-flow/creative-zhuyang.token`，由管理员当面或安全渠道交给本人。

**撤销方式**：`PATCH /api/v1/admin/credentials/creative-zhuyang/revoke` → 从生产 `.env` 的白名单里移除该 actor → `docker compose up -d --force-recreate video-backend`。注意：**再次调用创建接口会轮换 token**（旧 token 立即失效），补发凭证走的是同一条路。

### 2026-09-16：视频延长完成首轮真实验收，确认"只返回延长段"与"整帧计费"

任务 `5b1b2f2c-a5d8-4770-927e-05b95203e6f7`（槽内第 3 版）、Provider 任务 `cgt-20260916142151-11ick`，5 秒 / 480p / adaptive / mov / 有声，输入一段 786×1180 / 5.041667 秒的参考视频。产物 **530×794 / 120 帧 / 5.000 秒 / 2,131,354 字节**，SHA-256 `eec338f8…` **三方一致**（OSS 重下 = 本机成片 = 客户端收据），`verify` 12 项全过。预占 `4.296180` → 结算 **`4.142418`**（98,629 tokens），**预占偏高**、方向安全。已写入 `validation.records`（`status=passed`）。

**§12 留的两个问题都有答案了，还多出一条口径差异**：

1. **接口只返回"延长出来的那一段"**：输入 5.041667 秒 + 延长 5 秒 → 成片 **5.000 秒**（不是 10 秒）→ **必须自己拼到原视频后面**。与官方范例里"拼接后的视频"是单独一件吻合；创意手册已写明这一步。
2. **延长按整帧计费，与生成类不同**：`98,629 = (输入 5.0 + 输出 5.0) 秒 × 530×794 × 24 / 1024` 逐位吻合，而成片恰好 **120 帧 = 5×24**——**没有**生成类那多出的一帧。本实现统一加一帧，故延长类只会高估（本例多预留 0.154 元）；**不据单一样本改计费**，已作为"待复核差异"记进合同 `reservationAdjustment.note`，等更多样本（如 30 秒边界）再定是否按工作流区分。

**本轮另外暴露并修复的两个问题**（都不是这条工作流特有的，影响全部工作流）：

- **客户端与后端 ffprobe 版本不同 → 容器时长不一致**（同一个 mp4：5.1.9 报 5.077333、8.0.1 报 5.041667），而预检元数据要逐字段比对，导致 `PREFLIGHT_ACTUAL_CONTENT_MISMATCH`。两边改为都取**流时长**并部署；库里 9 条旧资产已重新检查自愈。
- **三处错误信息把原因丢掉**（Provider 失败、提交 4xx、预检失败），现在都会带出平台/服务端的原因码与原文——本次定位这两条问题全靠它。

### 2026-09-16：第五条工作流（视频延长）按 §12 长期开放

授权人按 [R8 授权清单 §12](./runbooks/r8-production-acceptance-scope.md) 开放 `seedance.video-extend.v1`（客户端模板 `seedance-video-extend-preflight-v1.comfy.json`），口径与前四条一致（同一批 actor、各自额度、全部参数、长期有效）。合同改为 `implementation=ready` / `admission={enabled:true, reason:null}`，`validation` 保持 `not_run`——这条同样没有真实出片（只有隔离环境的 R6.7）。两处不变量测试的声明列表同步加入。

**这条与前几条不同的三点**：

1. **画幅与格式都是固定的**：比例强制 `adaptive`（画幅跟随输入视频），输出格式固定 **mov**——官方在「视频延长」范例下明确写了"输出格式选择 MOV"，客户端本来就是这么做的，这次把理由落进记录。
2. **计费走含输入视频那一档**：42 元/百万 + 最低用量下限；5 秒延长 + 5 秒输入视频约 **9.11 元**起，输入视频越长越贵。
3. **一个待实测的语义**：官方范例里输入 10 秒、输出 5 秒，而**"拼接后的视频"是单独列出的成品**——也就是说**接口可能只返回延长出来的那一段**，需要用户自己拼到原视频后面。本轮实测必须记录"输出片长 vs 输入视频时长"并据实写进验证记录；若确实如此，创意手册要补上拼接这一步。

顺带把模板默认值换成**官方写法的完整示例**（`在 @视频1 的基础上向后延长 5 秒的视频：…续写内容…`），默认延长时长从 11 秒改成 5 秒与示例一致；tooltip 说明"延长是续写、不写时间戳分镜"，与从零生成的写法区分开。

### 2026-09-16：客户端交付给创意同事做真实操作验收（受控测试期交付）

**交付物**：`packages/comfyui-video-flow-client/` 的**干净导出**（不是工作目录），版本 `CLIENT_VERSION = 2026-09-16.1`。导出方式：

```bash
git archive main:packages/comfyui-video-flow-client | tar -x -C <目标目录>
```

**为什么必须用导出而不是直接拷目录**：客户端目录里混着并行会话**尚未提交**的消费/任务历史界面（`web/js/ConsumptionPanel.js`、`TaskListPanel.js`、`VideoFlowHistoryPanel.js`、`web/video_flow_history.*`、`web/css/`、`web/test/` 等）。`install.sh` 是 `cp -R web` 整目录拷贝，而 `__init__.py` 里 `WEB_DIRECTORY = "./web"` 意味着 ComfyUI 会把这些文件**当前端插件直接加载**——直接拷工作目录会把半成品界面装到同事机器上。

**导出副本实测**（2026-09-16）：42 个文件、只含已提交内容；独立导入通过（20 个节点类、空槽选项「不给素材」、`ffprobe` 兜底命中 `/opt/homebrew/bin/ffprobe`、8 份模板齐备）。安装器现在会打印版本号，排查时让同事报这一版即可。

**门禁状态**：ROADMAP 的客户端包装出口门禁**仍未关闭**，本条记录的是**受控测试期交付**——对应门禁条件里的"目标 ComfyUI 完成真实操作验收"；三端版本配套发布、管理员账号与预算授权等条件仍要在正式发布前补齐，届时按 README 的门禁清单逐条关掉并更新本节。

**同事侧前提**：若在他自己的机器上用他自己的 token，需要先 `POST /api/v1/admin/credentials` 建 actor、`PATCH /api/v1/admin/credentials/{actorId}/limits` 设额度、把 actor 加进生产 `VIDEO_FLOW_PRODUCTION_ACTORS` 并重启后端；否则一提交就被 `PRODUCTION_NOT_ALLOWED` 拦下。

### 2026-09-15：第四条工作流（多模态参考）按 §11 长期开放

授权人按 [R8 授权清单 §11](./runbooks/r8-production-acceptance-scope.md) 开放 `seedance.omni-reference.v1`（客户端模板 `seedance-multi-reference-preflight-v1.comfy.json`），口径与前三条一致（同一 Actor、100 元/日、全部参数、长期有效）。合同改为 `implementation=ready` / `admission={enabled:true, reason:null}`，`validation` 保持 `not_run`——这条同样没有真实出片（只有隔离环境的 R6.5）。两处不变量测试的声明列表同步加入。

**这条与前三条不同，值得单独记一笔**：

1. **单价随「是否含输入视频」切换**：无输入视频 70 元/百万；**含输入视频 42 元/百万**，5 秒 / 720p 的预占从 `7.623000`（纯图/图+音）跳到 `8.164800`（2 秒输入视频，最低值生效）或 `9.109800`（5 秒输入视频）；30 秒输出 + 5 秒输入视频是 `45.360000`。
2. **"最低 token 规则"至今没有被任何真实结算验证过**：`billedTokens = max(公式值, ceil(输出时长×5/3) 秒 × 像素 × 帧率 / 1024)` 是对着官方快查表 96 个数据点逐位核对出来的，但真实调用一次都没跑过。这是它第一次暴露在真实结算下——跑完要专门核对 `minimumTokens` 是否真的按预期生效。
3. R6.5 当时"含视频只允许 Preview、报价 `unavailable`（`INPUT_VIDEO_MINIMUM_TOKENS_UNRESOLVED`）"的阻塞**已经解除**：最低用量规则落地后报价可用，所以现在这条工作流的含视频路径可以真实提交。

### 2026-09-15：首尾帧完成真实验收，并推翻 `bounded` 的像素上界假设

首尾帧开放当天就跑了真实验收，两条独立任务（`1614cd62-…` 20:03、`141babe3-…` 20:05，同一 intent）：5 秒 / 720p / adaptive，首帧 611×917 + 尾帧 717×1051。两条产物均为 **786×1180 / 121 帧 / 5.056 秒**，SHA-256 `f2a6dba7…` 与 `79007caf…` 各自三方一致（OSS 重下 = 本机成片 = 客户端收据），`verify` 12 项全过。预占 `7.671090` → 结算 **`7.671580`**（109,594 tokens），合计 **15.343160 元**。已写入 `validation.records`（`status=passed`）。

**⚠️ 本轮抓到一个真的低估，并已修复。** 合同上一轮记的 `adaptiveOutputBound.status` 是 `assumed_sufficient`（"表内最大像素构成上界"）——这次实测**推翻**了它：

```
720p 表内最大像素 1112×834 = 927,408  →  旧预占 ceil(121 × 927408/1024) = 109,587 tokens
实际出片        786×1180  = 927,480  →  结算 floor(121 × 927480/1024) = 109,594 tokens   ← 多 72 px，少预留 7 tokens
```

钱可以忽略（0.00049 元），但性质是**系统性低估**，与"不得低估预占"冲突。成因看起来是结构性的：Provider 按最接近的表内比例的**面积**给预算、再用首帧比例取整，取整就会略微越过表内最大值——480p 那条同样越过（实测 421,344 > 表内最大 421,120）。

**修法**：`task-quote.service.ts` 新增 `ADAPTIVE_BOUND_MARGIN = 1.01`，`bounded` 路径改为按「表内最大像素 × 1.01」预留（basis 里同时保留原值 `outputPixelUpperBound` 与实际预留值 `outputReservedPixels`，可锁定尺寸的路径不加余量）。改后 5s/720p 的 bounded 预占 `7.671090 → 7.747810`，比实测多留约 1.1%。合同里 `adaptiveOutputBound` 改成 `falsified_needs_margin`，附三条真实样本作证据；回归用例把 786×1180 这条钉住，防止余量被后来的人当冗余删掉。

**同轮另外两条结论**：**"+1 帧"口径成立**（第 6、7 条样本，`floor(121 × 786×1180/1024) = 109,594` 逐位吻合）；**输出画幅跟随首帧**（首帧 0.6663、尾帧 0.6822、产物 0.6661）——尾帧不参与定画幅，按官方说明会被拉伸，**画面是否失真仍需肉眼确认**。

### 2026-09-15：第三条工作流（首尾帧）按 §10 长期开放

授权人按 [R8 授权清单 §10](./runbooks/r8-production-acceptance-scope.md) 开放 `seedance.first-last-frame-to-video.v1`，口径与前两条一致（同一 Actor `creative-pilot`、100 元/日 服务端强制、全部参数、长期有效）。合同改为 `implementation=ready` / `admission={enabled:true, reason:null}`，`validation` 保持 **`not_run` / 空**——这条**同样一次真实出片都没有**（跑通的是隔离环境的 R6.4）。

**用这条工作流前必须知道的两点**：

1. **素材恰好两张图**（`first_frame` + `last_frame`，顺序固定）。
2. **输出比例只按首帧锁定**：官方说明首尾帧只锁首帧，**尾帧画幅不一致时会被拉伸**；报价与预占同样只看首帧——首帧命中合同比例表（16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 21:9，容差 0.005）即锁定尺寸（5 秒 720p 预占 `7.623000`），否则退化为像素上界（5 秒 720p 为 `7.671090`）。选图时**首帧的比例比尾帧重要**。

两处不变量测试的声明列表同步加入该工作流；原先用来演示"环境变量越不过合同"的样本换成仍处 `incomplete` 的 `seedance.video-edit.v1`。

### 2026-09-15：第二条工作流（首帧）按 §9 长期开放，并完成首次真实验收

授权人按 [R8 授权清单 §9](./runbooks/r8-production-acceptance-scope.md) 开放 `seedance.first-frame-to-video.v1`，口径与 §8 的文生视频一致：同一 Actor `creative-pilot`、同样 100 元/日（服务端强制）、**全部参数**、**长期有效**。合同相应改为 `implementation=ready` / `admission={enabled:true, reason:null}`；`validation` 保持 **`not_run` / 空**——这条工作流**一次真实出片都还没有**（跑通的是隔离环境的 R6.3：真实 ComfyUI Queue + Fake Provider），照实写而不是先填上。

**不变量测试做了一处修正**。上一轮收口时加的"`implementation=ready` 必须有 validation 记录支撑"**过严，且与项目自己的放行流程矛盾**：受控放行本来就发生在真实出片之前（text-to-video 第一次开放时也是这样，`9ad08b1` 把 `implementation` 由 incomplete 改成 ready 时 `validation` 仍是 `not_run`）。现在改为：**有记录必须是 `passed` 且记录字段完整；未完成的工作流不允许留下记录**；付费闸门仍由声明列表把守——任何未声明的开放照样让两处测试失败。为了继续覆盖"环境变量越不过合同"与"未就绪即被拦"，测试里充当样本的工作流换成仍处 `incomplete` 的 first-last-frame 与 reference-image。

**用这条工作流前值得知道的**：输出比例是 `adaptive`，服务端按首帧实际宽高到合同像素表里找匹配（容差 0.005）。命中 16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 21:9 就能锁定尺寸，5 秒 720p 预占 `7.623000`；**不命中则退化为按该分辨率像素上界预占**（5 秒 720p 为 `7.671090`，偏高但在安全方向）。首帧裁成标准比例附近更省。

**首次真实验收已完成（同日晚）**：任务 `f6b3732f-d314-4263-81a6-8a96e8218876`（4 秒 / adaptive / 480p / 有声，首帧 769×1163 webp），Provider 任务 `cgt-20260915194409-mw10a`；产物 H.264 **528×798、97 帧、4.064 秒、2,677,725 字节**，SHA-256 `e6dd5028…` 三方一致（OSS 下载件 = 本机成片 = 客户端收据），`verify` 12 项全过。预占 `2.841650`（`bounded`）→ 结算 **`2.793840`**（39,912 tokens），**多预留 0.048 元**、安全方向。已写入该工作流的 `validation.records`（`status=passed`）。

**这轮新增的两条计费观察**（合同 `pricing.estimate.adaptiveOutputBound`）：

1. **锁不住画幅时 Provider 不吸附到合同像素表**：输出 528×798 是首帧自身画幅的等比缩放，不是表内任何一种尺寸；`bounded` 上界（480p 表内最大 21:9 = 428,544 px）这次兜住了实际 421,344 px。
2. **未证实的风险**：首帧宽于 21:9（比例 > 2.33）时上界是否仍够，**没有验证过**——若否，`bounded` 预占会低估。
3. 顺带：**"+1 帧"口径在 adaptive 输出上同样成立**（97 帧 = `4×24+1`；`97 × 528×798/1024 = 39,912.47` → Provider 截断记 39,912），这是第五条真实样本，也是第一条尺寸不在像素表内的样本。

### 2026-09-15：R8 收口 + 预占公式按实测补一帧（两处更正，三包回归全绿）

**一、预占公式补上实测多出的那一帧（代码更正）**。`packages/backend/src/tasks/task-quote.service.ts` 的输出 token 改为按**出片帧数**计：`帧数 = 输出时长 × 帧率 + 1`；分辨率像素、单价、`max(公式, 最低)` 的结论都不变。实现上把原 `formulaTokens` 拆成 `frameTokens(frames, width, height)`，输出部分加常数 `OUTPUT_EXTRA_FRAMES = 1`；**最低 token 口径不跟着动**——它是官方表逐行核对过的下限，且恒大于补帧后的公式项（`ceil(5D/3) ≥ D + 1/24`），所以 `max()` 在两种口径下都成立。

四条**真实结算**成为回归用例（`task-quote.service.spec.ts`）：4s/720p 87,300、5s/720p 108,900（两条独立任务）、6s/480p 9:16 58,045，逐位吻合。480p 那条每帧是 400.3125（非整数），Provider 截断到 58,045，本实现向上取整为 58,046——**多留 1 token 是刻意的保守**，与"不得低估预占"一致。

**为什么四条样本就够改**：本来定的是"等 30 秒边界复核再改"，但四条样本已覆盖 4s/5s/6s 三种时长、480p 与 720p 两种分辨率、16:9 与 9:16 两种画幅，且 `+1 帧` 的解释是编码器把起始帧也计费（与时长无关的结构性原因），不是拟合出来的系数。30 秒边界仍未实测这一点已写进合同；即便那里不成立，偏差方向也只是**多预留一帧**（720p 约 0.063 元），属于安全方向，与"不得低估预占"不冲突。

**后果（报价口径变化）**：所有报价/预占上移一帧——4s/720p `6.048000 → 6.111000`、5s/720p `7.560000 → 7.623000`、含输入视频 5s `8.164800 → 8.202600`、5s/480p 4:3 `3.454500 → 3.483340`、video-edit 12s `21.772800 → 21.810600`。因此报价现在会**略高于官方计算器**（720p 每次约 0.063 元）：这是有意的偏差，官方那条公式在页面上被明确标注为估算值，而项目规则是不得低估预占。合同里用 `pricing.estimate.reservationAdjustment` 显式记录了这个偏离、四条样本、以及"30 秒边界尚未实测"。**下文各日期条目里出现的 6.048000 / 7.560000 / 86,400 等预占值都是旧公式下的历史记录，不再是当前口径。**

**二、R8 收口，随后按新授权重新开放（合同更正两次）**。`seedance.text-to-video.v1` 先按收口语义写回：`implementation=ready`（链路确实通了，不退回 incomplete）、`admission.enabled=false`（reason `R8_ACCEPTANCE_INCOMPLETE`）、`validation.status=passed` 带**两条**记录（4s 与 5s；每条含工作流 / 模型 / 参数组合 / 软件版本（contractRevision + contractDigest + specVersion）/ taskId + providerTaskId / SHA-256 / 帧数 / 结算 / 证据路径）。按项目规则，没有用一个 `production_verified` 概括整个模型和所有规格。

**收口完成后，授权人当天决定改把它作为正式产能开放**，于是合同再改一次：`admission={enabled:true, reason:null}`，`validation` 两条记录保留不动。这次开放是一份显式授权（[R8 授权清单 §8](./runbooks/r8-production-acceptance-scope.md)），授权范围是**该工作流合同允许的全部参数组合**（480p/720p/1080p × 7 种比例 × 4–30 秒 × mp4/mov × 有声/无声 × 水印/无水印）、**长期有效、另行通知**，金额护栏仍是 `creative-pilot` 自身的 100 元/日（服务端强制）。该清单同时写明两条必须随授权一起读的差距：**准入是工作流级的，系统管不住参数**（1080p 也在内）；**真实出片证据只覆盖 720p/16:9/4–5 秒这一面**，其余参数与 30 秒边界都是按公式外推、没有真实出片。

两处不变量测试同步改写（`scripts/tests/workflow_contract_v2.test.mjs`、`packages/backend/src/tasks/workflow-catalog.service.spec.ts`）：声明列表以 §8 授权为准；新增"**implementation=ready 必须由 validation 记录支撑**，未完成的工作流不允许留下记录"；关闭原因不再钉死单串，但必须非空（该原因会作为预检 blocker 详情回到客户端）。`WORKFLOW_NOT_READY` / `WORKFLOW_NOT_ENABLED` 的覆盖从合同测试移到单测：合同测试里 text-to-video 已 ready 且开放，对它只剩账号与全局闸门类 blocker；单测新增一条用仍处 incomplete 的 first-frame 同时断言两个 blocker。

**三、验证**。Backend：`npm run build` + `npx jest`，26 suites / 275 passed。合同层：`VIDEO_FLOW_CONTRACT_DB_PORT=55435 bash scripts/run_mvp_contract.sh`，jest 合同 8 suites / 51 passed、跨包 live contract 21 passed / 2 skipped，退出码 0（默认端口 55432 被另一个项目的库占着，不是残留）。Worker `-q -rs`：214 passed / 26 个预期 skip / 23 deselected。Client：120 passed。`node --test scripts/tests/workflow_contract_v2.test.mjs scripts/tests/workflow_contract_sync.test.mjs`：7 passed；`sync_workflow_contracts.mjs --check` 三份合同资源字节一致。

**四、已部署（2026-09-15）**。`main` 推到 GitHub（`2f5c3e8`）后在生产 `8.140.49.56:/data/video-flow` 执行 `git pull --ff-only` → `docker compose build video-backend video-worker` → `up -d`，**零 migration**。上线后按 runbook §5（按当前 v2 接口口径）smoke：无凭证的 `POST /v1/tasks/preflight` 与 `POST /v1/tasks` 均 **401**；生产目录里 text-to-video 由 `validation=not_run` 变为 **`passed`（2 条记录）**，同时 `admission.enabled=true`；一次**免费**预检（5s / 720p / 16:9）返回 `reserve=7.623000`、`billedTokens=108,900`（= 121 帧 × 900）——新公式在生产生效；数据不变量 `tasks 21 / attempts 9 / reservations 6` 全部不变、`preflight_records +1`、未结案预占 0、无在途任务（`completed 11 / failed 3 / preview 7`）；Worker `/health` = `alive`，两个容器启动日志无 error/exception。

**五、未完成（重要）**：① R8 矩阵第 1 行的 **30 秒边界仍空缺**（本轮决定暂不花这笔钱，720p 约 45.42 元），其余工作流中只有首帧随后被开放（见上一条）、**其余六类仍未验收**，且 §8 授权开放的参数面中只有 720p/16:9/4–5 秒有真实出片；② 再开放任何其他工作流之前，必须先有一条对应授权并同步两处不变量测试的声明列表；③ 费用状态仍是推算（`billedCny` 恒为 null），不等于账单确认。

### 2026-09-15：修复 ComfyUI 状态提示从未生效的缺陷（UI 第 0 期）

`web/js/video_flow_status.js` 想在任务提交、等待和下载后提示"任务 id / 存到哪了 / 费用是否核实"，但在 v2 链路上**一次都没出现过**。根因是同一个 bug 的两面：**ComfyUI 只在节点返回 `ui` 键时才发 `executed` 事件**（源码 `execution.py:563`），而 `CreateTask` 的生产成功路径返回**裸 tuple**（`preflight_nodes.py:580-585`），事件根本不发；同时前端读的 `output.task_id` / `local_path` / `cost_status` 三个键，**这些节点从来没有发出过**。后果是用户在整个链路里看不到 taskId——而报障、查询和重新取片都要用它。附带症状：下载节点的本地路径错位地显示进了"检查报告"框（该节点在报告框的监听集合里）。

实现过程中由测试抓出**恢复路径（沿用槽内已有任务）有完全相同的缺口**，同样不发事件。

已修（提交 `854cfda`）：两条提交路径都改回 `ui.text`，与 `RequestPreview` / `DownloadResult` 既有一致；前端改读 `ui.text`，取数逻辑抽成可直测的 `web/video_flow_status_state.mjs`；下载节点移出报告框的监听集合。摘要遵守 `video_flow_task_report.py` 的**默认脱敏**原则，只含 taskId、执行槽与预占金额。客户端回归 120 passed，新增两条测试分别固定"提交结果带 `ui.text` 且不含提示词/URL"与 toast 取数契约。

**仍存在的已知限制**：`VideoFlowPolicyWait` 返回裸 tuple，**默认 1200 秒等待期间依旧没有提示**；补 `ui.text` 也要等结束才显示、毫无帮助，真正的修法是长任务进度上报，留待后续。

配套调研与后续分期方案（含三个待补的 actor 自助接口、两处须避免的既有隐患、以及动工前必须确认的产品决策）见 [UI 调研与分期方案](./2026-09-15/UI调研与分期方案.md)。该方案的界面范围变更**尚未**写入 `PRODUCT.md`，按 `PRODUCT.md:234` 在动工前必须先完成那一步。

### 2026-09-15：R8 第二条真实付费验收（文生视频 5 秒，走 ComfyUI 客户端人工路径），"少算一帧"第二个样本复现

这一条走的是创意同事真实使用的路径：ComfyUI 里 Preview → 切 Production → 再次 Queue（[R8 授权范围清单](./runbooks/r8-production-acceptance-scope.md) §4.2）。按该节列的三个陷阱看本次配置是对的：任务以 `mode=production` 记在生产后端、收据写进 `~/.video-flow/receipts`（生产回执目录），没有落到隔离环境。

任务 `d4d41580-f30c-4be1-96a7-6cce265451f1`（执行槽 `slot-template-text-v1`，Actor `creative-pilot`），Provider 任务 `cgt-20260915183853-isazs`，模型 `doubao-seedance-2-5-260628`，请求 5 秒 / 720p / 16:9 / 有声 / 无水印 / MP4；预检 `80af152a-a8ef-4569-bab8-fdbab3212c16` 报价 `7.560000`、`canSubmit=true`、无 blockers。产物是**真实视频**：8023991 字节、H.264+AAC、1280×720、24fps、5.056 秒、**121 帧**，SHA-256 `65d04429683a1041ccb9922e20073b73f98652ec9a061cb581e22f1ce21a75d5`。**三方哈希一致**：从 OSS 重新下载的产物、客户端落在本机的成片（`~/mylab/ComfyUI/output/video-flow/d4d41580-f30c-4be1-96a7-6cce265451f1-result.mp4`）与客户端收据记录的哈希相同；`verify` 12 项检查全过、退出码 0，证据导出 `/private/tmp/video-flow-comfy-acceptance/evidence/r8/r8-text-5s-evidence.json`。预占 `7.560000` 最终结算为 `7.623000`（108,900 tokens），reservation 为 `settled`；`cost.status` 仍为 `usage_calculated`、`billedCny` 仍为 null。

**"少算一帧"复现（重要）**：结算比预占高 900 tokens，恰好等于一帧（1280×720/1024 = 900），而实测帧数为 **121 = `5 × 24 + 1`**。这是与 4 秒样本**不同时长的第二个独立样本**，结论逐位吻合，进一步指向真实口径为 **`帧数 × 宽 × 高 / 1024`**（帧数 = `输出秒数 × 帧率 + 1`）。该偏差**已于同日的收口轮修复**（见本节第一条）：补帧公式 + 四条样本回归；30 秒边界仍未实测。

**边界**：本次时长 5 秒是模板默认值，**不是**验收矩阵第 1 行声明的 4 秒 / 30 秒，因此**不计入 R8 矩阵条目**——矩阵第 1 行的 4 秒条目仍以 4 秒那次为准，30 秒边界仍空缺；本条只作为（1）客户端人工路径的链路证据、（2）计费口径的第二个样本。收口动作（把 `seedance.text-to-video.v1` 的 `admission.enabled` 改回 `false` 并写 `validation.records`）已于同日执行，见本节第一条。

### 2026-09-15：R8 首条真实付费验收通过（文生视频 4 秒），并实测出预占少算一帧

R8 的第一条受控正式验收已在**生产环境、真实火山账号**上完成，全程未使用替身。授权范围记录在 [R8 授权范围清单](./runbooks/r8-production-acceptance-scope.md)：授权人 kafeichong、Actor `creative-pilot`、金额上限 100 元/日（由该 actor 自身的 `dailyLimitCny` 在服务端强制）、时间窗 2026-09-15、720p、不允许 1080p。为本次验收只把 `seedance.text-to-video.v1` 置为 `implementation=ready / admission.enabled=true`，其余七类保持关闭；两处不变量测试同步改为"断言**恰好**声明列表里的工作流是开启的"，任何未声明的开启仍会被抓住（提交 `9ad08b1`）。

任务 `3614cb63-dd7b-47d6-82ee-49ffbf7bf366`，Provider 任务 `cgt-20260915182806-2999s`，模型 `doubao-seedance-2-5-260628`，请求 4 秒 / 720p / 16:9 / 有声 / 无水印 / MP4。产物是**真实视频**：8409722 字节、H.264、1280×720、4.041667 秒、97 帧，SHA-256 `34a6c42f8a9ddcc203e48e2e742746d260c6c856e5a318d0c3bcb9e80d4142b0`，已下载并通过 `ffprobe` 解码；证据记录导出为 `/private/tmp/video-flow-comfy-acceptance/evidence/r8/r8-text-4s-evidence.json`，`verify` 判定 PASS（逐项检查全过）。预检报价 `estimated 6.048000`、`canSubmit=true`、无 blockers；预占 `6.048000` 最终按 `usage.completion_tokens` 结算为 `6.111000`，reservation 为 `settled`。

**本轮实测出的偏差（重要）**：结算值比预占高 900 tokens（+1.04%），而这 900 恰好等于一帧（1280×720/1024 = 900）。下载下来的视频确为 **97 帧**，即 `输出秒数 × 帧率 + 1`。也就是说真实计费口径是 **`帧数 × 宽 × 高 / 1024`**，而本轮采用并已取证的 `(输入视频时长 + 输出视频时长) × 宽 × 高 × 帧率 / 1024` 是官方页面上明确标注为**估算值**的那一条（官方原文即写明"准确 token 用量以调用 API 后返回的 `usage.completion_tokens` 为准"）。后果是**预占会系统性少算一帧**，与项目"不得低估预占"的要求不符。该绝对值是常数（720p 一帧约 0.063 元），随输出时长增长占比下降。

**该偏差尚未修复**：写本条时误以为只有 4 秒这一个样本。事后核对生产库，**09-14 还有两条真实付费任务同样支持这个口径**：`994e3fb6…`（5 秒 / 720p / 16:9 → `completion_tokens` 108,900 = 121 帧，与 09-15 的 5 秒样本逐位相同）与 `3bb48246…`（6 秒 / 480p / 9:16 → 58,045 tokens）。后者的每帧 token 不是整数（480×854/1024 = 400.3125），145 帧算出 58,045.3125，而**实测是 58,045——说明 Provider 在这一步是截断而不是向上取整**。因此补帧后的公式需要**向上取整**才对：截断会正好低估 1 token，ceil 则比实测多 1 token（保守方向）。**该公式已于同日的收口轮按这四条样本修正**（见本节第一条），30 秒边界仍未实测。

边界：本次只验收了**一个**工作流、**一种**分辨率、**一条**时长；其余七类与 30 秒边界尚未在真实环境验收。`billedCny` 仍为 null——"按冻结价格推算的 usage"不等于 Provider 账单确认。

### 2026-09-15：输入视频最低 Token 规则已取证并落地，八类工作流全部完成真实 ComfyUI Queue

**这一项此前是三行工作流（R6.5 含视频组合、R6.6 编辑、R6.7 延长）共同的阻塞点**：官方对"输入包含视频"的请求设有最低计费用量，缺少它就只能 fail-closed，否则公式值可能低估实际扣费。本轮把它解决了。

规则（`contracts/seedance-workflows.v2.json` 的 `pricing.inputVideoMinimumTokens`）：

```text
最低计费总秒数 = ceil(输出时长 × 5 / 3)
最低 token 数  = 最低计费总秒数 × 宽 × 高 × 输出帧率 / 1024
实际计费 token = max(公式值, 最低值)          ← 仅当输入包含视频
```

验证覆盖 **96 个官方数据点、全部逐位吻合**：方舟价格快查表最低 token 表 480p/720p/1080p 16:9 输出 4–30 秒共 81 行；同表 480p 的 4:3、1:1、21:9 三个宽高比；官方价格示例中 Seedance 2.5 三个分辨率的最低/最高价 6 点；以及 Seedance 2.0 价格示例 6 点（其 480p 实际为 864×496，与 2.5 的 854×480 不同，此前的一处不吻合正是用错了像素）。规则也解释了官方"最低价对应输入 2~4 秒"的说法：输出 5 秒时最低总秒数为 `ceil(25/3)=9`，减去输出 5 秒正好余 4 秒。

**取证过程与边界**：权威来源是官方页指向的[火山方舟视频生成模型价格快查表](https://bytedance.larkoffice.com/wiki/FXaYwxzJ5i5Zdik32ipcWzt7nxd)。最初 WebFetch 取不到该域名，只能由官方价格示例与公开镜像反推；随后改用本机浏览器（不受 claude.ai 域名策略限制）**直接打开并逐视图核对**，包括『最低token限制』的 480p/720p/1080p 三个子视图，以及『系列价格』视图里 720p 输入 2/3/4 秒同为下限 194,400、输入 5–30 秒逐个等于公式值、1080p 下限 437,400 且价格 20.12。合同的 `evidence` 字段已相应记为 `read_the_official_table_directly`。

随后又从同一批官方链接里的 `seedance2.5价格计算器` 补上两块：该计算器把计算逻辑完整嵌在页面的 `window.formMetaContent` 中，其中价格公式原文为 `单价 × MAX(估算token用量, 最低token用量) / 1000000`（输入含视频时）——**`MAX(估算, 最低)` 这条口径来自官方自身的公式**；而官方最低 token 表除了数值还存了**输入时长**列，逐行读取后 140/140 行等于 `ceil(2 × 输出时长 / 3)`，由于 `ceil(2D/3) + D ≡ ceil(5D/3)`，我原先反推的 `ceil(输出×5/3)` 恰好就是官方表自己存的那条下限。至此计费口径、token 估算公式与最低用量取值三部分均有官方依据。

仍需保留的一条边界：官方来源的**输入时长全部是整数秒**（表按整数列存、计算器是 2–30 下拉），**没有覆盖非整数秒**；本实现按精确小数秒计算，属于照公式连续外推，无官方依据。实际账单以 Provider 返回的 `usage.completion_tokens` 为准，该差异只影响预占金额。

实现按测试先行：先改 `task-quote.service.spec.ts` 观察到失败，再实现 `minimumTotalSeconds()` 与 `billedTokens = max(公式, 最低)`，并移除 `INPUT_VIDEO_MINIMUM_TOKENS_UNRESOLVED` 这条 fail-closed 分支。报价 basis 现在分别记录 `formulaTokens`、`minimumTokens`、`billedTokens` 与 `minimumTokensApplied`。三条纵向合同也从"Production 保持关闭"改写为跑通交付，并分别断言 `billedTokens = max(公式, 最低)` 与 Provider payload 的角色顺序。

**随后发现的越界改动与回退**：提交 `6121448`（信息为 `feat: enable controlled reference image ark canary`）在提交上述最低 Token 规则的同时，把 **`seedance.reference-image-to-video.v1` 在发货源合同里改成了 `implementation=ready / admission.enabled=true`**，而 `validation.status` 仍是 `not_run`。`admission.enabled` 正是 `preflight.service.ts` 用来拦截付费正式提交的那个开关，这等于在没有真实验收记录的前提下打开一条真实计费入口，也违反了"源合同保持全部关闭、临时开放只存在于 loopback 测试 Backend 依赖替身"的既定边界。经确认该改动不是有意安排，已通过 `5c18fa7` 回退，并把"八类必须全部关闭"从整体断言改为逐工作流断言，避免单个工作流被悄悄打开。最低 Token 规则与 `contractRevision 2026-09-15.4` 予以保留。

**四类工作流随即在真实 ComfyUI 中完成正式交付**（每条都在 Queue 前后采快照并断言）：

| 行 | 关键证据 |
| --- | --- |
| R6.5 多模态 | 图片+视频+音频链；`billedTokens=max(366481, 194400)`；payload 为 `image_url/reference_image + video_url/reference_video + audio_url/reference_audio`；预占 15.392202 → 结算 0.042000 |
| R6.6 视频编辑 | `duration=-1` 由唯一参考视频解析出 11.966667 秒；payload 保持 `-1/adaptive/mov`；**归档 `result.mov` 且 Asset 为 `video/quicktime`**；预占 21.712362 → 结算 0.042000 |
| R6.7 视频延长 | 三段不同视频总 27.008334 秒按链顺序绑定；`omni_reference_task_type=extend`；payload 含三段 `video_url`；预占 34.481202 → 结算 0.042000 |
| R6.8 音频参考 | 两段音频共 12 秒；`minimumTokens=null`（无输入视频时规则不适用）；payload 含两段 `audio_url/reference_audio`；预占 7.560000 → 结算 0.070000 |

四条任务的 `assert-preview`（Task / Attempt / 预占 / Asset / Provider create 全为 0，`PreflightRecord` 恰好 +1）与 `assert-production`（Task / Attempt / 预占各 +1、Provider create 恰好 +1）全部通过，终态均为 `completed / delivery ready / client delivered`，产物 `ffprobe` 可解析且 ComfyUI 播放控件可用。

为让运行中的环境加载新报价逻辑，验收环境做过一次重启。该环境的 PostgreSQL 用的是 `tmpfs`，数据库**按设计就是易失的**，重启即清空；重启前已 `pg_dump` 到 `/private/tmp/video-flow-comfy-acceptance/evidence/pre-restart-db-dump.sql`。

**边界必须保持**：Fake Provider 仍是固定 1 秒 64×64 测试片，只证明链路可跑通与可播放，不验证真实时长、画质、费用或创意效果；真实 Ark 出片仍归 R8。源合同仍然八类全部 `implementation=incomplete / admission.enabled=false`，最低 Token 规则的来源是反推而非 Lark 原表直录。验收过程中生成的音频夹具（5 秒与 7 秒 WAV）已从 ComfyUI input 目录删除；目录中另有一个非本轮产生的 `video-flow-acceptance-reference.png` 未作处理。

### 2026-09-15：参考图工作流的 Preview 零增量与同槽顺序生成已用前后快照隔离验证

下一条记录中的参考图 Preview 与 Production 是连着跑的，事后无法单独证明"Preview 没有创建正式任务"。本轮用 Playwright 驱动真实 ComfyUI 0.35.1 前端（`127.0.0.1:8188`，与 Comfy Desktop 同一个 server 与队列；本次 Queue 的 `client_id` 为 `467d8dcf…`，与 Desktop 的 `994c6b02…` 可区分）单独重跑参考图这一项，并在每一步 Queue 前后采集计数器快照做机器判定。

Preview：报告 `requestCheck.status=passed`、`mediaTransfer.uploaded=false`、`willUploadDuringPreview=false`，`effectiveRequest` 为 `seedance.reference-image-to-video.v1` / 5s / 16:9 / 720p / mp4 / 有声无水印，媒体为 `reference_image`（sha256 `f441d055…`、769×1163、image/webp、52644 字节），报价 `estimated 7.560000 CNY`。增量为 `tasks` / `execution_attempts` / `task_budget_reservations` / `assets` / Fake Provider `createCount` **全部为 0**，`preflight_records` 恰好 +1 —— 该独立记录既是用户看到的报告，也是后续 Production 消费的凭据，属于 Preview 合法且必需的副作用。

Production：同一画布切成 `production` 再次 Queue，创建任务 `27bf4fe8-640f-4b57-a4be-dbe0d93345bc`，槽 `slot-template-product-v1`、`slotSequence=2`，`preflightId=98372e7e…` 正是上一步 Preview 留下的那条记录。增量为 `tasks` / `execution_attempts` / `task_budget_reservations` 各 +1、Fake Provider `createCount` 恰好 +1 且归属本次 Prompt，`preflights` +0（复用了仍在有效期内的预检）。预占 `7.560000` 按 `usage.completion_tokens=1000` 结算为 `settled 0.070000`。Fake Provider 实际收到的 payload（`image_url` + `role=reference_image`、5s、16:9、720p、mp4、`generate_audio=true`、`watermark=false`）与冻结执行快照逐字段一致。任务终态 `completed / delivery ready / client delivered`，产物 `output/video-flow/27bf4fe8-…-result.mp4` 的 sha256 与客户端回执一致，`ffprobe` 为 H.264 64×64 1.0s，ComfyUI 成片预览节点出现可播放的视频控件（`0:00 / 0:01`）。

同一执行槽此前已有一条**已交付**的序号 1（`ce730c9f…`），本轮序号 2 的创建证明"完成本地交付后的下一次 Queue 才顺序生成下一版"在真实环境成立，而不是只靠单测断言。

新增 `scripts/comfyui_acceptance_evidence.py` 及其测试：对运行中的验收环境采集计数器与 Provider 统计的前后快照，并做 `assert-preview` / `assert-production` 增量子断言，使"Preview 必须零增量""Production 必须恰好一次"成为可机器复现的结论，而不是人工读日志。证据（快照 JSON、导入的模板副本、播放截图）保存在 `/private/tmp/video-flow-comfy-acceptance/evidence/`。

实现该工具时先按测试先行写错了一次断言：初版把 `preflight_records` 也当成"不得移动"的计数器，在真实环境误报失败。改为"恰好 +1"后才与实际设计一致。这条错误不跑真实 Queue 不会暴露。

**本轮发现并已修复的产品侧观测缺陷**：Worker 用 `print()` 输出运行日志，而 Python 的 stdout 在重定向到文件或管道时是块缓冲，`PYTHONUNBUFFERED` 在验收脚本与 Worker 镜像里都没有设置。实测 `worker.log` 停在 15:58（1218 字节），而 Worker 在 16:16 又完成了一个任务——审计 JSONL 与产物均按时更新，唯独 `tail worker.log`（手册第 6 节的排查步骤）与 `docker logs video-flow-worker` 看不到任何新内容；隔离复现显示，不设该变量时 `print()` 的内容要等进程退出才落盘，设置后立即落盘。已在 `packages/worker/Dockerfile` 增加 `ENV PYTHONUNBUFFERED=1`，把验收启动器的 Worker 环境抽成 `worker_environment()` 并同样设置该变量，`scripts/tests/test_worker_logging.py` 固定这两个断言。注意：**当前仍在运行的验收环境是修复前启动的，其 Worker 日志仍然滞后**，要重启该环境才会生效（重启会清空隔离数据库卷，本轮任务记录将无法再直接查询）。

### 2026-09-15：文生视频、参考图与首帧已完成真实 ComfyUI 本地隔离验收，不能等同于 Ark 正式验收

已在 Comfy Desktop `1.0.47` / ComfyUI `0.35.1` 中重新安装当前客户端，导入临时文生视频模板并实际 Queue。Preview 返回 `requestCheck.status=passed`、`canSubmit=true`、`willUploadMedia=false`、`willCallProvider=false`，且数据库 Task / Attempt / Reservation 与 Fake Provider create 增量均为 0。Production 再次 Queue 后，经真实客户端节点、Nest Controller/Guard、隔离 PostgreSQL、Worker 正式编译器、Fake Provider 和 Fake OSS 完成一条正式任务。

验收任务 `bd5c5d7d-3683-436c-bb06-cbe403af820f` 最终为 `completed / delivery ready / client delivered`；Fake Provider `createCount=1`，收到 `doubao-seedance-2-5-260628`、5 秒、720p、16:9、MP4、有声、无水印 payload。预算按请求参数预占 `7.560000 CNY`；Fake usage 为 `completion_tokens=1000`，按冻结价格推算并结算 `0.070000 CNY`，reservation 为 `settled`。输出 Asset 为 `video/mp4`、2246 bytes，客户端落盘到 `/Users/steven/mylab/ComfyUI/output/video-flow/bd5c5d7d-3683-436c-bb06-cbe403af820f-result.mp4`；`ffprobe` 识别为 H.264、64×64、1 秒，ComfyUI 播放控件进入“暂停”状态，证明下载文件可实际播放。

参考图工作流随后在同一 Comfy Desktop 中完成实际 Queue。对本机 `003bottle-rotate.webp` 的 Preview 生成有效 `reference_image` 描述（WebP、769×1163、52644 bytes、SHA-256），但没有上传素材或新增正式 Task / Attempt / Reservation，Fake Provider 计数仍为 1。再次 Queue 的 Production 创建任务 `ce730c9f-120e-47af-baf0-5b55302a298a`：本机 Fake OSS 的输入 Asset `a107af72-fa85-4cc9-b1c6-47be2d6ee2a3` 为 `verified`，MIME `image/webp`、大小 52644 bytes；Fake Provider 只新增一次 create，并收到带 `role=reference_image` 的 loopback Fake OSS URL 和冻结的 5 秒、720p、16:9、有声参数。任务最终 `completed / ready / delivered`，预占 `7.560000 CNY`、usage 结算 `0.070000 CNY`、reservation `settled`；产物为 2246 bytes H.264 MP4，落盘到 `/Users/steven/mylab/ComfyUI/output/video-flow/ce730c9f-120e-47af-baf0-5b55302a298a-result.mp4`，播放器实际进入“暂停”。

首帧图生视频随后使用同一张本机 WebP 完成实际 Queue。Preview 生成有效 `first_frame` 描述而未上传素材，Task / Attempt / Reservation 与 Fake Provider `createCount=2` 均未增加。Production 创建任务 `28cfdfbc-378d-4400-8f47-78d21342eff0`，最终为 `completed / ready / delivered`；Fake Provider 只新增一次 create，并收到 `image_url` 的 `role=first_frame`、`ratio=adaptive`、5 秒、720p、有声、MP4 的冻结请求。任务预占 `7.560000 CNY`，Fake `completion_tokens=1000` 按冻结价格结算 `0.070000 CNY`，成本状态为 `usage_calculated`；输出 Asset 为 `video/mp4`、2246 bytes，客户端落盘 `/Users/steven/mylab/ComfyUI/output/video-flow/28cfdfbc-378d-4400-8f47-78d21342eff0-result.mp4`，`ffprobe` 为 H.264、64×64、1 秒，ComfyUI 播放器实际进入“暂停”。

本轮同时修复了实测暴露的三处合同问题：文生视频模板错误复用 link ID；测试 Backend 中 V1 Asset 服务没有使用 loopback Fake OSS override；Fake OSS 没有回传上传对象的 Content-Type / SHA-256 metadata。客户端配置节点也改为保留环境注入的临时 token、receipt 目录和 spec version，避免验收数据写入用户默认目录。对应源码：`packages/comfyui-video-flow-client/workflows/seedance-text-to-video-preflight-v1.comfy.json`、`packages/backend/test/contract-backend.cjs`、`scripts/fake_provider.py`、`packages/comfyui-video-flow-client/nodes.py`、`scripts/comfyui_acceptance_env.py`。

修复后完整验证：Backend build 通过、26 suites / 272 tests；Worker 214 passed / 26 个仓库外 workflow JSON 预期 skip / 21 deselected；客户端 118 passed；验收环境与 Fake Provider 定向 16 passed；合同资源同步检查通过；隔离跨包合同 Backend 51/51、Fake Provider 8/8、真实 Backend/DB/Worker/Fake Provider 19 passed / 2 个外部场景 skip；全新库与模拟历史库均应用 13 个 migration；`git diff --check` 通过。隔离跨包脚本使用 `55435/19094`，结束后已清理自身容器、网络和数据库卷，不影响仍在运行的 ComfyUI 验收环境。

边界必须保持：固定测试视频只有 1 秒、64×64，它验证的是 Queue、正式提交、下载、归档、交付确认和播放，不验证 Seedance 真实 5 秒内容、画质或创意效果；另外 5 类模板尚未在目标 ComfyUI 中逐个实际 Queue。正式三份工作流合同仍为 `implementation=incomplete / admission.enabled=false`，8 类临时开放只存在于 loopback 测试 Backend。当前隔离环境仍在本机端口 `3400/8011/19093/55434` 运行，运行与清理步骤见 `docs/runbooks/local-manual-test.md`。

### 2026-09-15：R7 代码清理与自动化总回归已完成，ComfyUI 验收已覆盖文生视频、参考图与首帧

R7 已把 Backend 合同测试全部迁移到当前 v2 语义：Preview 只创建独立 `PreflightRecord`，对 Task、Attempt、预算预占和 Provider create 的增量均为 0；Production 测试先调用真实 `/api/v1/tasks/preflight`，再只提交 `preflightId + executionSlotId + media slot 绑定`。参考图 5 秒 720p 的预算边界按当前官方公式使用 7.560000 元；Provider usage 测试使用官方 `completion_tokens`，并按冻结的 `seedance-2.5-public-catalog-2026-09-15` 快照结算。源码：`packages/backend/test/workflow-fixtures.ts`、`preflight.contract-spec.ts`、`budget.contract-spec.ts`、`provider-outcome.contract-spec.ts`。

已删除没有运行时调用者、只靠旧测试互相维持的 `production-spec.ts`、`workflow-registry.ts`、`workflow-preflight.ts` 及其测试；`VIDEO_FLOW_PRODUCTION_SPEC_JSON` 不再出现在代码或合同脚本中。当前唯一新任务合同是 v2 workflow catalog + 独立 Preflight + 服务端冻结报价/执行快照；旧 `mode=preview` 和 `confirmLiveSubmission` 只保留负向拒绝测试。测试夹具使用明确的 `allowProduction/readyWorkflows`，且临时 ready 只存在于 `test/contract-backend.cjs` 的依赖替身，正式三份合同资源仍全部为 `implementation=incomplete / admission.enabled=false`。

本轮实际验证：Backend `npm run build` 和 26 suites / 272 tests；HTTP smoke 通过；Worker 214 passed / 26 个仓库外 workflow JSON 预期 skip / 21 deselected；客户端 117 passed；合同同步检查通过；隔离合同中 Backend 51/51、Fake Provider 7/7、真实 Backend/DB/Worker/Fake Provider 19 passed / 2 个外部场景 skip；空库和模拟历史库均成功应用 13 个 migration，历史 Decimal 值核验通过；`git diff --check` 通过。合同脚本结束后清理容器、网络和测试卷。

R7 尚未完成的边界：目标 ComfyUI 已完成当前插件重装以及文生视频、参考图、首帧模板的 Preview/Production 实际 Queue，但其余 5 份模板尚未逐个导入和 Queue；两个跨包 skip 对应的外部/运行环境验收不能计为通过。未部署、未提交、未推送、未上传真实素材、未连接真实 OSS/Ark、未创建付费任务。

### 2026-09-15：R6 八类工作流均已形成自动化纵向证据，尚待真实 ComfyUI 与外部缺项

R6 新增统一模板合同测试，对当前 8 份 `*-preflight-v1.comfy.json` 逐条检查全局 link、节点 input/output 反向引用、类型一致性、默认 Preview，以及从请求节点可达输出节点；同时明确参考图模板只有一个 `ProductInput/ProductRequest`，客户端时长选项为完整 4–30 秒。当前客户端完整回归 117 passed。源码：`packages/comfyui-video-flow-client/tests/test_workflow_templates.py`。

R6.1 已把仓库内官方 `referenceImage` fixture 接入实际 Worker 编译器测试：30 秒请求生成官方 content 角色和参数，3/31 秒在 Provider 调用前拒绝。Worker 定向 16 passed；Backend 工作流解析、冻结预检、素材 slot 绑定与预占定向 2 suites / 21 passed。

R6.2 文生视频新 v2 纵向合同已独立跑通 4 秒与 30 秒两条边界。正式预检和提交使用空媒体列表，冻结 `executionPlan.media` 为空，Worker 生成的 Provider `content` 只有 Prompt 文本，不创建、绑定或伪造输入 Asset；实际参数报价、预算预占、Fake Provider create、`usage.completion_tokens` 结算、输出 Asset 和 delivery ready 均完成。管理员任务报告最终只有 `output` Asset。测试：`packages/worker/tests/test_mvp_live_contract.py::LiveMVPContractTests::test_text_to_video_four_and_thirty_seconds_never_bind_an_input_asset`，1 passed。

R6.2 按 TDD 先观察到旧合同辅助函数强制读取 `payload.media[0]` 的 `IndexError`，随后将测试链改为按 `workflowKey` 构建媒体描述和 `slotId → assetId` 绑定；空媒体工作流自然生成空绑定。`scripts/run_mvp_contract.sh` 的 ready workflow 改为仅由显式测试环境变量配置，默认仍只允许参考图，生产源合同和正式运行时没有新增绕过开关。本轮回归：Worker 定向 16 passed、全量 208 passed / 26 个仓库外 workflow 资产缺失导致的预期 skip / 14 deselected；客户端全量 107 passed；Backend build、Fake Provider 7 passed、全新/历史库 13 个 migration 均由 R6.2 隔离纵向脚本再次通过。

R6.3 首帧工作流也已用官方 fixture 和新 v2 纵向合同覆盖。fixture 明确断言 `image_url + first_frame`、`ratio=adaptive`、4 秒和有声字段；纵向合同进一步跑通 4 秒与 30 秒，冻结媒体角色只含 `first_frame`，报价按已检查首帧 1280×720 比例解析 720p 输出尺寸并预占，Worker 向 Fake Provider 保留 `adaptive` 和首帧角色，最终完成 usage 结算与交付。测试：`test_seedance_execution_policy.py` 定向 17 passed；`test_first_frame_adaptive_four_and_thirty_seconds_reach_delivery` 1 passed；Worker 最新全量 209 passed / 26 个预期 skip / 15 deselected。测试先因辅助器只识别参考图/纯文本而失败，随后仅把合同测试 descriptor 构建扩展为按图片角色生成，没有修改生产准入或源合同状态。

R6.4 首尾帧工作流已使用两个内容、哈希、对象键和 Asset ID 均不同的隔离图片完成纵向合同。4 秒和 30 秒请求均以 `ratio=adaptive` 通过正式预检；冻结快照严格保持 `first_frame → last_frame` 及各自 `slotId → assetId`，Worker 向 Fake Provider 发送两个不同 URL 并保持同样角色顺序，随后完成实际预占、单次 create、usage 结算和交付。RED 阶段因尾帧 descriptor 错用首帧哈希而在 Task/预占前得到 `PREFLIGHT_ACTUAL_CONTENT_MISMATCH`，修正后转绿，证明测试能捕获素材错绑。官方 fixture 编译器测试同时覆盖 `image_url + first_frame/last_frame`、`adaptive`、时长和有声字段。

官方说明首尾帧输出比例只锁定首帧；尾帧画幅不一致时会被拉伸。Backend 报价回归因此加入首帧 900×1600、尾帧 1600×900 的组合，确认 720p 仍按首帧解析为 720×1280、`adaptiveBasis=first_frame`，5 秒预占为 7.560000 元，不按尾帧或两帧平均。R6.4 验证：纵向合同 1 passed；Worker 编译器 17 passed、全量 209 passed / 26 个预期 skip / 16 deselected；Backend 报价/预检/目录 3 suites / 30 passed；客户端模板与请求节点 25 passed。

R6.5 全模态参考当前形成了不能混写成“全部通过”的双结果。无输入视频的图片+音频组合可按官方公式确定预占，已在 4 秒和 30 秒两条纵向合同中完成不同 Asset 精确绑定、正式预检、预算预占、Worker 编译、Fake Provider 的 `image_url/reference_image + audio_url/reference_audio` payload、usage 结算和交付。含输入视频的图片+视频+音频组合则只允许完成 Preview：请求检查通过并保留每段实际视频时长，但报价明确为 `unavailable`，缺项为 `INPUT_VIDEO_MINIMUM_TOKENS_UNRESOLVED`，Production 返回 `QUOTE_UNAVAILABLE`，对应执行槽无 Task，Worker 运行后 Provider create 仍为 0。没有用公式估算值、固定金额或刊例价绕过最低 Token 规则。

Worker 新增官方 `omniReference` fixture 回归，明确保持图片加两个视频的角色、`omni_reference_task_type=reference`、15 秒和 MOV 字段。客户端已移除固定 `3 图 + 1 视频 + 1 音频` 的临时节点，改为独立图片、视频、音频节点：每个节点可接入上一份 `reference_media` 并追加一项，按链路顺序生成稳定的分角色 slot。客户端本地检查接受官方上限 `30 图 + 10 视频 + 10 音频 = 50 项`，超过任一角色或总数立即拒绝；视频和音频各自 30 秒总时长规则继续复用统一媒体检查器，完整 Preview 仍由 Backend 合同复验。模板示范图片 → 视频 → 音频链式组合并保持默认 Preview，不把示范数量当作产品上限。R6.5 当前验证：两条纵向合同各 1 passed；Worker 编译器 18 passed、全量 210 passed / 26 个预期 skip / 18 deselected；Backend 报价/预检/目录 3 suites / 30 passed；客户端最新全量 111 passed，模板结构 4 passed。

R6.5 尚不能标记完整完成：客户端数量入口已覆盖官方上限，MOV 归档扩展名/MIME 也已由 R6.6 共用修复；但含视频最低 Token 明细仍未取得，目标 ComfyUI 也未实际导入和 Queue。因此本项保持部分完成和 fail-closed，不勾选 ROADMAP。

R6.6 视频编辑已完成当前可安全验证的自动化边界。Worker 编译器现在直接使用官方 `videoEdit` fixture，确认 `reference_video`、`duration=-1`、`ratio=adaptive`、`omni_reference_task_type=edit` 和 `output_format=mov`，定向 18 passed。客户端新增 `VideoFlowVideoEditRequest` 和第 6 份 Preview/Production 模板：至少需要一段 4–30 秒参考视频，请求节点固定官方特殊字段，不向用户暴露可产生非法组合的普通时长、比例和格式选项。

现代 Worker 归档链不再把所有视频写成 MP4：它从冻结 `executionPlan.outputFormat` 选择扩展名和 MIME。MP4 仍归档为 `result.mp4 / video/mp4`；MOV 归档为本地 `.mov`、OSS `result.mov` 和 Asset `video/quicktime`，同一 task + attempt 的稳定幂等 key 不变。MOV 定向归档 2 passed；Worker 最新全量 212 passed / 26 个预期 skip / 19 deselected，客户端最新全量 113 passed。

视频编辑隔离纵向合同在全新/历史 PostgreSQL 应用全部 13 个 migration，Backend build 和 Fake Provider 7 passed 后运行 1 passed：Preview 请求检查通过并完整保留 `-1/adaptive/mov`，报价明确缺少 `INPUT_VIDEO_MINIMUM_TOKENS_UNRESOLVED`，Production 返回 `QUOTE_UNAVAILABLE`，执行槽无 Task，Worker 周期后 Provider create 数不变。R6.6 仍不能勾选：最低 Token 明细未取得，因而尚无合法 Production Task 可跑 MOV 全链；目标 ComfyUI 也未实际导入和 Queue。

R6.7 视频延长已完成当前可安全验证的自动化边界。客户端新增 `VideoFlowVideoExtendRequest` 和第 7 份 Preview/Production 模板：示范三段参考视频链式输入，允许继续按统一集合规则增删图片、视频或音频；输出时长只开放整数 4–30 秒，比例固定 `adaptive`，正式字段冻结为 `omni_reference_task_type=extend` 和 `outputFormat=mov`。Worker 直接消费仓库内官方 `videoExtend` fixture，确认三个 `reference_video` 的角色顺序、11 秒、`adaptive/extend/mov` 均由现有正式编译器保留，无需新增另一套编译路径。

视频延长隔离纵向合同同样在全新/历史 PostgreSQL 应用全部 13 个 migration，Backend build、Fake Provider 7 passed 和目标 live contract 1 passed：Preview 检查通过并完整保留 `11/adaptive/mov`；因输入视频最低 Token 明细仍缺失，报价为 `unavailable`，Production 返回 `QUOTE_UNAVAILABLE`，执行槽无 Task，Worker 周期后 Provider create 数不变。R6.7 仍不能勾选：尚无合法 Production 报价与 MOV 交付纵向证据，目标 ComfyUI 也未实际导入和 Queue。

R6.8 音频参考已完成自动化正式链路。官方资料确认 Seedance 2.5 支持纯音频参考，属于全模态 `reference` 子任务；图片/视频/音频组合继续由 R6.5 负责。客户端新增 `VideoFlowAudioReferenceRequest` 和第 8 份模板，示范两段音频链式输入，产品边界为 1–10 段 `reference_audio`、总时长不超过 30 秒，输出时长开放整数 4–30 秒；混入图片或视频时明确提示改用全模态模板。Worker 官方 `audioReference` fixture 断言实际正式编译结果为 `audio_url/reference_audio + omni_reference_task_type=reference`。

纯音频不含输入视频，因此 R6.8 的 4 秒和 30 秒请求都在隔离纵向合同中获得基于实际参数的非零预占，创建一次 Fake Provider Task，按 `usage.completion_tokens` 结算并完成 MP4 交付。首次运行只因测试误认为 `pricingSnapshot` 顶层含 `inputVideoDurationSeconds` 而失败；修正为断言冻结 `reserveCny` 非零后转绿，没有修改生产报价服务。最终回归：Worker 214 passed / 26 个预期 skip / 21 deselected，客户端 117 passed，合同资源与同步 6 passed；全新/历史库 13 个 migration、Backend build、Fake Provider 7 passed、目标 live contract 1 passed。R6.8 仍不勾选 ROADMAP，因为目标 ComfyUI 尚未实际安装、导入并 Queue Preview，源合同继续 fail-closed。

参考图新 v2 纵向合同现已独立跑通 4 秒与 30 秒两条边界：隔离 PostgreSQL 从空库和模拟历史库应用 13 个 migration；真实 Backend Controller/Guard 创建独立 Preview，再用测试 bootstrap 临时把且只把参考图工作流设为 ready；正式提交复验 verified Asset 实际字节并按报价预占；真实 Worker 编译冻结快照后只向 Fake Provider create 一次；Fake Provider 返回 `usage.completion_tokens`；Backend 按冻结价格结算；Worker 完成 MP4 下载、归档、Asset 登记和 delivery ready。最终断言覆盖 Provider payload 时长/角色、预占金额、usage 推算金额、reservation settled 和交付 Asset。测试：`packages/worker/tests/test_mvp_live_contract.py::LiveMVPContractTests::test_reference_image_four_and_thirty_seconds_reach_delivery_with_frozen_usage`，1 passed；Fake Provider 7 passed；Worker 全量 208 passed / 26 个仓库外 workflow 资产缺失导致的预期 skip / 13 deselected。

该链路实际观察到两次 RED：旧总合同先以 42 failed / 9 passed 暴露旧 Preview Task、旧 ProductionSpec 等 R7 待迁移用例；新纵向合同首次运行又因 Fake Provider 返回旧 `total_tokens` 而使当前 Seedance 2.5 费用状态成为 `unavailable`。修正方式是让 Fake Provider 按当前官方合同返回 `completion_tokens`，没有放宽生产结算器。`scripts/run_mvp_contract.sh` 新增显式的定向运行参数，默认仍会运行旧完整合同，不会把已知失败隐藏为绿色；回环合同进程同时清空本机代理变量，避免测试误走 SOCKS。

R6.1–R6.4 的自动纵向证据已经具备，但目标 ComfyUI 尚未重新安装、导入模板并实际 Queue Preview，因此 ROADMAP 的 R6.1–R6.4 暂不勾选，源合同仍保持 `implementation=incomplete`、`admission.enabled=false`、`validation=not_run`。测试 bootstrap 的 ready 覆盖不会进入生产运行时。

此前盘点出的 Worker 固定 `.mp4` 缺口已由 R6.6 修复，并用 MOV 本地路径、对象键和 `video/quicktime` Asset 登记回归覆盖。R6.1–R6.4 的 MP4 路径保持不变；R6.5–R6.7 后续仍需在其合法 Production 纵向合同中再次验证实际 MOV 交付。本轮只有隔离数据库、Fake Provider、Fake OSS 产生测试数据，脚本结束后容器、网络和测试卷均已清理；未调用真实 Provider/OSS，未创建付费任务，未安装、部署、提交或推送。

### 2026-09-15：R5 客户端统一入口已完成自动化验收（本地未提交）

客户端已开始消费 R4 的正式合同。Production 会先调用 `GET /api/v1/tasks/slots/:slotId/current`：存在未完成本地交付的 Task 时直接恢复，不读取预检有效期，也不受新任务额度或暂停状态影响；槽为空后才检查新任务条件。正式创建请求已改为只发送 `mode + preflightId + executionSlotId + media[{slotId,assetId}]`，不再发送旧的 `confirmLiveSubmission`、Prompt、生成规格、价格或按顺序猜测的 role。源码：`packages/comfyui-video-flow-client/preflight_nodes.py`、`client.py`、`submission_state.py`。

6 份当前 Preview/Production 模板均保存独立执行槽；前端扩展保证原节点继续使用已有槽，复制正式提交节点时生成新槽。Production 模式不再使用一次性确认布尔值；当前内容没有有效预检时，本次 Queue 自动执行无上传 Preview 并停止，提示用户检查后再次 Queue。源码：`execution_slot.py`、`web/execution_slot.js`、`web/execution_slot_identity.mjs`、`workflows/*-preflight-v1.comfy.json`。

客户端下载成功后先把本地路径、大小和 SHA-256 写入按账号隔离的槽回执，再调用 client-delivery 确认；确认失败时下次 Queue 会重新校验本地文件并只重试原 Task 的确认，不重复下载或生成。槽回执同时保存当前轮次的原请求、精确 POST body、幂等键和 Task；未完成提交重试原 key，上一轮本地交付确认且服务端释放槽后生成新轮次 key，同一有效预检已验证可顺序创建 `task-1`、`task-2`。

Preview 和 Production 首次自动 Preview 现在使用同一报告结构，只展示服务器权威 `effectiveRequest`、逐项 `requestCheck`、Preview 零上传状态、报价依据及当时的 `canSubmit/blockers`，不再并列展示客户端原始 request。新一轮执行开始会覆盖旧成功提示；执行错误会显示失败原因，避免旧绿色状态残留。源码：`preflight_nodes.py`、`web/preflight_report.js`、`web/preflight_report_state.mjs`。

旧上传式 Preview、旧无预检 Production、固定 5 秒 OneClick 和旧文本 Preview 已从 ComfyUI 注册表移除，对应 3 份 workflow 和 1 份 production example 不再由安装器交付；`nodes.py` 只保留 Config 与凭已有 `taskId` 等待/下载的恢复能力，`examples/seedance-resume.json` 保留。加入 R6 模板检查后的当前客户端完整回归为 `107 passed`，R5 代码与自动化验收仍保持通过。尚未执行目标 ComfyUI 的重新安装、重启、模板导入、报告渲染和 Queue Prompt 操作验收，因此不能据此宣称实际客户端已交付或链路可用。

### 2026-09-15：R4 正式提交、执行槽与唯一 Worker 编译器已完成（仅本地分支）

R4 已实现新的正式提交服务。`POST /api/v1/tasks` 的 Production 请求只接受 `preflightId`、稳定 `executionSlotId` 和 `media[{slotId,assetId}]`；不接受客户端重复提交 Prompt、生成规格、摘要、价格或 Provider 字段，也不再使用一次性 `confirmLiveSubmission`。服务端从有效 `PreflightRecord` 重建冻结 executionPlan，原样固化合同/意图/报价摘要、服务端模型、实际生成参数、`reserveCny` 和 `pricingSnapshot`。素材工作流按 `slotId` 精确绑定同账号 `verified` 输入 Asset，并在创建前流式复验对象实际 SHA-256/大小，事务内再次检查预检、报价、素材、Production 暂停、Actor 权限和额度。源码：`packages/backend/src/tasks/production-submission.service.ts`、`preflight.service.ts`、`task-budget.service.ts`。

Task 已增加 `executionSlotId`、`slotSequence`、`preflightId`、三个摘要和客户端交付状态。`actorId + executionSlotId` 在 advisory lock 下串行化：同槽已有未交付或结果不确定 Task 时，无论新提交使用什么幂等键、预检是否过期或当前新任务准入是否暂停，都先恢复原 Task，不会重复创建或重复预占；只有客户端确认本地交付，或系统能够证明该 Task 不会再产生结果时，才能创建下一序号。新增 `GET /api/v1/tasks/slots/:slotId/current` 和 `POST /api/v1/tasks/:id/client-delivery`；交付确认要求 Task 所有权和服务端产物已就绪，重复确认幂等。数据库由 `20260915150000_add_production_execution_slots` migration 增量扩展，不新增 ExecutionSlot 表，不改写历史 Task。

Worker 新任务只经过 `providers/seedance_execution_policy.py::compile_seedance_payload`：它校验冻结执行规则摘要、服务端模型、workflow 官方能力、媒体角色/顺序、4/30 秒边界、编辑特殊 `-1`、比例、分辨率、输出格式和 Provider 特殊字段，再构造 Ark payload。完整目录使用独立 `catalogDigest`；Task/Preflight 的 `contractDigest` 只覆盖模型、官方能力、媒体角色、生成参数和 Provider 字段，不包含当前 `implementation`、`admission`、验收、展示或价格状态。Worker 要求冻结 `workflowVersion` 存在，但不再要求等于最新目录 revision，也不读取当前准入状态；工作流关闭只阻止 Backend 创建新 Task，不否定已创建 Task。重复的 `seedance_compiler.py` 已移除。编译发生在写入 Provider submitted 证据之前；编译失败时 Provider create 为 0，并释放确认未调用 Provider 的预算预占。已有 `providerTaskId`、提交结果不确定、归档恢复和 usage 证据边界保持不变。源码：`packages/backend/src/tasks/workflow-catalog.service.ts`、`packages/worker/providers/seedance_execution_policy.py`。

R4 完成的是通用 Backend/Worker 正式执行层，不等于 8 类工作流已经对用户开放。按照 v2.1 规范，当前 8 类工作流仍保持 `capability=confirmed`、`implementation=incomplete`、`admission.enabled=false`、`validation=not_run`。生产源码没有打开工作流的测试环境变量；Backend 单元测试使用测试文件内的 Catalog fixture，真实 Nest 合同通过 `test/contract-backend.cjs` 在测试模块中替换依赖。R5 已让客户端改用稳定槽、本地回执和交付确认；各工作流模板及完整纵向合同尚待 R6。含输入视频的最低 Token 规则仍未取得可执行值，因此相关报价继续 `unavailable`。当前本地代码不可直接作为已可用 Production 客户端发布。首次改变执行规则前仍须把旧摘要对应合同加入 Worker 版本注册并保留到旧 Task 排空；当前尚未上线，没有旧 v2 正式 Task 需要迁移。

本次实际验证：

- Backend：`cd packages/backend && npm run build && npx jest --runInBand`，29 suites / 294 passed；R0/R2/R4 定向回归为 8 suites / 93 passed；
- Worker：`cd packages/worker && venv/bin/python -m pytest -q -rs`，205 passed / 26 个仓库外 workflow JSON 缺失导致的预期 skip / 12 deselected；R4 编译、参数和恢复定向 43 passed；
- 客户端：`cd packages/comfyui-video-flow-client && .venv/bin/python -m pytest -q -rs`，98 passed；该结果只证明现有客户端回归，不能替代 R5 新协议实现；
- 合同资源：revision `2026-09-15.3` 的三份 `seedance-workflows.v2.json` 字节一致；Node 合同/同步 6 passed；Backend 与 Worker 的执行规则摘要均为 `2e95034c85ad474935befa206d2b7721eb4c3748653a83c5f6a40fdf390e8ecc`；脚本回归 26 passed，其中 Fake Provider 7 passed，证明冻结 4 秒 payload 原样到达，31 秒在编译阶段拒绝且 create=0；
- HTTP/数据库：隔离 PostgreSQL 的空库和模拟历史库均成功应用全部 13 个 migration；`20260915170000_decimal_execution_costs` 将 `Task.cost` 和 Attempt 的估算、usage 推算、账单金额统一为 `Decimal(18,6)`，历史有限浮点值保留为数据库实际值并规范到 6 位，`NaN/Infinity` 会使迁移明确失败；`test/preflight-v2.contract-spec.ts` 2 passed，真实 Nest/Guard/Prisma 下验证同槽并发只创建 1 个 Task/1 次预占、原 Task 恢复、客户端交付确认及下一序号创建，全程无 Attempt/Provider 调用；容器、网络和临时卷已清理；
- R7 已将此前 42/51 个旧合同失败迁移到 v2 纵向合同；当前 Backend 合同为 51/51 通过。该结果仅证明隔离测试环境，不代表源合同已开放或真实 ComfyUI/Ark 已验收。

未部署、未安装新客户端、未上传素材、未调用 Ark/真实 OSS、未创建真实 Provider Task 或付费任务。

### 2026-09-15：R3 唯一报价与冻结定价解释已完成（仅本地分支）

R3 新增 `PricingCatalog` 与 `TaskQuoteService`，v2 Preview 不再返回固定 2 元或 `R3_PRICING_NOT_IMPLEMENTED`。无输入视频时，服务端使用请求的实际输出时长、合同中的精确分辨率/比例像素、24 FPS 和适用单价，以 Decimal 计算 Token 与六位小数金额；例如 4 秒、720p、16:9 为 86,400 Token、6.048000 元。固定比例不再通过短边重新近似，首帧/首尾帧 `adaptive` 可从已检查首帧比例映射；无法锁定的 adaptive 使用该分辨率官方像素表最大值形成 `bounded` 预占，不伪造精确估算。源码：`packages/backend/src/tasks/pricing-catalog.ts`、`task-quote.service.ts`、`preflight.service.ts`。

含输入视频的公式会累加每个实际 `durationSeconds`，不再出现“只要有视频就按 30 秒”的旧逻辑；2 秒、30 秒和合法多视频总时长均有回归。由于官方价格页把 Seedance 2.5 最低 Token 明细放在独立表格/计算器，本轮网页检索与两次浏览器只读访问仍未取得可执行数值，因此含输入视频的报价会展示公式 Token 和 42/46 元刊例价，但保持 `status=unavailable`、`reserveCny=null`、缺项 `INPUT_VIDEO_MINIMUM_TOKENS_UNRESOLVED`。这会阻止相关新 Production，而不是用可能低估的公式金额预占。

公开刊例价默认只作为估算/预算依据，不冒充最终账单。1080p 72 折只有在 `VIDEO_FLOW_SEEDANCE_25_CONFIRMED_PROMOTION_IDS` 明确确认当前账户适用时才生效，报价有效期不跨促销结束时间；已确认账户/订单价可通过带 `pricingVersion`、来源、完整分辨率价格和有效期的 `VIDEO_FLOW_SEEDANCE_25_ACCOUNT_PRICING_JSON` 注入，缺档或格式错误 fail-closed。Preview 和 check 保存同一 `quoteDigest`；报价到期、促销/账户价变化或内容被篡改时要求重新预检，不静默更价。

新结算解释优先读取冻结 `pricingSnapshot` 和 `usage.completion_tokens`，按快照中的 rate 计算；当前价格变化不会覆盖旧任务。快照损坏、usage 缺失或无效时保留 `unavailable/review`，`usage_calculated` 仍不等同于 Provider 账单确认。旧 `pricingVersion` 静态表只保留已有历史任务解释；无调用者且包含“有视频固定 30 秒”的旧 `estimateSeedanceCost` 已移除。R4 的快照消费现已由顶部结果完成；工作流实际开放仍等待 R5/R6。

本次实际验证：

- Backend：`cd packages/backend && npm run build && npx jest --runInBand`，28 suites / 257 passed；R3 定向报价、预检、预算、结算为 5 suites / 81 passed；
- 客户端：`cd packages/comfyui-video-flow-client && .venv/bin/python -m pytest -q`，96 passed；
- Worker：`cd packages/worker && venv/bin/python -m pytest -q`，202 passed / 26 skipped / 12 deselected，另有 7 条既有 pytest-asyncio/Pydantic 弃用警告；
- 合同与同步：`node scripts/sync_workflow_contracts.mjs --check && node --test scripts/tests/workflow_contract_sync.test.mjs scripts/tests/workflow_contract_v2.test.mjs`，6 passed，`git diff --check` 通过；
- 报价回归：公开刊例、账户价、促销跨期、固定/自适应比例、2/30 秒和多视频、编辑 `-1`、未知模型/时长、最低 Token 阻断及账户价格缺档 fail-closed 均通过；
- HTTP/数据库：隔离 PostgreSQL 应用全部 11 个 migration；`test/preflight-v2.contract-spec.ts` 真实 Nest/Guard/Prisma 1 passed，验证 4 秒 720p Preview 返回 6.048000 元、check 保留同一报价，同时 Task/Attempt/Reservation 不变；容器、网络和临时卷已清理。

未部署、未安装 ComfyUI、未调用 Ark/OSS、未创建正式 Task/Attempt/预算预占或付费任务。

### 2026-09-15：R2 本地与服务端素材识别已完成（仅本地分支）

R2 新增客户端共用 `media_inspection.py`：PNG/JPEG/WebP 使用 Pillow 读取实际内容，MP4/MOV/WAV/MP3 使用 `ffprobe` 读取容器与流；输出稳定 `slotId`、实际 SHA-256、检测 MIME、字节数及规范化 metadata，不保留原始文件字节。产品图、首帧、首尾帧和多参考图节点共用该入口并强制同名文件重检；上传前 `read_verified_media` 再次识别完整描述，内容变化返回 `MEDIA_CONTENT_CHANGED`。Preview HTTP payload 只包含 descriptor，不包含本机路径、文件、Base64 或缩略图。源码：`packages/comfyui-video-flow-client/media_inspection.py`、`preflight_nodes.py`。

Backend `MediaInspectorService` 不再根据 expected MIME 决定媒体类型，而是根据 ffprobe 的格式、文件品牌、流和编码识别 PNG/JPEG/WebP/BMP/TIFF/GIF、HEIC/HEIF、MP4/MOV、WAV/MP3；expected MIME 只是一致性约束。时长和 FPS 统一规范为最多 6 位小数。统一 Preview 规则同时检查图片/视频尺寸和比例、视频像素/FPS/编码/单段时长、音频单段时长，以及视频和音频各自不超过 30 秒的总时长。源码：`packages/backend/src/assets/media-inspector.service.ts`、`media-policy.ts`、`tasks/workflow-catalog.service.ts`。

R2 对照仓库内官方接口原文修正了合同中的文件大小边界：图片 `<30MB`、视频 `≤200MB`、音频 `≤15MB`。源合同 revision 更新为 `2026-09-15.3` 并同步到 Backend/Worker；客户端真实文件检查与 Backend Preview 描述检查执行相同的包含/不包含边界，视频恰好 200MB 和音频恰好 15MB 合法，图片恰好 30MB 拒绝。源码：`contracts/seedance-workflows.v2.json`、`packages/comfyui-video-flow-client/media_inspection.py`、`packages/backend/src/assets/media-policy.ts`。

上传完成现在必须具备实际内容 Inspector，缺失时 fail-closed；通过 OSS 实际字节 SHA-256、对象大小、Content-Type、签名对象 ffprobe 和媒体规则后，输入 Asset 标记为 `verified`。已验证的同内容 Asset 可直接复用；历史 `uploaded` Asset 不覆盖对象，但客户端会先调用 complete 补做实际内容复验。Actor 所有权、实际流式哈希和未完成上传隔离保持不变。源码：`packages/backend/src/v1/assets/v1-assets.controller.ts`、`assets.service.ts`、`packages/comfyui-video-flow-client/client.py`。

R2 不在 Worker 再实现媒体探测器：`slotId → verified Asset` 的正式提交复验和冻结已由顶部 R4 完成，Worker 只消费该快照。该边界避免 Backend 与 Worker 出现两套可能漂移的 MIME/时长判断。

本次实际验证：

- Backend：`cd packages/backend && npm run build && npx jest --runInBand`，27 suites / 244 passed；其中 `media-inspector.integration.spec.ts` 使用本机真实 ffmpeg/ffprobe/cwebp 临时生成并识别 PNG/JPEG/WebP、MP4/MOV、WAV/MP3，7 项通过；
- 客户端：`cd packages/comfyui-video-flow-client && .venv/bin/python -m pytest -q`，96 passed；其中真实媒体、损坏/伪装、同名内容变化、依赖缺失、总时长和文件大小边界 13 项通过；
- Worker：`cd packages/worker && venv/bin/python -m pytest -q`，202 passed / 26 skipped / 12 deselected；skip 仍是仓库外 ComfyUI workflow 资产缺失的预期结果；
- 合同与同步：`node scripts/sync_workflow_contracts.mjs --check && node --test scripts/tests/workflow_contract_sync.test.mjs scripts/tests/workflow_contract_v2.test.mjs`，6 passed；三份合同资源字节一致；
- HTTP/数据库：隔离 PostgreSQL 应用全部 11 个 migration；`test/preflight-v2.contract-spec.ts` 真实 Nest/Guard/Prisma 合同 1 passed，验证 Preview 只新增 PreflightRecord，Task/Attempt/Reservation 不变；测试容器、网络与临时卷已清理。

上述媒体集成测试只操作本机临时文件；没有安装到创意 ComfyUI、没有连接真实 OSS 或 Ark、没有创建 Provider Task、ExecutionAttempt、预算预占或付费任务。R2 的后续 R3/R4 服务层已完成，但 Production 对用户开放仍等待 R5/R6/R7。

### 2026-09-15：R1 统一规则与独立预检报告已完成（仅本地分支）

R1 已将新版 Preview 从 Task 域中拆出：`POST /api/v1/tasks/preflight` 通过统一工作流合同形成唯一 `effectiveRequest`、逐字段检查、当时的 Production blockers 和独立 `PreflightRecord`；`GET /api/v1/tasks/preflight/:id/check` 从记录复验合同/意图/报价摘要，并重新计算当前准入。Preview 无论 Production 白名单、暂停或额度状态如何都能返回请求检查结果，但接口本身仍要求有效身份。源码：`packages/backend/src/tasks/workflow-contract.ts`、`workflow-catalog.service.ts`、`preflight.service.ts`、`src/v1/tasks/v1-tasks.controller.ts`。

工作流目录已从同一 v2 合同返回 8 类工作流的角色、参数和 `capability / implementation / admission / validation` 四维状态；源合同通过 `scripts/sync_workflow_contracts.mjs` 同步到 Backend/Worker 构建资源。Prisma migration `20260915090000_add_preflight_records` 只新增 `preflight_records` 与索引，不改写 Task、Attempt、Asset 或预算数据。旧 `mode=preview` Task 创建已返回 `PREVIEW_TASK_CREATION_RETIRED`；已有 Task 的授权查询保持独立。

R1 完成时尚未接入实际参数报价和正式快照消费，这两项缺口现已分别由顶部 R3/R4 结果取代。8 类工作流仍因目标 ComfyUI 与外部验收未完成而保持 `incomplete / admission=false`。R7 已删除旧 `workflow-registry.ts`、`workflow-preflight.ts` 和固定 ProductionSpec 路径；当前 v2 API 只使用统一工作流合同、独立预检记录和冻结报价/执行快照。

本次实际验证：

- Backend：`cd packages/backend && npm run build && npx jest --runInBand`，26 suites / 225 passed；
- Worker：`cd packages/worker && venv/bin/python -m pytest -q`，202 passed / 26 skipped / 12 deselected；26 项因仓库外 ComfyUI workflow 资产缺失而预期跳过；
- 客户端：`cd packages/comfyui-video-flow-client && .venv/bin/python -m pytest -q`，80 passed；
- 合同与同步：`node --test scripts/tests/workflow_contract_v2.test.mjs scripts/tests/workflow_contract_sync.test.mjs && node scripts/sync_workflow_contracts.mjs --check`，6 passed，Backend/Worker 资源字节一致且 Nest 构建资源位置通过；
- 全新数据库：隔离 PostgreSQL 应用全部 11 个 migration；`test/preflight-v2.contract-spec.ts` 真实 Nest/Guard/Prisma 合同 1 passed，验证未鉴权 401、Preview 只新增 PreflightRecord、Task/Attempt/Reservation 数量不变、8 类目录和旧 Preview 拒绝；
- 历史数据库：`VIDEO_FLOW_MIGRATION_ONLY=1 ... bash scripts/run_mvp_contract.sh` 通过，模拟已有 Task 前向升级后历史 Task 保留且新表存在；回滚策略为暂停新提交并回滚应用，保留新表与历史记录，不执行破坏性降级。

上述验证只使用隔离本地数据库和 loopback 地址；测试容器、网络和临时卷已清理。未验证 R2 实际媒体识别、R3 报价、R4 正式提交、真实 ComfyUI 导入或 Ark 成片。

### 2026-09-15：R0 合同与替换边界已冻结

R0 已完成，不代表 R1–R8 业务重构、部署或真实付费验收已经完成。新增 [Seedance v2 可执行合同](../contracts/seedance-workflows.v2.json)，冻结正式接口、模型 ID、8 类工作流、普通 4–30 秒、编辑特殊 `-1`、媒体限制、公开计费公式/单价及输入视频最低 Token 阻断策略；新增 [v2 强制规范](./requirements/2026-09-15/workflow-preview-production-spec-v2.md)、[官方合同证据](./2026-09-15/Seedance-2.5工作流与计费合同证据.md)和[旧设计替换清单](./2026-09-15/Preview-Production旧设计替换清单.md)。v1.1 完整原文已归档，原路径保留兼容入口。

R0 明确：八类 Provider 能力均为 `confirmed`，但新 v2 实现均为 `incomplete`、`admission.enabled=false`、真实验收 `not_run`；不能因官方支持直接开放 Production。含输入视频的最低 Token 明细尚未取得可执行数据，因此这类新 Production 报价必须保持 `unavailable`，不得用固定金额兜底。未调用 Ark/OSS、未创建 Task/Attempt/预算预占、未部署、未推送。

本次验证：

- `node --test scripts/tests/workflow_contract_v2.test.mjs`：4 passed；
- `cd packages/worker && venv/bin/python -m pytest -q tests/test_seedance_2_5_contract_evidence.py`：2 passed；
- 测试先在合同/fixture 缺失时分别观察到 ENOENT 和 `KeyError: 'textToVideo'`，补齐后转绿；
- 完整三包回归尚未在 R0 重跑，业务代码现状仍按下一节 2026-09-15 评审判断。

### 2026-09-15：R1 实施前的代码核验基线（历史）

**这是 R1 修改前的基线，不是当前结论。** 当时判断为部分满足，参考图路径最接近完成，其余七类工作流尚未形成完整正式执行链；其中 Preview 独立记录和统一报告缺口已由本节顶部 R1 结果取代，其余缺口仍按 R2–R8 推进。评审针对包含未提交修改的本地工作区，不代表线上版本。逐项发现及本地复现保存在[当日评审快照](./2026-09-15/Preview与Production代码符合性评审.md)，修正阶段只见[ROADMAP R0–R8](./ROADMAP.md)。

| 当前缺口 | 源码依据 |
| --- | --- |
| 新预检链无上传，但仍注册的旧 Preview 上传素材；首帧文件刷新和视频/音频客户端输入未完整实现 | `packages/comfyui-video-flow-client/nodes.py:81`、`:304`；`preflight_nodes.py:142`、`:177` |
| Preview 仍被生产白名单/暂停直接阻断；报告缺完整准入原因，素材角色与媒体类型未关联校验，规则版本绑定不完整 | `packages/backend/src/v1/tasks/v1-tasks.controller.ts:65`；`workflow-preflight.ts:23`、`:37` |
| adaptive/-1估算失败回退固定金额；输入视频固定按30秒；checkPreflight仍用固定金额；适用价格与最低用量规则未完整实现 | `packages/backend/src/tasks/task-cost.ts:18`、`:33`；`packages/backend/src/v1/tasks/v1-tasks.controller.ts:105` |
| 状态混合开发/启用/验收；实际正式编译器缺文本与音频参考策略，也未完整复验普通时长 | `packages/backend/src/tasks/workflow-registry.ts:3`；`packages/worker/providers/seedance_execution_policy.py:14`、`:93`；`executor.py:956` |
| 服务端图片类型判断仍受预期MIME影响；新画布找回已有任务前仍要求预检有效与新任务准入 | `packages/backend/src/assets/media-inspector.service.ts:31`；`packages/comfyui-video-flow-client/preflight_nodes.py:255`、`:290` |
| 文本预检模板发现两处输入link引用错误；其余四份新预检模板静态连线一致 | `packages/comfyui-video-flow-client/workflows/seedance-text-to-video-preflight-v1.comfy.json`；`tests/test_preflight_nodes.py:169`仅覆盖产品模板连线 |

保留依据：身份与所有权校验、实际对象SHA-256、Task/预占同事务、Provider ID恢复、不确定提交留痕和生成/交付分离已有实现，见 `packages/backend/src/assets/asset-presign.service.ts:107`、`tasks/task-budget.service.ts:67`、`packages/worker/executor.py:831`、`:1054`。Worker固定70元辅助计算属于旧任务兼容分支，不是新任务正式结算路径。

本次实际验证：

- Backend：`cd packages/backend && npm run build && npx jest --runInBand`，24 suites / 223 passed。
- Worker：`cd packages/worker && venv/bin/python -m pytest -q`，202 passed / 26 skipped / 12 deselected。
- 客户端：`cd packages/comfyui-video-flow-client && .venv/bin/python -m pytest -q`，80 passed。
- HTTP：`cd packages/backend && node test/preflight-http.smoke.cjs`通过；真实Nest/Guard，数据库、额度与OSS为测试替身。
- 定向内联诊断确认金额不一致、角色错配、编译器覆盖与媒体误识别；输入输出见当日评审§5.1，不冒充真实素材上传或付费接口验收。
- `git diff --check`通过。实际ComfyUI全模板运行、完整数据库跨包及正式Provider出片不在本次验证范围内。

该评审时点已完成职责文档、评审归档和路线图替换，但尚未开始 R0–R8 业务修改；此后 R0、R1 已按顶部记录完成。以下旧日期记录保留其当时上下文；与顶部当前结论冲突的判断不得作为当前状态引用。

### 2026-09-14：统一预检规范的开发分支增量（历史记录）

此条记录仅描述 `feat/workflow-preflight-confirmation` 本地开发，未提交、未推送、未部署、未安装到实际 ComfyUI、未创建付费任务。

- 新增产品参考图无上传预检接口，使用已有 Preview Task 保存带版本和生产规格摘要的预检记录，有效期 30 分钟；无新增数据库迁移。源码：`packages/backend/src/v1/tasks/workflow-preflight.ts`、`v1-tasks.controller.ts`。
- 正式提交增加有效预检记录与显式确认校验，绑定 actor、参数及素材；OSS 内容检查读取实际字节计算哈希。源码：`packages/backend/src/assets/asset-presign.service.ts:verifyObjectContent`。
- 新增同一画布 Preview/Production 分步节点、请求报告和模板，安装清单包含新增模块。源码：`packages/comfyui-video-flow-client/preflight_nodes.py`、`web/preflight_report.js`、`workflows/seedance-product-preflight-v1.comfy.json`、`install.sh`。
- 已执行编译及离线测试：Backend build 通过，Jest 24 suites / 216 passed；客户端 pytest 69 passed；Worker pytest 201 passed / 26 skipped / 12 deselected。命令分别为 `cd packages/backend && npm run build && npx jest --runInBand`、`cd packages/comfyui-video-flow-client && .venv/bin/python -m pytest -q`、`cd packages/worker && venv/bin/python -m pytest -q`。真实 HTTP Guard smoke 已通过，存储、额度和 OSS 为测试替身，验证命令 `cd packages/backend && node test/preflight-http.smoke.cjs`。
- 新增 `packages/backend/test/preflight.contract-spec.ts`，在真实 Nest/鉴权/Prisma 数据库上验证无上传预检、无 Attempt/预占、修改提示词或实际字节后拒绝、明确确认后准入，以及重复请求仅一笔预占。下游额度/恢复测试通过 `test/workflow-fixtures.ts` 预置“此前成功”的记录，便于验证预检后暂停或额度变化；这些夹具不替代预检 HTTP 用例。
- 原 48 项 Backend 契约用例已适配新准入，新增后合计 49 passed；Fake Provider 5 passed；Worker 跨包 10 passed / 2 skipped。验证命令：`VIDEO_FLOW_CONTRACT_DB_PORT=55433 VIDEO_FLOW_CONTRACT_PROVIDER_PORT=19092 bash scripts/run_mvp_contract.sh`。`packages/backend/test/contract-backend.cjs` 仅在测试启动时替换对象存储读取传输，保留真实流式字节哈希校验；不修改正式启动入口。测试图片元信息由夹具写入，不代表真实图片解码与 OSS 验收。跨包沿用明确跳过的独立账号额度竞态 E04、外部告警/容器重建 E12，不能写成全覆盖。
- 未验证：实际 ComfyUI 导入/报告显示、真实 OSS 上的整链验收；CLI 和旧直接提交模板尚未适配新增预检字段。旧入口不能因已有测试通过视为满足新规范。本分支不得直接发布，收尾计划见 ROADMAP W5。
- Preview 额度体验调整：每日/月度金额不足仅在 Preview 报告中返回 warning，不再阻断无付费预检；Production 仍严格执行额度准入。当前改动待重新完成三包回归和线上部署后生效。
- 新增独立 `VideoFlowPolicyPreview` 节点：接收下载节点返回的本地视频路径，在 ComfyUI 结果区输出 `ui.videos` 播放项；路径为空时仅显示 Preview 未生成视频的提示，并拒绝 output 目录之外的路径。模板已串接“下载保存 → 成片预览”，客户端回归为 72 passed，已安装到 `/Volumes/lvmac/ai/ComfyUI/ComfyUI/custom_nodes/video_flow_client`；需重启 ComfyUI 后实际加载。
- `VideoFlowPolicyPreview` 已针对实际 ComfyUI 0.35.x 前端修正为 `ui.images + animated` 的 MP4 兼容输出；原先的 `ui.videos` 在该前端不会渲染播放器。定向客户端测试 9 passed，插件已重新安装；需重启 ComfyUI 后重新执行一次下载/预览链路验收。
- Seedance 2.5 参考图正式入口已允许 Registry 的 `duration=4–30s`、标准 `ratio` 和 `resolution=480p/720p/1080p`；仅指定 `seedance-2-5-official-v1` 时动态估算并按 `usage.completion_tokens` 解释费用，其他版本仍回退固定金额。2026-09-15核验发现估算/检查不一致及特殊模式缺口，不能称完整参数计费已经完成，详见本节最新核验。
- 工作流目录已按“文生视频 → 首帧 → 首尾帧 → 多参考图”新增独立 ComfyUI 节点和 Preview 模板。新增工作流仍为 `preview_only` 或 `disabled`；原有参考图工作流可以通过正式接口提交 4–30 秒任务。完整回归记录为 Backend build 通过、Jest 24 suites / 221 tests、客户端 80 passed、Worker 202 passed / 26 skipped；本轮未调用 Provider、未创建付费任务。插件安装和 ComfyUI 重启后的实际导入仍待验收。
- 原有现状记录保持原验证时间与上下文；本增量不回填历史交付结果。


### 2026-09-11：创意交付链路评审快照（历史记录）

以下内容保留当日问题发现过程，不能作为 2026-09-15 当前风险清单；其中预算事务、Asset 归属、Provider ID 恢复和交付分离已有后续实现。当前结论只看本节顶部的 2026-09-15 核验及第 4 节当前风险登记册。

**当时尚不能宣告可交付创意人员独立使用；也不是重新从零开发。** 当时已有任务、鉴权、上传、Provider 调用和下载接口，但“有这些组件”不等于“同事从 ComfyUI 一次执行能拿到成片”。

| 问题 | 本轮源码证据（仓库根相对路径） | 判断 |
| --- | --- | --- |
| Wait 是否真的等待？ | `packages/comfyui-video-flow-client/nodes.py:105`：只 GET 一次，输出 `task_json` 而不是完成后的 `task_id` | 未形成提交 → 等待 → 下载的执行依赖；节点注册不证明工作流跑通 |
| 视频是否进入用户实际 output？ | `packages/comfyui-video-flow-client/nodes.py:119`：按安装路径推导，没有读取 ComfyUI 运行时 output 设置 | 自定义输出目录可能不一致；结果只返回路径字符串，未证明用户能找到并播放 |
| 重启能否接续原任务？ | `packages/backend/src/tasks/task-claim.service.ts:110` 未展平 Attempt 的 `providerTaskId`；`packages/worker/executor.py:107` 读取展平字段 | 恢复逻辑与真实返回契约不匹配，不能称“恢复已完成” |
| completed 是否必有可取视频？ | `packages/worker/executor.py:525` 起：无 URL 可继续完成；Asset 登记与最终状态回写返回值未检查 | Provider 成功、归档成功、客户端拿到文件三种成功未严密区分 |
| 生成成功但归档失败，费用还在吗？ | `packages/worker/executor.py:554`：usage / 成本在下载、OSS 上传之后才回写 | 中途失败会遗漏已发生的 Provider usage；不能仅靠成功 Task 汇总消耗 |
| 有额度字段是否等于有额度控制？ | `packages/backend/prisma/schema.prisma:161`；`packages/backend/src/v1/tasks/v1-tasks.controller.ts:95` | 字段存在，生产创建路径未执行额度占用和拦截 |
| 能否使用任意输入 Asset？ | `packages/backend/src/v1/tasks/preview-plan.ts:97` 只检查标识存在；`packages/backend/src/v1/internal/v1-worker.controller.ts:26` 按 ID 查询 uploaded Asset | 生产入口缺输入 Asset 与 actor 的归属校验；已知他人 Asset ID 不能仅靠 ID 难猜来保护 |
| 是否完全没有记录？ | `packages/backend/prisma/schema.prisma`；`docker-compose.yml:48`、`:77` | 已有 Task / Attempt / Asset 与 Docker 日志；缺的是可靠写入、关键阶段串联、保留期与有人处理的告警 |

本表属于静态调用链结论，不声称故障已在生产注入复现。核验命令见第 5 节。交付门槛和整改顺序只在 [ROADMAP.md](./ROADMAP.md) 维护。

### 外部能力与本地实现不能混为一谈

2026-09-11 查阅的[火山官方 SDK 任务资源源码](https://raw.githubusercontent.com/volcengine/volcengine-python-sdk/master/volcenginesdkarkruntime/resources/content_generation/tasks.py)具有 create / get / list / delete，并暴露 `resolution`、`callback_url` 等字段。它证明接口入口存在，**不证明当前账号、模型都支持，也不证明 delete 等于免费取消**。

本地 `packages/worker/providers/seedance_adapter.py` 实现提交、查询、轮询与 usage 推算，但未转发 `resolution`，没有列表/删除调用，也没有经核实的 Provider 幂等约定。精确完成百分比、提交前最终账单金额、取消计费语义、无 ID 时的可靠请求匹配，本轮均未建立足够证据；不能将它们写成可保证能力，也不能武断写成平台不支持。创意效果与产品还原度仍需看实际视频，接口返回成功不能代替判断。

---

## 1. 系统定位

让创意同事继续使用自己电脑上的 ComfyUI 与本地模型，通过公司服务器统一调用公司已充值的火山引擎 Seedance，并为身份、任务记录、检测、费用、限额和审计保留稳定扩展点。

```text
同事电脑：ComfyUI + 本地模型 + Video Flow 客户端节点
                        │ HTTPS + 可撤销凭证
                        ▼
公司服务器：Backend(NestJS) + PostgreSQL + Worker(Python) + OSS
                        │
                        ▼
                火山引擎 Seedance
```

冻结边界（见 [architecture/seedance-integration-baseline.md](./architecture/seedance-integration-baseline.md)）：

- 火山生产密钥只在 Worker；OSS 凭证限受信任的服务器组件：Worker 上传，Backend 签发上传/下载 URL 与 HEAD 校验（`docker-compose.yml`、`packages/backend/src/assets/asset-presign.service.ts`）。历史“只有 Worker 持有 OSS 密钥”的文字与实现不符。
- 同事电脑只有 Video Flow 的可撤销凭证，永不接触 Ark / OSS 密钥。
- PostgreSQL 是任务与执行状态的权威数据源；数据库只永久保存 `objectKey`，签名 URL 按需生成。新归档产物按 Task 创建日（UTC）存为 `videos/YYYY/MM/DD/{taskId}/{attemptId}/result.mp4`；创建日使跨日补偿仍覆盖同一对象，历史对象键保持原样可读（`packages/worker/artifact_delivery.py`、`packages/worker/executor.py`）。
- 不在服务器上集中部署 ComfyUI 或 Seedance 模型。

---

## 2. 代码结构与规模

| 包 | 技术栈 | 职责 | 受版本控制文件数 |
| --- | --- | --- | --- |
| `packages/backend` | NestJS 12 + Prisma 5.22 + PostgreSQL 16 | v1 对外接口、Worker 私有接口、管理接口 | 55 |
| `packages/worker` | Python 3.13 + FastAPI | 轮询领取任务、调用 Provider、OSS 归档、状态回写 | 36 |
| `packages/comfyui-video-flow-client` | Python（ComfyUI 自定义节点） | 同事本机节点：上传素材、提交任务、查询与下载结果 | 12 |

开发跨度 2026-09-09 → 2026-09-11。前轮生产核验快照为版本 `6d3582e`，包含安全收敛与输出登记/下载接口；不能据此称产物交付闭环验收完成。Production 白名单在该快照中为空，本轮未重新查询远端。

---

## 3. 已经具备的能力（附证据）

### 3.0 开发分支实施历史（不作为最新状态）

- 2026-09-14：Seedance 2.5 工作流目录的后端请求策略继续收敛。`workflow-registry.ts` 已为八个键声明媒体角色/数量/顺序、generation 约束，以及已取证的 `omniReferenceTaskType` / `outputFormat`；`disabled` 工作流无法再创建 Preview；Production 在预算预占前复验已检查 Asset 的 role 与 MIME/媒体类型匹配。冻结字段已由 `packages/worker/models.py` 保留，但 Ark payload 编译器尚未消费。验证：Backend `npx jest --runInBand && npm run build`（22 suites / 205 tests）、Worker `venv/bin/python -m pytest -q`（189 passed / 26 skipped / 12 deselected）、ComfyUI 客户端 `.venv/bin/python -m pytest -q`（58 passed）。该变更未调用 Ark、未部署、未改变任何 workflow 的 `production_verified` 状态；详见 [ROADMAP W3–W4](./ROADMAP.md#W3registry-与-generation-policy)。
- 2026-09-14：Worker 新增 `seedance_execution_policy.py`，将已冻结的 reference-image、首尾帧、全模态参考、视频编辑和视频延长意图编译为 Ark `content` payload，并在提交前复验角色、顺序、数量、`adaptive` / `duration=-1` 与 `reference/edit/extend` 字段。`executor.py` 已在素材 URL 解析后调用编译器，并通过 `SeedanceAdapter.create_task_payload()` 原样运输；编译失败进入 `requires_review` 且不调用 Provider，已有 `providerTaskId` 的恢复分支不重新提交。验证：`cd packages/worker && venv/bin/python -m pytest -q`（199 passed / 26 skipped / 12 deselected）。未调用 Ark、未部署、未改变任何 workflow 的 `production_verified` 状态。
- 2026-09-14：Fake Provider 已增加 `lastCreatePayload` 测试观测字段；跨包 Worker 合同改为当前 `workflowKey` 请求格式，并断言最终 POST 保留冻结后的 `content`、时长、比例和分辨率。验证：`cd packages/worker && venv/bin/python -m pytest ../../scripts/tests/test_fake_provider.py -q`（5 passed）。包含 Backend、Docker、Worker 的完整合同脚本本轮尚未重跑。
- 2026-09-14：隔离 Docker 合同首次因 `MediaInspectorService` 把函数参数作为 Nest 依赖注入而无法启动；已改为 `MEDIA_PROBE_RUNNER` 显式 Token 和默认 `ffprobe` provider。验证：Backend `npx jest --runInBand && npm run build`（22 suites / 205 tests）。重跑后 Backend 已启动，合同中 40 个失败均为旧 `capability/profile/params` 请求和无媒体元数据 fixture，需迁移为当前 `workflowKey` 合同；该套 Docker 合同当前不能标为通过。
- 2026-09-14：隔离 Docker 跨包合同已全套通过。Worker live contract 已迁移为当前 `workflowKey` 请求形状，测试输入 Asset 也携带已检查的 `mime_type` 与图片尺寸元数据；`VIDEO_FLOW_CONTRACT_DB_PORT=55433 VIDEO_FLOW_CONTRACT_PROVIDER_PORT=19092 bash scripts/run_mvp_contract.sh` 的结果为 Backend 合同 6 suites / 48 tests、Fake Provider 5 tests、Worker live contract 10 passed / 2 skipped。跳过项是 E04（独立生产白名单 Actor、专属输入 Asset 和精确额度 fixture）与 E12（真实容器重建、外部告警通道），并非通过的替代证据。全量本地回归：Backend `npm run build && npx jest --runInBand`（22 suites / 206 tests）、Worker `venv/bin/python -m pytest -q`（199 passed / 26 skipped / 12 deselected）、ComfyUI 客户端 `.venv/bin/python -m pytest -q`（58 passed）。所有验证仅访问本地 Fake Provider，未调用 Ark、未部署、未推送；当前唯一 `production_verified` 工作流仍是 `seedance.reference-image-to-video.v1`，尚待单独、有额度上限的真实验收。

- `feat/creative-mvp` 隔离 worktree 已完成 ROADMAP T00：新增真实编译 Backend + PostgreSQL 的合同测试入口、仅 loopback 的假 Provider、Provider 测试环境 fail-closed 校验，并修正 `start:prod` 指向实际构建入口 `dist/src/main`。
- ROADMAP T01 已在本分支实现：Production 只接受固定规格和本人已上传的 input Asset，Task 保存 `executionPlan` / `deliveryStatus`，Worker 新提交缺少批准快照时转 `requires_review`，已有 Provider ID 的恢复路径不因此重建任务。证据：`packages/backend/src/tasks/production-spec.ts`、`packages/backend/src/v1/tasks/v1-tasks.controller.ts`、`packages/worker/executor.py`。
- 2026-09-11 只读查询生产 `_prisma_migrations` 确认四个旧 migration 均已登记，实际顺序为 init → execution domain → attempt model → asset hash index。未修改这些旧 migration；新增 `20260910190000_prepare_assets_for_hash_index` 与 `20260911000030_repair_asset_foreign_keys` 后，隔离测试已分别验证全新空库和模拟现有库都能执行 `prisma migrate deploy`，旧 Task 的新增字段保持 null。验证入口：`scripts/run_mvp_contract.sh`。
- 2026-09-11 T01 提交前复验：Backend build + 75/75；Worker 86 通过 / 26 预期跳过；ComfyUI 客户端 19/19；合同测试 10/10、Fake Provider 2/2。合同脚本同时验证空库 migration、模拟现有库升级，以及 Fake Provider 隔离地址。
- 上述仅是开发分支离线证据，未推送、未部署、未开放 Production、未创建真实 Provider 任务。

#### 2026-09-12 ~ 09-13 第二轮执行事实（T02–T11）

按 ROADMAP 逐任务推进，每项单独提交；证据字段沿用 task / commit / checks / scope / production / remaining。
**production 一栏全部为"未操作"**：本轮没有部署、没有开放白名单、没有创建真实 Provider 任务。

| task | commit | checks（命令与结果） | scope |
| --- | --- | --- | --- |
| T02 额度预占 | `0d30d36` | 后端单测 105→含预算 22 用例；合同 `budget` 10 场景 | 全局/actor 双 advisory lock、日任务数上限、`limits` 接口白名单字段 |
| T03 领取边界 | `a1544ab` | `jest task-claim tasks.service legacy-tasks-auth`；合同 `claim-recovery` 9 用例 | claim 在途锁、actor 授权、`ATTEMPT_TASK_MISMATCH`、拒重置 pending |
| T04 提交不确定 | `bc0c1b3` | Worker `test_submission_journal` 13 用例 + 重启对账 | `submission_journal.py`、journal 白名单、启动对账保持暂停 |
| （缺陷修复） | `ecc1497` | `prisma validate` / `generate` | Task 的 `executionPlan`/`deliveryStatus` 重复定义 |
| T05 终态与结算 | `461d791` | `jest task-cost executions`；合同 `provider-outcome` 10 用例 | `task-cost.ts`、outcome 接口原子结算、admin `budget-review` |
| T06 可恢复归档 | `b2483f8` | 合同 `artifact-delivery`；Worker `artifact_delivery` | 稳定产物键、Asset 登记幂等、delivery CAS、`resume-delivery` |
| T07 生成意图回执 | `7acf9c1` | 客户端 56 用例 | 回执命名空间、重试沿用原 key/原 body、`ReceiptUpdateError` |
| T08 等待与模板 | `610ebfe` | 客户端 56 用例（含状态序列） | `wait_for_task`、节点只输出 taskId、`IS_CHANGED`、稳定下载 |
| T09 持久日志 | `3da7e2a` | Worker 165；后端 179；脚本 8 | `audit_log.py` 脱敏、`GET .../report` 只读报表、人工处置留痕 |
| T10 心跳与巡检 | `7eb5fad` | Worker 182；后端 185；脚本 21 | `health_state.py`、`/ready`、`operations/health`、`production-gate`、monitor |
| T11 跨包回归 | `8077d29` `bf76a5d` `ae7e1b8` `7276a94` `f55d43b` `caa35c5` `3d47893`（当前工作树未提交） | 合同 6 specs/48 tests + Fake Provider 5 + 跨包 10 通过 / 2 跳过 | 跨包用例、对象存储替身、Worker 重启恢复、Docker 寻址、CI 分层、手册；E03/E05/E08/E10/E11 已补 |

**本轮在实现过程中发现并修复的真实缺陷**（都不是测试问题，都会影响生产行为）：

1. 预算准入事务用 Serializable 隔离级别与 advisory lock 冲突：后拿到锁的事务用旧快照做预算检查，COMMIT 时才报 serialization 失败，被当成 500 而不是 429。
2. Worker 的「submitted 无 ID 拒绝重提」分支没检查执行快照，短路了带快照任务经 journal 保护的受控重提。
3. `prisma/schema.prisma` 里 Task 的 `executionPlan` / `deliveryStatus` 重复定义，`prisma generate` 完全无法执行（构建一直沿用旧生成产物）。
4. `findRecoverable` 不含 `archiving`，Worker 从 recover 拿到归档中的任务会落进 create 分支**重复扣费**。
5. `Asset.sizeBytes` 是 BigInt 列而 Worker 传 JSON number，产物登记必然 500（此前无测试覆盖）。
6. advisory lock 参数需显式 `::int`，否则 Prisma 按 bigint 传参直接报 42883。
7. 适配器在密钥为空时仍拼出 `Authorization: Bearer `（非法头），httpx 本地拒绝 → **每次提交都被误判成"结果不确定"**，真实原因"没配密钥"被完全掩盖。
8. Fake Provider 在容器内只监听 `127.0.0.1`，同网络的其它容器能解析服务名却永远连不上。

**当前实测（本轮实跑，非历史数字）**：

```bash
cd packages/backend && npx jest --runInBand          # 19 套件 / 185 通过
cd packages/worker && venv/bin/python -m pytest -q   # 常规单测；live_contract marker 默认排除
cd packages/comfyui-video-flow-client && .venv/bin/python -m pytest -q   # 57 通过
packages/worker/venv/bin/python -m pytest scripts/tests -q               # 22 通过
VIDEO_FLOW_CONTRACT_DB_PORT=55433 VIDEO_FLOW_CONTRACT_PROVIDER_PORT=19092 bash scripts/run_mvp_contract.sh  # 6 specs/48 + Fake Provider 5 + 跨包 10 通过/2 跳过
bash scripts/run_docker_provider_addressing.sh       # Docker 服务名寻址
```

**remaining（未完成，且不能靠开发环境完成）**：

- T08 三项：节点展示扩展未经真实 ComfyUI 验证；两份模板目前是 API 格式而非真实导出的 UI 格式；未在自定义 output 路径与重启后的主实例做导入/执行/重新取片。**卡点**：需要一个可运行、可安装节点、可重启的 ComfyUI（本机 Comfy Desktop 的数据根 `~/mylab/ComfyUI` 没有 `.venv`，`install.sh` 需要 ComfyUI 自带 Python；且安装会改动正在使用的环境，待 Steven 确认目标环境与授权）。
- T10 两项：宿主计划任务检查巡检/备份回执超时、外部可用性渠道验证"整机失联可告警"——依赖实际宿主与通知渠道；"上线时触发一条无付费测试告警并由责任人确认收到"同属部署动作。
- T11 两项：E04 需要独立的白名单 Actor、专属输入 Asset 和精确额度 fixture，才能验证两个新意图争抢最后预算；E12 需要真实容器重建与外部告警通道。其余 E03/E05/E08/E10/E11 已做成跨包合同并实跑通过。
- T12 全部：部署与真实创意验收，需生产操作授权。

**本轮所有提交均未推送、未部署。** main 领先 origin/main 41 个提交。

### 3.1 Backend

| 能力 | 证据 |
| --- | --- |
| Preview / Production 双模式：`mode` 缺省为 `preview`；Production 按 actor 白名单 fail-closed | `src/v1/tasks/v1-tasks.controller.ts:62-72`、`src/v1/tasks/production-policy.ts` |
| Preview 结构上不可执行：落 `status='preview'`，而 Worker 只 claim `status='pending'` | `src/tasks/tasks.service.ts:84-106`、`src/tasks/task-claim.service.ts:13-16` |
| 幂等：`Idempotency-Key` 必填 + `(actorId, clientRequestId)` 唯一约束 + 请求体稳定序列化比对 + P2002 并发回读 | `src/v1/tasks/v1-tasks.controller.ts:27-43,79-140` |
| 请求校验：只接受注册的 `workflowKey`、结构化 `prompt/generation/media`；旧 `capability/profile/params` 返回 `WORKFLOW_KEY_REQUIRED` | `src/tasks/workflow-registry.ts`、`src/v1/tasks/v1-tasks.controller.ts`；验证：`cd packages/backend && npm test -- --runInBand` |
| 原子 claim + 5 分钟租约 + 自动创建 ExecutionAttempt | `src/tasks/task-claim.service.ts:22-84` |
| 凭证鉴权：token 只存 `sha256`、可撤销、记录 `lastUsedAt` | `src/auth/credentials.service.ts`、`src/auth/api-credential.guard.ts` |
| Worker / Admin 内部接口用独立服务令牌，`timingSafeEqual` 比对 | `src/auth/worker-service.guard.ts`、`src/auth/admin-token.guard.ts` |
| 素材预签名直传：内容寻址复用 Asset、`/complete` 时用 OSS HEAD 校验 size / mime / sha256；ticket 支持官网列示图片、MP4/MOV、WAV/MP3 和各自单文件上限，记录 `mediaType` | `src/v1/assets/v1-assets.controller.ts`、`src/assets/asset-presign.service.ts`；验证：`npx jest src/v1/assets/v1-assets.controller.spec.ts --runInBand` |
| Worker 登记输出时继承 Task actor，写入 `ownerId`、`inspectionStatus='uploaded'` 与永久 `objectKey`；actor 可按 Task 获取新签名下载 URL | `src/v1/internal/v1-worker.controller.ts`、`src/v1/assets/v1-assets.controller.ts`、`src/assets/assets.service.ts` |
| 数据模型分域：Task / ExecutionAttempt / Asset / ActorCredential；费用四态 `estimated / usage_calculated / billed / unavailable` | `prisma/schema.prisma` |

### 3.2 Worker

| 能力 | 证据 |
| --- | --- |
| Seedance 适配器：提交、轮询、下载、usage 计费 | `providers/seedance_adapter.py` |
| 网络请求异常有 `requires_review` 分支；但 5xx、成功响应缺 ID 等不确定情况未统一归类 | `executor.py:584-601`、`providers/seedance_adapter.py:135` |
| 存在按 `providerTaskId` 恢复轮询的代码；Backend 返回映射缺字段，真实恢复未通过 | `executor.py:104-200`、`src/tasks/task-claim.service.ts:110`（Backend） |
| 有 OSS 归档、Asset 登记、含 `pricingVersion` 的成本审计代码；归档失败与回写失败存在缺口 | `executor.py:524-578`、`recovery.py` |
| ComfyUI 本地 dry-run 通道（生产环境关闭：`COMFYUI_ENABLED=false`） | `executor.py:63-72,376-392` |
| HTTP 探针：`/`、`/health` | `main.py` |

### 3.3 ComfyUI 客户端

| 能力 | 证据 |
| --- | --- |
| 五个节点：`Video Flow Config`、`Seedance Preview`、`Seedance Production`、`Wait Video Flow Task`、`Load Video Flow Result` | `nodes.py` |
| token 来源优先级：`VIDEO_FLOW_TOKEN` > `VIDEO_FLOW_TOKEN_FILE` > `~/.video-flow/token` | `config.py` |
| Preview / Production 使用不同作用域的幂等键，profile / duration / ratio 也纳入稳定键 | `client.py` 的 `stable_idempotency_key()`、`mode_scoped_idempotency_key()` |
| 素材上传带 SHA-256，服务端据此复用 Asset | `client.py:25-72` |
| 结果节点按 Task 请求新签名 URL，流式下载并清理失败的 `.part`；目录按安装路径推导，未适配运行时 output 覆盖 | `client.py` 的 `download_task_result()`、`nodes.py:119` |

### 3.4 部署现状

以下均为前轮核验/历史记录，不是本轮重新执行的远端检查；正式验收前须刷新版本、白名单、主实例与任务状态。

- 服务器：`8.140.49.56:/data/video-flow`，容器 `video-flow-backend` / `video-flow-worker` / `video-flow-postgres`。
- 公网入口：`https://ai.sweetyshell.com/api/` → `127.0.0.1:3100`（Nginx，见 [runbooks/domain-and-https.md](./runbooks/domain-and-https.md)）。
- 旧 `/api/tasks` 的 create / list / pending / findOne 已要求 Admin token，claim / recover / update 要求 Worker token；2026-09-11 公网无凭证验收均返回 401。
- Backend 只监听宿主 `127.0.0.1:3100`；Worker 与 PostgreSQL 不发布宿主端口。生产 `.env` 权限为 `600`，历史 `.env.backup-token-*` 已清理。
- Production 白名单当前为空（对所有人关闭）。
- 版本 `6d3582e` 部署后，5 个历史输出已补齐 owner 与 `inspectionStatus='uploaded'`，Task 中遗留的过期签名 URL 已全部替换为永久 `objectKey`；该回填没有创建 Provider 任务。
- 主 ComfyUI 的客户端文件已更新；隔离运行实例在 `127.0.0.1:8190` 验证五个节点全部注册。当前 Comfy Desktop 主实例启动早于安装，仍需重启后才会在 UI 显示两个新增节点。
- 2026-09-10 完成过一次真实付费出片：Task `e9a0903e-bf99-4c71-b4f1-de4b41436632`，费用 ¥7.623（`usage_calculated`，非账单确认）。该次验收**未**覆盖重启恢复、并发上传、历史迁移与账单对账。
- 2026-09-11 完成 Preview 零付费验收：Task `054a6e53-86f8-4f84-8db4-b5539133b0b9` 落 `status='preview'`、Attempt 为 0；Production 请求返回 403。详见 [runbooks/preview-acceptance.md](./runbooks/preview-acceptance.md)。

---

## 4. 当前风险登记册

本节只记录 2026-09-15 按 v2 职责重新核验后仍成立的风险。严重度：**P0 = 可能破坏素材、资金或付费执行边界，开放前必须解决；P1 = 阻断完整产品流程或造成错误反馈；P2 = 不阻断当前重构的工程债。** 具体实施顺序只看 [ROADMAP R1–R8](./ROADMAP.md#4-逐阶段实施清单)，完整发现和复现只看[当日评审快照](./2026-09-15/Preview与Production代码符合性评审.md)。

### P0：开放前必须解决

| ID | 当前风险 | 发现依据 | 影响 | 处置阶段 |
| --- | --- | --- | --- | --- |
| C01 | 仍注册的旧 Preview 节点会上传素材，新旧入口行为不同 | F01 | 用户选择 Preview 仍可能产生素材出站，违反无上传边界 | R5、R7 |
| C02 | Preview 请求检查、Production 准入和角色/媒体类型检查未闭合 | F02–F04 | 无权限用户拿不到诊断报告，错误类型素材又可能被报告为参数通过 | R1、R2 |
| C03 | Preview、check、正式预占和结算价格依据不一致，未知报价会回退固定金额 | F05–F08 | 费用展示失真，可能错误放行、错误预占或错误解释 usage | R3、R4 |
| C04 | 服务端实际媒体类型判断仍受声明 MIME 影响 | F13 | 视频可能被当成图片，上传后内容复验不能形成可靠安全边界 | R2 |
| C05 | 工作流状态混合能力、实现、启用和验收，实际 Worker 编译入口又未覆盖全部工作流和边界 | F11、F12 | 仅修改状态可能开放尚未完成的付费执行路径 | R1、R4、R6 |

### P1：完整流程阻断

| ID | 当前风险 | 发现依据 | 影响 | 处置阶段 |
| --- | --- | --- | --- | --- |
| C06 | 客户端恢复原任务前先检查新预检、权限和额度 | F14 | 预检过期、暂停或额度变化后，用户可能无法继续等待或重新下载已有产物 | R5 |
| C07 | 视频/音频输入节点和模板不完整，文本模板存在连线错误 | F10、F15 | 多类工作流不能在实际 ComfyUI 中形成可靠 Preview/Production 操作链 | R5、R6 |
| C08 | 预检记录没有完整绑定工作流规则和价格内容摘要 | F09 | 规则或价格变化后，旧确认可能无法可靠失效 | R1、R3、R4 |
| C09 | 八类工作流尚未完成跨包合同、实际 ComfyUI 和受控真实 Provider 的逐项验收 | 当日评审 §6、§8 | 单测或模板存在不能证明完整链路和实际出片可用 | R6–R8 |

### 待重新核验的早期风险

2026-09-15 本轮评审没有重新核验完整可观察性、内容审核、分页、多 Worker 租约和管理接口错误语义。这些早期问题不再混入当前 F01–F15 风险清单，也不能视为已经关闭；进入相关开发或发布阶段前，应重新检查当前源码和运行环境。历史状态保存在[重整前 ROADMAP 快照](./archive/2026-09-15-roadmap-before-responsibility-reset.md)和 Git 历史中。

---

## 5. 验证命令与实测结果

本轮静态复核（仓库根执行）：

```bash
git status --short --branch
rg -n 'providerTaskId|attachAttempt|findRecoverable' packages/backend/src/tasks/task-claim.service.ts packages/worker/executor.py packages/worker/models.py
rg -n 'class VideoFlowWaitTask|def wait|default_output_dir|stable_idempotency_key' packages/comfyui-video-flow-client/nodes.py
rg -n 'dailyLimitCny|monthlyLimitCny' packages/backend/src packages/backend/prisma/schema.prisma
rg -n 'result_url|create_asset|cost_audit|Completed successfully' packages/worker/executor.py
rg -n 'max-size|max-file' docker-compose.yml
```

以下测试结果是 2026-09-11 **前轮实跑记录**，本轮仅修改文档，未重新执行。历史通过数字不是下一版的固定期望数量。

在提交修复前后都应运行这三条；AGENTS.md 要求三包全绿。

```bash
# Backend：构建 + 单测（期望 13 套件 / 68 测试通过）
cd packages/backend && npm run build && npx jest

# Worker：单测（期望 80 通过 / 26 跳过）
cd packages/worker && venv/bin/python -m pytest -q

# ComfyUI 客户端：使用自己的依赖环境，可从包根运行
cd packages/comfyui-video-flow-client && python -m pip install -r requirements.txt pytest && python -m pytest -q
```

| 命令 | 2026-09-11 实测 |
| --- | --- |
| Backend `npm run build && npx jest` | 13 套件 / 68 测试通过 |
| Worker `pytest -q` | 80 通过 / 26 跳过（6 个既有 deprecation warning） |
| Client（包根、安装自身依赖） | 19 通过 |
| `git ls-files \| grep -iE "token\|\.env"` | 仅为敏感文件名检查；不能据此证明文件内容或整个 Git 历史无泄露 |

> 客户端依赖在 `packages/comfyui-video-flow-client/requirements.txt` 中声明为 `httpx[socks]`。运行客户端测试前必须在客户端自己的环境安装该文件；不要借用 Worker venv。

---

## 6. 测试覆盖的局限（重要）

- **测试全绿 ≠ 链路可用。** 2026-09-10 的评审报告已证明：29 个后端测试全绿时，三条主链路仍然互不匹配。关键路径必须靠端到端契约验证，不能只看单测。
- 鉴权相关改动不能只依赖单测：部分 spec 用 `jest.mock('@nestjs/common')` 替换装饰器，绕过了真实 Guard 装配。涉及鉴权的改动必须补集成验证（真实 HTTP 请求 + 期望 401/403）。
- Worker 的 26 项 skip 覆盖了真实 ComfyUI workflow 解析；这些路径目前**没有**自动回归保护。
- `packages/comfyui-video-flow-client/tests/test_nodes.py` 使用假客户端与临时目录，不证明真实节点图等待、ComfyUI 自定义 output、下载后播放可用。
- `scripts/seedance_production_acceptance.py` 以 completed 与非空 `videoUrl` 判断通过，不足以证明视频已下载并可解码；默认时间戳幂等键也不能用于不加区分地重跑付费验收。
- 跨包用例已经覆盖"预览不创建 Provider 任务""同意图只创建一次""重跑沿用原 ID""完整交付链路""准入被拒不产生费用""Worker 重启恢复""Docker 服务名寻址"，但**仍未覆盖真实 ComfyUI 与真实 Provider**：对象存储与 Provider 都是替身，真实网络、真实配额、真实计费均未验证。
- 合同环境按规约不得持有真实 Provider 凭证（脚本与 CI 都有硬闸门），因此"用真实凭证跑一次"这件事**只能**在 T12 的授权下进行。
