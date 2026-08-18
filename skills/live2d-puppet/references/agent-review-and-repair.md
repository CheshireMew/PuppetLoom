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

主运动部位使用 `amplitude/response/stability`。前发额外使用 `ahogeAmplitude/ahogeResponse/ahogeStability/lagResponse/lagDamping/deformationScale`；其它次级运动使用 `lagResponse/lagDamping/deformationScale`。幅度表示目标可见度，response 表示跟随速度，stability 和 lagDamping 控制收敛与回弹，lagResponse 控制物理追赶速度，deformationScale 控制局部关键形变形。`rationale` 必须写看到了什么和为什么这样改，不能只复述数字。

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 agent plan --project E:\Puppets\Character --spec E:\Puppets\rig-spec-r0.json --json
& <skill>\scripts\invoke_puppetloom.ps1 agent apply --project E:\Puppets\Character --spec E:\Puppets\rig-spec-r0.json --json
```

`plan` 必须返回 `inputMode: structured-specification`。规格 revision 过期、同一部位重复、参数越界、目标图层不存在或范围与用户目标不符时停止并重新观察，不通过改 `baseRevision` 强行套用旧判断。`--instruction/--scope` 是旧调用兼容入口；正式外部 Agent 流程不依赖软件解析自然语言。

## 看图—返修循环

1. 在任何写入前运行 `verify/describe/render/record` 并实际打开基线姿态、整体动作和次级运动证据。先记录角色原有效果和不能退化的区域。
2. 生成当前 revision 的规格模板。外部 Agent 依据用户目标与基线选择部位、填写数值和理由，运行只读 `plan`，核对目标图层、素材状态、草稿、检查项和阻断项。
3. 在获准的工作项目执行 `apply`。每个完成部位都有独立 from/to revision；实际打开全部 `focusComparisonSheet` 和 4×4 `focusMotionSheet`，检查前后差异与完整连续运动。只有需要定位某一帧时才读取 `focusMotionManifest`。不能只打开整模缩略图，也不能只读 JSON。
4. 给每个部位作出明确视觉判断：`accept`、`repair`、`needs-assets`、`not-present` 或 `blocked`。判断至少覆盖中立一致性、近大远小、根部/关节连接、自由端形变、遮挡穿插、回正连续性、回弹次数与未点名区域退化。
5. 若只是幅度、速度、阻尼或局部变形量不合适，在当前 revision 重新生成模板，填写新的结构化规格并再跑一轮。若参数关系、关键形或物理图结构不够表达，升级到 `author inspect/apply`；只有少量已知顶点、轴心或权重需要修正时才用 `describe --layer` 与稀疏 `calibrate`。不要为了回避 Agent 判断去扩建桌面手工编辑器。
6. 每轮返修都重新查看准确 to revision 的静态和连续证据。目标成立且没有明显退化才停止；同一方向多轮收敛仍失败时恢复最后可接受 revision，把真实阻断报告给用户，不用降低检查门槛或无限猜数。

## 缺陷如何路由

- 整体方向、角色气质、运动节奏或审美幅度不对：外部 Agent 改结构化规格。
- 图层语义、Alpha 部件、根部/铰链或自动目标识别错误：先用 `describe` 取证；若跨多个项目重复，修 PuppetLoom 算法，否则在规格中限定图层或做项目校准。
- 关键形关系、参数维度、变形器层级、表达式或物理图不够：外部 Agent 使用 `author inspect/apply`，PuppetLoom 只验证并提交明确操作。
- 个别顶点、轴心或权重偏差：稀疏 `calibrate`，保留 from/to 证据。
- 缺闭眼、嘴形或真实分层素材：报告 `needs-assets`，不能用参数伪造。
- 结构和安全检查全绿但画面难看、僵硬或破坏原效果：仍判为 `repair` 或失败；这是外部 Agent 必须承担的视觉判断。

## 给用户的验收

先展示最终角色窗口或准确 revision 的前后/连续效果，再报告完成部位、缺失部位、素材边界和仍需用户判断的观感。不要把测试清单当作主要交付。用户不满意时先接收“哪里看起来不对”的结果反馈，由 Agent 自己定位部位和参数；只有 CLI 不能表达的局部问题才邀请用户手调。
