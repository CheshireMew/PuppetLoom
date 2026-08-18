# Agent 调用说明

Codex 一类外部 Agent 通过 CLI 完成从 PSD 到可运行角色的工作，并用同一修订与证据接口和用户协作。软件负责格式、结构化规格验证、确定性制作、渲染、安全收敛和历史；外部 Agent 负责理解自然语言、选择整模或分部范围、观察实际证据、判断是否继续调整，以及把“当前角色校准”和“通用算法缺陷”分开。桌面应用只负责创建、查看、播放和人工兜底，不内嵌 Agent 对话或编排。

下面用 `$cli = "E:\Code\PuppetLoom\apps\cli\dist\index.js"` 表示入口。

## 从零创建

先运行 `inspect --input <psd> --json`，再运行 `create --input <psd> [--reference <image>] --output <new-directory> --seed 42 --json`。参考图必须与 PSD 对应；没有就省略，不得找别的图片代替。`grouped` 或 `minimal` 是保守的可用结果，不是失败。

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

部位状态必须按原义报告：`completed` 是已经写入并产生证据，`not-present` 是项目没有相应语义图层，`needs-assets` 是闭眼或嘴形等可选素材尚缺，`blocked` 是自检、草稿、修订或最终验证阻止继续。不能新建不存在的假图层，也不能把缺素材或不存在说成制作完成。

每个已完成部位会返回 `focusComparisonSheet`、4×4 `focusMotionSheet` 和用于定位单帧的 `focusMotionManifest`。外部 Agent 必须实际打开前后对比与连续运动接触表：头脸看体积和连接，眼嘴看形状与遮挡，头发和配饰看根部、滞后和回弹，身体与衣服看连接、呼吸和惯性。`verification.valid` 及 13 姿态全绿只证明结构安全，不能替代观感。最终应把这些证据交给用户看；用户反馈“幅度小一点”之类结果时，用同一 scope 再执行，而不是让用户自己拖网格。

`agent front-hair plan/apply`、`agent secondary plan/apply` 和顶层 `--instruction/--scope` 是精确控制或旧调用兼容入口。它们不是正式的自然语言理解边界；理解、看图和决定返修属于外部 Agent。结构化规格无法表达的高层结构才交给下面的 `author inspect/apply`；只剩局部点位问题时才使用稀疏 `calibrate`。

## AI authoring 闭环

需要增加标准参数之外的表情、局部姿态或变形器时，先读取当前 authoring 图和 revision：

```powershell
node $cli author inspect --project E:\Puppets\CharacterName --json
```

不要直接拼改整份 `puppetloom.json`。`author apply` 接受按顺序执行的高层操作，现支持参数、绑定、旋转/网格变形器、图层挂接、表情、参数物理和行为的新增、更新与删除。下面的补丁增加一个笑容参数，并把它绑定到一个图层顶点；实际点位必须来自同一 revision 的 `describe --layer`：

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

操作按数组顺序执行，最终整图一次验证和提交。删除仍被引用的参数、变形器或表情会失败；确实要清理依赖链时必须在对应删除操作中显式写 `"cascade": true`。过期 `baseRevision`、不完整的双参数关键形态网格、循环变形器/物理依赖、越界参数和不存在的目标都不会写入。

绑定会自动把关键形态坐标加入修改前后证据；表情、物理和行为也会自动推导预览。需要指定更有判断价值的姿态时，可在补丁顶层传 `previews`，用 `parameters`、`expressions` 或 `behavior` 驱动预览；物理预览可增加 `settleSeconds`。成功会话的 `patch.authoring` 保留原始高层操作和最终预览，不只保存展开后的模型。

## 校准闭环

先从 `describe` 读取稳定的图层 ID、控制点、轴心、网格规模和当前 revision，再使用 `describe --layer <id> [--revision <n>]` 读取该层完整顶点。每个顶点同时给出 `basePosition`、当前 `position`、相对基准的 `delta`、UV 和七个作用通道；补丁中的 `meshPointDeltas` 填写新的完整 delta，不是相对当前画面的二次增量。`alphaTopology.components` 用于发现一个纹理中互不相连的合并部件。只提交需要改变的稀疏字段，不复制整份 `puppetloom.json`。补丁示例：

