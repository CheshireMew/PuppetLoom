# PuppetLoom 项目格式

项目是普通目录。`puppetloom.json` 的顶层 `version` 当前为 `4`；读取器仍兼容版本 1、2 和 3，并在内存中补齐标准参数模型与显式网格拓扑，不会为了读取旧项目而改写文件。旧文件的原始 SHA-256 继续作为校准基线，因此迁移不会使既有校准历史失联。读取器用严格结构验证必要字段，但不依赖输出目录名。

## 顶层字段

| 字段 | 含义 |
| --- | --- |
| `version` | 项目格式版本，当前为 `4` |
| `name` | 创建时指定的名称，默认使用 PSD 文件名 |
| `canvas` | 原 PSD 画布像素尺寸 |
| `source` | 原文件名、PSD SHA-256、相对路径，以及可选参考图路径和哈希 |
| `rigLevel` | `semantic`、`grouped` 或 `minimal` |
| `layers` | 按原绘制顺序保留的可见像素图层 |
| `model` | 参数、关键形态绑定、变形器、表情、物理和行为组成的 AI authoring 图 |
| `anchors` | 自动推导的头、脸、脖子、肩膀和身体标准化坐标 |
| `runtime` | 种子、动作档案、动作上限与启用功能 |
| `quality` | 中立相似度、13 个姿态结果、安全缩放和问题列表 |
| `disabledReasons` | 为什么禁用视线、眨眼、次级运动或更复杂绑定 |

所有几何坐标在运行项目中归一化为 `0..1`，原点位于画面左上角，X 向右、Y 向下。图层 `side` 始终表示角色自身的解剖学左右，因此正面角色的 `left` 通常显示在画面右侧；画面左右会明确写成 screen-left 或 screen-right。纹理和源文件路径使用项目目录内的正斜杠相对路径。

## 运行姿态字段

新建且能可靠定位脸部的语义项目使用 `runtime.profile: "coherent-v3"`。`runtime.poseField` 保存由角色关键点推导的脸部与头骨中心、横纵半径、最大 yaw/pitch 角度和透视强度。`runtime.semanticCage` 保存 23 个标准化控制点、脸部与头骨三角形、受作用语义组，以及定位后的检查、修正和综合置信度。运行时让脸型与五官使用脸部控制网，让头发、耳朵和头饰使用头骨控制网；两者共享头部根节点，再按语义深度和局部权重混合。项目不保存针对某一张角色图手写的顶点动画。

`runtime.motionTuning` 的 `amplitude`、`response` 和 `stability` 分别控制动作总幅度、追随速度和阻尼稳定度。它们作用于同一个头部目标，不会为不同部位生成互不相关的随机运动。读取器继续兼容 `coherent-v2` 双表面、`coherent-v1` 单表面和没有姿态场的 `calm-v1` 项目；没有控制笼的旧项目保持原来的双表面路径。

## AI authoring 图

`model.parameters` 保存稳定 ID、显示名、分组、连续/开关类型、`min/default/max` 和可选标准语义。标准语义包括头部 yaw/pitch/roll、身体 sway/pitch/roll、视线 X/Y、呼吸、眨眼和张嘴。运行时先读取这些语义对应的现有 `MotionState` 字段，再叠加表情和行为；调用方在 `MotionState.parameters` 中给出的显式值优先级最高，并按参数范围收敛。

`model.bindings` 把一个或两个参数绑定到图层或变形器。每个绑定使用一维线性或二维双线性关键形态网格，可保存稀疏图层顶点增量、网格变形器控制点增量、平移/旋转/缩放、透明度倍数和绘制顺序偏移。双参数绑定必须给出完整矩形坐标网格；点索引、参数范围和目标引用在 JSON 边界统一验证。

`model.deformers` 支持旋转变形器和规则控制网变形器。图层通过 `deformerId` 挂到一个直接父变形器，变形器可通过 `parentId` 继续组成无环层级；求值顺序为图层关键形态、子变形器、父变形器，最后叠加旧项目已有的安全自动姿态。这样 v1/v2/v3 项目迁移后保持原动作，新 authoring 结果又能进入同一 WebGL 与离线证据链。

