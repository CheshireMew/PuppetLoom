# Agent 调用说明

原图闭眼、脸缘和五官修形可通过 `author inspect-shape` 标记结构，使用 `transform-keyform` 的 `fit-landmarks` / `curve-warp` 表达目标，再以 `author preview` 检查目标标记、修改前后和中间姿态，最后 `author apply` 保存同一补丁。字段、坐标与边界见 [SHAPE_GUIDES.md](SHAPE_GUIDES.md)。

制作执行与视觉结论分开：`agent apply` 执行成功时 `ok` 为 true，`status` 为 `awaiting-visual-review`，`visualReview` 为 `unreviewed`；自动检查不能宣布角色制作完成。分部报告另有 `executionStatus: succeeded`。外部 Agent 检查准确 revision 的造型与连续动作；用户接受后通过已有 `evidence --session <id> --status accepted` 记录，历史执行报告不自动改写。头脸 `measurements` 仅报告当前比例与变化，不要求不同角色满足统一近远眼或下半脸伸缩比例。

Codex 一类外部 Agent 通过 CLI 完成从 PSD 到可运行角色的工作，并用同一修订与证据接口和用户协作。软件负责格式、结构化规格验证、确定性制作、渲染、安全收敛和历史；外部 Agent 负责理解自然语言、选择整模或分部范围、观察实际证据、判断是否继续调整，以及把“当前角色校准”和“通用算法缺陷”分开。桌面应用只负责创建、查看、播放和人工兜底，不内嵌 Agent 对话或编排。

下面用 `$cli = "E:\Code\PuppetLoom\apps\cli\dist\index.js"` 表示入口。

## 从零创建

先运行 `inspect --input <psd> --json`，检查 `preflight` 中的连通区域、高置信度噪点、保留的疑似绘画细节、成对部件拆分依据和回退数量，再运行 `create --input <psd> [--reference <image>] --output <new-directory> --seed 42 --json`。默认创建会自动清理透明度很低、范围极小且与主体断开的高置信度噪点，同时保留眼睛高光、细发丝和装饰等不确定区域；只有为了诊断才使用 `--preserve-alpha-noise` 保留全部区域，只有用户明确接受可能误删绘画细节时才使用激进的 `--clean-alpha`。这些选项都只作用于输出纹理，复制进项目的源 PSD 不变。参考图必须与 PSD 对应；没有就省略，不得找别的图片代替。`grouped` 或 `minimal` 是保守的可用结果，不是失败。

现有项目只缺少后来新增的多房束、侧脸深度或躯干体积字段时，先运行 `extensions plan --project <directory> [--torso-volume] --json`，确认实际存在可升级的头发和服装图层，再运行 `extensions apply` 写入当前项目的下一条 revision。该流程复用项目已经保存的 PSD、网格、校准和历史，不新建项目；只有源 PSD 本身变化时才使用 `migrate` 创建新目录。

创建后依次运行：

```powershell
node $cli verify --project E:\Puppets\CharacterName --json
node $cli describe --project E:\Puppets\CharacterName --json
node $cli render --project E:\Puppets\CharacterName --output E:\Puppets\CharacterName\reports\agent-baseline --suite calibration --size 960 --focus whole --json
node $cli record --project E:\Puppets\CharacterName --output E:\Puppets\CharacterName\reports\agent-motion --mode autonomous --json
```

`verify.valid` 证明文件和安全约束通过，不能代替视觉检查。Agent 必须实际查看 `pose-sheet.png` 和 `motion-sheet.png`，重点比较中立、左右转、上下看、四个组合方向，以及前后发、呆毛、耳朵、衣摆和尾巴的独立运动。需要检查脸、眼睛或局部轮廓时，把 `--focus` 换成对应部位，并使用 960 或 1200 的 `--size`；局部图会从更高分辨率源图重新渲染和裁切，不是放大低清缩略图。只有确实需要连续时间证据时才运行 `record`，不应拿低清视频代替高清姿态图。需要把主运动冻结后单看惯性时，另运行 `record --mode secondary`；报告中的 `headAndBodyFrozen` 和主运动极值必须证明冻结真实发生。

## 整模与分部自动制作

外部 Agent 的首选制作入口是结构化规格，不是桌面按钮，也不是让软件用关键词猜自然语言。整模先取得与当前 revision 绑定的模板；Agent 看过基线后修改 `goal`、`parts`、数值 `intent` 和每个部位基于画面的非空 `rationale`，保存为 JSON，再做只读计划和执行。CLI 会拒绝原样模板、占位理由、缺少理由、重复部位、越界数值和过期 revision：

