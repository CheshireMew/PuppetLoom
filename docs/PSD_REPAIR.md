# Photoshop PSD 修复 CLI

`psd repair` 供外部 Agent 在进入 PuppetLoom 创建流程前整理有缺陷的分层 PSD。它通过 Windows COM 启动本机 Photoshop，把结构化配方转换为真实的图层操作；基础 PSD、候选 PSD 和参考图只读，新任务的输出 PSD 与审计目录必须尚不存在。

这条命令不是自动猜图层的黑盒。外部 Agent 先比较原画和候选 PSD，再明确选择每个部件的来源、拆分位置、清理区域和绘制顺序。Photoshop 负责实际复制、选择、去白边、合并和保存，PuppetLoom 负责输入哈希、非覆盖保护、重新打开检查以及白色、深色、棋盘和逐图层证据。

## 命令

先只读校验配方和所有输入：

```powershell
node .\apps\cli\dist\index.js psd repair `
  --recipe E:\Characters\repair.json `
  --output E:\Characters\character-repaired.psd `
  --workdir E:\Characters\character-repair-run `
  --dry-run `
  --json
```

确认计划后删除 `--dry-run` 执行。`--show-photoshop` 可以显示 Photoshop 窗口，默认以隐藏窗口运行。任务会先写 `operation.json` 的 pending 状态，再启动 Photoshop；输入哈希、空间预算、路径预算、每次尝试、当前阶段、输出哈希、失败原因和恢复命令都保存在同一个工作目录。Photoshop 中断或自动复核失败后，直接重跑完全相同的命令即可恢复。没有被任务确认的部分输出不会删除，而会移入工作目录的 `recovery/` 后再重试。

自动检查通过后，命令返回退出码 4、`ok: false`、`status: "awaiting-visual-review"` 和 `readyForCreate: false`。这表示 Photoshop 与结构检查已经结束，但整个 PSD 任务尚未完成，不能进入创建流程。外部 Agent 必须打开 `visual-review.json` 中绑定的全部图片，将六项 `pending` 检查改成 `pass`、`repair`、`fail` 或 `not-applicable`，填写说明、reviewer 和最终状态，再执行：

```powershell
node .\apps\cli\dist\index.js psd finalize `
  --workdir E:\Characters\character-repair-run `
  --decision E:\Characters\character-repair-run\visual-review.json `
  --json
```

只有 `accepted` 或 `accepted-with-repairs` 会得到 `readyForCreate: true`。`accepted` 不能带修复项；`accepted-with-repairs` 必须有明确的 repair 检查和非空修复计划；`rejected` 必须有 fail 检查和阻断项。`finalize` 会重新核对输出 PSD 与每张视觉证据的 SHA-256，终态一旦写入便不能改写。

已有 PSD 可以独立重新复核，不会再次启动 Photoshop；它同样先进入 `awaiting-visual-review`，并使用上面的 `psd finalize` 写入终态：

```powershell
node .\apps\cli\dist\index.js psd review `
  --input E:\Characters\character-repaired.psd `
  --recipe E:\Characters\repair.json `
  --workdir E:\Characters\character-review `
  --json
```

## 配方

```json
{
  "version": 1,
  "kind": "puppetloom-photoshop-psd-repair",
  "basePsd": "./base.psd",
  "referenceImage": "./source.png",
  "sources": [
    { "id": "candidate-a", "path": "./candidate-a.psd" }
  ],
  "operations": [
    {
      "op": "duplicate-layer",
      "source": "candidate-a",
      "layer": "headwear",
      "name": "headwear-source"
    },
    {
      "op": "split-layer-x",
      "layer": "headwear-source",
      "splitX": 640,
      "leftName": "headwear-r-base",
      "rightName": "headwear-l-base"
    },
    {
      "op": "extract-white-region",
      "sourceImage": "./source.png",
      "bounds": [465, 0, 615, 120],
      "name": "antler-r-top",
      "tolerance": 40,
      "method": "magic-wand"
    },
    {
      "op": "merge-layers",
      "layers": ["antler-r-top", "headwear-r-base"],
      "name": "headwear-r",
      "placement": { "relativeTo": "ears-r", "position": "after" }
    }
  ],
  "checks": {
    "requiredLayers": ["headwear-r", "ears-r", "face"],
    "opaqueInteriorLayers": [
      {
        "layer": "headwear-r",
        "bounds": [465, 0, 615, 120],
        "maxInteriorPartialRatio": 0.005
      }
    ]
  }
}
```

相对路径以配方所在目录为基准。图层选择器可以是唯一图层名，也可以是从顶层组开始的路径数组。当前操作包括：

- `delete-layer`、`rename-layer`、`set-visibility`、`move-layer`
- `duplicate-layer`：从声明的候选 PSD 复制图层
- `split-layer-x`：按画布横坐标拆成左右两层
- `clear-region`：清除指定矩形中的误带内容
- `extract-white-region`：从原画矩形中用 Photoshop 连续魔棒或主体选择提取前景，并自动去白边
- `remove-white-matte`、`defringe`
- `merge-layers`：把已确认的相邻部件合并为一个完整图层

`opaqueInteriorLayers` 只检查明确应当实心的局部。它使用距透明边缘至少两个像素的区域判断内部半透明，避免把正常抗锯齿边缘和纱质衣物误报为缺陷。自动检查通过仍不等于视觉验收通过；外部 Agent 必须查看 `on-white.png`、`on-dark.png`、`on-checker.png`、`reference-comparison.png` 和 `layer-contact-sheet.png`。
