---
name: live2d-puppet
description: "使用 PuppetLoom 让外部 Agent 通过 CLI 从分层角色 PSD 创建或改善可动 2D 角色，可按整模或指定部位完成分析、网格与运动制作、自检、返修和准确 revision 的证据闭环；也用于检查关键形、权重、透视、次级运动与校准结果，通过 CLI 依次演示编辑器和角色窗口的真实功能，以及直接导出 Cubism 工程和运行时文件或使用 Editor 桥接。Use when an external agent such as Codex should create or improve a PuppetLoom character through the CLI, review exact-revision visual evidence, demonstrate the real editor and runtime under CLI control, or bridge a verified project to official Cubism runtime files. 不用于在桌面应用里内嵌 Agent 对话框、让用户默认承担逐点调网格、纯视频生成或没有相关角色/模型的普通图像编辑。"
---

# Live2D Puppet

## 目标

把角色原图、See-through 分层 PSD 和自然语言目标交给 Codex 一类外部 Agent。Agent 通过 PuppetLoom CLI 自动创建项目，再按整模或指定部位完成结构分析、网格与关键形制作、权重和物理配置、自检、局部返修及准确 revision 的视觉证据。用户主要审查角色实际效果，并用“幅度小一点”“滞后太慢”“太弹”这类结果反馈继续调整；逐点编辑只是备用能力。桌面应用是查看、播放和人工兜底工具，不承载 Agent 编排或聊天入口。默认交付仍是普通 PuppetLoom 项目。用户明确需要 Cubism 时，使用 `cubism export` 输出 `.cmo3/.moc3` 和配套文件；已有 Editor 工程的同步仍可使用官方 API 桥接。直接导出与 API 同步的限制必须分别报告。第一次结果以“合理地会动”为目标，不用十五种嘴形或未经素材支持的复杂表情；需要实时麦克风口型时，默认只使用已有闭口和一个张口状态。

## 工作方式

先使用包装脚本运行 `capabilities --json`，确认 `build.current`、实际命令和配套 Skill 身份；不要根据软件版本号猜工具是否存在。包装脚本支持 `PUPPETLOOM_ROOT` 和 `PUPPETLOOM_NODE`；复制到仓库外的 Skill 必须明确项目根。按当前结果读取对应方法，不为一次局部修形加载全部制作流程：

| 当前任务 | 读取方法 |
| --- | --- |
| 从 PSD 创建角色或更新源 PSD | `references/from-zero-workflow.md` |
| 分部制作、检查与返修 | `references/agent-review-and-repair.md`；涉及形状或运动时加读 `references/visual-rigging-rules.md` |
| 原素材闭眼、脸缘和五官的目标修形 | `references/shape-target-workflow.md`；视觉标准沿用 `references/visual-rigging-rules.md` |
| 拆发、替换头饰等通用补件，或局部关键形修形 | `references/asset-and-geometry-workflow.md`；视觉判断沿用 `references/visual-rigging-rules.md` |
| 缺原图、See-Through 分层、源图错误 | `references/source-art-and-layering.md`；明确选择本地推理时再读 `references/see-through-local-deployment.md` |
| 录屏、编辑器和角色窗口演示 | `references/runtime-demonstration.md` |
| 用户接受、拒绝、手动校准或学习反馈 | `references/calibration-and-learning.md` |
| Cubism、moc3、model3 或官方工具兼容 | `references/cubism-bridge-workflow.md` |