```powershell
node $cli agent specification --project E:\Puppets\CharacterName --scope whole --json
node $cli agent plan --project E:\Puppets\CharacterName --spec E:\Puppets\rig-spec-r0.json --json
node $cli agent apply --project E:\Puppets\CharacterName --spec E:\Puppets\rig-spec-r0.json --json
```

规格的 `scope` 会明确保留这是整模任务还是选定部位任务。`--scope whole` 的 `parts` 只包含项目实际存在、需要 Agent 看图填写的部位；计划和最终报告仍会按确定顺序逐项覆盖 13 类职责：`headFace`、`eyes`、`mouth`、`frontHair`、`backHair`、`ahoge`、`ears`、`headwear`、`body`、`topCloth`、`skirt`、`tail` 和 `accessory`。不存在的部位明确报告 `not-present`，整模规格漏掉实际存在的部位则会阻止执行。只调整一个部位时在生成模板时把 scope 换成对应 ID，例如：

```powershell
node $cli agent specification --project E:\Puppets\CharacterName --scope frontHair --json
node $cli agent plan --project E:\Puppets\CharacterName --spec E:\Puppets\front-hair-spec-r0.json --json
node $cli agent apply --project E:\Puppets\CharacterName --spec E:\Puppets\front-hair-spec-r0.json --json
```

模板只是安全起点，不能原样执行。`plan` 不写项目。正式规格计划返回 `inputMode: structured-specification`、当前 `baseRevision`、请求范围、草稿接管情况、各部位目标图层、检查、自动返修、素材请求、`canApply` 和 `blockers`。规格过期或数值越界时应重新看当前画面并生成新规格，不能只改 revision 绕过。确认范围和基线后才运行 `apply`。执行时，每个存在且通过计划的部位单独形成可恢复 revision；最终 JSON 返回总 `status`、from/to revision、各部位结果、最终 `verification`、跨部位 `coherenceChecks`、总 `blockers` 和 `reportPath`。整模任务会声明并检查与实际范围有关的结构约束：头脸、眼睛和头饰必须保持同一转头关系；已有前发制作不得被头脸任务静默清除；上衣与裙子连接处、身体与尾根不得出现相对滑动。任一必需检查失败时，结果会阻断而不是伪装成完成。

`headFace.intent` 除 yaw、pitch 和 perspective 外，还可以填写 `contourStrength`、`depthStrength`、`occlusionFadeStart`、远侧耳朵/侧发的保留透明度，以及 `sideHairDepthSwap`。眼睛与眉毛只通过收窄、位移和轮廓遮挡表达透视，运行时始终保持完全不透明；`farEyeOpacity` 和 `farBrowOpacity` 仅为旧项目格式兼容而保留，制作规格会固定为 1。Agent 应根据左右大角度证据判断其它值：轮廓强度解决脸缘体积，深度强度解决五官和头骨的相对位移，外围遮挡字段解决耳朵或侧发仍完整贴在脸缘外的问题。不要用降低整头转角来掩盖单一遮挡穿帮。

部位状态必须按原义报告：`awaiting-visual-review` 是制作命令成功执行、仍需检查实际造型与动作，`not-present` 是项目没有相应语义图层，`needs-assets` 是实现当前目标确实还缺必要素材，`blocked` 是自检、草稿、修订或最终验证阻止继续。原眼部图层能够通过几何变形闭合时，不因缺少替换用闭眼图片而要求补图。不能新建不存在的假图层，也不能把技术检查通过说成视觉验收通过。

每个成功执行的部位会返回 `focusComparisonSheet`、4×4 `focusMotionSheet` 和用于定位单帧的 `focusMotionManifest`。外部 Agent 必须实际打开前后对比与连续运动接触表：头脸看体积和连接，眼嘴看形状与遮挡，头发和配饰看根部、滞后和回弹，身体与衣服看连接、呼吸和惯性。`verification.valid` 及 13 姿态全绿只证明结构安全，不能替代观感。最终应把这些证据交给用户看；用户反馈“幅度小一点”之类结果时，用同一 scope 再执行，而不是让用户自己拖网格。

`agent front-hair plan/apply`、`agent secondary plan/apply` 和顶层 `--instruction/--scope` 是精确控制或旧调用兼容入口。它们不是正式的自然语言理解边界；理解、看图和决定返修属于外部 Agent。结构化规格无法表达的高层结构才交给下面的 `author inspect/apply`；只剩局部点位问题时才使用稀疏 `calibrate`。

