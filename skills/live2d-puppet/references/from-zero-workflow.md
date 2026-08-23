# 从零创建与复核

## 输入边界

理想输入是一张原始角色图和由它直接生成的 See-Through 分层 PSD。原图用于检查分层重组是否改变角色，PSD 是 PuppetLoom 的必要运行素材。只有 PSD 也可继续，但要报告没有原图作为重组一致性参考。只有原图时先展示确认，再列出三种选择：推荐用户在 `https://modelscope.cn/studios/ljsabc/See-Through/?st=1WIdxVcPQ8ylM43-0Vr14FQ` 以 1024 自行上传、下载 PSD；用户选择偷懒选项后由 Agent 代传当前已确认图片；在线入口不可用时才推荐本地部署。完全没有角色图时，把当前身份、角色设计和项目画风参考直接交给图像模型，取得完成度正常且关键部件可辨的日系二次元原画，实际打开检查并展示给用户，等待确认后再列出这三种路线。不把普通 PNG 改后缀或自行猜层当成分层结果，也不用抽象图或几何测试卡代替正式二次元角色输入。

合适的角色原图为日系二次元单人半身或全身，头部基本端正，脸部基本对称，双眼自然睁开，闭口中立，关键部位没有严重遮挡。人物可以有轻微动态，不限定头身比，也不能为了分层擅自做矮或做成 Q 版。PSD 至少应尽量提供脸、双眼、虹膜/睫毛、眉毛、前发、后发、脖子和上身。缺层时软件会降级，不要把“还能运行”说成“完整语义绑定”。复杂伴生角色只用于压力测试或独立素材，不与正式人物分层结果混为一体。

自动拆层不会替代验收。下载后先验证确实是 PSD，再运行 `inspect`，查看图层预览，并强制从 PSD 实际可见图层重新合成，不能信任内置预览图。把同画布归一化原图、重组图、白底/深色底和差异图一起查看。单独检查从后到前的图层顺序：后裙应在裸露腿后，腿在前裙后，后发在脖子和脸后，眉毛在脸前；实际设计不同则以原画为准。若只是完整独立图层顺序错误，记录为 `accepted-with-repairs`，创建后用 `move-layer` 形成可恢复 revision；若前后结构已粘在同一层，或核心五官/身体区域缺失、第二主体串层、严重错位、有效 Alpha 大面积污染、PSD 无法读取，则拒绝并停止，不转为孤立部件生图、绿幕抠图或代码拼接。呆毛、小配饰、少量边缘残留、孤立噪点和轻微颜色变化等不改变主要轮廓与遮挡的问题也可后修。结构检查和数值差异不能替代视觉结论。

用户只要求生成 PSD、测试 See-Through 或检查分层质量时，在保存原图副本、实际上传副本、PSD、预览、`inspect`、重组对照和 `accepted/accepted-with-repairs/rejected` 三档记录后停止。Agent 填写 `visual-review.json` 后必须通过 `acquire_layered_psd.ps1 -FinalizeReview` 校验并同步 `result.json`，不得手工维护两份互相独立的结论。不得创建项目、编写绑定规格或调用 `agent plan/apply`。只有用户明确要求继续制作角色且分层视觉验收成立，才把原图传给 `create --reference` 并进入后续 CLI 顺序。

## CLI 顺序

