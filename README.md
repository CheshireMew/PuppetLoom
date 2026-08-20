# PuppetLoom

PuppetLoom 把一份分层角色 PSD 创建为会自主运动、可以继续由外部 Agent 或用户校准的 2D 角色项目。自动创建不要求用户绘画、手工绑点或制作动作：程序先识别图层，推导关键点和网格，验证 13 个姿态，必要时缩小动作或切换到更保守的绑定。Codex 一类外部 Agent 可以通过 CLI 对整模或指定部位完成制作、自检、返修和证据审查，也可以用事务式高层操作增加参数、关键形态、变形器、表情、参数物理和行为；桌面应用负责查看、播放和人工兜底，不内嵌 Agent 对话。两条编辑路径共用修订、证据、安全检查和运行时，最后都能在透明桌面窗口中运行。

角色会呼吸、左右观察、抬头和低头，视线先于头部；脖子与上半身和头部同时进入姿态，头发、发饰、衣摆和尾巴才按各自重量延后响应。自主时间线把这些动作组织成可辨认的短段落，不把多个方向混成无意义摇摆；鼠标跟随时仍保留可见的自主头部动作，光标越远才越明确地接管朝向。三态嘴形齐全时，角色偶尔以数次长短不同的开合组成一句短促说话动作，而不是长时间维持同一个张口形状；缺少任一嘴形时嘴部保持闭合。没有闭眼素材时也不会伪造眨眼。

## 当前能力

- 导入扁平或分组 PSD，保留所有可见像素图层、顺序、透明度、坐标和混合模式记录；未知图层照常绘制。导入预检会列出每层 Alpha 连通域、确定噪点、疑似绘画细节和实际拆分依据。创建项目时默认只移除透明度很低、范围极小且与主体断开的高置信度噪点，眼睛高光、细发丝和装饰等不确定区域继续保留；源 PSD 始终原样保存。
- 识别中、英、日常见图层名称，合并的左右眼部图层优先按连通区域及脸部中心拆分；像素粘连时才退回中心切分，并在报告中降低置信度。
- 自动生成语义、分组和最保守三档绑定；语义项目会从实际图层 Alpha 定位 23 个脸部、眼角、嘴角、头骨和颈部控制点，检查顺序、包含关系与连接关系，并在置信度允许时自动修正异常点。除损坏 PSD 或完全没有可见像素外，总会尝试给出安全结果。
- 沿图层 Alpha 轮廓自动生成可包含孔洞和多个断开部件的不规则 ArtMesh；WebGL2 使用实际三角拓扑变形，规则矩形控制网只保留给 Warp Deformer、完全不透明矩形图层和旧项目兼容。
- v4 项目格式支持标准和自定义参数、一维/二维关键形态、旋转/网格变形器层级、命名表情、通用参数物理与循环/自动播放行为；旧 v1/v2/v3 项目读取时在内存迁移，原文件和校准哈希不被改写。
- 自动验证中立姿态和 12 个运动姿态，检查网格翻转、过度拉伸、眼睛越界、脸发分离、颈部断开和画布越界。
- CLI、使用一体化无边框外壳的 PSD 创建与编辑桌面界面，以及透明、无边框、置顶的角色窗口。创建器与编辑器共用可拖动的应用标题栏和原生最小化、最大化、还原、关闭能力；编辑器支持图层显示/锁定/父级/顺序、控制点、身体锚点、图层轴心、次级锚点、网格密度、软选择网格、脸部/头骨/头部/身体/视线/次级运动逐顶点权重、动作范围和分部响应参数；角色窗口支持拖动、缩放、暂停、置顶、鼠标穿透、系统级鼠标跟随、摄像头面捕、麦克风口型、表情动作触发和 WebM 表演录制。
- 每次校准都保存为新修订，并生成姿态、次级运动、修改前后拼图和像素差异图。用户可以接受或拒绝一次修改，Agent 可以读取同一证据继续迭代，不需要猜测界面中发生了什么。
- `agent specification` 为当前 revision 生成结构化制作模板；外部 Agent 看图并理解自然语言后填写部位、数值意图和理由，再由 `agent plan/apply --spec` 确定性制作。每个部位独立提交并生成局部前后对比和连续运动证据，最后返回整模验证与阻断项；软件不靠关键词替代 Agent 的理解和审美判断。
- CLI 可以读取任一修订的完整顶点、作用权重和透明区域拓扑，为准确修订录制透明动态证据，并把更新后的 PSD 迁移到独立新项目而不覆盖旧项目。
- `author inspect/apply` 让 AI 用高层操作事务修改同一个模型，自动为关键形态、表情、物理和行为生成前后预览；`export` 把当前有效修订烘焙成经过验证的新项目目录，不压缩、不覆盖现有目录。
- 本机回环控制服务和 `runtime` CLI 允许外部 Agent、输入设备或自动化脚本按来源、优先级、混合权重和 TTL 驱动角色；摄像头、麦克风、快捷键与外部控制可录成可确定性回放的 JSON。`actions` 为现有角色补齐标准表情、点头摇头、鞠躬、观察、短说话、身体弹动、挥手和踏步，并保留为可恢复 revision。
- 头部姿势壳层按转向动态收窄远侧眼睛并降低远侧眉、耳和侧发可见度；近远侧发的绘制深度可随方向交换。头脸 Agent 规格可以明确轮廓、深度、遮挡起点和远侧部件保留量。
- 前发、后发和侧发会从真实下缘轮廓识别多条房束，保存每条房束的发根、发梢、顶点归属、释放曲线、置信度与独立弹簧；头皮吸附和物理释放是可编辑的逐顶点权重。侧脸使用额头、鼻根、鼻尖、上下唇和下巴六个语义深度点；躯干体积曲线仅在角色或服装确实需要时显式启用。
- `benchmark` 用带素材用途声明和 revision 锁定的清单批量验证真实角色，报告项目指纹、源文件与历史、语义覆盖、ArtMesh、表情动作、13 姿态、壳层和遮挡。仓库只提供框架，真实素材由使用者按授权登记。
- Cubism 官方桥接会生成 exp3/motion3/physics3/cdi3，连接 Editor 读取和事务同步公开 API 可写结构，再以 Editor 官方导出的 moc3/model3 为真源生成新运行时目录；ArtMesh 顶点和 Warp 控制点不能由当前官方 API 写入时会明确阻断完整兼容结论。
- 缺少闭眼或三态嘴形素材时生成精确裁切图和 Agent 请求单；新的自然闭口层通过后才停用原 PSD 淡嘴层，错误补图不会覆盖安全回退。

