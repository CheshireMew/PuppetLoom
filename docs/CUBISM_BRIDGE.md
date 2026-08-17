# Cubism 官方格式桥接

PuppetLoom 现在可以生成和合并公开的 Cubism 3 JSON 文件，连接 Cubism Editor External API，同步官方 API 确实允许写入的结构，并把 Editor 官方导出的 `.moc3` 整理成可验证的 `.model3.json` 运行时目录。`.moc3` 仍必须由 Live2D Cubism Editor 生成：Cubism Core 是官方二进制读取运行库，不是公开的 moc3 编译器；PuppetLoom 不伪造该文件，也不会把“参数已创建”报告成“网格已经转换”。

这条边界来自 Live2D 的[模型文件说明](https://docs.live2d.com/en/cubism-sdk-manual/model-web/)、[Cubism Core 说明](https://docs.live2d.com/en/cubism-sdk-manual/cubism-core/)和 [External API 1.1.0 手册](https://cubism.live2d.com/editor-alpha/doc/manual/alpha1/ja/external-api-intergration/index.html)。

## 实际支持范围

| 内容 | PuppetLoom 的处理 | 验收含义 |
| --- | --- | --- |
| `.model3.json` | 读取 Editor 导出文件，保留原引用并合并 PuppetLoom 侧车 | 验证 Version、路径边界和全部引用 |
| `.moc3` | 只接受并复制 Editor 官方导出文件 | 检查 `MOC3` 文件头；不自行编译 |
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
node $cli cubism prepare --project E:\Puppets\MyCharacter --output E:\Puppets\MyCharacter-cubism-work --json
```

`plan.strictReady` 只有在没有阻断项时才为 `true`。`prepare` 始终可以生成映射和侧车供检查，但不会生成 `.moc3`。输出中的 `puppetloom/cubism-bridge.json` 记录源 revision、全部映射、覆盖数量和限制。

在 Cubism Editor 中从同一 PSD 建立或打开建模文件，保持 ArtMesh 名称与 PSD 图层名一致，然后在“文件 → 外部应用程序集成的设置”中启用服务。首次连接时授予 Allow；结构同步还要授予 Edit。先检查连接：

```powershell
node $cli cubism editor inspect --json
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

`finalize` 不改 Editor 导出目录，也不覆盖已有目标。它把全部原引用复制到旁路暂存目录，合并 PuppetLoom 侧车，验证通过后才一次性发布。失败时会返回并保留暂存目录，方便检查；它不会删除任何文件。

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