统一通过 `scripts/invoke_puppetloom.ps1` 调用：

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 inspect --input E:\Input\character.psd --json
& <skill>\scripts\invoke_puppetloom.ps1 create --input E:\Input\character.psd --reference E:\Input\character.png --output E:\Puppets\Character --seed 42 --json
& <skill>\scripts\invoke_puppetloom.ps1 verify --project E:\Puppets\Character --json
& <skill>\scripts\invoke_puppetloom.ps1 describe --project E:\Puppets\Character --json
& <skill>\scripts\invoke_puppetloom.ps1 render --project E:\Puppets\Character --output E:\Puppets\Character\reports\agent-baseline --suite calibration --revision 0 --size 1080 --focus whole --json
& <skill>\scripts\invoke_puppetloom.ps1 record --project E:\Puppets\Character --output E:\Puppets\Character\reports\agent-motion-r0 --mode autonomous --revision 0 --json
& <skill>\scripts\invoke_puppetloom.ps1 record --project E:\Puppets\Character --output E:\Puppets\Character\reports\agent-secondary-r0 --mode secondary --revision 0 --json
```

先查看 `inspect` 返回的 `preflight`：普通创建保持自动 Alpha 清理，不传高级例外参数。系统默认只移除透明度很低、范围极小且与主体断开的高置信度噪点，眼睛高光、细发丝和装饰等疑似有效细节继续保留，源 PSD 始终不改。`--preserve-alpha-noise` 只用于诊断时保留全部区域；只有用户明确接受可能误删绘画细节时才使用 `--clean-alpha` 激进清理。不要把这两个高级例外变成普通用户创建角色前必须勾选或决定的步骤。

`create` 输出必须是新目录或空目录；每次 `record` 也使用新的证据目录，软件不会覆盖同名证据。上面的 `record` 只在确实需要连续视频且用户允许时运行，不是固定交付物。参考图缺失时省略参数，不得代入不对应的图片。成功生成 `semantic/grouped/minimal` 任一等级都返回 0；2 是输入或补丁无效，3 是文件系统、项目或运行时错误。创建完成后始终维护一个规范项目目录，以内部 revision、session 和证据历史管理版本，不复制 `Character-r1/Character-r2` 一类目录。

`visual-review.json` 已记录独立图层顺序修复时，先用 `author inspect` 取得稳定 layer ID，再用 `author apply` 提交 `move-layer` 操作。`beforeLayerId` 表示把目标放到参照层后面，`afterLayerId` 表示放到参照层前面；二者只能提供一个。每次移动后重新 `render` 中立、眨眼和相关身体动作，确认腿、裙摆、脖子、后发、脸和眉毛没有被错误遮挡。不要直接改 `puppetloom.json`，也不要静默改写源 PSD。

```json
{
  "version": 1,
  "baseRevision": 0,
  "label": "修正独立图层遮挡顺序",
  "operations": [
    { "op": "move-layer", "layerId": "back-skirt", "beforeLayerId": "left-leg" },
    { "op": "move-layer", "layerId": "back-hair", "beforeLayerId": "neck" },
    { "op": "move-layer", "layerId": "left-eyebrow", "afterLayerId": "face" }
  ]
}
```

这里的 ID 只是结构示例，实际补丁必须使用当前项目 `author inspect` 返回的 ID 和 revision；不能照抄示例。

## Agent-first 修改顺序

创建后的基础结果和已有项目都通过外部 Agent 调用 CLI 继续工作。用户要求整模时处理整模，点名一个部位时不扩写成其它部位。选择修改入口时遵守下面的优先级：

1. 外部 Agent 先看基线，用 `agent specification` 取得结构化模板并填写明确意图，再使用 `agent plan/apply --spec` 完成整模或分部闭环。软件负责确定性制作、自检、安全收敛、提交和证据；理解用户、视觉判断和下一轮返修由外部 Agent 负责。
2. 顶层 Agent 无法表达、但参数、关键形、变形器或物理能够表达的目标，使用 `author inspect/apply` 高层修改。
3. 只有局部顶点、轴心或权重需要修正时，才使用 `describe --layer` 和稀疏 `calibrate`。
4. `edit` 是用户明确想手调或公开 CLI 无法表达局部修正时的备用入口。桌面应用不运行 Agent 编排，不把用户变成人工网格制作员，也不继续补手工工具来绕开 Agent 任务。

已有项目执行“完成整模”“检查遗漏”“继续做完”前先审查，后写入。运行 `history/verify/describe`，读取当前 revision、所有实际存在的部位、accepted/rejected/unreviewed session，并用准确 revision 的高分辨率整模和局部证据检查已接受结果。整模审查覆盖所有实际存在部位，但 `apply` 只覆盖确有可见缺陷且本轮获准修改的部位；不要为了覆盖部位清单而重做已经成立的结果。若没有待修缺陷，不执行 `apply`、`author apply` 或 `calibrate`，不创建新 revision。

用户问“这轮最新版”“全部做完了吗”或要求查看这轮解决的问题时，先从完整任务、批注和后续纠正重建需求清单。逐项读取公开入口的实际默认值或本次调用参数、规范项目当前 revision 的真实数据、匹配证据和接受记录；不能从代码存在、帮助文本、测试夹具或隔离副本反推正式用户路径已经启用。`test/artifacts`、临时迁移目录和报告副本不能参与“哪个是最新版”的判断。后来的单项截图只修正该项，不自动取消此前仍在同一任务内的其它要求。

整模的正式入口是先取得与当前 revision 绑定的模板，由外部 Agent 看图后编辑成 `rig-spec-rN.json`，再计划和执行：

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 agent specification --project E:\Puppets\Character --scope whole --json
& <skill>\scripts\invoke_puppetloom.ps1 agent plan --project E:\Puppets\Character --spec E:\Puppets\rig-spec-r0.json --json
& <skill>\scripts\invoke_puppetloom.ps1 agent apply --project E:\Puppets\Character --spec E:\Puppets\rig-spec-r0.json --json
```