## 环境与安装

当前只验收 Windows。需要 Node.js 24 或更高版本、npm 11，以及支持 WebGL2 的显卡。

```powershell
cd E:\Code\PuppetLoom
npm install
npm run build
```

仓库的 `.npmrc` 已把 npm 缓存指定到 `D:\Tools\npm-cache`。项目不生成安装包；开发阶段直接运行编译产物。

## 使用桌面应用

双击仓库根目录的 `启动PuppetLoom.cmd` 即可打开。它会把用户数据、缓存和启动日志放在 `D:\Tools\PuppetLoom`，缺少编译产物时自动构建；启动失败会显示明确错误和日志路径。开发时也可以运行：

```powershell
npm run desktop
```

拖入 See-through 在线版生成的 PSD；原始角色图可选，只用于检查重新合成是否改变角色。右侧会先显示 Alpha 连通域、自动清理的高置信度噪点、保留的疑似绘画细节、智能拆分和回退拆分数量。默认创建不需要勾选清理：程序自动移除高置信度噪点并保留不确定细节；只有高级排查时才勾选“保留所有高置信度 Alpha 噪点”。复制到项目中的源 PSD 始终不修改。选择一个新目录或空目录后点击“创建角色项目”。程序先在旁路目录完整生成并强验证，最后一次性发布到目标目录；失败时不会把半成品伪装成项目。创建完成后可以进入绑定与校准编辑器，也可以直接打开透明角色窗口。首页只显示仍然存在的正式项目，并以项目目录名显示通用的内部名称。窗口顶部属于 PuppetLoom 自己的一体化界面，可以拖动窗口并执行最小化、最大化、还原和关闭；编辑器中的关闭仍会先刷新未提交草稿。

