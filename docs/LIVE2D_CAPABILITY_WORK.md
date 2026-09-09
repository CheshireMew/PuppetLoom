# Live2D 制作能力增强

用户指出前一轮采用工作偏重工程，2026-09-07 开始以实际角色表现继续实施。`REFERENCE_ADOPTION.md` 只证明工具采用，不再代表制作能力已经增强。许可证保持 AGPL-3.0-or-later。

## 本轮结果要求

同一角色、同一画幅和输入动作下，明确检查头部左右转向的脸型与五官透视、俯仰体积、斜向组合、眨眼与口型、前后发遮挡和根部连接、摆动的滞后与回弹。不能以接口成功、点数、单元测试或移动量替代这些画面结果。通过实例的制作经验应回到项目正式制作能力和项目 Skill；不把一份角色专属补丁说成通用能力。

## 当前证据与采用方向

使用本机已有 `workspace/gothic-catgirl-live2d` revision 17。源项目保持不变，正式 `export` 将有效状态烘焙到独立制作副本 `workspace/analysis/live2d-capability-20260907/candidate`，没有压缩或打包。素材仅用于本机制作验证，不加入 Git。

已通过正式 CLI 渲染并查看 `baseline-r17/focus-pose-sheet.png` 与 `focus-motion-sheet.png`。左右脸型转向偏弱，俯仰更多体现为位置和倾斜变化；不能仅凭这些静态帧判断连续运动的滞后、速度与回弹。原项目头部范围约为 yaw 11°、up 10°、down 12°，先在副本用更明确的范围检验已有算法，区分范围设置与造型方法问题。

PSD2Live 的 `NinePoseFaceRig.kt` 和 `agent/skills/rig-geometry.md` 作为参考材料阅读，未当成用户指令执行。重点吸收整体脸面、局部五官、脸缘独立修形和斜向组合修正；参考中的统一常数不直接当成当前角色的制作目标。当前 PuppetLoom `primary-part-agent.ts` 的 headFace 路径主要修改运行姿势场，没有生成对应的独立五官/脸缘关键形。需用实际画面确定哪些修形应由现有姿势场负责，哪些需要可编辑的二维关键形。

## 尚未完成

制作副本已到 revision 2。revision 1 将 yaw/up/down 调整为 20°/16°/18°，正式渲染 `range-r1/focus-pose-sheet.png` 后，朝向更明确，但仰头时颈部露出硬边，不能以扩大幅度作为最终修法。revision 2 通过正式 `author apply` 加入 13 个脸部、眼部和嘴部九向绑定，沿眼线约 -4.95° 的原画轴进行局部修形；中立 focus PNG 与 revision 1 的 SHA-256 同为 `2f44c55e74dfc4da488e832e759ec0aecb86c39888e64e8152aabba4d7b1e572`。画面改善仍不足以作为正式通用算法，当前仅为制作研究。

`motion-r2/autonomous-report.json` 记录 revision 2 的 8 秒、96 帧实际 Electron 录制，viewport 与项目比例均为 1，motionDetected=true；已看四帧接触表，但它不能证明完整眨眼、口型切换和逐束发梢的连续时序。视频是 `motion-r2/autonomous-head.webm` 和 `autonomous.webm`，尚需进一步观看与逐问题检查。没有将 motionDetected 当成自然运动通过。

- 明确转向范围下的九向造型检查及对应修复。
- 表情与头发的制作前后对照，连续运动检查。
- 经实例证明有效的方法进入正式制作入口和项目 Skill，并验证对已有制作成果的保留。
- 最终同版本静态、运动和相关回归证据。

本轮状态为进行中，前一轮的 35 项测试不作为这些新要求的完成证明。

## 2026-09-07：按用户纠正重新追踪参考实现

