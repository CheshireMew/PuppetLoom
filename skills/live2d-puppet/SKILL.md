---
name: live2d-puppet
description: "使用 PuppetLoom 让外部 Agent 通过 CLI 从分层角色 PSD 创建或改善可动 2D 角色，可按整模或指定部位完成分析、网格与运动制作、自检、返修和准确 revision 的证据闭环；也用于检查关键形、权重、透视、次级运动与校准结果，以及通过 Cubism Editor 官方链路桥接运行时格式。Use when an external agent such as Codex should create or improve a PuppetLoom character through the CLI, review exact-revision visual evidence, or bridge a verified project to official Cubism runtime files. 不用于在桌面应用里内嵌 Agent 对话框、绕过 Cubism Editor 编译 moc3、让用户默认承担逐点调网格、纯视频生成或没有相关角色/模型的普通图像编辑。"
---

# Live2D Puppet

## 目标

把角色原图、See-through 分层 PSD 和自然语言目标交给 Codex 一类外部 Agent。Agent 通过 PuppetLoom CLI 自动创建项目，再按整模或指定部位完成结构分析、网格与关键形制作、权重和物理配置、自检、局部返修及准确 revision 的视觉证据。用户主要审查角色实际效果，并用“幅度小一点”“滞后太慢”“太弹”这类结果反馈继续调整；逐点编辑只是备用能力。桌面应用是查看、播放和人工兜底工具，不承载 Agent 编排或聊天入口。默认交付仍是普通 PuppetLoom 项目。用户明确需要 Cubism 时，再通过 Editor 官方导出的 `.moc3/.model3.json` 生成官方运行时目录，并把可自动同步、需要 Editor 完成和当前官方 API 无法写入的内容分开报告。第一次结果以“合理地会动”为目标，不用十五种嘴形或未经素材支持的复杂表情。

## 工作方式

每次开始先完整读取 `references/from-zero-workflow.md` 和 `references/agent-review-and-repair.md`。用户要求诊断或改善转头、上下看、脸部透视、头发、耳朵、呆毛、衣服、尾巴、呼吸、眨眼或嘴部时，再完整读取 `references/visual-rigging-rules.md`。用户提供了手动校准、接受/拒绝结果，或明确要求 Skill/软件从经验中学习时，再完整读取 `references/calibration-and-learning.md`。用户提到 Cubism、`.moc3`、`.model3.json`、官方格式、Editor External API、SDK 运行时或导出兼容时，再完整读取 `references/cubism-bridge-workflow.md`。

使用 `scripts/invoke_puppetloom.ps1` 调用公开 CLI。普通项目先 `inspect/create/verify/describe/render/record`，实际查看姿态图、次级运动图、动态接触表或 WebM 后才能判断结果；测试通过不等于视觉自然。

修改角色的正式入口是外部 Agent 先看基线，再用 `agent specification` 取得当前 revision 的结构化模板，填写 `goal/parts/intent/rationale`，最后运行 `agent plan/apply --spec <json>`。每个部位都必须填写基于准确 revision 画面的非空 `rationale`；原样模板、占位理由或缺少理由会被 CLI 拒绝，不能用安全默认值冒充视觉判断。`parts` 可覆盖头脸、眼睛、嘴、前发、后发、呆毛、耳朵、头饰、身体、上衣、裙摆、尾巴和配饰。先运行只读 `agent plan`，核对 `inputMode: structured-specification`、`baseRevision`、草稿接管、目标图层、各部位状态、检查、返修、素材请求和 `blockers`；计划符合目标后再运行 `agent apply`。自然语言 `--instruction/--scope` 只保留旧调用兼容，不是正式入口：自然语言理解、看图判断和返修决策由本 Skill 中的外部 Agent 承担，软件只执行和验证明确规格。整模执行按确定顺序处理所有存在的部位，每个部位单独形成可恢复 revision，最后返回整模 `verification`、总状态和报告路径。项目没有相应图层时报告 `not-present`，缺少闭眼或嘴形等可选素材时报告 `needs-assets`，不能伪造图层或把它们说成已经制作完成。

`agent front-hair plan/apply` 与 `agent secondary plan/apply` 仍是精确控制和兼容入口；正式外部 Agent 制作优先使用顶层结构化规格入口。只有 Agent 入口无法表达的高层结构才使用 `author inspect/apply`，只剩局部顶点、轴心或权重修正时才使用 `describe --layer <id>` 与稀疏 `calibrate`。`edit` 只在用户明确想手调，或公开 CLI 确实无法表达局部修正时打开，不用继续扩建手工编辑器代替外部 Agent 制作。

