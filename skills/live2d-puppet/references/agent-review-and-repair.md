# 外部 Agent 看图、制作与返修

## 职责边界

外部 Agent 负责理解用户说的“自然、克制、活泼、跟紧、柔软”等结果目标，决定处理哪些部位，实际查看基线和修改后的图像/连续帧，判断轮廓、体积、遮挡、连接、节奏和角色原有效果是否成立，并据此决定下一轮数值或更高层结构修改。这里的 Agent 是 Codex、Claude 等通过 CLI 操作项目的外部执行者，不是 PuppetLoom 桌面应用里的聊天框或常驻运行时。

PuppetLoom 负责读取 PSD 和项目、生成结构化规格模板、验证明确的数值与图层、制作网格/关键形/物理、执行安全检查和有限的确定性收敛、提交 revision、生成准确证据、检测并发冲突以及恢复历史。软件不得用几条关键词正则冒充自然语言理解，也不得把结构安全检查说成审美判断。

## 正式规格合同

先为当前 revision 生成模板：

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 agent specification --project E:\Puppets\Character --scope whole --json
```

模板的 `kind` 固定为 `puppetloom-rig-spec`，`scope` 明确区分 `whole` 与 `selected`，`baseRevision` 绑定当前项目，`parts` 只包含项目实际存在且本轮获准处理的部位。整模计划仍必须逐项报告全部职责：不存在的部位标为 `not-present`，规格漏掉实际存在的部位则停止，不能静默使用默认值。外部 Agent 必须在看过基线后修改 `goal`、每个部位的 `intent` 和 `rationale`，再保存为 JSON。模板数值只是安全起点，不能原样当成“已经理解用户”。`layerIds` 只在自动目标不够精确时填写。

主运动部位使用 `amplitude/response/stability`。前发额外使用 `ahogeAmplitude/ahogeResponse/ahogeStability/lagResponse/lagDamping/deformationScale`；其它次级运动使用 `lagResponse/lagDamping/deformationScale`。幅度表示目标可见度，response 表示跟随速度，stability 和 lagDamping 控制收敛与回弹，lagResponse 控制物理追赶速度，deformationScale 控制局部关键形变形。裙摆还可使用 `garmentStructure` 区分软垂布料与保体积支撑结构，并用 `garmentFlexibility` 单独控制支撑结构中下段的受限弹性。支撑类型、整体摆动速度和局部柔性是三个独立判断：“塌陷”先修结构，“太慢”调 response/lag，“太硬”调 flexibility，不能靠降低摆幅把软布伪装成裙撑，也不能靠锁死整件裙子维持体积。`rationale` 必须写看到了什么和为什么这样改，不能只复述数字。

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 agent plan --project E:\Puppets\Character --spec E:\Puppets\rig-spec-r0.json --json
& <skill>\scripts\invoke_puppetloom.ps1 agent apply --project E:\Puppets\Character --spec E:\Puppets\rig-spec-r0.json --json
```

`plan` 必须返回 `inputMode: structured-specification`。规格 revision 过期、同一部位重复、参数越界、目标图层不存在或范围与用户目标不符时停止并重新观察，不通过改 `baseRevision` 强行套用旧判断。`--instruction/--scope` 是旧调用兼容入口；正式外部 Agent 流程不依赖软件解析自然语言。

生成规格前以当前项目为真源，检查目标部位的稳定 layer ID、语义角色、`alphaTopology`、连接区域、轴心、已有绑定以及每个参数实际驱动的图层。以前角色、参考素材或历史规格只能帮助观察，不能默认继承部件关系、运动方向或物理响应。用户指出当前角色的分层或连接与以前不同，或质疑两个部件是否仍被连带驱动时，即使 `plan` 全绿，也先用 `describe` 和实际参数输入检查结构与耦合，再决定是改规格、做项目校准还是修软件；不要先靠缩小幅度掩盖语义错误。

## 看图—返修循环

1. 在任何写入前运行 `history/verify/describe/render`，按用户允许的形式选择 `play` 或 `record`，并实际打开基线姿态、整体动作和次级运动证据。先记录 accepted session 对应的角色原有效果、实际存在部位和不能退化的区域。
2. 生成当前 revision 的规格模板。外部 Agent 依据用户目标、基线和刚核对的当前结构选择部位、填写数值和理由，运行只读 `plan`，核对目标图层、素材状态、草稿、检查项和阻断项。
3. 在获准的工作项目执行 `apply`。每个完成部位都有独立 from/to revision；整模后续部位阻断不会自动撤销已提交 revision，因此逐项核对 session 与 `history`。实际打开全部 `focusComparisonSheet` 和 4×4 `focusMotionSheet`，检查前后差异与完整连续运动。只有需要定位某一帧时才读取 `focusMotionManifest`。不能只打开整模缩略图，也不能只读 JSON。
4. 给每个部位作出明确视觉判断：`accept`、`repair`、`needs-assets`、`not-present` 或 `blocked`。判断至少覆盖中立一致性、近大远小、根部/关节连接、自由端形变、遮挡穿插、回正连续性、回弹次数与未点名区域退化。失败项必须指出具体部位、姿态或连续帧、看到的现象和对应证据；不能只给出“通过多少项”的计数。
5. 若只是幅度、速度、阻尼或局部变形量不合适，在当前 revision 重新生成模板，填写新的结构化规格并再跑一轮。若参数关系、关键形或物理图结构不够表达，升级到 `author inspect/apply`；只有少量已知顶点、轴心或权重需要修正时才用 `describe --layer` 与稀疏 `calibrate`。不要为了回避 Agent 判断去扩建桌面手工编辑器。
6. 每轮返修都重新查看准确 to revision 的静态和连续证据。目标成立且没有明显退化才停止；同一可见缺陷经过一轮合理参数返修仍基本不变时，不再反复猜幅度或降低阈值，转入下面的根因检查。确认现有 CLI 或素材确实无法表达后，恢复最后可接受 revision，把真实阻断报告给用户。