## 标准表演动作与运行中控制

角色缺少可触发动作时先运行 `actions plan`。计划只会使用项目实际存在的眉毛、开眼/闭眼素材、三态嘴形、左右手臂/手、腿/脚、独立耳朵或头饰上的耳部铰点，以及尾巴图层；每个部位都会返回 `completed`、`not-present` 或 `needs-assets`。`actions apply` 以幂等 authoring revision 增加适用的四个表情和点头、摇头、鞠躬、左右观察、双眨眼、短说话、身体弹动、左右挥手、原地踏步、耳朵轻弹和尾巴摇摆。缺少素材的项目不会用透明消失或假图层冒充动作。

```powershell
node $cli actions plan --project E:\Puppets\CharacterName --json
node $cli actions apply --project E:\Puppets\CharacterName --json
```

角色窗口打开后，外部 Agent 通过本机回环服务控制，不需要往产品里增加 Agent 对话框。先 `runtime inspect` 取得 viewer ID 和当前参数、表情、动作，再使用自己的 `source` ID。持续控制必须设置合理 TTL；一次性动作使用 trigger；结束时 release。不同来源按优先级和混合权重合成，摄像头、麦克风和用户快捷键仍可同时工作。

```powershell
node $cli runtime inspect --json
node $cli runtime set --viewer 1 --source agent-demo --head-yaw 0.5 --gaze-x 0.8 --ttl 1000 --json
node $cli runtime trigger --viewer 1 --source agent-demo --behavior action-wave-left --json
node $cli runtime release --viewer 1 --source agent-demo --json
```

需要复现一次输入时用 `runtime record-start/record-stop/replay` 保存控制事件 JSON。它不是成片；用户看到的最终画面由角色窗口的视频按钮录成 WebM。Agent 不应把审计用动态证据、可回放输入和用户表演视频混为一件事。

## AI authoring 闭环

需要增加标准参数之外的表情、局部姿态或变形器时，先读取当前 authoring 图和 revision：

```powershell
node $cli author inspect --project E:\Puppets\CharacterName --json
```

不要直接拼改整份 `puppetloom.json`。`author apply` 接受按顺序执行的高层操作，现支持参数、绑定、旋转/网格变形器、图层挂接、基础图层顺序、表情、参数物理和行为的新增、更新与删除。下面的补丁增加一个笑容参数，并把它绑定到一个图层顶点；实际点位必须来自同一 revision 的 `describe --layer`：

```json
{
  "version": 1,
  "baseRevision": 0,
  "label": "增加笑容控制",
  "operations": [
    {
      "op": "upsert-parameter",
      "parameter": {
        "id": "expression-smile",
        "name": "Smile",
        "group": "Expression",
        "kind": "continuous",
        "min": 0,
        "default": 0,
        "max": 1
      }
    },
    {
      "op": "upsert-binding",
      "binding": {
        "id": "expression-smile-face",
        "parameterIds": ["expression-smile"],
        "target": { "kind": "layer", "id": "layer-000-face" },
        "keyforms": [
          { "values": [0] },
          { "values": [1], "meshPointDeltas": { "12": { "x": 0.004, "y": -0.002 } } }
        ]
      }
    }
  ]
}
```

```powershell
node $cli author apply --project E:\Puppets\CharacterName --patch E:\Puppets\authoring.json --json
```

完整独立图层的遮挡顺序错误使用 `move-layer`：`beforeLayerId` 把目标放到参照层后面，`afterLayerId` 把目标放到参照层前面，二者必须且只能提供一个。操作会重新编号基础绘制顺序并保存为 revision，不改写源 PSD；前后内容已经粘在同一图层时不能用它伪装修复。

```json
{ "op": "move-layer", "layerId": "back-hair", "beforeLayerId": "neck" }
```

操作按数组顺序执行，最终整图一次验证和提交。删除仍被引用的参数、变形器或表情会失败；确实要清理依赖链时必须在对应删除操作中显式写 `"cascade": true`。过期 `baseRevision`、不完整的双参数关键形态网格、循环变形器/物理依赖、越界参数和不存在的目标都不会写入。

绑定会自动把关键形态坐标加入修改前后证据；表情、物理和行为也会自动推导预览。需要指定更有判断价值的姿态时，可在补丁顶层传 `previews`，用 `parameters`、`expressions` 或 `behavior` 驱动预览；物理预览可增加 `settleSeconds`。成功会话的 `patch.authoring` 保留原始高层操作和最终预览，不只保存展开后的模型。

