# 从零创建与复核

## 输入边界

理想输入是一张原始角色图和由它直接生成的 See-through 分层 PSD。原图用于检查分层重组是否改变角色，PSD 是 PuppetLoom 的必要运行素材。只有 PSD 也可继续；只有原图时先尝试当前环境可用的 See-through 在线服务，下载 PSD 后再进入确定性流程。若没有稳定可用的服务接口，停下来向用户说明需要 PSD，不把普通 PNG 改后缀或自行猜层当成分层结果。

合适的角色原图为正面单人半身或全身，头部端正，脸部基本对称，双眼自然睁开，闭口中立，身体没有严重遮挡。PSD 至少应尽量提供脸、双眼、虹膜/睫毛、前发、后发、脖子和上身。缺层时软件会降级，不要把“还能运行”说成“完整语义绑定”。

## CLI 顺序

统一通过 `scripts/invoke_puppetloom.ps1` 调用：

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 inspect --input E:\Input\character.psd --json
& <skill>\scripts\invoke_puppetloom.ps1 create --input E:\Input\character.psd --reference E:\Input\character.png --output E:\Puppets\Character --seed 42 --json
& <skill>\scripts\invoke_puppetloom.ps1 verify --project E:\Puppets\Character --json
& <skill>\scripts\invoke_puppetloom.ps1 describe --project E:\Puppets\Character --json
& <skill>\scripts\invoke_puppetloom.ps1 render --project E:\Puppets\Character --output E:\Puppets\Character\reports\agent-baseline --suite calibration --json
& <skill>\scripts\invoke_puppetloom.ps1 record --project E:\Puppets\Character --output E:\Puppets\Character\reports\agent-motion-r0 --mode autonomous --revision 0 --json
& <skill>\scripts\invoke_puppetloom.ps1 record --project E:\Puppets\Character --output E:\Puppets\Character\reports\agent-secondary-r0 --mode secondary --revision 0 --json
```

`create` 输出必须是新目录或空目录；每次 `record` 也使用新的证据目录，软件不会覆盖同名证据。参考图缺失时省略参数，不得代入不对应的图片。成功生成 `semantic/grouped/minimal` 任一等级都返回 0；2 是输入或补丁无效，3 是文件系统、项目或运行时错误。

## Agent-first 修改顺序

创建后的基础结果和已有项目都通过外部 Agent 调用 CLI 继续工作。用户要求整模时处理整模，点名一个部位时不扩写成其它部位。选择修改入口时遵守下面的优先级：

1. 外部 Agent 先看基线，用 `agent specification` 取得结构化模板并填写明确意图，再使用 `agent plan/apply --spec` 完成整模或分部闭环。软件负责确定性制作、自检、安全收敛、提交和证据；理解用户、视觉判断和下一轮返修由外部 Agent 负责。
2. 顶层 Agent 无法表达、但参数、关键形、变形器或物理能够表达的目标，使用 `author inspect/apply` 高层修改。
3. 只有局部顶点、轴心或权重需要修正时，才使用 `describe --layer` 和稀疏 `calibrate`。
4. `edit` 是用户明确想手调或公开 CLI 无法表达局部修正时的备用入口。桌面应用不运行 Agent 编排，不把用户变成人工网格制作员，也不继续补手工工具来绕开 Agent 任务。

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

补丁只包含用户点名部位所需的参数、关键形、变形器或物理操作，并使用刚读取的 base revision。已有项目若被用户明确指定为只读对照，不在其中执行 `apply`、`author apply` 或 `calibrate`；只对另行获准的工作项目写入，并在交付前核对对照项目没有变化。

## 视觉复核

至少查看 `pose-sheet.png`、`motion-sheet.png` 和两种 `record` 的接触表或 WebM。整模/分部 Agent 返回的每个 `focusComparisonSheet` 和 4×4 `focusMotionSheet` 都要实际打开；只有需要定位单帧时才读取 `focusMotionManifest`，不能只读取路径或 JSON。主姿态逐格检查中立、左右转、向上看、向下看和四个组合方向；自主视频检查事件进入、保持、退出是否连续；secondary 报告必须显示 `headAndBodyFrozen: true`，且头、身体、视线、呼吸、眨眼和嘴部极值都为 0，再检查前后发、呆毛、耳朵、衣摆与尾巴的独立惯性。报告中的绝对项目路径、`baseProjectSha256`、`revision`、`currentRevisionAtStart` 和窗口比例必须匹配本次任务，不能拿旧进程或旧视频代替。放大查看脸缘、眼角、前发发梢、头皮/发饰边界和脖子连接，不能只看整张缩略图。

`verify.valid`、13 个安全姿态和 Agent checks 只证明对应结构与安全条件，不证明自然，也不证明参数最终让画面产生了有效运动。修改后必须使用 from/to revision 的前后证据，并对准确 to revision 重新 `record`：检查目标部位确实有连续像素变化，根部没有脱离，进入、保持、回正和回弹没有跳变，未点名区域与原来相比没有明显退化。若参数存在但目标部位不动，或全绿检查下实际观感更差，本次结果仍失败；恢复旧 revision 后停止，不修改阈值掩盖结果。

视觉异常先用摘要 `describe` 找稳定 ID，再运行 `describe --layer <id> --revision <n>`。顶点补丁使用输出中的完整 `delta`，不是在当前画面上重复累加；权重使用该顶点的当前绝对值。`alphaTopology.componentCount/components` 用于识别一个纹理中合并的头饰、双耳或其它分离部件，再决定是否需要多个锚点、局部权重或重新分层。坐标原点在画面左上，X 向右、Y 向下；`side` 是角色自身的解剖学左右，角色 left 通常位于画面右侧。不要直接改 `puppetloom.json`。

缺少闭眼或三态嘴形时，先检查 `requests/asset-requests.json`。只有补充 PNG 的尺寸、Alpha 和覆盖率都符合请求，才运行 `enhance --assets <directory>`；命令返回的 `accepted` 才算接入，`rejected` 不能当成成功。

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

用户保存后运行 `history`，找到最新 session，重建或读取项目内的前后证据。用户接受则运行 `evidence --status accepted`。用户拒绝自动制作或人工校正时，先把相关 session 标为 `rejected`，再 `restore --revision <最后接受的 revision>`，检查准确 revision 的恢复证据并停止继续调整，除非用户提出新的具体方向。恢复会保留新审计记录。

运行角色用 `play --project <directory> --revision <n>`，明确检查的 revision，避免当前校准变化后仍观察旧窗口。不要为了演示而自动接入可选闭眼/嘴形；缺少它们时，眨眼和嘴部保持安全状态即可。