只处理一个部位时，在生成规格模板时把 `--scope` 设为稳定 ID：`headFace`、`eyes`、`mouth`、`frontHair`、`backHair`、`ahoge`、`ears`、`headwear`、`body`、`topCloth`、`skirt`、`tail` 或 `accessory`。例如：

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 agent specification --project E:\Puppets\Character --scope frontHair --json
& <skill>\scripts\invoke_puppetloom.ps1 agent plan --project E:\Puppets\Character --spec E:\Puppets\front-hair-spec-r0.json --json
& <skill>\scripts\invoke_puppetloom.ps1 agent apply --project E:\Puppets\Character --spec E:\Puppets\front-hair-spec-r0.json --json
```

模板不能原样执行。外部 Agent 必须根据用户目标和实际基线填写 `goal`、选择 `parts`、调整每个部位的数值 `intent` 并写出基于画面的 `rationale`。`plan` 只读，先核对 `inputMode: structured-specification`、`baseRevision`、`requestedParts`、草稿、目标 layer、各部位 `checks/repairs/assetRequests`、`canApply` 和 `blockers`。存在不兼容草稿、自检失败或 revision 冲突时停止，不清空用户的其它工作。`apply` 按确定顺序处理存在的部位，每个成功部位形成独立可回滚 revision、session、前后证据和 Agent 报告；最后返回整模 `verification` 和汇总报告。`not-present` 表示项目没有相应图层，`needs-assets` 表示闭眼或嘴形等素材还需补充，`blocked` 才是本轮无法继续的问题。不得伪造缺失图层，也不得把这三种状态冒充 `completed`。

整模 `apply` 不是整体事务。它逐部位提交，前面已完成的 revision 不会因为后续部位 `blocked` 自动回滚；返回后逐项核对 `status`、实际 from/to revision、session、报告路径和 `history`。当前只有前发 Agent 能在提案等价时明确返回无变化，其它主运动和次级部位可能仍提交 revision，所以成熟项目不能用整模 `apply` 代替只读审查。`coherenceChecks` 只覆盖软件当前声明的跨部位规则，不能替代对全部历史 accepted 结果的视觉保护清单。若整模最终阻断且已落盘的候选没有被接受，标记所有受影响 session 为 `rejected`，恢复最后接受的 revision 并复核。

`agent front-hair plan/apply`、`agent secondary plan/apply` 以及顶层 `--instruction/--scope` 是保留的精细或旧调用兼容入口；正式外部 Agent 流程使用结构化规格，不能把理解自然语言的责任推回软件。桌面应用只用于播放、查看和必要的人工兜底，不应出现项目内嵌的 Agent 对话入口。

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 agent front-hair plan --project E:\Puppets\Character --instruction "检查并重做前发运动" --json
& <skill>\scripts\invoke_puppetloom.ps1 agent front-hair apply --project E:\Puppets\Character --instruction "检查并重做前发运动" --json
& <skill>\scripts\invoke_puppetloom.ps1 agent secondary plan --project E:\Puppets\Character --part tail --instruction "尾巴根部固定，回弹自然" --json
```

