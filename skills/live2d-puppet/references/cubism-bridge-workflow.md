# Cubism 官方格式桥接

这条流程用于把 PuppetLoom 项目交给 Live2D Cubism 官方运行时，不替代 PuppetLoom 自身项目，也不绕过 Cubism Editor。公开 JSON 可以由 PuppetLoom 生成、合并和检查；专有 `.moc3` 必须由 Cubism Editor 官方导出。Cubism Core 是读取运行库，不是公开的 moc3 编译器。

## 能力和停止边界

PuppetLoom 可以生成 `.exp3.json`、`.motion3.json`、`.physics3.json` 和 `.cdi3.json`，读取并合并 Editor 导出的 `.model3.json`，复制其 moc、纹理和其它引用，并检查引用边界、缺失文件、JSON、纹理解码和 `MOC3` 文件头。它也可以连接 Editor External API，读取授权、模型、参数和对象，在一个可回滚事务中同步参数、参数关键点及 API 公开的 ArtMesh/变形器属性。

External API 1.1.0 当前没有写入 ArtMesh 顶点坐标或 Warp 控制点坐标的操作，也不能完整表达 PuppetLoom 的程序化面部表面、网格位移、平移和非等比缩放。遇到这些内容时，`plan` 必须输出 blocking issue，默认同步在 `EditBegin` 前停止。不能把“参数已经创建”“model3 引用有效”或“MOC3 文件头存在”说成网格已经转换或视觉已经等价。

`--allow-partial` 会同步仍可写的参数和属性，同时留下网格由用户在 Editor 中完成。只有用户明确接受这个结果边界时才使用；返回的 `partial: true`、blocking 和 warnings 进入交付记录，不能在汇报时省略。

## 版本、授权和输入

结构同步要求 Editor 支持 External API 1.1.0；当前对应 Cubism Editor 5.4 alpha 或后续提供同一 API 的版本。5.3.03 可以检查连接、读取参数、临时预览、清除预览、验证文件和打开 Viewer，但不能执行 1.1.0 结构编辑。先用 `editor inspect` 读取实际能力，不只根据安装目录猜版本。

首次连接需要在 Editor 的“外部应用程序集成的设置”中启用服务并授予 Allow；结构同步还要授予 Edit，当前模型必须处于 Modeling 模式。PuppetLoom 不自动安装 Editor/SDK、不替用户接受许可，也不分发 Cubism Core。授权 Token 默认属于 `%LOCALAPPDATA%\PuppetLoom\cubism-editor-token.txt`，CLI JSON 不输出 Token；用户需要其它位置时传 `--token-file`。

桥接的必要输入是一个已经验证的 PuppetLoom 项目。最终导出还需要 Cubism Editor 从对应角色正式导出的 `.model3.json`、`.moc3`、纹理及其侧车。ArtMesh 最好与原 PSD 图层同名；名称不能唯一匹配时严格同步停止，不猜目标对象。

## 先分析，不先承诺

统一通过包装脚本调用：

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 cubism plan --project E:\Puppets\Character --json
& <skill>\scripts\invoke_puppetloom.ps1 cubism prepare --project E:\Puppets\Character --output E:\Puppets\Character-cubism-work --json
```

`plan` 不写文件，先读取当前有效 revision，返回参数映射、binding 覆盖、expression/motion/physics 数量和 issues。`strictReady: true` 只表示当前 PuppetLoom 内容没有已知 blocking；它仍不代替 Editor 导出和 Viewer 检查。`prepare` 输出必须是尚不存在的新目录，生成映射、兼容报告和 JSON 侧车，不生成 `.moc3`。`puppetloom/cubism-bridge.json` 是本次桥接记录。

只要用户问“能否兼容”或“还缺什么”，运行 `plan` 后解释实际覆盖即可，不需要先启动 Editor。只有用户要求检查一个已有官方运行时文件时，可以直接运行 `cubism verify --model <model3.json> --json`；这不需要 PuppetLoom 项目。

## Editor 检查和参数预览

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 cubism editor inspect --json
& <skill>\scripts\invoke_puppetloom.ps1 cubism editor preview --project E:\Puppets\Character --pose left --json
& <skill>\scripts\invoke_puppetloom.ps1 cubism editor preview --project E:\Puppets\Character --pose blink --json
& <skill>\scripts\invoke_puppetloom.ps1 cubism editor clear-preview --json
```