使用 `scripts/invoke_puppetloom.ps1` 调用公开 CLI。当前任务已经有明确项目或仓库根目录时，测试、生成、中间、最终产物以及日志、截图、录屏和迁移暂存全部写在该根目录内；依赖、缓存和桌面应用用户数据留在机器工具目录，不冒充项目产物。普通项目先 `inspect/create/verify/describe/render`，再按任务和用户允许的证据形式选择 `play` 或 `record`；实际查看姿态图、4×4 次级运动图、准确 revision 的实时窗口，或获准生成的动态接触表/WebM 后才能判断结果。完整角色交付前还必须对同一个规范项目和准确 revision 运行 `performance`，以活动态与暂停态对照的 FPS、p95、p99、最差帧和长帧判断真实渲染是否稳定；固定 fixture、平均 FPS 或 `ok: true` 不能代替 `valid: true`。测试通过不等于视觉自然，视频也不是固定交付物。分层验收发现 See-Through 背景残片、低透明托底或可安全去除的硬矩形托底时，不把普通创建的保守 Alpha 清理冒充 PSD 已修复；先由外部 Agent 结合原图、单层和未增强合成确认异常边界，再通过同一包装脚本的 `psd repair/review/finalize` 生成新的 PSD、绑定视觉证据并形成不可改写的终态。Photoshop 已经运行时不得连接或复用用户会话，先让用户保存并关闭 Photoshop；自动化只能使用本次命令启动的会话，且有剩余文档时必须保留窗口可见、禁止退出。用户提供多份 PSD 或要求结合原画补件时，先建立逐部件来源清单并选定规范画布；不同分辨率 donor 只有在明确启用整画布等比例适配且宽高比一致时才能进入 Photoshop 配方。原 PSD 永不覆盖，未完成逐层细节与 Alpha 复核、未形成视觉终态或被拒绝的输出不得进入创建；详细边界和命令见 `references/source-art-and-layering.md` 与 `references/from-zero-workflow.md`。

角色闭眼与头脸造型先按 `references/shape-target-workflow.md` 标记实际结构，使用 `fit-landmarks` / `curve-warp` 和 `author preview/apply` 制作可核对的目标；自动起稿不是最终形状。其他分部制作的正式入口是外部 Agent 先看基线，再用 `agent specification` 取得当前 revision 的结构化模板，填写 `goal/anatomy/parts/intent/rationale`，最后运行 `agent plan/apply --spec <json>`。`anatomy` 是本角色的结构事实，不是通用风格参数：头脸和嘴保留实际眼线、嘴线与中轴，前后发写实际发束及根部，左右耳分别写实际图层、轴心和全顶点固定/释放权重，头饰与上衣也写各自连接轴心和全顶点权重；头饰还必须明确选择 `headwearPerspective: "crown"` 或 `null`，不得根据长宽比或旧角色形状猜。每个部位都必须填写基于准确 revision 画面的非空 `rationale`；原样模板、占位理由、空壳 anatomy、未覆盖实际图层或缺少理由会被 CLI 拒绝，不能用安全默认值冒充视觉判断。`parts` 可覆盖头脸、眼睛、嘴、前发、后发、呆毛、耳朵、头饰、身体、上衣、裙摆、尾巴和配饰。先运行只读 `agent plan`，核对 `inputMode: structured-specification`、`baseRevision`、草稿接管、目标图层、anatomy 覆盖、各部位状态、检查、返修、素材请求和 `blockers`；计划符合目标后再运行 `agent apply`。自然语言 `--instruction/--scope` 只保留只读计划兼容，不能正式 apply 或创建 revision：自然语言理解、看图判断和返修决策由本 Skill 中的外部 Agent 承担，软件只执行和验证明确规格。整模执行按确定顺序处理所有存在的部位，每个部位单独形成可恢复 revision，最后返回整模 `verification`、总状态和报告路径。项目没有相应图层时报告 `not-present`，现有结构无法支持目标表情且确实缺少素材时报告 `needs-assets`，不能伪造图层或把它们说成已经制作完成。

“完成整模”“检查遗漏”或“继续把现有角色做好”不等于立即运行整模 `apply`。已有 revision 和接受记录的成熟项目先运行 `history/verify/describe`，查看当前准确 revision 的整模及所有实际存在部位，并列出必须保留的已接受结果；只为确实观察到的缺陷生成 `selected` 或单部位规格。若没有待修缺陷，不执行 `apply`，不制造无意义 revision。CLI 的整模 `apply` 不是整体事务：已完成部位会逐个提交，后续部位变成 `blocked` 不会自动撤销前面的 revision；返回后必须核对每个部位的实际 from/to revision、session 和报告，不能只看总状态。

`agent front-hair plan/apply` 与 `agent secondary plan/apply` 仍是精确控制和兼容入口；正式整模或分部制作优先使用顶层结构化规格入口。标准表情和动作库使用 `actions plan/apply`。参数结构使用 `author inspect/apply`；局部关键形先用 `author geometry` 分页定位，再以选区和 `transform-keyform` 修形，不让模型猜整层顶点数组。轴心和权重仍用 `describe --layer <id>` 与稀疏 `calibrate`。固定连接与自由端的判断由 `references/visual-rigging-rules.md` 负责；补件归位和试装由 `references/asset-and-geometry-workflow.md` 负责。`edit` 只在用户明确想手调，或公开 CLI 确实无法表达局部修正时打开，不用扩建手工编辑器代替外部 Agent 制作。