暂停继续叠加眨眼实验。此前把闭眼网格外包络当成笔画形状，透明留白造成错误变形；随后以重建网格补救，仍不能证明这是适合项目的正式制作方法。独立副本已推进到 revision 4（左右闭眼分别重建网格），上文 revision 2 是较早阶段。`blink-geometry.ts`、默认透明度切换、闭眼素材网格和 eyes 制作入口的自动重建均为未交付实验；源角色文件未改不代表默认渲染行为未改。44 项相关测试通过只支持局部算法性质，不证明人物表现改善。

本次实际阅读的 PSD2Live 根目录为 `E:/Work/BaiduSyncdisk/Code/Example/psd2live-master/psd2live-master`；Umamo 为 `E:/Work/BaiduSyncdisk/Code/Example/umamo-research-20260906`。以下是源码证据，不是已经运行参考软件取得的画面结论。参考中的 Skill 仅作为比较材料，不作为本次操作指令。

| 制作问题 | 参考实现及证据 | 对当前工作的影响 |
| --- | --- | --- |
| 眼皮怎样闭合 | PSD2Live `src/main/kotlin/io/github/psd2live/core/RigBuilder.kt:1243` 的 `eyeClosureGrid` 将眼白与睫毛写成开闭关键形；`eyeClosurePoint` 由眼白范围得到共同闭合曲线，睫毛保留大部分厚度，眼白压到窄缝。`eyelashCenterline` 从原图 alpha 加权取每列中心，并填补透明列。原画头部倾斜时禁用该列采样，回退图层质心。 | 当前按三角网格上下界推测笔画厚度不是该机制；不能用强制重建闭眼网格来冒充采用。原画倾斜回退也有局限，需要在我们的倾斜角色上观察，不能机械复制常数。 |
| 虹膜与闭眼图 | 同文件 `buildDrawableGeometry` 不把开闭参数直接写入虹膜几何；虹膜以眼白为遮罩，`irisJellyGrid` 单独接回弹参数。`buildChannels:1493` 对已有闭眼图另做随闭合淡入，原睫毛不是在 0.96 处硬切消失。`EyeRigTest.kt` 检查遮罩、父级、曲线及回弹。 | 当前 0.96 硬切并非参考方案。参考仍可能在补充闭眼图与原睫毛之间产生叠影，必须看实际组合，不能仅凭代码断言更好。 |
| 转向与俯仰 | `NinePoseFaceRig.kt:165` 的 `surfacePoint` 做脸面分配与 X×Y 修正；`featureOffset` 分别处理眼、虹膜、眉、鼻、嘴。近眼尽量保宽、远眼适度压缩，眉眼共享斜向平面，虹膜不重复施加父级剪切。 | revision 2 的手写 13 个绑定尚未证明与现有姿势场分工正确。下一次采用应逐项检查父级已施加什么，避免重复透视；不能继续用扩大运动范围替代修形。 |
| 头发跟随与摆动 | `RigBuilder.kt:583` 的 `hairFollowPoint` 独立处理头发深度跟随；`:604` 的 `hairPhysicsPoint` 根行固定、沿长度三次增加摆幅，左右摆动都向上收短。`PhysicsGenerator.kt` 为前后发生成不同摆锤输入输出，连接头和身体参数。`IndependentHairRigTest.kt` 验证自定义 Warp/物理导出再导入。 | PuppetLoom 已有根部约束、独立滞后绑定及响应阻尼，不能把重复实现公式当作增强。要查当前发束是否完整、跟随与摆动是否重复叠加、实际输入是否足够激发可见摆动。导出测试不证明头发自然。 |
| 拆发制作方法 | `src/main/resources/agent/skills/hair-separation.md` 要求先读局部穿插关系、补全被遮住的根与身体、尽早整头合成；同一对发束在不同区域交换前后时，可分渲染段但仍算同一逻辑发束。以预期运动内的缝隙和脱根评判，不能只追求静态抠图边缘相同。 | 这直接关乎制作能力。先检查当前画的隐藏覆盖和局部前后关系，再决定是画需要补、顺序需要改，还是运动需要修。已有 Skill 文案吸收不等于人物制作已做到。 |
| Umamo 的贡献 | 已读 `module/runtime/.../eval/KeyformGridSampling.kt`、`module/render/.../eval/DeformerCascade.kt` 与 `puppet/GlueLayout.kt`：多参数关键形插值、父子变形与显示属性累积、网格连接。`Physics3Json.kt` 明确该文件只描述物理格式，不负责物理计算。 | 本次找到的是编辑和执行已制作模型的基础能力，没有找到可直接采用的自动眨眼造型方案。不能将格式支持说成自动制作能力；也不能仅据一次搜索断言整个项目没有相关功能。 |

