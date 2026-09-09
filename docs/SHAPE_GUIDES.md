# 按角色目标制作关键形

`author inspect-shape` 导出一个实际图层的原素材、网格、合成和原图坐标映射。`author preview` 接受现有 AuthoringPatch，在写入前生成目标标记、实际前后结果、关键形端点和各轴中间组合。`author apply` 保存同一补丁，继续使用既有 revision/session/restore。软件不推测人物的审美目标，默认起稿不代表视觉制作完成。

```powershell
node apps/cli/dist/index.js author inspect-shape --project <项目> --layer <图层> --output <检查目录> --json
node apps/cli/dist/index.js author preview --project <项目> --patch <补丁.json> --output <预览目录> --focus headFace --json
node apps/cli/dist/index.js author apply --project <项目> --patch <预览目录/patch.json> --json
```

## 目标点

`transform-keyform` 增加以下 transform。例子只是字段说明，坐标必须根据当前原图重新填写。

```json
{
  "kind": "fit-landmarks",
  "radiusPixels": 60,
  "points": [
    {"label": "下巴目标", "source": {"x": 0.5, "y": 0.7}, "target": {"x": 0.51, "y": 0.695}},
    {"label": "保持脸颊连接", "source": {"x": 0.45, "y": 0.6}, "target": {"x": 0.45, "y": 0.6}}
  ]
}
```

点坐标是父级变换之前的归一化画布坐标，半径是源图像素。有限支撑径向基函数求解移动点和固定点的约束；在长方形画布上也使用真实像素距离。点位重合、求解病态、产生非有限坐标或过渡翻折时拒绝。网格顶点采样后的曲面不保证任意非顶点标记处的位移完全等于解析目标；用实际边缘核对，粗网格不能仅靠增加目标点变得精细。

## 眼睑曲线与收缩分区

```json
{
  "kind": "curve-warp",
  "source": [{"x":0.4,"y":0.3},{"x":0.45,"y":0.27},{"x":0.5,"y":0.3}],
  "target": [{"x":0.4,"y":0.3},{"x":0.45,"y":0.32},{"x":0.5,"y":0.3}],
  "profile": [
    {"source":-20,"target":-3}, {"source":-2,"target":-1.5},
    {"source":2,"target":1.5}, {"source":20,"target":1.6}
  ],
  "taper": {"start":0.1,"middle":1,"end":0.1}
}
```

source/target 分别是三个二次贝塞尔控制点，均为归一化画布坐标。source 两端决定眼轴，所有控制点沿轴的投影必须分别位于起点、中点和终点；曲率和目标位置沿眼轴法线改变，允许倾斜轴。profile 两列是相对原曲线法线方向的原图像素距离，必须严格递增；区间外按首/末段斜率延伸。taper 是沿曲线位置的正数厚度倍率，默认 1。不内置棕色阈值、月牙形、固定闭眼厚度或人物眼角位置。原睫毛保留的笔画与需要收起的侧壁由 Agent 看图判断后分别指定。

两种操作都沿用 selection；选区在 rest 网格上固定，变换作用于当前关键形及前序 transform 的结果。操作只修改指定已有关键形。中立关键形需由调用者保留；新绑定或插键仍用已有 `upsert-binding` / `insert-binding-key`，完整头部来源仍由 `set-layer-head-pose` 显式选择。没有自动替换用户关键形，也没有自动重建网格或清除同轴物理绑定。

## 预览与限制

preview 校验基线、拒绝未处理草稿，输出 `saved:false`、`baseFingerprint`、`proposalFingerprint`、`patchFingerprint`。未保存提案的图表有明确标题，其 revision 是来源基线，不是已写入版本。标记图中蓝色为来源、橙色为目标；标记在 rest 空间，合成背景可能经过父级/中立求值，最终效果必须看 proposal 的实际渲染。sourceView 是原纹理矩形映射，meshView 是 rest 网格，不能在已有 UV/中立修形时混用。

自动预览包含受影响绑定各轴的现有键值和相邻中点，双参数键值取笛卡尔积。额外表情、眨眼、视线或物理组合通过 AuthoringPatch.previews 指定（沿用补丁最多 12 个显式姿态的限制）。自动补充后总数最多 100 个，超过时按相关部位分开；不通过抽样减少来隐藏已知失败姿态。技术检查失败返回 blocked，其他情况仍是 awaiting-visual-review/unreviewed。实际的临界翻折、任意多绑定组合、父级运动和连续时间物理仍需按目标检查；关键形的线性过渡面积检查不保证所有多参数、父级组合安全。

这些能力属于通用工具，人物的目标点、曲线、收缩分区属于项目数据。软件测试通过、两个实际项目能够预览，都不能称为所有人物的自动制作已经可靠。

## 2026-09-09 验证记录

CLI 已构建为 `b755a14b4559`。相关的目标变形、authoring、闭眼和公开 CLI 测试共 20 项通过；其中公开入口测试核对了预览不修改项目、显式与自动姿态编号不冲突、基础帧不被带状态的组合帧替代、保存后的项目指纹等于提案指纹，以及过期补丁拒绝和恢复。Skill 合约测试 33 项通过，文件预算、桌面主进程与渲染端类型检查通过。

实际项目验证材料位于 `workspace/analysis/character-review-20260909/general-tools`。猫娘使用原睫毛曲线与厚度分区生成 7 个预览姿态；蓝发女仆使用其自身脸部点位生成 25 个双参数端点及中间姿态。两者技术检查通过，画面已查看，均保留 `saved:false` / `unreviewed`。前者的保守厚度提案仍有需要视觉修整的角部细线，后者只是脸部局部目标工具验证；这两份材料不作为新的角色制作成品交付。正式猫娘第 21 版和蓝发女仆第 41 版的内容指纹与预览基线一致，见该目录的 `verification.json`。

验证中，一份过度压薄的睫毛提案被过渡翻折检查拒绝；测试也确认真实翻折不能以“闭眼本来就薄”为理由放行。预览检查只排除正常几何闭合导致的薄眼白、虹膜被闭合遮罩遮挡这两类误报，不代替眼角残留、笔画与脸形的视觉判断。