其它当前可由高层结构表达的修改使用：

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 author inspect --project E:\Puppets\Character --json
& <skill>\scripts\invoke_puppetloom.ps1 author apply --project E:\Puppets\Character --patch E:\Input\authoring.json --json
```

补丁只包含用户点名部位所需的参数、关键形、变形器或物理操作，并使用刚读取的 base revision。已有项目若被用户明确指定为只读对照，不在其中执行 `apply`、`author apply` 或 `calibrate`；只对另行获准的工作项目写入，并在交付前核对对照项目没有变化。用户在任务中追加的范围和素材限制立即生效：说“只使用现有素材”时不得运行 `enhance`、生成或下载新图、修改 PSD 或把参考图加入项目；允许继续制作现有素材能支持的部位，缺口只报告为 `needs-assets`。说“不要视频”时不得运行 `record`，不能把证据偏好擅自改写成素材或能力扩展。

用户要求建立或补齐标准表情、肢体、耳朵、尾巴等可触发动作时，先按真实图层只读规划，再写入同一项目的可恢复 revision：

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 actions plan --project E:\Puppets\Character --json
& <skill>\scripts\invoke_puppetloom.ps1 actions apply --project E:\Puppets\Character --json
```

逐项核对 `completed/not-present/needs-assets`，不能因为动作库命令成功就把缺素材部位说成完成。重复计划应无待写入变化；若它仍提出相同修改，先查项目 revision 和幂等性，不继续制造 revision。

## 视觉复核

始终查看准确 revision 的 `pose-sheet.png`、`motion-sheet.png`、每个 `focusComparisonSheet` 和 4×4 `focusMotionSheet`；只有需要定位单帧时才读取 `focusMotionManifest`，不能只读取路径或 JSON。需要新的高清证据时运行 `render --project <directory> --output <new-directory> --revision <n> --size 1080 --focus <part>`，并用 `play --project <directory> --revision <n>` 打开同一候选。打开新 revision 前关闭或明确替换旧角色窗口，不能让用户在多个过期窗口中猜哪个是当前结果。主姿态逐格检查中立、左右转、向上看、向下看和四个组合方向；动态进入、保持、退出确实影响判断且用户允许视频时，再运行 `record --project <directory> --output <new-directory> --mode autonomous --revision <n>`。secondary 证据必须证明主运动归零；若使用报告，其 `headAndBodyFrozen: true`，且头、身体、视线、呼吸、眨眼和嘴部极值都应为 0，再检查前后发、呆毛、耳朵、衣摆与尾巴的独立惯性。报告中的绝对项目路径、`baseProjectSha256`、`revision`、`currentRevisionAtStart` 和窗口比例必须匹配本次任务，不能拿旧进程、旧视频或文件名推测代替。放大查看脸缘、眼角、前发发梢、头皮/发饰边界和脖子连接，不能只看整张缩略图。

`verify.valid`、13 个安全姿态和 Agent checks 只证明对应结构与安全条件，不证明自然，也不证明参数最终让画面产生了有效运动。修改后必须使用 from/to revision 的前后证据，并在准确 to revision 上检查允许的连续证据：目标部位应以源图像像素计产生可见连续变化，根部没有脱离，进入、保持、回正和回弹没有跳变，未点名区域及历史 accepted 结果没有明显退化。归一化数值改变或不到一个源像素的位移不能冒充“肉眼可见”。若参数存在但目标部位不动，或全绿检查下实际观感更差，本次结果仍失败；恢复旧 revision 后停止，不修改阈值掩盖结果。

