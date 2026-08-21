# 原图生成与 See-Through 分层

## 职责和输入路由

本流程只负责把角色需求变成 PuppetLoom 可检查的输入。外部 Agent 理解设定、检查画面并调用图像工具或服务；See-Through 生成候选分层 PSD；PuppetLoom 从 PSD 确定性分析和制作。不要把单张 PNG 称为已经完成的 Live2D 形象，也不要把生图模型、提示词引擎或 Agent 运行时加入 PuppetLoom。

按实际输入选择唯一路线：

1. 同时有原图和 PSD：保留两者，先做本地重组一致性检查和 `inspect`；只有用户明确要求继续制作角色且视觉验收成立，才进入 `create`。
2. 只有 PSD：可以 `inspect/create`，但明确报告没有原图参考，不能声称已经验证分层前后完全一致。
3. 只有原图：告诉用户这张图将上传到第三方 ModelScope。任务已经明确要求自动取得 PSD 时，使用下述 API；否则先取得对这张具体图片的上传同意。
4. 完全没有原图：若环境具备用户已授权的图像生成能力，生成一张正常二次元可绑定原图并实际打开检查。用户给定角色设定时保持该设定；用户明确允许自由发挥或只要求测试 PSD 时，不为角色设计增加一次无必要的确认暂停。若无法调用生图工具，则原样交付下面的一条提示词和 See-Through 网址，等待用户带回原图或 PSD。

用户说“只使用现有素材”时，不生图、不上传、不下载新 PSD，只报告当前素材缺口。

用户只要求生成或测试 PSD 时，这是一个完整且独立的任务边界：交付原图、PSD、重组与视觉结论后停止。不要创建 PuppetLoom 项目，不要生成 `rig-spec`，也不要调用 `create`、`agent plan` 或 `agent apply`。

## 可绑定角色原图

优先使用高分辨率正面单人全身图；半身图只能制作素材实际覆盖的范围。头部端正、脸部基本对称、双眼自然睁开、闭口中立、身体正对镜头。双臂与躯干、双腿之间留出可识别空隙，手脚和发梢不要裁切。前发、后发、脸、颈部、袖子、衣摆、尾巴和配饰边界尽量清楚，避免交叉手臂、手持道具、强烈透视、极端动作、大面积遮挡、复杂背景和文字。

没有原图时，自动生图和无法自动化时的人工交接都只使用下面这一条提示词，不再附加提示词模板、字段表或多轮问卷：

> 生成一张用于 See-Through 分层测试的正常二次元角色立绘。角色设计由你自由决定，但必须是单人、正面全身、头部端正、双眼自然睁开、闭口中立，双臂与躯干分开，双腿和鞋完整，头发、服装、尾巴和配饰边界清楚。使用纯白或均匀浅灰的不透明纯色背景，不要渐变、阴影、纹理、文字、道具、夸张透视、动态姿势或裁切。

用户给定角色身份、造型、配色或服装时，只替换“角色设计由你自由决定”，保留后面的可绑定约束。用户已经提供完整生图提示词时不擅自重写；先按原提示生成，再实际打开结果检查。人物不正常、关键身体区域被裁切、肢体严重粘连或复杂背景与主体大面积混合时先重新生成或让用户决定；轻微渐变、阴影、纹理、透明背景和少量噪点不单独阻断测试，保留为预处理或后期修复项。

## 自动分层

