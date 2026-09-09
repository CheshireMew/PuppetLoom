# Cubism 导出与 Editor 桥接

PuppetLoom 提供两条独立路线。`cubism export` 通过与 PSD2Live 相同的 Umamo 编码器，直接输出可编辑 `.cmo3`、`.moc3` 和运行时配套文件；`cubism prepare/editor/finalize` 保留原有 Editor External API 交接流程。直接导出不要求 Editor API 提供顶点写入接口。

## 直接导出

首次配置 Java 21+ 和固定版本的转换依赖，然后构建 CLI：

```powershell
node scripts/setup-cubism-exporter.mjs
npm run build -w @puppetloom/core
npm run build -w @puppetloom/cli
node apps/cli/dist/index.js cubism export --project E:\Puppets\Character --output E:\Puppets\Character-cubism --editor-version 5.3 --runtime-version 5.0 --json
```

可用 `--java`、`--libs`、`--compiler` 和 `--cache` 指定配置位置；默认下载缓存位于 D 盘。依赖及编译器都有 SHA-256 校验，转换器源码变化后必须重新配置。仓库不包含上游 JAR、官方 Core 或角色导出文件。

桌面“导出中心”的 CMO3/MOC3 按钮调用同一核心实现。工程格式与运行时格式独立选择：工程 `5.3` 使用 Editor 5.3.01 保存结构核对过的格式，`5.4` 保留上游原生格式；运行时支持 `4.2`、`5.0`、`5.3`。默认 `5.3 / 5.0`。工程 5.3 处理会核对并移除 5.4 的空状态集和默认图集锁，调整对应类版本；遇到非空新功能就报错，不能通过改文件头伪装降级。它只适用于本导出器新建的工程，不是任意 CMO3 的降级工具。

输出包含 `model.cmo3`、`model.moc3`、`model.model3.json`、`textures`、表情/动作/物理/显示信息侧车、`puppetloom-source` 和 `export-status.json`。源项目 revision 和内容指纹会记录并复查。目录必须不存在，有草稿时拒绝导出。纹理按 PSD2Live 的方式组成保留原像素的二次幂图集；程序化变形和绑定组合被采样为可编辑网格关键形，检查中间插值并在超限时报错。

参数与图层 ID 通过报告中的稳定映射保留关联，去除 Editor 不接受的字符；数值单位放大 100 倍，配套动作、表情和物理同步映射。这样避免官方 Core 的绝对 0.001 关键点吸附吞掉密集的局部变化。原程序化变形器层级不会原样保留；源 PSD 的完整分组和未使用图层也不等于合成后的 CMO3 原画结构。双素材嘴型在原参数 `.498..5` 的极短区间过渡。源项目本身的造型问题不会因为导出而自动改善。

成功写文件的状态是 `awaiting-visual-review`，不能据此声称画面通过。可选的本地官方 Core 检查：

```powershell
$env:CUBISM_EDITOR_HOME = 'D:\Software\Work\Live2D Cubism 5.3'
node scripts/check-native-export.mjs E:\Puppets\Character-cubism E:\Puppets\Character
```

它比较九向、眨眼阶段、参数端点及组合姿态的顶点/透明度/UV/拓扑，并使用实际导出图集生成与源项目的对照图。CMO3 还需在目标 Editor 打开、检查及另存，再从 Editor 导出 MOC3。在上述命令末尾追加该 `model3.json` 路径，会在 `qa-editor` 中检查编辑器重新导出的结果。此检查使用本工程原图集布局；若手工重排图集，不能继续用原 UV 做逐值对照。几何与文件引用校验不能替代画面检查。

CMO3 的原画网格按纹理 UV 与图层原始范围建立，默认姿态的造型也保存在关键形中，避免编辑器从非线性变形后的网格反推贴图位置。首次打开上游编码器生成的工程可能显示“免费版本中创建”信息；这与“高版本创建”兼容性提示不同。

## 原有 Editor API 交接路线

