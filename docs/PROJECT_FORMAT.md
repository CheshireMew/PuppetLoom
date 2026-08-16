# PuppetLoom 项目格式

项目是普通目录。`puppetloom.json` 的顶层 `version` 当前为 `2`；读取器仍兼容版本 1，并在内存中补齐版本 2 默认值，不会为了读取旧项目而改写文件。读取器用严格结构验证必要字段，但不依赖输出目录名。

## 顶层字段

| 字段 | 含义 |
| --- | --- |
| `version` | 项目格式版本，当前为 `2` |
| `name` | 创建时指定的名称，默认使用 PSD 文件名 |
| `canvas` | 原 PSD 画布像素尺寸 |
| `source` | 原文件名、PSD SHA-256、相对路径，以及可选参考图路径和哈希 |
| `rigLevel` | `semantic`、`grouped` 或 `minimal` |
| `layers` | 按原绘制顺序保留的可见像素图层 |
| `anchors` | 自动推导的头、脸、脖子、肩膀和身体标准化坐标 |
| `runtime` | 种子、动作档案、动作上限与启用功能 |
| `quality` | 中立相似度、13 个姿态结果、安全缩放和问题列表 |
| `disabledReasons` | 为什么禁用视线、眨眼、次级运动或更复杂绑定 |

所有几何坐标在运行项目中归一化为 `0..1`，纹理和源文件路径使用项目目录内的正斜杠相对路径。

## 运行姿态字段

新建且能可靠定位脸部的语义项目使用 `runtime.profile: "coherent-v3"`。`runtime.poseField` 保存由角色关键点推导的脸部与头骨中心、横纵半径、最大 yaw/pitch 角度和透视强度。`runtime.semanticCage` 保存 23 个标准化控制点、脸部与头骨三角形、受作用语义组，以及定位后的检查、修正和综合置信度。运行时让脸型与五官使用脸部控制网，让头发、耳朵和头饰使用头骨控制网；两者共享头部根节点，再按语义深度和局部权重混合。项目不保存针对某一张角色图手写的顶点动画。

`runtime.motionTuning` 的 `amplitude`、`response` 和 `stability` 分别控制动作总幅度、追随速度和阻尼稳定度。它们作用于同一个头部目标，不会为不同部位生成互不相关的随机运动。读取器继续兼容 `coherent-v2` 双表面、`coherent-v1` 单表面和没有姿态场的 `calm-v1` 项目；没有控制笼的旧项目保持原来的双表面路径。

## 图层字段

每个图层包含：

- 可稳定引用的 `id`、原名称 `sourceName` 和完整分组路径 `sourcePath`；
- 语义 `role`、左右侧 `side`、原顺序 `order`、`opacity` 和 `blendMode`；
- 标准化 `bounds` 与相对纹理路径 `texture`；
- 变形中心 `pivot`、规则网格顶点/UV/三角形，以及可选的局部固定点 `secondaryAnchors`；
- 可选的逐顶点 `mesh.influences`：`head`、`body`、`gaze`、`physics` 和 `pin`。前四项调节某个顶点受对应运动的比例，`pin` 用于固定根部或必须保持连接的位置；
- 头部、身体、视线和惯性的作用权重；
- 所属头部或身体组、虹膜可选的 `clipLayerId`，以及嘴部可选的 `mouthVariant`（`closed`、`slight` 或 `open`）。

尾巴使用独立的 `role: "tail"`，从身体根部向末端逐渐释放弹性；它不再归入普通 `accessory`。未知图层使用 `role: "unknown"`。它们不会被丢弃；程序只不给它们猜测专用表情行为。

当左右耳与女仆头饰合并在同一 `headwear` 图层时，`secondaryAnchors.earHingeLeft` 和 `earHingeRight` 保存程序从脸部边缘及图层 Alpha 推导出的两个耳根固定点。耳翼围绕各自固定点变形，头饰中央仍只做轻微整体回弹。若透明区域无法证明左右都存在耳翼，程序不写入固定点，并保留旧的保守动作。

## 报告

`reports/build-report.json` 是面向调用者的摘要，包含最终绑定等级、识别数量、安全缩放、启用/禁用功能、警告、补充请求数量和关键点校准摘要。

`reports/neutral.png` 是 PSD 中立合成。`reports/pose-sheet.png` 为 960×960 诊断图，按顺序绘制中立、左右转头、半幅转头、上下俯仰、左右倾斜和四个组合姿态。每格标签来自同一次安全检查。

语义项目还会生成 `reports/semantic-cage.png`、带编号与置信度表的 `reports/semantic-cage-head.png`，以及机器可读的 `reports/landmark-report.json`。JSON 同时列出控制点、三角形、修正记录和实际被脸部/头骨控制网作用的 PSD 图层，可由 Agent 在无需人工绑点的情况下复核结果。

角色窗口运行后会按需创建 `reports/runtime.log`。它使用逐行 JSON 记录启动参数、项目读取、窗口创建、页面加载、渲染进程异常和正常关闭事件，用于诊断“进程存在但窗口没有出现”等桌面问题；它不包含纹理像素或用户素材。

## 校准与修订

`puppetloom.json` 是自动绑定基线，不因用户拖动控制点而重写。当前校准在 `calibration/current.json` 中保存：

- `baseProjectSha256` 指向对应基线，避免把补丁误用到另一个项目；
- `revision` 从 0 递增；
- `overrides` 只保存改变过的锚点、语义点、图层属性、稀疏网格位移、逐顶点作用权重和运行参数。

每次保存都会创建 `calibration/sessions/<session-id>.json`，其中包含前后修订、补丁、修改前后覆盖、项目指纹和 `unreviewed/accepted/rejected` 证据状态。恢复旧修订也会创建新修订，不覆盖或删除历史。

桌面编辑器和 CLI 都会在 `reports/calibration/<session-id>/` 生成同一份视觉证据：九个主姿态、九个次级运动、`before-after.png`、`difference.png` 与机器可读清单。项目级校准记录是对当前角色的事实；只有多个项目反复出现并经过复核的问题，才应进入自动绑定算法或 Agent Skill 的通用规则。

## 补充素材请求

`requests/asset-requests.json` 请求左右闭眼线，以及在存在原始嘴层时请求自然闭口、微张和小幅张开三态嘴形。文档声明 `optional: true`，每项包含：

- 对应源图层和原画布裁切框；
- 可直接交给图像模型的 `requests/references/*.png` 参考裁切；
- 目标路径、精确尺寸和真实透明背景要求；
- 保留角色脸型、线条、颜色和视角的约束；
- 不得修改的区域说明与英文建议提示词；
- 最小、最大非透明覆盖率。

`enhance` 只接受与请求尺寸完全相同、Alpha 与覆盖率通过的 PNG。两只闭眼都通过后才启用自动眨眼；嘴形素材分别标记为 `closed`、`slight` 和 `open`，三态齐全后才启用偶发的自主开合。新的 `closed` 通过后才把 PSD 原嘴层透明度置零，因此失败时仍有原嘴回退。失败文件只写入拒绝结果，不修改已经安全的项目。

## 兼容约定

- 消费者遇到未知 `role` 或未来新增的非必要字段时应保持图层可绘制。
- 生产者不得改变已有版本字段含义；破坏性变更提升顶层 `version`。
- `source/source.psd` 和纹理是项目可复现依据，不应依赖仓库外绝对路径。
- 项目目录无需打包即可复制；复制后相对路径继续有效。