编辑器左侧是可显示、锁定和分层的图层树，中间直接查看角色、当前姿态及修改证据，右侧调整属性。控制点和网格顶点既可拖动，也可聚焦后用方向键微调，按住 Shift 使用较大步长。规则网格升级为 ArtMesh 时每次只处理当前图层，先检查中立与九向姿态再保存；核心保存层会拒绝一次重建多个图层，也会拒绝视觉差异过大的单层重建。未提交修改会自动保存到项目草稿；返回主页、直接关窗或重启软件后都可以继续。恢复历史或自动绑定前必须先保存或明确放弃草稿，避免静默丢失。点击“保存校准”才生成正式修订；保存会校验调用方看到的基线 revision，并在跨进程写入锁内先生成完整证据，最后只切换一次当前版本。失败或并发冲突不会推进 revision。每次保存都保留前一修订和修改前后证据，可以在修改前、修改后、分割、叠加和差异五种视图间切换；“恢复”会生成新的可追踪修订，不会删除历史。编辑器顶部可直接运行当前角色，不需要返回创建页。

鼠标穿透启用后，可在创建窗口中恢复，也可以按 `Ctrl+Shift+P` 让所有穿透中的角色窗口重新接收鼠标。

角色窗口默认使用自主观察，不会因为光标静止在屏幕中央而看起来“头不动”。需要互动时可以点击“自主”开启系统级鼠标跟随：角色以自动定位出的脸部中心为观察原点，眼睛先看向光标，头部平滑追随，脖子和上半身以较小幅度同时进入同一姿态；即使开启鼠标穿透也能继续跟随。鼠标停在角色附近时仍保留明显的待机头部动作，移到远处后光标朝向逐步取得主导。创建窗口也提供同一远程开关。

角色窗口的摄像头按钮使用本机 MediaPipe Face Landmarker 完成短暂中立校准和连续驱动；麦克风按钮使用带噪声门的音量包络控制口型。JSON 按钮记录的是摄像头、麦克风、快捷键和外部来源的控制事件，可再次回放；视频按钮录制的是用户真正看到的透明角色最终画面，保存为 WebM，麦克风已开启时同时带音轨。视频按 1 秒分块写入 `reports/performances`，正常停止生成 `.webm` 与报告；窗口意外关闭时保留 `.partial.webm` 和中断报告，不静默删除。表情与动作按钮会列出当前项目实际具有的能力，`Ctrl+Shift+1…4` 触发前四个表情，`Ctrl+Shift+5…8` 触发前四个动作。

同一项目已经运行时，再次启动不会叠加第二个透明窗口；程序会把原窗口带到前面，并自动退出鼠标穿透状态。开发工作区中的 `启动角色.cmd` 只是调用这一入口的本机快捷脚本，不包含角色数据。

## 使用 CLI