这条边界来自 Live2D 的[模型文件说明](https://docs.live2d.com/en/cubism-sdk-manual/model-web/)、[Cubism Core 说明](https://docs.live2d.com/en/cubism-sdk-manual/cubism-core/)和 [External API 1.1.0 手册](https://cubism.live2d.com/editor-alpha/doc/manual/alpha1/ja/external-api-intergration/index.html)。

## 实际支持范围

| 内容 | PuppetLoom 的处理 | 验收含义 |
| --- | --- | --- |
| `.model3.json` | 读取 Editor 导出文件，保留原引用并合并 PuppetLoom 侧车 | 验证 Version、路径边界和全部引用 |
| `.moc3` | `finalize` 接受并复制 Editor 官方导出文件 | 检查 `MOC3` 文件头；直接编码见上文 `export` |
| `.exp3.json` | 从命名表情生成 | 以默认值为基准生成 Add 差值 |
| `.motion3.json` | 从行为轨道生成 | 支持 linear、hold 和 smoothstep 对应曲线 |
| `.physics3.json` | 把参数弹簧转换为两粒子近似并与现有物理合并 | 必须在 Viewer 中复核幅度和响应 |
| `.cdi3.json` | 生成参数显示信息并与现有显示信息合并 | 不丢失 Editor 原有参数、分组和部件说明 |
| Editor 参数与属性 | 通过 External API 事务同步 | 任一步失败时 `EditEnd { Cancel: true }` 回滚 |
| ArtMesh 顶点、Warp 控制点 | 当前官方 API 没有写入接口 | 严格模式阻止“完整同步”结论 |

External API 1.1.0 能增删参数、部件和变形器，添加参数关键点，并按关键点编辑 ArtMesh、部件和变形器公开属性；它没有写入 ArtMesh 顶点坐标或 Warp 控制点坐标的操作。因此 PuppetLoom 可以自动搭好参数和可写结构，但程序化转头、面部表面和网格关键形态若依赖逐顶点位移，仍需 Live2D 增加官方写入接口，或者由用户在 Cubism Editor 中完成对应网格建模。

## 版本要求

本机现有 Cubism Editor 5.3.03 可以使用 `editor inspect`、`editor preview`、`editor clear-preview`、`verify` 和 `open`。结构修改需要 Cubism Editor 5.4 alpha 或后续包含 External API 1.1.0 的版本。5.4 alpha 是限期评估版本，数据与稳定版兼容性和到期时间以 Live2D 的[官方 5.4 alpha 公告](https://www.live2d.com/en/information/cubism-5_4-alpha/)为准；PuppetLoom 不自动下载安装、不替用户接受许可，也不随仓库分发 Cubism Core 或 SDK。

## 完整工作流

先构建并分析当前有效修订：

```powershell
$cli = "E:\Code\PuppetLoom\apps\cli\dist\index.js"
node $cli cubism plan --project E:\Puppets\MyCharacter --json
node $cli cubism handoff --project E:\Puppets\MyCharacter --output E:\Puppets\MyCharacter-cubism-work --json
```

`plan.strictReady` 只有在没有阻断项时才为 `true`。`handoff` 与兼容命令 `prepare` 都可以生成映射和侧车供检查，但不会生成 `.moc3`。输出中的 `puppetloom/handoff.json` 锁定项目绝对路径、revision、内容指纹、源 PSD、阻断项和完整命令；`HANDOFF.md` 供人阅读，`editor-checklist.json` 逐项区分 PuppetLoom、Editor 和操作者的责任。清单初始状态都是 pending，不会因为文件已生成就假装人工步骤已经完成。

在 Cubism Editor 中从同一 PSD 建立或打开建模文件，保持 ArtMesh 名称与 PSD 图层名一致，然后在“文件 → 外部应用程序集成的设置”中启用服务。首次连接时授予 Allow；结构同步还要授予 Edit。先检查连接：

```powershell
node $cli cubism editor inspect --json
node $cli cubism editor validate --project E:\Puppets\MyCharacter --stage pre-sync --json
```

5.3 可以用参数临时缓存检查标准映射，不改变模型文件：

```powershell
node $cli cubism editor preview --project E:\Puppets\MyCharacter --pose left --json
node $cli cubism editor preview --project E:\Puppets\MyCharacter --pose blink --json
node $cli cubism editor clear-preview --json
```

使用支持 1.1.0 的 Editor 后执行同步：

```powershell
node $cli cubism editor sync --project E:\Puppets\MyCharacter --json
```

默认是严格模式。只要项目包含官方 API 不能写入的网格或程序化变形，它就会在 `EditBegin` 前停止。`--allow-partial` 只适合明确接受“建立参数和可写属性，网格仍需手工完成”的场景；返回结果中的 `partial: true` 和 warnings 必须保留在交付记录里。

`editor validate` 在同步前检查 Allow/Edit 授权、External API 1.1.0、Modeling 模式、每个 PSD 图层是否只有一个同名 ArtMesh，以及已有参数是否发生范围冲突；缺失参数在 pre-sync 阶段只是待自动创建项。同步和人工补形后再执行 `--stage post-sync`，此时缺失参数会成为阻断项。官方 API 无法读取并证明顶点视觉等价，因此报告会一直把相关绑定列在 `manualGeometryReviewRequired`，除非项目本身没有这类内容；这部分只能由 Editor 中的人工视觉签核完成。

同步完成并人工补齐网格后，由 Cubism Editor 使用官方“导出嵌入数据”功能生成 `.moc3`、纹理和 `.model3.json`。最后从该 model3 生成一个新目录：

```powershell
node $cli cubism finalize `
  --project E:\Puppets\MyCharacter `
  --editor-model E:\CubismExport\MyCharacter.model3.json `
  --output E:\Puppets\MyCharacter-cubism-runtime `
  --json

node $cli cubism verify --model E:\Puppets\MyCharacter-cubism-runtime\MyCharacter.model3.json --json
node $cli cubism open --model E:\Puppets\MyCharacter-cubism-runtime\MyCharacter.model3.json
```

`finalize` 不改 Editor 导出目录，也不覆盖已有目标。它把全部原引用复制到旁路暂存目录，合并 PuppetLoom 侧车，验证通过后才一次性发布，并写入 `puppetloom/official-runtime-verification.json` 记录来源 revision、Editor 真源和验证结果。失败时会返回并保留暂存目录，方便检查；它不会删除任何文件。

## 标准参数映射

| PuppetLoom 语义 | Cubism ID | 换算 |
| --- | --- | --- |
| head-yaw / pitch / roll | `ParamAngleX/Y/Z` | `value × 30` |
| body-sway / pitch / roll | `ParamBodyAngleX/Y/Z` | `value × 10` |
| gaze-x / gaze-y | `ParamEyeBallX/Y` | 原值 |
| breath | `ParamBreath` | 负值裁到 0 |
| blink | `ParamEyeLOpen`、`ParamEyeROpen` | `1 - value` |
| mouth-open | `ParamMouthOpenY` | 原值 |

自定义参数使用稳定的 `ParamPuppetLoom...` ID。同步前会读取 Editor 已有参数；同 ID 的范围、默认值不一致时严格模式停止，不会静默改写现有模型。

## 验证边界

`cubism verify` 是结构验证：它检查 model3 Version 3、引用不能逃出运行时目录、文件存在、JSON 可解析、纹理可解码，以及 moc3 具有 `MOC3` 文件头。它不能证明 moc3 内部的参数、顶点和变形与 PuppetLoom 视觉等价，也不能替代 Cubism Core 实际加载和 Viewer 视觉检查。

最终交付至少需要同时满足：`verify.valid === true`、`plan.strictReady === true` 或有明确接受的 partial 记录、Cubism Viewer 能正常打开，以及中立、左右、上下、眨眼、嘴部和物理动作经过人工视觉复核。

授权 Token 默认保存在 `%LOCALAPPDATA%\PuppetLoom\cubism-editor-token.txt`，JSON 输出不会包含 Token。可以用 `--token-file` 指定其它位置。每次 Editor 重启后，是否需要重新勾选授权以 Editor 当前行为为准。