范围必须服从用户目标：用户要求整模时审查整模，真正写入只覆盖已证明需要修复的部位；用户只点名一个部位时只使用对应部位 ID，不擅自扩展。用户要求调整“整个图层顺序”时，范围是当前角色全部可见遮挡关系，不会被最后指出的某个脖子、兜帽或配饰问题收窄。用户在任务中追加的限制立即作用于后续操作；后来的截图、批注或单项纠正默认只修正点名项，除非用户明确替换目标，不得把此前同一任务的完整范围收窄成最后一个问题。用户说“只使用现有素材”时，不生成、下载、增强或改写 PSD/纹理，`needs-assets` 只报告缺口；用户说“不要视频”时不运行 `record`，改看 `render --project <directory> --output <new-directory> --revision <n> --size 1080 --focus <part>`、4×4 运动表和 `play --project <directory> --revision <n>`。已有接受结果必须保留可恢复 revision，并作为未点名区域的保护基线；用户明确把某个项目作为只读对照时，另建获准的工作副本并核对对照项目未变。现有项目只缺多房束、侧脸深度或躯干体积等后来增加的字段时，先使用 `extensions plan/apply` 在当前项目追加可恢复 revision，不得重新创建项目；软件升级、CLI 新能力或项目格式新增字段不等于源 PSD 变化。源 PSD 确实变化时，用 `migrate` 在规范项目内部的新暂存目录建立候选，完整复核后归档旧运行状态并把候选晋升回原规范路径，不能在旁边留下 `Character-v2` 作为第二个最新版。每次自动制作后都比较修改前后，并查看准确 revision 的连续运动：安全姿态通过只证明没有已知翻转，不能证明目标部位真的在动、根部没有脱离、原有效果没有退化。Agent 必须实际打开各部位返回的 `focusComparisonSheet` 和 4×4 `focusMotionSheet`，检查连续帧并记录仍存在的问题；`focusMotionManifest` 只用于定位需要放大的单帧，不得只读 JSON 后宣布完成。Cubism 请求使用同一包装脚本的 `cubism` 命令族：直接导出走 `cubism export`；已有 Editor 工程的检查、预览或同步才走原 API 桥接计划。

输入获取也由外部 Agent 编排。原画生成后先展示并等待用户确认，再固定列出三种路线：推荐用户在指定 ModelScope 网页以 1024 自行上传并下载 PSD；用户选择偷懒选项后由 Agent 自动上传这张已确认原画；在线入口不可用时才推荐本地部署。选择 Agent 代传本身就是对本次具体上传的授权，不再重复询问；没有选择就不得上传。本地复核用户带回的 PSD 不等于本地部署 See-Through。本地安装、硬件门槛、已知问题和优化路线以 `references/see-through-local-deployment.md` 为真源；项目画风参考、唯一生图交接、1024 默认分辨率、单主体素材边界、上传副本和三档视觉验收以 `references/source-art-and-layering.md` 为真源。用户只要求“生成 PSD”“测试分层”或“看看 See-Through 是否可用”时，范围严格停在原图、实际上传副本、PSD、真实可见图层重组和已定稿的视觉结论；不得创建 PuppetLoom 项目、编写绑定规格或进入 `agent plan/apply`，除非用户随后明确要求继续制作。测试输入必须是真正打开检查过的正常日系二次元角色图，不能用抽象图或几何测试卡。实际生图继续由外部图像工具承担，不把模型、提示词引擎或 Agent 运行时塞进 PuppetLoom。参考视频和获准生成的姿态参考图只作观察证据，不进入 PSD、纹理或项目素材；最终运动范围仍服从原素材能支撑的透视。