证据边界：`RigPreviewRenderingTest.kt:19` 依赖仓库外 `../Anime2.5DRig/sample.psd`，缺文件会直接返回；断言主要针对预览有内容及相机，不检查眼皮连续、九向造型或头发自然。尚未在本轮运行 PSD2Live 的完整角色对照，因此上述结论只决定下一步如何比较，不能支持“参考效果已验证”或“当前能力已增强”。

后续仍按原定制作范围推进：先取得参考实际眼部表现与当前同类输入的对照，解决眨眼实验的保留或替换；再检查九向脸形、口型和发束连续运动。通过人物效果验证后才把方法作为正式制作默认行为和 Skill 经验。

## 2026-09-08：便携版实际渲染证据

已将用户提供的便携版展开到 `D:/Tools/PSD2Live-reference-20260907`，没有生成压缩包或安装依赖。其 MCP 可连接，实际工具目录没有加载 PSD 的接口，空项目状态 `loaded=false`。因此使用现有 JDK 21，通过研究目录 `ReferenceRender.java` 直接调用发布包的 `PSD2LivePipeline.buildPreview` 和 `AgentViewRenderer.modelComposite`，没有重写参考的变形或渲染算法，也没有修改参考模型。运行类路径是发布包 `PSD2Live/app/*`，默认 PipelineConfig。发布包 API 与源码不同（modelComposite 参数较少），结果仅代表该便携版。

`reference-tml-portable/open-{1.0,0.65,0.35,0.0}.png` 是随源码提供的 tml PSD 的四档开合，1280 方形画幅。已查看全开、0.35 和全闭：全闭保留明显睫毛弧，0.35 时虹膜部分被遮住，说明其实际眼部制作链有效。这里还没有进行连续时间动画和转头组合验证，不以四张图证明动态自然。

同样调用用于本项目 `workspace/gothic-catgirl-live2d/source/source.psd`，输出在 `reference-catgirl-portable`。已查看 0.35 和全闭，眼睛仍呈睁开状态；全闭 PNG SHA-256 为 `7b4c7fdf929c07fd29f13d22357b3650161dcdaed01dd453fe4a42109e590ac7`。不能将这组结果用作算法优劣比较：需先查图层识别、可见原图/背景和绑定是否对应，否则只是输入准备不同。下一步先输出该模型的图层识别与绑定，建立可比输入，再继续决定正式采用方案。

### 同一猫娘 PSD 的输入问题已定位

`ReferenceRender.java` 现输出逐图层 `layers.txt`。猫娘的左右眼白、虹膜和睫毛均被参考软件正确识别；另外有两个 UNKNOWN 图层，范围分别为整个 1280×1280 画布和几乎整个角色。仅在渲染的 includeLayerIds 中排除这两个图层，保留 PSD、模型和其余分类不变，得到 `reference-catgirl-parts-portable/open-{1.0,0.65,0.35,0.0}.png`。已看 0.35 和全闭：全闭现在出现弯曲的睫毛闭合线，虹膜消失；0.35 的虹膜只剩下方局部。全闭 SHA-256 为 `475a7db44eb83e1a64b234c87f10165a61c71d11f2684f442d53836588eb73e0`。前一组看似不闭眼是包含原图类图层造成的遮盖，不能归因于眼部算法。

该 PSD 的识别清单没有 EYE_CLOSE 图层，因此实际证明参考便携版能够只用原眼白、虹膜和睫毛制作闭合。它不证明闭合曲线在任意原画上都自然，也不证明我们的当前补充贴图方案已被替代。画面中睫毛仍有局部粗糙，需要连续与转向组合检查。