正式人工入口是 [ModelScope See-Through](https://modelscope.cn/studios/ljsabc/See-Through)，独立 Gradio 服务为 `https://ljsabc-see-through.ms.show`，命名 API 端点为 `/inference`。它接收图片、`resolution`、`seed` 和 `tblr_split`，返回分层 PSD 与图层预览。

通过包装脚本调用，不控制 Windows 鼠标：

```powershell
& <skill>\scripts\acquire_layered_psd.ps1 E:\Input\character.png -Resolution 1024 -Seed 42 -SplitLimbs
```

默认结果写入 Skill 自有且被忽略的 `runtime/see-through/<UTC 时间-随机编号>/`，不覆盖既有任务。即使接口与 `inspect` 均成功，结果仍保持 `readyForCreate: false`，因为脚本只证明服务返回了 PuppetLoom 可读取的 PSD 和待审查证据，不证明分层语义或重组画面正确。先用只读检查确认当前 API 协议仍匹配：

```powershell
& <skill>\scripts\acquire_layered_psd.ps1 -Check
```

每个运行目录自带 `source-original.*`、`source-upload.png`、`source-normalized.png`、PSD、带语义名称的 `previews/`、`previews/index.json` 与 `previews/contact-sheet.png`、`inspect.json`、从实际可见图层生成的 `recomposition.png`、`difference.png`、`comparison.png`、`comparison-metrics.json`、待 Agent 填写的 `visual-review.json` 和完整调用记录。预览总览用于一次检查全部语义层，再对缺眼、长条污染或异常边缘的单层预览放大确认。`source-original.*` 是未经改写的输入副本；`source-upload.png` 是 EXIF 校正、不缩放、白底不透明副本，在线获取时它是实际发送给 See-Through 的文件，本地复核时只用作同规则比较而不会上传；原图已有透明像素时不会被静默覆盖。`source-normalized.png` 才是用于同画布比较的居中补方与缩放结果。三者路径和哈希都进入调用记录，返回结果时明确指出原图、实际上传图和 PSD 在哪里。

只有传输超时、连接中断或事件流没有完整结果时，脚本才使用同一分辨率、种子和拆肢选项自动重试一次，并在 `attempts/attempt-1`、`attempts/attempt-2` 中分别保留记录。画面缺眼、残留底色或分层错误不是传输故障，不能自动批量换种子；Agent 看过证据后再决定是否另开一次调用。

已有原图和 PSD 时使用本地复核，不上传任何文件：

```powershell
& <skill>\scripts\acquire_layered_psd.ps1 E:\Input\character.png -ReviewPsd E:\Input\character.psd -OutputRoot E:\Output\layering-review
```

API 失败、持续排队、结果 URL 无法下载或服务协议改变时，保留错误任务目录并报告失败；不要假装已经获得 PSD。把准确入口 `https://modelscope.cn/studios/ljsabc/See-Through` 交给用户，说明人工步骤：上传同一张原图，选择分辨率、种子和是否拆分左右手臂与腿，运行后下载 PSD 和图层预览，再把原图与 PSD 一起交回。浏览器只有在能使用现有登录状态且能可靠下载时才作为备用入口。

## 下载后的验收

脚本验证文件非空且以 PSD 签名 `8BPS` 开头。随后运行：

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 inspect --input E:\Output\character.psd --json
```

实际打开 `source-normalized.png`、`recomposition.png`、`comparison.png`、`previews/contact-sheet.png` 和需要放大的单层预览，确认脸、双眼、虹膜/睫毛、前发、后发、脖子和上身等核心语义存在；全身角色还要检查手臂、腿、裙摆、尾巴和配饰。`recomposition.png` 必须由 PSD 的实际可见图层强制合成，不能信任 PSD 内置预览图。对照图同时展示白底、深色底和只保留角色有效 Alpha 的放大差异，用于检查脸形、五官、发际线、服装图案、肢体轮廓、透明边、残留底色、离散噪点和画布位置。透明 PNG/WebP 的裸查看器可能显示 Alpha 为零区域里的无效 RGB；只有在白底或深色底 Alpha 合成后仍可见的条纹、底色和噪点才是画面污染，不能凭透明区中的隐藏 RGB 误判。

`inspect` 通过、图层数量充足或 `comparison-metrics.json` 的差异较小，都不能自动接受候选。外部 Agent 必须把 `visual-review.json` 中五官、头发、服装肢体、背景透明边和整体重组逐项记录为通过、可后修或失败，并给出 `blockingIssues` 与 `repairPlan`。缺失核心五官或主要身体区域、Alpha 合成后存在大面积白雾或底色、有效 Alpha 内有影响主体的污染、画布严重错位或分层结构不足以可靠创建项目时才标为 `rejected`；缺少呆毛、小配饰或其它可补特征，少量边缘残留、孤立噪点、轻微颜色与纹理变化等标为 `accepted-with-repairs`。写完结论后通过确定性入口校验三档状态并同步结果，Agent 不再手工维护两份状态：

```powershell
& <skill>\scripts\acquire_layered_psd.ps1 -FinalizeReview E:\Output\layering-review\<run>\visual-review.json
```

`accepted` 不得带阻断项或待修计划；`accepted-with-repairs` 必须有具体 `repairPlan`，但不带阻断项；`rejected` 必须说明至少一个真正阻止继续创建的 `blockingIssues`。命令校验原图与 PSD 哈希、审图证据路径和结论内部一致性，再同步更新 `visual-review.json` 与 `result.json`。用户只要求 PSD 时，返回文件、分级结论和修复计划后停止。用户同时要求继续制作时，`accepted` 可直接进入 `create --reference <原图>`；`accepted-with-repairs` 可以继续，但必须把修复计划带入后续项目，在交付前补层、修纹理或用更新 PSD 执行 `migrate`，不能把“以后能修”误报成已经修好。
