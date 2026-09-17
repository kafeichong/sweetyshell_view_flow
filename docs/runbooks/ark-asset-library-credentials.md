# 方舟私域素材库的 Access Key 配置

> 建立日期：2026-09-17
> 用途：为「私域素材库」功能准备一套**权限最小**的火山引擎 Access Key（AK/SK）。
> 背景与缺口清单见 [私域素材库与肖像素材通路分析](../architecture/private-asset-library-and-portrait-paths-2026-09-17.md)。

## 为什么需要单独一套密钥

方舟的素材库接口（`CreateAssetGroup` / `CreateAsset` / `GetAsset` / `ListAssets` / `DeleteAsset` …）用的是
**Access Key（AK/SK）签名**，与视频生成用的 API Key 是**两套鉴权**。

而且 AK **是全账号级**的：它能建、改、删素材组与素材。所以**不能复用主账号或别的用途的 AK**，
要单独建一个只够管素材库的子账号——泄露时的爆炸半径才可控。

> 素材库功能还需要**高级创作权益包**（付费）。本页只讲密钥，不含采购。

## 第 1 步：建一条最小权限的自定义策略

1. 打开火山引擎控制台 → **访问控制** → **权限策略** → **新建自定义策略**
2. 名称填 `video-flow-ark-asset`
3. 切到 **JSON 编辑器**，粘贴：

   ```json
   {
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["ark:*Asset*"],
         "Resource": ["*"]
       }
     ]
   }
   ```

4. **提交**

## 第 2 步：建子账号并赋权

1. **用户管理** → **用户** → **新建用户** → **通过用户名创建**
2. 基本信息设置：
   - 用户名：`video-flow-ark-asset`
   - 访问方式：**只勾「编程访问」**
     - ⬜ 控制台访问（要设密码）**不用勾**
     - ⬜ 允许用户管理自己的API密钥 **不用勾**（密钥由管理员管）
3. 「下一步」→ 权限设置 → **直接添加权限** → 添加权限策略 → 勾上第 1 步建的
   `video-flow-ark-asset` → 限制到项目资源选 **全局**
4. 审阅 → 完成

> **找不到「编程访问」？** 它不在「创建用户」的首页，点进 **通过用户名创建** 之后才有。
>
> **找不到「限制到项目资源」？** 它是可选项，有就选「全局」，没有就跳过。

## 第 3 步：把密钥写进操作机（600 权限）

拿到 **AccessKey ID** 与 **AccessKey Secret** 后，在操作机终端里按顺序跑：

```bash
umask 077 && mkdir -p ~/.video-flow
```

```bash
printf '%s\n%s\n' '你的AccessKeyID' '你的AccessKeySecret' > ~/.video-flow/ark-asset-credentials
```

```bash
chmod 600 ~/.video-flow/ark-asset-credentials
```

**格式**：文件只有两行，第 1 行 AccessKey ID、第 2 行 AccessKey Secret，值用单引号包住、不要有空格。

**`chmod 600` 的作用**：把权限改成只有文件属主可读写。不跑它的话是默认权限，同机器上别的账号可能读得到——
里面是密钥，必须收紧；`~/.video-flow/` 下现有的 `token` / `creative-*.token` 也都是这个权限。

**Secret 只显示一次**：控制台上建完用户后立刻弹出，关掉就取不回来了；丢了只能删掉重建 AccessKey。

### 不要做的事

- **不要把 AK/SK 写进任何仓库文件、Workflow JSON、截图或聊天**；
- **不要贴进 shell 命令历史**——上面前两条命令里的值会进历史记录，介意的话跑完清理一下；
- 客户端的创意电脑**不持有**这套密钥：素材库调用只发生在 Backend，创意侧只用个人 actor token。

## 第 4 步：确认

```bash
awk '{print NR": "length($0)" 字符"}' ~/.video-flow/ark-asset-credentials
```

应当输出两行、都不为 0：

```text
1: 24 字符
2: 32 字符
```

（长度随账号而变，关键是**两行都有内容**。）只打印长度、不打印内容，避免密钥进终端回滚缓冲。

## 后续

密钥就位后，才会开始：

1. 确认 **ProjectName**——素材所属项目必须与生成用 API Key 同项目，错了要到**生成任务**才报错，最难查；
2. 取证 `asset://` 到底支持哪些 role（官方只对 `reference_*` 有示例，`first_frame` / `last_frame` 未知，不能假设）；
3. 之后再改合同与代码。

在取证有结论之前，**合同里不写任何素材库字段**——本仓库的规矩是字段必须有官方示例或真实账号验证兜底。