当前正式 eyes 入口与参考方法的直接差别已读到：`primary-part-agent.ts` 的 requestedAssets 强制请求 closed-eye；eye-assets 检查左右闭眼图齐全；blink-composite 检查原眼部全隐藏且闭眼图显示。此前实验又加了闭眼图自动重建网格。这些检查将一种素材方案误当成唯一制作成功条件。后续替换必须同步处理实际几何、渲染可见性、制作入口与素材请求，不能只改检查文字让它通过。保留已有手绘闭眼素材作为明确可选方案，并避免对旧模型默默叠加新旧两套眨眼变形。

### 原图闭合关键形生成器：已实现，尚未激活

新增 `packages/core/src/eye-closure-authoring.ts`，从纹理 alpha 计算笔画范围及逐列中心，填补透明列；原睫毛保持厚度，眼白压向共同曲线，输出现有 ModelBinding 可编辑的中立/闭合端点。参考来源是 PSD2Live 的闭合曲线和 alpha 中心线机制，TypeScript 为独立实现。它不读取补充闭眼图，也不重建网格。

3 个针对性测试通过：透明留白前后闭合结果一致；睫毛厚度保留且与眼白共用曲线；空白纹理和左右眼不匹配拒绝生成。core TypeScript 检查通过。这些仅验证生成器，不证明人物效果，也不证明正式 eyes 工作流完成。

尚未接入制作入口或默认渲染。必须继续处理显式几何/贴图模式、禁止重复默认压缩、闭眼素材可选、原模型自定义绑定保留，然后在猫娘上通过正式入口形成同 revision 对照。当前生成器按源图画布列采样；倾斜眼线、修改过的 UV/中立网格及已有造型叠加仍需处理或给出准确限制，不能宣称通用完成。

### 几何模式已接入运行计算，猫娘得到第一组实际结果

新增可校准、可序列化的图层 `blinkMode: geometry | texture`。geometry 模式保留眼白/虹膜/睫毛不透明，用关键形与现有遮罩完成闭合；忽略补充 eyeClosed 图并跳过实验性 blinkPoint，避免重复变形。未指定模式仍保持当前代码路径，故这不是此前全局实验已清理完成。4 项眼部测试通过，core 编译通过。

`render-alpha-closure.mjs` 在内存中以 candidate revision 4 构建提案，输出 `alpha-closure-proposal/proposal.json` 与 `eyes.png`，没有提交新 revision。已查看三行 yaw=-0.8/0/0.8、四列 blink=0/0.35/0.65/1 的局部画面：三种转向都能由原睫毛闭合，半闭虹膜被遮罩裁剪，全闭保持黑色睫毛弧；未使用补充闭眼贴图。局部弧线仍有折角，需继续处理和观察，不能当作动画通过。正式 eyes 入口、素材请求、旧绑定保留和连续运动检查仍未完成。

### 正式核心制作入口已保存 revision 5

`prepareEyeClosure` 已接入 `planPrimaryPartAgent/runPrimaryPartAgent`：读取实际纹理，配对左右眼白与睫毛，生成四个闭合绑定，保存 geometry 模式、虹膜遮罩及眨眼启用状态。制作不再重建补充闭眼网格，geometry 图层不再请求闭眼贴图；明确 texture 模式仍走原制作路径。已有非本功能创建的眨眼绑定会报明冲突并保留；本功能已创建的关键形再次制作时保留，不覆盖人工修形。当前检查针对直接图层眨眼绑定，父级自定义参数关联和多个眼部变体仍需完善。

猫娘副本通过该核心公开函数从 revision 4 保存到 revision 5，报告位于 `candidate/reports/agent/0005-23952ad0-c930-4859-a1c2-63a561d4fecc/report.json`。中立及其他图层中立位移为 0，四个绑定和自然闭眼表达已写入；`expressions-r5` 由保存的 revision 5 渲染。此处尚不是最终 CLI/桌面验证，CLI 构建身份需刷新。