`model.expressions` 是命名参数预设；`model.behaviors` 用参数或表情轨道、严格递增的时间关键帧、循环和可选自动播放组织状态变化；`model.physics` 用输入/输出参数、响应、阻尼和缩放建立无环参数物理。实时控制器以固定顺序推进物理，离线 authoring 证据可按 `settleSeconds` 预运行同一物理后再截图。

## 图层字段

每个图层包含：

- 可稳定引用的 `id`、原名称 `sourceName` 和完整分组路径 `sourcePath`；
- 语义 `role`、左右侧 `side`、原顺序 `order`、`opacity` 和 `blendMode`；
- 标准化 `bounds` 与相对纹理路径 `texture`；
- 变形中心 `pivot`、渲染网格顶点/UV/三角形，以及可选的局部固定点 `secondaryAnchors`；`mesh.topology` 为 `art` 时，`mesh.art` 还保存纹理尺寸、Alpha 阈值、细节尺度和由外轮廓/孔洞组成的可重建区域；`grid` 仅保留 `rows/cols`；
- 可选的逐顶点 `mesh.influences`：`face`、`skull`、`head`、`body`、`gaze`、`physics` 和 `pin`。前两项分别调节语义脸部控制笼和头骨控制笼，随后四项调节整体头部、身体、视线和次级运动，`pin` 用于固定根部或必须保持连接的位置；
- 头部、身体、视线和惯性的作用权重；
- 所属头部或身体组、可选父图层 `parentLayerId`、可选 authoring 变形器 `deformerId`、可选的编辑锁定与运行可见性、虹膜可选的 `clipLayerId`，以及嘴部可选的 `mouthVariant`（`closed`、`slight` 或 `open`）。父图层和变形器层级不能指向自身、缺失节点或形成循环；运行绘制使用参数求值后的顺序和可见性。

尾巴使用独立的 `role: "tail"`，从身体根部向末端逐渐释放弹性；它不再归入普通 `accessory`。未知图层使用 `role: "unknown"`。它们不会被丢弃；程序只不给它们猜测专用表情行为。

当左右耳与女仆头饰合并在同一 `headwear` 图层时，`secondaryAnchors.earHingeLeft` 和 `earHingeRight` 保存程序从脸部边缘及图层 Alpha 推导出的两个耳根固定点。耳翼围绕各自固定点变形，头饰中央仍只做轻微整体回弹。若透明区域无法证明左右都存在耳翼，程序不写入固定点，并保留旧的保守动作。

## 报告

`reports/build-report.json` 是面向调用者的摘要，包含最终绑定等级、识别数量、安全缩放、启用/禁用功能、警告、补充请求数量和关键点校准摘要。

`reports/neutral.png` 是 PSD 中立合成。`reports/pose-sheet.png` 为 960×960 诊断图，按顺序绘制中立、左右转头、半幅转头、上下俯仰、左右倾斜和四个组合姿态。每格标签来自同一次安全检查。

语义项目还会生成 `reports/semantic-cage.png`、带编号与置信度表的 `reports/semantic-cage-head.png`，以及机器可读的 `reports/landmark-report.json`。JSON 同时列出控制点、三角形、修正记录和实际被脸部/头骨控制网作用的 PSD 图层，可由 Agent 在无需人工绑点的情况下复核结果。

角色窗口运行后会按需创建 `reports/runtime.log`。它使用逐行 JSON 记录启动参数、项目读取、窗口创建、页面加载、渲染进程异常和正常关闭事件，用于诊断“进程存在但窗口没有出现”等桌面问题；它不包含纹理像素或用户素材。日志先写 `runtime-log-policy.json`，单段达到 5 MiB 后通过移动归档，总量默认限制为 64 MiB；达到上限后停止追加，只报告候选，不自动删除。