视觉异常先用摘要 `describe` 找稳定 ID，再运行 `describe --layer <id> --revision <n>`。顶点补丁使用输出中的完整 `delta`，不是在当前画面上重复累加；权重使用该顶点的当前绝对值。`alphaTopology.componentCount/components` 用于识别一个纹理中合并的头饰、双耳或其它分离部件，再决定是否需要多个锚点、局部权重或重新分层。坐标原点在画面左上，X 向右、Y 向下；`side` 是角色自身的解剖学左右，角色 left 通常位于画面右侧。不要直接改 `puppetloom.json`。

缺少闭眼或三态嘴形时，先检查 PSD、项目现有图层和 `requests/asset-requests.json`，盘点中立状态已经具备什么。已有闭嘴图层直接作为 `mouthOpen=0`，不能再生成一张闭嘴图替换它；只处理真正缺少的微张、张口或左右闭眼素材。完整角色制作中，这些缺失表情由 Agent 默认生成和检查，不再向用户逐项索取授权。生成时同时参考原画、PSD 重组图和请求裁图，严格继承线稿、睫毛体量、眼角、口腔配色、阴影和抗锯齿；闭眼不能是一条弧线。PNG 的尺寸、Alpha、位置、左右和覆盖率符合请求后才运行 `enhance --assets <directory>`；命令返回的 `accepted` 才算接入，`rejected` 不能当成成功。用户明确限定现有素材或禁止生图时保留请求但不执行增强，并报告 `needs-assets`。

## 现有项目接入新增能力

软件升级、CLI 新增能力或项目格式增加字段不等于源 PSD 变化。规范项目仍使用原来保存的同一 PSD，而只是缺少后来增加的多房束、侧脸深度或可选躯干体积数据时，先运行：

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 extensions plan --project E:\Puppets\Character --json
& <skill>\scripts\invoke_puppetloom.ps1 extensions apply --project E:\Puppets\Character --json
```

只有用户目标和素材确实需要躯干体积时才添加 `--torso-volume`，不能把它当成所有角色的默认身体效果。`plan` 必须读取项目自己的源 PSD，并把新增数据作为同一规范目录中的可恢复 revision；执行后重新检查需求清单，不能只凭 `extensions` 命令成功就宣称所有点名能力都已进入项目。

## 更新 PSD

收到同一角色的新 PSD 时，不替换旧项目文件。运行：

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 migrate --project E:\Puppets\Character --input E:\Input\character-v2.psd --reference E:\Input\character-v2.png --output E:\Puppets\Character-v2 --json
```

查看 `reports/migration.json` 和 `migration-patch.json`。`exact` 才允许迁移几何校准；`geometry-changed`、`missing` 或 `ambiguous` 必须重新描述、渲染和校准。旧项目始终保留，迁移成功也不能跳过新项目的完整视觉复核。

## 结果反馈与人工备用

用户对自动结果的反馈优先由外部 Agent 解释为同一范围的新规格，例如“摆动幅度小一点”“滞后太慢”“呆毛太弹”。Agent 重新查看当前 revision，生成新模板并调整对应 `intent/rationale`；高层 authoring 能承接时才修改对应关键形或物理。不要先要求用户指出顶点、权重或参数编号。

只有自动或高层入口不能表达的局部校正才用 JSON 稀疏补丁和 `calibrate`，每次修改后用 `compare`。用户明确希望自己调时运行：

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 edit --project E:\Puppets\Character
```

候选结果先运行定向安全检查并展示准确 revision 的高清画面或角色窗口，不在用户看候选前先耗时跑完整回归或执行推送。用户接受后运行 `evidence --project <directory> --session <id> --status accepted`，再完成获准范围内的完整回归和发布操作。用户拒绝自动制作或人工校正时，运行 `history` 找出本次所有 session，分别用 `evidence --project <directory> --session <id> --status rejected` 标为 `rejected`，再 `restore --revision <最后接受的 revision> --base-revision <当前 revision>`，检查准确 revision 的恢复证据并停止继续调整，除非用户提出新的具体方向。恢复会保留新审计记录。

运行角色用 `play --project <directory> --revision <n>`，明确检查的 revision，避免当前校准变化后仍观察旧窗口。不要为了演示而自动接入可选闭眼/嘴形；缺少它们时，眨眼和嘴部保持安全状态即可。