`inspect` 的 `approved`、`editApproved`、`editApiAvailable`、`modelUid`、`editMode`、parameters、objects 和 warnings 决定下一步。`preview` 使用稳定的 `SetParameterValues` 临时缓存，可检查 `neutral/left/right/up/down/blink/mouth`，不修改模型文件；检查完成后运行 `clear-preview`。

## 严格事务同步

支持 API 1.1.0 且权限、模式和当前模型都正确后运行：

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 cubism editor sync --project E:\Puppets\Character --json
```

同步前再次读取计划和 Editor 当前结构。同 ID 参数范围或默认值不一致、目标 ArtMesh 不能唯一匹配、项目包含不可写几何或程序化变形时，严格模式停止，不静默改写。真正写入时全部操作位于一个 `EditBegin/EditEnd` 事务；任一步失败以 `EditEnd { Cancel: true }` 回滚。成功结果记录 applied/skipped operations，失败不能靠部分 Editor 状态冒充完成。

## 标准参数映射

| PuppetLoom 语义 | Cubism 参数 | 换算 |
| --- | --- | --- |
| head-yaw / head-pitch / head-roll | `ParamAngleX/Y/Z` | 原值乘 30 |
| body-sway / body-pitch / body-roll | `ParamBodyAngleX/Y/Z` | 原值乘 10 |
| gaze-x / gaze-y | `ParamEyeBallX/Y` | 原值 |
| breath | `ParamBreath` | 负值裁到 0 |
| blink | `ParamEyeLOpen`、`ParamEyeROpen` | `1 - value` |
| mouth-open | `ParamMouthOpenY` | 原值 |

自定义参数使用稳定的 `ParamPuppetLoom...` ID。命名表情以默认值为基准生成 Add 差值；行为轨道生成 motion 曲线；PuppetLoom 参数弹簧只能转换成 physics3 的近似，必须在 Viewer 中复核幅度和响应。

## Editor 导出后的最终目录

同步并人工补齐不可写网格后，由 Cubism Editor 使用官方导出生成 moc、model3 和纹理。不要用占位 moc 或手写二进制替代。然后整理到一个尚不存在的新目录：

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 cubism finalize `
  --project E:\Puppets\Character `
  --editor-model E:\CubismExport\Character.model3.json `
  --output E:\Puppets\Character-cubism-runtime `
  --json

& <skill>\scripts\invoke_puppetloom.ps1 cubism verify --model E:\Puppets\Character-cubism-runtime\Character.model3.json --json
& <skill>\scripts\invoke_puppetloom.ps1 cubism open --model E:\Puppets\Character-cubism-runtime\Character.model3.json
```

`finalize` 不改 Editor 导出目录、不覆盖现有目标。它在旁路暂存目录复制全部原引用，合并 PuppetLoom expression、motion、physics 和 display-info，通过结构验证后才发布；失败时返回并保留暂存路径，不能把它当作成功目录。

`cubism verify` 只证明 model3 Version、目录内引用、JSON、纹理和 MOC3 文件头成立，不能读取 moc3 内部顶点或证明视觉等价。最终还要在 Cubism Viewer 中实际打开，检查中立、左右、上下、眨眼、嘴部、已有表情、动作和物理。若 `strictReady: false`，只有用户明确接受的 partial 范围可以交付，不能改称完整官方模型转换。

## 交付记录

向用户返回 PuppetLoom 项目路径和 source revision、Editor/API 状态、兼容计划路径或 JSON、`strictReady`、blocking/warning、同步是否 partial、Editor 官方 model3/moc3 来源、最终 model3 路径、`verification.valid` 和 Viewer 实际检查结果。结构验证与视觉验收分开写；尚未安装支持 1.1.0 的 Editor、未授予 Edit、未由 Editor 导出 moc3 或未看 Viewer 时，准确停在对应边界。