## 校准闭环

先从 `describe` 读取稳定的图层 ID、控制点、轴心、网格规模和当前 revision，再使用 `describe --layer <id> [--revision <n>]` 读取该层完整顶点。每个顶点同时给出 `basePosition`、当前 `position`、相对基准的 `delta`、UV 和九个作用通道；头发层还会返回每条 `hairStrands` 的根梢、置信度、弹簧参数、网格归属和释放数组。补丁中的 `meshPointDeltas` 填写新的完整 delta，不是相对当前画面的二次增量。`alphaTopology.components` 用于发现一个纹理中互不相连的合并部件。只提交需要改变的稀疏字段，不复制整份 `puppetloom.json`。补丁示例：

```json
{
  "baseRevision": 0,
  "label": "固定发根并调整头皮附着和发梢释放",
  "overrides": {
    "layers": {
      "layer-000-front-hair": {
        "vertexInfluences": {
          "pin": { "0": 1 },
          "head": { "0": 0.2 },
          "headAttachment": { "0": 1, "18": 0.15 },
          "physicsRelease": { "0": 0, "18": 0.9 }
        }
      }
    }
  }
}
```

侧脸仍不自然时，优先校准 `runtime.poseField.faceDepthProfile` 的额头、鼻根、鼻尖、上下唇和下巴六点，而不是用全局转角掩盖局部体积问题。`runtime.torsoVolumeProfile` 是完整替换的可选结构，只应在衣服或身体侧转证据确实需要体积时写入；不需要时保持缺省。两种曲线和整条 `hairStrands` 都属于 revision 数据，Agent 必须从当前 `describe` 读取完整结构后再提交，不能只传数组的一部分。

保存与比较：

```powershell
node $cli calibrate --project E:\Puppets\CharacterName --patch E:\Puppets\change.json --json
node $cli compare --project E:\Puppets\CharacterName --from 0 --to 1 --output E:\Puppets\Compare --json
node $cli history --project E:\Puppets\CharacterName --json
```

`baseRevision` 必须来自本轮 `describe` 的 `calibrationRevision`。`calibrate` 会在跨进程租约内重新比较该值，并验证坐标、图层、顶点和 13 个姿态；不安全补丁、证据生成失败或并发冲突都不会推进当前 revision。成功时它自动在项目内生成带哈希清单的修改前后证据。Agent 要查看人物本身，而不是只看差异图：差异图能证明哪里改变了，不能证明改变自然。

如果用户在桌面编辑器中拖动了控制点，Agent 重新运行 `history` 和 `compare` 就能读取精确前后数值并看到对应渲染。用户确认效果后，用 `evidence --session <id> --status accepted --json` 标记；不满意则标记 `rejected`。这只是当前角色的可靠证据，不得因为一次接受就改写所有角色的通用规则。

需要回到旧状态时运行 `restore --revision <n> --base-revision <current> --json`。恢复本身会创建新 revision，因此所有尝试仍可追踪；基线过期时命令拒绝覆盖。用户明确拒绝修改时，应先把对应会话标为 `rejected`，再恢复已接受的 revision，并停止继续猜测。用户想直接操作时运行 `edit --project <directory>`。

## 更新源 PSD

不要替换已有项目的 `source/source.psd` 或 `puppetloom.json`。使用 `migrate --project <old-project> --input <updated.psd> --output <new-project> --json` 创建独立新项目。迁移按完整 `sourcePath` 映射图层；只有画布、图层范围和映射都能证明兼容时才迁移绝对锚点、控制点和稀疏几何。`reports/migration.json` 会列出 `exact`、`geometry-changed`、`missing` 和 `ambiguous`，`reports/migration-patch.json` 保留实际提议。几何变化项必须重新 `describe`、校准和比较，不能因为图层同名就直接套旧顶点。

## 可移植导出

需要交付当前有效修订时，导出到一个尚不存在的新目录：

```powershell
node $cli export --project E:\Puppets\CharacterName --output E:\Puppets\CharacterName-portable --json
```

导出会把当前校准和 authoring 结果烘焙进新的 v4 基线，复制它实际引用的 PSD、参考图和纹理，创建 revision 0 校准并重新执行 `verify`。它不创建压缩包、不覆盖目标目录；来源目录和 revision 记录在 `reports/portable-export.json`。导出失败时未发布副本会保留并返回准确路径，不能把它当成成功交付物。