`describe --layer <id>` 会从对应纹理 Alpha 计算有意义的四连通区域，报告像素数量和归一化边界，并列出完整网格的基准位置、当前位置、delta、UV、三角形与逐顶点作用权重。该结果是 Agent 构造稀疏补丁的接口，不需要也不允许直接改 `puppetloom.json`。

`record` 在调用者指定的目录生成 `<mode>.webm`、局部 WebM、接触表和 `<mode>-report.json`。报告保存基础项目哈希、准确 revision、画布与窗口比例、采样时刻、帧差、动作极值及 ffmpeg 路径。已有同名证据不会被覆盖。

## 校准与修订

`puppetloom.json` 是自动绑定基线，不因用户拖动控制点而重写。当前校准在 `calibration/current.json` 中保存：

- `baseProjectSha256` 指向对应基线，避免把补丁误用到另一个项目；
- `revision` 从 0 递增；
- `headSessionId` 是当前可达历史的唯一头指针；版本 1 旧项目没有该字段；
- `overrides` 保存改变过的锚点、语义点、图层属性、稀疏网格位移、逐顶点作用权重和运行参数；AI authoring 修订在同一覆盖中保存完整当前 `model`，避免另建一套历史真源。

未提交修改在 `calibration/draft.json` 中原子覆盖保存，并绑定基础项目哈希和当前 revision。正式校准提交后旧草稿会因 `baseRevision` 不匹配而自动失效，不需要在提交点之后再写第二份状态；用户明确放弃时才把草稿覆盖为空，始终不删除文件。图层覆盖既可保存稀疏 `meshPointDeltas`，也可保存经过完整 `meshSchema` 校验的替换 `mesh`；后者用于从项目现有 PNG Alpha 非破坏式升级旧规则网格。改变 ArtMesh 细节尺度会从已保存的 Alpha 轮廓重新约束三角剖分，并按 UV 从旧三角形重投影全部作用权重；旧规则网格改变行列数时使用同一通用投影。两种重建都会主动退出旧顶点索引，避免把旧顶点修改误套到新网格。

每个校准补丁必须包含调用者看到的 `baseRevision`。保存先取得 `calibration/write.lock`，重读当前版本，写入 `reports/calibration/<operation-id>/operation.json` 的 pending 状态，再生成完整证据和会话；只有全部成功后才原子切换 `calibration/current.json`。租约释放和失效租约都移动到 `calibration/locks/`，不删除。中断恢复只根据头指针把 pending 标为 succeeded 或 interrupted，不自动重放。每次保存都会创建 `calibration/sessions/<session-id>.json`，其中包含父会话、前后修订、补丁、修改前后覆盖、项目指纹和 `unreviewed/accepted/rejected` 证据状态。恢复旧修订也走同一事务并创建新修订。

桌面编辑器和 CLI 都会在 `reports/calibration/<operation-id>/evidence/` 生成同一份视觉证据：九个主姿态、九个次级运动、authoring 补丁涉及的关键形态/表情/物理/行为预览、`before-after.png`、`difference.png` 与机器可读哈希清单。离线证据与 WebGL 播放共用参数求值、变形器、图层顺序、表情透明度和混合模式约定，并按裁剪纹理的真实 Alpha 生成蒙版。项目级校准记录是对当前角色的事实；只有多个项目反复出现并经过复核的问题，才应进入自动绑定算法或 Agent Skill 的通用规则。

源 PSD 更新使用 `migrate` 创建新项目目录，旧项目保持不变。新项目的 `reports/migration.json` 保存按 `sourcePath` 建立的图层映射、兼容等级、已迁移字段、跳过字段和警告；`reports/migration-patch.json` 保存提议补丁。范围或画布变化时，绝对锚点、语义点、轴心、次级锚点和稀疏顶点不会被静默迁移。

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
- `export` 会把当前有效修订烘焙为另一个经过 `verify` 的普通项目目录，revision 从 0 重新开始；它不压缩、不覆盖已有目录，来源 revision 写入 `reports/portable-export.json`。