## 重复缺陷的根因检查

把同一位置的源 Alpha、neutral 状态 ArtMesh、目标姿态下的网格/轮廓边界和最终实际像素并排比较，确认问题最早在哪一层出现。再检查图层语义、`alphaTopology`、根部与铰链、长边界边、局部权重、关键形方向、遮挡顺序和证据阈值。`plan` 全绿只说明规格在当前结构假设下满足已有检查，不证明语义关系本身正确。目标运动量以源图像像素计算；归一化参数变化、网格节点移动或亚像素差异本身不证明观众能看到运动。若根因在可复用的网格、语义或变形算法，按软件缺陷处理并增加通用测试；若只与该 PSD 的局部几何有关，留在项目校准。

同一个 ArtMesh 或纹理可能同时包含头皮、中央刘海、侧发、呆毛、双耳或头饰。共享网格不等于共享语义、根部和运动：先按 Alpha 连通区域、连接结构和视觉职责划分语义区，再分别约束稳定体积、随头结构和自由端次级运动。不要因为它们位于同一图层就让整个网格同幅平移、旋转或回弹。

## 卡顿与动作停顿的区分

用户说“卡”“顿一下”“跟不上”时，先对当前规范项目的准确 revision 运行 `performance`，不要先猜显卡，也不要拿固定 fixture 的结果代替。活动态和暂停态都出现相近的 p95/p99 或长帧，优先判断为窗口、系统调度或测量环境问题；暂停态稳定而只有活动态失败，判断为 PuppetLoom 渲染、模型求值、临时对象或 GPU 上传路径问题，先修软件并用同一项目复测。两者都通过但视觉仍像停住，说明帧没有丢，问题在动作事件的硬保持、响应速度、稳定性、回正曲线或次级运动节奏；实际查看 `play` 或用户允许的连续证据，再修改规格或通用动作曲线。不能用降低运动幅度掩盖掉帧，也不能用性能全绿否定用户看到的机械停顿。

报告时把事实分开写清：`active/paused` 帧时间证明是否掉帧，`renderCpu` 帮助定位活动渲染开销，连续画面证明动作是否硬停或响应过慢。`diagnosis.frameDropSource` 是基于活动/暂停对照的程序判断，不替代 Agent 对动作节奏的视觉判断。性能修复后必须在同一 revision 再测，不能只跑通用基准；动作修复后必须查看进入、停顿、回正三个阶段的连续性，不能只看极值姿态。

## 缺陷如何路由

- 原画或 PSD 已缺失主要结构、语义分错、画布错位，或前后内容粘在同一图层造成遮挡错误：停止绑定，按原画与分层流程把候选标为 `rejected`。若内容完整且只是几个独立图层顺序错误，记录明确的 layer ID 和相对关系，创建后使用 `move-layer` authoring 操作形成可恢复 revision，再看中立和动作证据；不要直接改项目 JSON 或源 PSD。
- 整体方向、角色气质、运动节奏或审美幅度不对：外部 Agent 改结构化规格。
- 图层语义、Alpha 部件、根部/铰链或自动目标识别错误：先用 `describe` 取证；跨多个项目重复，或单个项目已经用通用代码路径和可复现数据证明算法根因时，修 PuppetLoom 算法并补通用 fixture，否则在规格中限定图层或做项目校准。
- 关键形关系、参数维度、变形器层级、表达式或物理图不够：外部 Agent 使用 `author inspect/apply`，PuppetLoom 只验证并提交明确操作。
- 个别顶点、轴心或权重偏差：稀疏 `calibrate`，保留 from/to 证据。
- 完整角色制作缺闭眼或一个张口：Agent 默认按原画与重组图生成真正缺少的素材，验证后通过 `enhance` 接入；已有闭嘴不重画。微张嘴或音素嘴形只有用户明确需要对应表情或独立触发时才增加，不进入默认麦克风口型。用户明确禁止生图或限定现有素材时才报告 `needs-assets`，不能用参数伪造。
- 结构和安全检查全绿但画面难看、僵硬或破坏原效果：仍判为 `repair` 或失败；这是外部 Agent 必须承担的视觉判断。

## 给用户的验收

先展示候选角色窗口或准确 revision 的前后/连续效果，再报告完成部位、缺失部位、素材边界和仍需用户判断的观感。每个未通过项说明它在什么姿态或帧出现、画面具体哪里不对、证据在哪里以及当前能否修复；不要只报告检查计数。候选接受后才把对应 session 标为 `accepted` 并运行完整回归；拒绝后标记、恢复、复核并停止。不要把测试清单当作主要交付。用户不满意时先接收“哪里看起来不对”的结果反馈，由 Agent 自己定位部位和参数；只有 CLI 不能表达的局部问题才邀请用户手调。