## Cubism 官方格式交付

需要直接输出 `.cmo3/.moc3` 时，配置 `node scripts/setup-cubism-exporter.mjs` 后运行 `cubism export --project <项目> --output <新目录> --editor-version 5.3 --runtime-version 5.0 --json`。这是完整文件的直接编码路线，不受 Editor API 顶点写入能力限制。结果 `awaiting-visual-review` 只表示等待看图；使用 `scripts/check-native-export.mjs` 检查实际 Core 与导出图集，在目标 Editor 中打开、编辑并另存工程后再报告实际通过范围。

以下为保留的 Editor API 交接流程，适用于已有 Cubism 工程的可写结构同步。External API 1.1.0 当前不能写 ArtMesh 顶点或 Warp 控制点；这条路线的 `strictReady: false` 表示完整同步条件尚未成立，即使 `finalize` 后的目录结构通过验证也一样。

```powershell
node $cli cubism plan --project E:\Puppets\CharacterName --json
node $cli cubism handoff --project E:\Puppets\CharacterName --output E:\Puppets\CharacterName-cubism-handoff --json
node $cli cubism editor inspect --json
node $cli cubism editor validate --project E:\Puppets\CharacterName --stage pre-sync --json
node $cli cubism editor preview --project E:\Puppets\CharacterName --pose left --json
node $cli cubism editor sync --project E:\Puppets\CharacterName --json
node $cli cubism editor validate --project E:\Puppets\CharacterName --stage post-sync --json
node $cli cubism finalize --project E:\Puppets\CharacterName --editor-model E:\CubismExport\CharacterName.model3.json --output E:\Puppets\CharacterName-cubism --json
node $cli cubism verify --model E:\Puppets\CharacterName-cubism\CharacterName.model3.json --json
```

AI 必须交付并保留 handoff 的 revision、指纹、阻断清单和 Editor checklist，再确认 Allow/Edit、API 版本、Modeling 模式和当前模型 UID。严格模式的阻断项不能擅自改成 `--allow-partial`；只有用户明确接受剩余网格要在 Editor 中制作时才可使用该选项。事务失败会自动回滚。post-sync 校验能证明参数和同名对象覆盖，不能证明官方 API 读不到的顶点视觉等价。最终还要在 Cubism Viewer 中检查中立、左右、上下、眨眼、嘴部和物理，不能把文件头与引用检查当成视觉验收。完整边界见 [Cubism 官方格式桥接](CUBISM_BRIDGE.md)。

## 真实角色批量回归

新增真实角色时不要把授权不明的素材复制进仓库。按 [真实角色基准库](../benchmarks/real-characters/README.md) 登记项目路径、素材用途、revision、难点标签和该角色应保持的门槛，再运行 `benchmark validate/run`。结果中的项目指纹用于防止换了 revision 仍沿用旧结论；空清单的 `readyForMaterials: true` 只表示基础设施已就绪，不表示已经有真实角色通过。

## 应该改哪里

- 只在一个角色上出现，且可由控制点、轴心、网格或权重解决：保存项目校准。
- 多个结构相似角色重复出现，自动结果方向一致地错误：修改 PuppetLoom 算法，加入通用夹具和视觉回归测试。
- Agent 经常选错命令、跳过视觉检查或把局部校准误当通用知识：在用户确认后改进 `live2d-puppet` Skill。

不要直接编辑 `puppetloom.json`，不要绕过安全缩放，不要为了“更多动作”凭空生成未知脸部内容。左右转头需要检查近大远小、两侧眼角和脸缘关系；上下看是俯视/仰视，不是整颗头上下平移；头、脖子和上半身是结构连接，前后发、呆毛、耳朵、裙摆和尾巴才有独立惯性。视频参考用于学习关系，除非用户明确要求，不把视频复制进项目运行素材。

## 可选补充素材

`requests/asset-requests.json` 中的闭眼和嘴形请求不阻塞可动结果。若使用图像模型，必须提供对应裁切。不要相信提示词能直接保证透明通道：先验证文件 Alpha；不透明结果要按纯色背景抠图，再交给 `enhance`。只有 `accepted` 的素材算接入成功，失败文件不能覆盖安全回退。

## 运行和退出码

`play --project <directory> [--revision <n>]` 打开透明角色窗口；鼠标穿透后按 `Ctrl+Shift+P` 恢复。`record` 每次启动独立隐藏进程并在报告中记录基础项目 SHA-256、目标 revision、启动时当前 revision 和窗口比例，不能拿没有这些字段的旧视频代替当前证据。退出码 0 表示命令或任一安全绑定成功，2 表示输入/补丁无效，3 表示文件系统、项目结构或运行时错误。成功 JSON 在标准输出，结构化错误在标准错误，不能混合解析。
## 区域修形与构建身份