```powershell
node apps\cli\dist\index.js inspect --input character.psd --json
node apps\cli\dist\index.js create --input character.psd --reference character.png --output E:\Puppets\MyCharacter --seed 42 --json
node apps\cli\dist\index.js create --input character.psd --output E:\Puppets\MyCharacterWithAllNoise --preserve-alpha-noise --seed 42 --json
node apps\cli\dist\index.js create --input character.psd --output E:\Puppets\MyAggressivelyCleanedCharacter --clean-alpha --seed 42 --json
node apps\cli\dist\index.js verify --project E:\Puppets\MyCharacter --json
node apps\cli\dist\index.js describe --project E:\Puppets\MyCharacter --json
node apps\cli\dist\index.js describe --project E:\Puppets\MyCharacter --layer layer-000-front-hair --revision 0 --json
node apps\cli\dist\index.js agent specification --project E:\Puppets\MyCharacter --scope whole --json
node apps\cli\dist\index.js agent plan --project E:\Puppets\MyCharacter --spec E:\Puppets\rig-spec-r0.json --json
node apps\cli\dist\index.js agent apply --project E:\Puppets\MyCharacter --spec E:\Puppets\rig-spec-r0.json --json
node apps\cli\dist\index.js author inspect --project E:\Puppets\MyCharacter --json
node apps\cli\dist\index.js author apply --project E:\Puppets\MyCharacter --patch E:\Puppets\authoring.json --json
node apps\cli\dist\index.js render --project E:\Puppets\MyCharacter --output E:\Puppets\Evidence --suite calibration --size 960 --focus headFace --json
node apps\cli\dist\index.js record --project E:\Puppets\MyCharacter --output E:\Puppets\MotionEvidence --mode autonomous --revision 0 --json
node apps\cli\dist\index.js calibrate --project E:\Puppets\MyCharacter --patch E:\Puppets\change.json --json
node apps\cli\dist\index.js compare --project E:\Puppets\MyCharacter --from 0 --to 1 --output E:\Puppets\Compare --json
node apps\cli\dist\index.js history --project E:\Puppets\MyCharacter --json
node apps\cli\dist\index.js history --project E:\Puppets\MyCharacter --full --json
node apps\cli\dist\index.js restore --project E:\Puppets\MyCharacter --revision 0 --base-revision 3 --json
node apps\cli\dist\index.js edit --project E:\Puppets\MyCharacter
node apps\cli\dist\index.js enhance --project E:\Puppets\MyCharacter --assets E:\Puppets\MyCharacter\supplements --json
node apps\cli\dist\index.js migrate --project E:\Puppets\MyCharacter --input character-v2.psd --output E:\Puppets\MyCharacter-v2 --json
node apps\cli\dist\index.js export --project E:\Puppets\MyCharacter --output E:\Puppets\MyCharacter-portable --json
node apps\cli\dist\index.js extensions plan --project E:\Puppets\MyCharacter --torso-volume --json
node apps\cli\dist\index.js extensions apply --project E:\Puppets\MyCharacter --torso-volume --label "接入新绑定扩展" --json
node apps\cli\dist\index.js actions plan --project E:\Puppets\MyCharacter --json
node apps\cli\dist\index.js actions apply --project E:\Puppets\MyCharacter --json
node apps\cli\dist\index.js runtime inspect --json
node apps\cli\dist\index.js runtime set --viewer 1 --source agent-demo --head-yaw 0.5 --ttl 1000 --json
node apps\cli\dist\index.js runtime trigger --viewer 1 --source agent-demo --behavior action-wave-left --json
node apps\cli\dist\index.js benchmark validate --manifest benchmarks\real-characters\corpus.json --json
node apps\cli\dist\index.js cubism plan --project E:\Puppets\MyCharacter --json
node apps\cli\dist\index.js cubism handoff --project E:\Puppets\MyCharacter --output E:\Puppets\MyCharacter-cubism-handoff --json
node apps\cli\dist\index.js cubism editor inspect --json
node apps\cli\dist\index.js cubism editor validate --project E:\Puppets\MyCharacter --stage pre-sync --json
node apps\cli\dist\index.js cubism editor preview --project E:\Puppets\MyCharacter --pose left --json
node apps\cli\dist\index.js cubism editor sync --project E:\Puppets\MyCharacter --json
node apps\cli\dist\index.js cubism finalize --project E:\Puppets\MyCharacter --editor-model E:\CubismExport\MyCharacter.model3.json --output E:\Puppets\MyCharacter-cubism-runtime --json
node apps\cli\dist\index.js cubism verify --model E:\Puppets\MyCharacter-cubism-runtime\MyCharacter.model3.json --json
node apps\cli\dist\index.js play --project E:\Puppets\MyCharacter --revision 0
```