```json
{
  "baseRevision": 0,
  "label": "固定呆毛根部并降低头部作用",
  "overrides": {
    "layers": {
      "layer-000-front-hair": {
        "vertexInfluences": {
          "pin": { "0": 1 },
          "head": { "0": 0.2 }
        }
      }
    }
  }
}
```

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

导出会把当前校准和 authoring 结果烘焙进新的 v3 基线，复制它实际引用的 PSD、参考图和纹理，创建 revision 0 校准并重新执行 `verify`。它不创建压缩包、不覆盖目标目录；来源目录和 revision 记录在 `reports/portable-export.json`。导出失败时未发布副本会保留并返回准确路径，不能把它当成成功交付物。

## Cubism 官方格式交付

需要 `.moc3/.model3.json` 时先运行 `cubism plan`，不能直接承诺“已兼容”。`.moc3` 只能由 Cubism Editor 官方导出；External API 1.1.0 当前不能写 ArtMesh 顶点或 Warp 控制点。`strictReady: false` 表示视觉等价尚未成立，即使 `finalize` 后的目录结构通过验证也一样。

```powershell
node $cli cubism plan --project E:\Puppets\CharacterName --json
node $cli cubism editor inspect --json
node $cli cubism editor preview --project E:\Puppets\CharacterName --pose left --json
node $cli cubism editor sync --project E:\Puppets\CharacterName --json
node $cli cubism finalize --project E:\Puppets\CharacterName --editor-model E:\CubismExport\CharacterName.model3.json --output E:\Puppets\CharacterName-cubism --json
node $cli cubism verify --model E:\Puppets\CharacterName-cubism\CharacterName.model3.json --json
```

AI 必须先确认 Allow/Edit、API 版本、Modeling 模式和当前模型 UID，再同步。严格模式的阻断项不能擅自改成 `--allow-partial`；只有用户明确接受剩余网格要在 Editor 中制作时才可使用该选项。事务失败会自动回滚。最终还要在 Cubism Viewer 中检查中立、左右、上下、眨眼、嘴部和物理，不能把文件头与引用检查当成视觉验收。完整边界见 [Cubism 官方格式桥接](CUBISM_BRIDGE.md)。

## 应该改哪里

- 只在一个角色上出现，且可由控制点、轴心、网格或权重解决：保存项目校准。
- 多个结构相似角色重复出现，自动结果方向一致地错误：修改 PuppetLoom 算法，加入通用夹具和视觉回归测试。
- Agent 经常选错命令、跳过视觉检查或把局部校准误当通用知识：在用户确认后改进 `live2d-puppet` Skill。

不要直接编辑 `puppetloom.json`，不要绕过安全缩放，不要为了“更多动作”凭空生成未知脸部内容。左右转头需要检查近大远小、两侧眼角和脸缘关系；上下看是俯视/仰视，不是整颗头上下平移；头、脖子和上半身是结构连接，前后发、呆毛、耳朵、裙摆和尾巴才有独立惯性。视频参考用于学习关系，除非用户明确要求，不把视频复制进项目运行素材。

## 可选补充素材

`requests/asset-requests.json` 中的闭眼和嘴形请求不阻塞可动结果。若使用图像模型，必须提供对应裁切。不要相信提示词能直接保证透明通道：先验证文件 Alpha；不透明结果要按纯色背景抠图，再交给 `enhance`。只有 `accepted` 的素材算接入成功，失败文件不能覆盖安全回退。

## 运行和退出码

`play --project <directory> [--revision <n>]` 打开透明角色窗口；鼠标穿透后按 `Ctrl+Shift+P` 恢复。`record` 每次启动独立隐藏进程并在报告中记录基础项目 SHA-256、目标 revision、启动时当前 revision 和窗口比例，不能拿没有这些字段的旧视频代替当前证据。退出码 0 表示命令或任一安全绑定成功，2 表示输入/补丁无效，3 表示文件系统、项目结构或运行时错误。成功 JSON 在标准输出，结构化错误在标准错误，不能混合解析。