开始调用前运行 `capabilities --json`，检查 `build.current`、构建指纹和当前命令列表。项目内 `invoke_puppetloom.ps1` 会检查并构建过旧的 CLI；独立安装的 Skill 通过 `PUPPETLOOM_ROOT` 指向源码根，可用 `PUPPETLOOM_NODE` 明确 Node 路径。构建只覆盖 CLI、core、renderer；桌面进程、输入设备和 Cubism 仍由各自运行时检查负责。

`author geometry --project <目录> --binding <绑定ID> --values 1,0 --offset 0 --limit 64 --json` 返回准确 revision 和至多 256 个点。也可单独用 `--layer` 或 `--deformer` 检查中性控制点。这里的坐标是父级变换之前的归一化画布坐标，不是最终屏幕位置；不将采样网格称为原生贝塞尔控制点。

通过现有 `author apply --patch` 提交 `transform-keyform`：指定 `bindingId`、已有关键形的 `values`、`coordinateSpace: "rest-canvas"`、`selection` 和 1–32 个有序 `transforms`。选区可为 all、indices、rect、circle 或 line；rect/circle/line 的 `feather` 为 0–1 的内侧柔化比例。选区始终按中性点固定，不因前一步变形改变归属。translate 的 delta、scale/rotate 的 origin、circle/line 的坐标均使用同一空间；rotate 的 degrees 为顺时针角度。bend 的 axis 表示位移方向，曲线沿另一轴展开，由 center、halfSpan 和 amount 定义。smooth 平滑位移而非原始轮廓，默认保留外边界与孔洞边界。

需要新增关键值时，使用 `insert-binding-key`，提供 `bindingId`、`parameterId` 和 `value`。二维绑定自动插入完整一行或一列，使用运行时插值保留现有运动；随后可在同一事务内修形。一次操作只编辑指定绑定的关键形，完整姿态仍由现有渲染与校准证据检查。合法但没有改变最终项目状态的提交不会创建新 revision。

例如，已存在的单参数绑定 `hair-turn` 在值 1 的关键形，可使用以下操作把圆形选区内的点向右平移；绑定 ID、坐标和 baseRevision 应先从当前项目读取，不能照抄示例值：

```json
{"version":1,"baseRevision":3,"operations":[{"op":"transform-keyform","bindingId":"hair-turn","values":[1],"coordinateSpace":"rest-canvas","selection":{"kind":"circle","center":{"x":0.5,"y":0.35},"radius":0.1,"feather":0.3},"transforms":[{"kind":"translate","delta":{"x":0.01,"y":0}}]}]}
```

校准会话中的 `authoring.changes` 记录实际新增、移除或修改的对象及字段；例如移动一个图层时会列出所有绘制顺序实际变化的关联图层。对象字段的 JSON 排列变化不会被误报为内容变化。

## 已配准补件

依次调用 `assets reference --project <目录> --layer <模板ID> --json`、`assets register --project <目录> --reference <ID> --image <PNG> --registration <JSON> --json`、`assets preview --project <目录> --assembly <JSON> --json` 和 `assets apply --project <目录> --plan <ID> --json`。参考返回原素材、整模上下文、标注图和源画布像素框；登记保留原始 PNG，通过明确画框或对应锚点配准，不负责生成图像或去底。

frame 配准 JSON 的例子是 `{"kind":"frame","generatedRect":{"x":10,"y":14,"width":200,"height":300},"sourceRect":{"x":100,"y":80,"width":100,"height":150}}`；前者是输入 PNG 的像素框，后者是源画布目标框，必须用实际测量值。试装 JSON 为 `{"baseRevision":3,"additions":[{"registrationId":"<登记返回的ID>","layerId":"new-hair"}],"replaceLayerIds":["<旧图层ID>"]}`。

新增图层继承模板父级、已有中性修形、重投影的关键形和运动权重。试装不改变当前 revision；应用检查版本、内容和原始素材哈希，再进入现有校准事务。原图层只隐藏，回退用 `restore`。必须查看整模中性、转向和次级运动证据；同一张补件单独看起来正确，不证明组合成立。详细操作判断见 [补件与局部修形](../skills/live2d-puppet/references/asset-and-geometry-workflow.md)。