所有确定性命令都能返回 JSON。`extensions plan/apply` 专门把多房束头发、六点侧脸深度和显式躯干体积曲线接入现有项目的下一条可恢复 revision，不需要新建项目；不存在对应图层时会明确跳过，不伪造部件。`agent specification` 生成外部 Agent 要结合画面填写的 revision 固定模板；`agent plan --spec` 只读返回整模或分部计划，`agent apply --spec` 为每个存在的部位建立独立可恢复 revision，并返回局部证据、跨部位一致性检查和最终 `verification`；已接受的前发、头脸—眼睛—头饰结构链、腰部连接和尾根连接会作为整模约束，违反时不会把结果当作完成。`describe` 提供可调整的稳定 ID 和坐标；`author` 提供当前参数图和带 `baseRevision` 的高层事务；`calibrate` 只接受经过结构、安全和并发基线验证的稀疏修改；`restore` 同样要求 `--base-revision`。`history` 默认只输出适合人和 Agent 浏览的修订摘要，需要完整补丁时再使用 `--full`。`render` 与 `compare` 为 Agent 和用户生成同一套视觉证据；`render --size 300..1600 --focus <scope>` 可额外生成原生高清局部姿态证据，避免从低清整图放大后判断细节。只要成功生成任一绑定等级，`create` 就返回 0；无效输入或校准补丁返回 2；文件系统、项目或运行时错误返回 3。详细流程见 [Agent 调用说明](docs/AGENT_USAGE.md) 和 [版本与产物管理](docs/VERSIONING.md)。

## 项目目录

PuppetLoom 输出普通目录，不使用私有压缩包：

```text
MyCharacter/
  puppetloom.json
  calibration/current.json
  calibration/draft.json
  calibration/sessions/*.json
  source/source.psd
  source/reference.png        # 仅在提供原图时存在
  textures/*.png
  reports/build-report.json
  reports/neutral.png
  reports/pose-sheet.png
  reports/calibration/<operation-id>/operation.json
  reports/calibration/<operation-id>/evidence/before-after.png
  reports/calibration/<operation-id>/evidence/difference.png
  reports/input-sessions/*.runtime-input.json
  reports/performances/*.webm
  reports/performances/*.performance.json
  reports/semantic-cage-head.png
  reports/landmark-report.json
  requests/asset-requests.json
  requests/references/*.png
  supplements/
```

格式字段和兼容约定见 [项目格式](docs/PROJECT_FORMAT.md)，Cubism 的真实支持范围与完整导出步骤见 [Cubism 官方格式桥接](docs/CUBISM_BRIDGE.md)，编辑操作见 [校准编辑器说明](docs/EDITOR_GUIDE.md)，本次对官方 Ren Foster 项目在功能、界面和工作流上的实机结论见 [Cubism 5.3 编辑体验对标](docs/CUBISM_EDITOR_BENCHMARK.md)，Agent 与用户如何通过同一证据迭代见 [校准证据说明](docs/CALIBRATION_EVIDENCE.md)，包边界与运行链见 [架构说明](docs/ARCHITECTURE.md)。转头与分层跟随的实现依据见 [统一姿态模型](docs/COHERENT_POSE_MODEL.md)，第三个视频项目中哪些机制被采用、哪些没有采用见 [视频参考结论](docs/VIDEO_REFERENCE_FINDINGS.md)，两套 Live2D 运行模型提供了哪些可迁移的运动关系见 [Live2D 运动参考结论](docs/LIVE2D_MOTION_REFERENCE.md)。

## 验证

```powershell
npm run build
npm run typecheck
npm test
npm run test:e2e
npm run test:launcher
npm run test:real-project
npm run test:motion-evidence
npm run test:visual
npm run test:performance
npm run artifacts:report
```

`typecheck` 和 `test` 都会先构建当前核心与渲染源码，不会读取上一次遗留的声明文件得到假绿；仓库也有同一套 Windows CI。运行产物在写入前检查总预算和磁盘余量，每轮先写 `run.json`，结束时记录完整清单与 SHA-256。`artifacts:report` 只报告旧产物和可处置候选，不自动删除。测试 PSD 全部由脚本生成，不包含用户角色或来源不明的示例素材。视觉检查直接读取 WebGL 画布的 Alpha 和前后帧；性能检查使用 1280×1280、23 层项目在当前机器连续采样。详见 [测试说明](docs/TESTING.md) 和 [验收记录](docs/VALIDATION.md)。

## 许可证与致谢

PuppetLoom 使用 [Apache License 2.0](LICENSE)。借鉴项目、依赖用途和完整致谢见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。仓库不提交用户角色图或下载的第三方角色样例。