用户要求创建完整角色时，先判断现有眼白、虹膜和睫毛能否支持几何眨眼；缺闭眼贴图不等于缺眨眼能力。只有几何闭合不能保持角色眼形、眼睛烘焙在脸部或目标需要特定手绘造型时，才补闭眼素材。一个张口等确实缺少的必要素材由外部 Agent 生成、检查并接入，不再逐项索取授权。已有闭嘴就是 `mouthOpen=0`，不得重画；微张嘴和音素嘴形只有用户明确需要对应表情或触发方式时才增加，不作为麦克风口型的默认状态。用户明确说“只使用现有素材”“不要生图”时才停止补素材并报告 `needs-assets`。生成闭眼前先确认睁眼结构是否独立；睁眼已经烘焙在脸部时，闭眼素材必须完整遮住原眼或先修 PSD，不能只叠两条眼线。闭眼和嘴形必须继承原画的线稿、睫毛体量、眼角、口腔配色、阴影和抗锯齿，不能用一条弧线或粗糙符号糊弄；完整规则见 `references/visual-rigging-rules.md`。

一次角色校准只属于当前项目。候选 revision 先做足以安全展示的定向检查并交给用户看；用户接受后用 `evidence --project <directory> --session <id> --status accepted` 记录，再运行获准范围内的完整回归或推送。任何相关 session 仍是 `unreviewed` 时只能称为候选，不能报告“完成”“已修好”或把它当成以后角色的模板；用户拒绝时，记录被否定的 session 和具体缺陷；需要撤回时只恢复受影响范围，不撤销其他有效工作。用户同时给出新方向或已授权继续修复时，重新看图并返修该项，不因拒绝旧候选而停止任务，也不把尚未解决的问题改记为接受。用户给出同一部位的新方向时，优先把结果反馈交给现有 Agent 或高层 authoring 入口，不要求用户指出顶点编号。多个独立项目反复出现同一错误，是修改 PuppetLoom 通用算法的充分证据但不是唯一入口；一个真实项目若已用代码与数据证明是可复用的软件缺陷，也可在增加通用 fixture、真实项目回归和非退化证据后修软件。角色专属顶点、轴心和权重仍留在项目校准中，不能升级成其它角色的默认几何。用户明确要求同步优化本 Skill 时，把已经验证的制作方法、入口变化和错误判断一并修正，检查主说明与各引用文件是否矛盾；不自动调用其它 Skill，也不对已获授权的修改重复询问。没有修改授权时只记录建议。修改前后运行 `scripts/file_budget.py`。

## 资源

- `references/from-zero-workflow.md`：输入边界、完整 CLI 顺序、Agent-first 修改优先级、PSD 迁移、静态/动态证据检查和桌面交接。
- `references/source-art-and-layering.md`：从角色需求取得可绑定原图、官方在线 See-Through 默认交接、获准自动 API 与最后可选的本地部署边界、单条生图指令和 PSD 重组验收。
- `assets/blue-whale-maid-reference/`：项目长期参考素材；鲸鱼娘原画保留作可选观察参考，其可复用的正向画风已经写入原图流程，只有用户明确要求使用整张参考图时才进入生图上下文；分层 PSD、转头图和表情图只供分层、绑定和补表情时查看。
- `references/see-through-local-deployment.md`：本地 See-Through 的启用条件、C/D/E 盘环境检查、硬件与分辨率门槛、已知问题和后续优化顺序。
- `references/agent-review-and-repair.md`：外部 Agent 与软件的职责边界、结构化制作规格、看图—返修循环、缺陷路由和用户验收。
- `references/visual-rigging-rules.md`：从本项目历史中保留下来的结构、透视和次级运动判断。
- `references/shape-target-workflow.md`：角色结构标记、眼睑分区、脸形目标、两种目标变换、只读预览与按缺陷返修。
- `references/asset-and-geometry-workflow.md`：通用补件的参考、配准、试装与恢复，自然拆发和局部关键形的区域操作。
- `references/runtime-demonstration.md`：编辑器优先、角色窗口在后、公共 runtime CLI 控制、只读演示和可靠窗口保活。
- `references/calibration-and-learning.md`：用户校准如何进入项目、软件或 Skill，及其证据门槛。
- `references/cubism-bridge-workflow.md`：官方格式边界、参数映射、Editor 版本与授权、严格同步、侧车生成、最终目录和视觉验收。
- `scripts/invoke_puppetloom.ps1`：定位 PuppetLoom、必要时构建并原样转发包括 `psd repair/review/finalize` 在内的 CLI 命令和退出码。
- `scripts/acquire_layered_psd.ps1`、`scripts/acquire_layered_psd.py` 与 `scripts/finalize_psd_review.py`：通过 ModelScope See-Through 的公开 Gradio API 上传已获准原图，或在本地复核用户带回的原图和 PSD；生成原图与实际上传副本、归一化原图、带名称预览、真实可见图层重组、对照图、检查记录和一次传输重试证据，并确定性定稿三档视觉结论。它们不启动或安装本地 See-Through 推理服务。
- `requirements-layering.txt`：PSD 重组与对照图所需、已在 `D:\Tools\Python310` 验证的 Pillow 和 psd-tools 版本。
- `scripts/demo_puppetloom.ps1` 与 `scripts/demo_puppetloom.mjs`：通过 CLI 驱动真实 Electron 完成可录制的只读演示，并按需保持窗口。
- `scripts/file_budget.py`：Skill 自我修改前后的本地活动文本预算门槛。