范围必须服从用户目标：用户要求整模时使用 `--scope whole`，用户只点名一个部位时只使用对应部位 ID，不擅自扩展。已有接受结果必须保留可恢复 revision；用户明确把某个项目作为只读对照时，另建获准的工作副本并核对对照项目未变。每次自动制作后都比较修改前后，并查看准确 revision 的连续运动：安全姿态通过只证明没有已知翻转，不能证明目标部位真的在动、根部没有脱离、原有效果没有退化。Agent 必须实际打开各部位返回的 `focusComparisonSheet` 和 4×4 `focusMotionSheet`，检查连续帧并记录仍存在的问题；`focusMotionManifest` 只用于定位需要放大的单帧，不得只读 JSON 后宣布完成。更新 PSD 必须用 `migrate` 创建新项目，不能覆盖旧项目。Cubism 请求使用同一包装脚本的 `cubism` 命令族，先读取兼容计划，再决定是只检查、临时预览、严格同步还是整理 Editor 导出文件。

只有原图而没有 PSD 时，若当前环境有可操作且可下载结果的 See-through 在线服务，使用浏览器完成分层并检查重新合成；服务不可用、格式改变或必须由用户登录时，明确停在这个边界，不伪造 PSD。只有 PSD 时可以创建，原图只是重组一致性参考。不得把参考视频复制进角色项目，除非用户明确要求它成为素材。

一次角色校准只属于当前项目。用户拒绝某次修改时，必须把相关 session 标为 `rejected`，恢复已接受 revision，复核恢复结果并停止继续猜测；用户给出同一部位的新方向时，优先把结果反馈交给现有 Agent 或高层 authoring 入口，不要求用户指出顶点编号。多个独立项目反复出现同一错误，才考虑修改 PuppetLoom 自动绑定并增加测试；Agent 路由或判断反复出错，且用户明确要求改进未来行为时，才通过 `$meta-skills` 修改本 Skill。任何自我修改前后都运行 `scripts/file_budget.py`，修改方案先向用户说明并获得确认。

## 资源

- `references/from-zero-workflow.md`：输入边界、完整 CLI 顺序、Agent-first 修改优先级、PSD 迁移、静态/动态证据检查和桌面交接。
- `references/agent-review-and-repair.md`：外部 Agent 与软件的职责边界、结构化制作规格、看图—返修循环、缺陷路由和用户验收。
- `references/visual-rigging-rules.md`：从本项目历史中保留下来的结构、透视和次级运动判断。
- `references/calibration-and-learning.md`：用户校准如何进入项目、软件或 Skill，及其证据门槛。
- `references/cubism-bridge-workflow.md`：官方格式边界、参数映射、Editor 版本与授权、严格同步、侧车生成、最终目录和视觉验收。
- `scripts/invoke_puppetloom.ps1`：定位 PuppetLoom、必要时构建并原样转发 CLI 命令和退出码。
- `scripts/file_budget.py`：Skill 自我修改前后的本地活动文本预算门槛。

## 输出与完成

创建任务返回项目目录、绑定等级、禁用功能和视觉证据路径；整模或分部任务返回 `scope`、自然语言目标、from/to revision、各部位的 `completed/not-present/needs-assets/blocked` 状态、实际操作、前后对比、动态证据、最终 `verification`、总 `blockers` 和任务报告路径。只有 `verification.valid`、实际姿态与每个准确 revision 的动态证据都看过、报告中的项目指纹和窗口比例匹配、目标部位产生可见而合理的运动、未点名区域没有明显退化、用户要求的角色窗口或编辑器链能够打开，才算普通项目结果在客观范围内成立。依赖观感的幅度、延迟和回弹在用户判断前只是待确认结果，不能因为自检全绿就宣称完成。

Cubism 任务还要返回源 revision、Editor/API 状态、兼容计划、`strictReady`、blocking/warning、最终 model3 路径和结构验证结果。`.moc3` 必须来自 Cubism Editor；`cubism verify` 通过只证明目录结构、引用、JSON、纹理和文件头，不证明内部顶点或视觉等价。只有严格计划成立，或者用户明确接受并保留 partial 记录，且 Cubism Viewer 实际打开并完成人工动作复核，才能按相应范围交付。需要用户判断时展示前后画面并说明具体变化，不用“应该好了”代替视觉证据。
