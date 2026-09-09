# 从人物结构制定目标形状

用于原素材闭眼、脸缘和五官修形。外部 Agent 负责观察和目标判断；PuppetLoom 负责目标约束到网格的计算、预览、保存与恢复。默认公式和参考软件输出都是可比较的起稿，不能代替这个人物的目标。不要在软件中增加 Agent 或模型调用。

## 先核对结构和坐标

在规范项目运行 `history/describe`，固定当前 revision，保留已有有效结果。对目标层执行：

```powershell
& ./skills/live2d-puppet/scripts/invoke_puppetloom.ps1 author inspect-shape --project <规范项目> --layer <实际图层ID> --output <仓库内新目录> --json
```

实际查看 sourceView、meshView 和 compositeView。返回的 texture 是原文件，pixelBounds 和 coordinates 给出画布尺寸、缩放及坐标映射。标记用归一化画布坐标：原图像素 x 除以画布宽，y 除以画布高；不是截图尺寸、局部裁图尺寸或窗口坐标。sourceView 是原纹理矩形映射，meshView 是当前 rest 网格，compositeView 含模型实际中立求值；已有 UV/中立修形或父级时不能混为同一空间。用 `author geometry --layer` 或 `--binding --values` 核对当前输入关键形的点位，父级影响另看合成。

记录每一处目标的名称、来源点或曲线、预期去向、影响范围和视觉理由。图层名不等于像素职责：同一睫毛里可能有黑色笔画、棕色侧壁和浅色眼线；同一脸层也包含需要保持的额头与需要改变的下巴。检查不清时先放大原图，不能猜一套全人物共用坐标。

## 两种目标操作

沿用 `author apply` 的 `transform-keyform`，不手写密集顶点数组。操作明确 bindingId、已有关键形 values、coordinateSpace: rest-canvas、selection 和 transforms。选区仍固定在 rest 网格上，目标变换作用于该关键形经过前序操作后的点位。缺少关键值先 `insert-binding-key` 保形插入；新绑定先 `upsert-binding`，明确参数、目标层和中立空关键形。不能覆盖一个有其他已制作关键形的绑定再重新起稿。

`fit-landmarks` 接受 `radiusPixels` 和 `points: [{label, source:{x,y}, target:{x,y}}]`。source/target 是归一化画布坐标，半径是真实原图像素，在长方形画布上也使用像素距离。固定点写相同 source/target；移动点写实际目标。软件求解平滑、有限影响范围的位移，控制点过近导致不稳定或目标使网格翻折时拒绝。控制约束不是贴图像素逐点跟踪的保证：标记落在粗三角形内部时应检查实际边缘是否到位，必要时局部改善网格，不能仅看输入点的目标值。

`curve-warp` 接受 `source` 和 `target` 两组三个控制点，表示二次贝塞尔曲线。两曲线共用原眼轴：source 首尾决定轴，第二控制点投影在轴的中点；target 三点投影分别在同一起点、中点、终点，只沿法线改变形状。点位均为归一化画布坐标。这支持倾斜眼轴，不是要求眼睛水平。要改变眼角沿轴位置时另用目标点修形，不违反曲线约束硬填数据。

`profile: [{source, target}, ...]` 表示离原曲线法线方向的距离如何收缩，单位均为原图像素；两列必须严格递增。中间笔画可保留适当厚度，外侧或下方侧壁采用更小但非零的厚度。可选 `taper: {start, middle, end}` 是沿曲线的正数厚度倍率，用于符合原画的两端收尖。不要把某个角色的棕色阈值、收缩比或月牙曲率写成通用值。中间笔画、侧壁的界线必须来自当前原图。

## 眼睛和头脸分别制作

眼睛左右分别确定角点和线条结构；眼白与睫毛使用同一闭合位置，虹膜由对应眼白遮罩收起。保留原素材和 UV，半闭过程中侧壁逐步收缩，全闭没有残留竖块。闭眼是否月牙、弯曲多少、粗细如何，服从用户要求和角色原画，不对所有角色规定同一弧线。不要为保留睫毛而把整张睫毛纹理都按原厚度搬过去，也不要为去掉侧壁把黑色笔画一起抹掉。现有几何眨眼绑定仍须显式更新，重跑自动 eyes 制作会保留它，不会替你修曲线。

头脸先分别确定左右和俯仰目标中的脸颊、下巴、五官及固定点，再制定四个斜向修正。保持原画斜轴及不对称性，不能先镜像或套统一近远眼比例。一个层上的局部修正沿用当前头部来源；只有已明确制作完整双参数头部关键形，才用 `set-layer-head-pose: keyforms` 关闭该层的程序化 yaw/pitch。固定层、头发附着、表情和物理职责不能因共用 yaw 参数被一起合并。参考移植误差小只证明移植准确，不证明人物好看。

## 先预览，再写入同一份方案

```powershell
& ./skills/live2d-puppet/scripts/invoke_puppetloom.ps1 author preview --project <规范项目> --patch <目标补丁.json> --output <仓库内新预览目录> --focus eyes --json
# 查看返回画面并修正具体缺陷后，写入预览保存的同一补丁：
& ./skills/live2d-puppet/scripts/invoke_puppetloom.ps1 author apply --project <规范项目> --patch <预览目录/patch.json> --json
```

preview 不写 revision，返回来源/目标标记图、before、proposal、显式姿态以及受影响绑定各轴的端点和中间值，九向双参数绑定会检查中间组合。蓝色标记来源，橙色标记目标；它们位于父级变换之前，只是坐标诊断，最终造型以 proposal 为准。尚未保存的 proposal 即使 manifest 使用基线 revision 也不是该 revision 的正式结果，必须用 preview.json 的 saved:false、baseFingerprint、proposalFingerprint 和 patchFingerprint 区分。过期基线和未提交草稿会阻止预览。

自动检查返回具体姿态问题，失败时 status 为 blocked；无技术问题也只是 awaiting-visual-review。检查眼角残留、线条体量、脸缘与五官的关系、原人物辨识度和中间过渡。端点与中间采样不等于连续时间运动，也不证明未采样的表情/物理组合；按任务补充相关 previews 或准确 revision 的允许连续证据。发现问题只改对应目标、分区、网格或组合，不全局重做，不靠放慢掩盖错误脸形。

apply 后重读 history、实际结果及 session，确认写入规范项目而非研究副本。修改过补丁或基线后重新预览，不只更改 baseRevision。按用户目标交付画面并保留视觉待确认状态；用户给出新方向且继续授权返修时，保留历史继续处理具体缺陷，不因旧候选被否定就自动停止整个任务。

## 通用改进的证据范围

软件测试覆盖长方形画布、倾斜曲线、侧壁收缩、固定/移动点、其他关键形保留、翻折拒绝、预览不写入以及保存/恢复。至少用不同结构的实际角色检查公开入口，说明是只读预览、制作候选还是已接受结果。数学夹具不能替代角色视觉验证；两个人物成功也不能保证任意分层都能自动制作。通用工具、已验证的方法与人物专属目标分别报告。