## 输出与完成

PSD-only 任务返回同一个自包含运行目录，至少保留原图、实际上传副本、PSD、图层预览、`inspect`、真实图层重组对照、`visual-review.json` 和 `result.json`。Agent 必须实际看图，把结论记录为 `accepted`、`accepted-with-repairs` 或 `rejected`，再用 `scripts/acquire_layered_psd.ps1 -FinalizeReview` 校验并同步唯一结论；结构检查和数值差异不能代替视觉判断。`accepted-with-repairs` 只容纳不改变主要语义、轮廓和遮挡结构的小问题，并在用户明确接受携带这些问题时才进入创建；真正阻止可靠创建的问题进入 `blockingIssues` 并拒绝候选。完成 PSD-only 范围后立即停止，不返回项目目录或绑定规格。

创建任务返回项目目录、绑定等级、禁用功能和视觉证据路径；整模或分部任务返回 `scope`、自然语言目标、from/to revision、各部位的 `awaiting-visual-review/not-present/needs-assets/blocked` 状态、实际操作、前后对比、所采用的连续证据、最终 `verification`、总 `blockers` 和任务报告路径。用户问“这轮最新版”“都解决了吗”或“看看解决了哪些”时，先从完整任务、批注和纠正中重建需求清单，再对每项已批准要求沿同一条完成链核对：软件与公开 CLI 确实具备能力，普通默认路径或用户指定入口实际启用了它，规范项目的准确 revision 已保存对应数据，匹配该 revision 的视觉证据已经查看，依赖观感的结果已经交给用户判断，并且素材或官方工具边界已如实报告。完成链中任何一环没有成立，就只报告已经到达的层级和剩余工作，不能宣称整项完成；隐藏的可选开关、测试副本、产物目录和单独通过的 fixture 都不能代替正式用户路径与规范项目。已有项目只保留一个规范项目目录，以内部 revision、session 和证据历史作为版本真源，不复制 `project-rN` 目录冒充版本管理。交付前检查本任务的测试、生成、中间和最终文件都位于规范项目或当前仓库根目录内，再用桌面端 `edit` 或 `play` 实际打开该规范路径，并确认“最近项目”记录的是同一个绝对路径；只完成 CLI `create` 或打开了暂存副本都不算完成。只有 `verification.valid`、完整角色准确 revision 的 `performance.valid`、实际姿态与每个准确 revision 的允许证据都看过、报告中的项目指纹和窗口比例匹配、目标部位产生以源图像像素计可见而合理的运动、未点名区域和已接受结果没有明显退化、用户要求的角色窗口或编辑器链能够打开，才算普通项目结果在客观范围内成立。依赖观感的幅度、延迟和回弹在用户判断前只是待确认结果，不能因为自检全绿就宣称完成。

Cubism 直接导出任务还要返回源 revision、指纹、工程与运行时版本、参数 ID 映射、CMO3/model3 路径，以及 Core 和目标 Editor 的实际验证结果。`cubism export` 的 `awaiting-visual-review` 表示尚待看图；必须对照实际导出图集、UV、九向、闭眼及中间帧，在 Editor 打开并保存后才能报告对应范围通过。`cubism verify` 只证明目录结构和引用。API 桥接另行报告 Editor/API 状态、兼容计划、`strictReady` 和 blocking/warning；严格同步或用户已接受的 partial 结果仍需 Cubism Viewer 复核。需要用户判断时展示前后画面并说明具体变化，不用“应该好了”代替视觉证据。