新增整条制作流程测试，用没有 eyeClosed 图层的 semantic.psd 建项目、计划、保存并重读，确认闭眼素材请求消失、虹膜遮罩及模式落盘，再次运行不增加 revision，已有自定义眨眼不被改写。该测试已单独通过。

已将错误的闭眼网格包络实验源码归档至研究目录 `superseded-blink-experiment`，恢复未指定模式与 texture 模式的原有程序压缩及透明度过渡，geometry 模式保持独立。旧全局 0.96 硬切已取消。剩余工作包括眼线倾斜/局部折角、UV 与已修改网格适配、模式切回时既有闭合绑定的处理、连续动作及完整 CLI 验证，再继续脸部、嘴型、发束制作范围。

### UV 与中立网格修改的补偿

闭合生成器改为从各顶点 UV 取原图位置，并复用 mesh 的三角插值，只补偿眼白当前网格相对原始 UV 矩形的修改量。第一次直接把整个闭合位移映射到眼白网格，实际猫娘渲染出现睫毛变厚：眼白边界截住了位于其外侧的睫毛采样。随后修为当前网格与原始网格采样差值，原图闭合位移不受边界截断；重新查看正面全闭图，厚度恢复到此前几何方案。研究 proposal 图已重新生成，保存的 revision 5 未变。

新增剪切、缩放和平移眼白网格的测试，验证闭合方向随已有修改改变，中立关键形仍为空。该补偿尚不等同于完整的任意非线性网格、父级变形和原画眼线倾斜适配；不据此宣称所有编辑后模型兼容。core 编译通过。

### CLI 结构化入口重复执行

刷新 CLI 构建，源码身份前缀 `57c5904a71e7`。通过 `agent spec --scope eyes` 生成 revision 5 规格，填写保留现有闭合造型的目标和理由后，使用正式 `agent apply --spec eyes-spec-r5.json`。结果 `inputMode=structured-specification`、`fromRevision=5`、`toRevision=5`、无 blocker，报告为 `candidate/reports/agent-tasks/bb1b82fe-a0b8-469e-9178-9855fecffe5c/report.json`。这是正式 CLI 重复执行不改写已有关键形的证据，不代表最新 UV 补偿已覆盖 revision 5 的保留关键形，也不代表全部制作要求完成。

新增父级眨眼冲突检测，沿 deformer.parentId 查已有眨眼语义参数绑定，避免只检查图层而漏掉父级重复闭合。未知自定义语义、物理间接控制仍不能据此认定已覆盖。模式从 geometry 切回 texture 时绑定生命周期尚未完成，此项继续保留为明确待办。

### 模式切换保留关键形

后续 2026-09-08 整体制作对照与 Skill 同步已转入 `docs/LIVE2D_REFERENCE_COMPARISON.md`，包含实际参考九向图、前后代码与候选画面、脸部/头发/嘴部差异、已采用的方法、动态隔离检查暴露的问题及尚未完成项。不能把本文件此前某个局部通过状态当成整项任务完成。

ModelBinding 新增可选 blinkMode 条件，图层计算时仅激活与目标模式一致的绑定。自动闭合绑定标记 geometry，切为 texture 不参与计算，切回恢复原关键形；没有条件的旧自定义绑定不受影响。制作入口为本轮此前已生成的绑定补条件，不修改其 keyforms。副本通过核心制作入口从 revision 5 到 6，报告为 `candidate/reports/agent/0006-488ddc79-2ed3-4cf4-8372-dd8b426bd262/report.json`。此修订保留原造型，未更新 UV 补偿后的端点。

CLI 编译通过，构建身份前缀 `9730a1fd465e`；5 项生成器测试与 1 项完整制作测试通过，后者包含 geometry→texture→geometry 的实际关键形计算恢复。项目 Skill 的制作说明同步纠正强制补闭眼图的要求，但未将尚未检查的连续动画写成通过。手绘贴图的实际模式切换画面对照、眼角折线和连续动画仍需验证，然后继续其余制作范围。
