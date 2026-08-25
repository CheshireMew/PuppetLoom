<!-- readme-header:start -->

<p align="center">
  <img src="./assets/readme/logo.svg" width="112" alt="PuppetLoom">
</p>

<h1 align="center">PuppetLoom</h1>

<p align="center">
  <strong>把分层角色 PSD 变成可自动制作、可验证、可继续校准的 2D 动态角色。</strong>
</p>

<p align="center">
  <strong>中文</strong> · <a href="./README.en.md">English</a> · <a href="./README.ja.md">日本語</a> | <a href="./docs/AGENT_USAGE.md">文档</a> | <a href="./CONTRIBUTING.md">贡献</a> | <a href="https://github.com/CheshireMew/PuppetLoom/issues">反馈</a>
</p>

<p align="center">
  <a href="https://x.com/0xCheshire" title="X"><img src="https://img.shields.io/badge/X-%400xCheshire-000000?logo=x&amp;logoColor=white" alt="X：@0xCheshire"></a>
  <a href="https://t.me/CheshireBTC" title="Telegram"><img src="https://img.shields.io/badge/Telegram-CheshireBTC-26A5E4?logo=telegram&amp;logoColor=white" alt="Telegram：CheshireBTC"></a>
  <a href="https://blog.blacknico.com/" title="Blog"><img src="https://img.shields.io/badge/Blog-blog.blacknico.com-2E7D32?logo=rss&amp;logoColor=white" alt="博客：blog.blacknico.com"></a>
  <a href="https://blacknico.com/" title="Homepage"><img src="https://img.shields.io/badge/Home-blacknico.com-1F6FEB?logo=googlechrome&amp;logoColor=white" alt="个人主页：blacknico.com"></a>
</p>

<p align="center">
  <a href="https://github.com/CheshireMew/PuppetLoom/stargazers"><img src="https://img.shields.io/github/stars/CheshireMew/PuppetLoom?style=flat" alt="GitHub Stars"></a>
  <a href="https://github.com/CheshireMew/PuppetLoom/forks"><img src="https://img.shields.io/github/forks/CheshireMew/PuppetLoom?style=flat" alt="GitHub Forks"></a>
  <a href="https://github.com/CheshireMew/PuppetLoom/blob/main/LICENSE"><img src="https://img.shields.io/github/license/CheshireMew/PuppetLoom?style=flat" alt="Repository License"></a>
</p>

<!-- readme-header:end -->

<p align="center">
  <img src="./assets/readme/puppetloom-cover-v2.png" width="100%" alt="PuppetLoom：让分层角色动起来">
</p>

## 从分层 PSD 到可以持续制作的角色

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="分层 PSD 经过结构化绑定、revision 证据，成为可自主运动的 2D 角色">
</p>

PuppetLoom 是一套 Windows 桌面应用、确定性 CLI、普通目录项目格式和外部 Agent Skill。它读取分层角色 PSD，生成保守的初始绑定，验证中立姿态和 12 个运动姿态，把每次修改保存为可恢复 revision，最后在透明桌面窗口中运行。桌面应用负责创建、查看、播放和人工兜底；外部 Agent 通过公开 CLI 与仓库内 Skill 制作和返修角色，软件内部不增加 Agent 对话或隐藏的模型调用。

第一次结果追求的是“在现有素材能支持的范围内合理地会动”。PuppetLoom 软件本身不会用参数伪造缺少的闭眼或嘴形；完整 Agent 制作流程可以按原画风格补齐真正缺少的表情素材，已有闭嘴不会重画。动作不安全时会缩小范围或阻断；每次校准都先生成证据，再切换当前 revision。

## See-Through 与效果边界

PuppetLoom 从单张原画开始的自动流程建立在 [See-Through](https://github.com/shitagaki-lab/see-through) 提供的动漫角色分层能力之上。See-Through 把确认后的原画转换为带原始画布坐标和透明通道的分层 PSD，是原画进入 PuppetLoom 结构分析、绑定和验证的重要的一环。我们感谢 See-Through 作者及其论文 [“See-through: Single-image Layer Decomposition for Anime Characters”](https://arxiv.org/abs/2602.03749)。PuppetLoom 不内置或再分发 See-Through 的代码与模型；默认使用官方在线演示，只有在线入口不可用且用户主动选择时才考虑本地部署。

PuppetLoom 的目标是用自动化流程较快得到效果不错、可以使用、够用的简单 2D 动态角色，但它不等于专业定制 Live2D。自动分层和自动绑定难以替代画师对遮挡托底、表情素材和可动结构的专门设计，也难以替代建模师对大角度转头、精细网格、复杂物理和演出节奏的逐项打磨。需要更高完成度时，应找专业角色画师和 Live2D 建模师制作。

## 你能得到什么

| 你要完成的事 | PuppetLoom 交付的结果 |
| --- | --- |
| 从 PSD 创建角色 | 图层预检、Alpha 连通域与噪点判断、语义控制点、不规则 ArtMesh、保守绑定，以及强验证通过后才发布的普通项目目录。 |
| 让角色自然地待机和运动 | 呼吸、视线先行的转头、颈部与上半身跟随、按重量延迟的头发/服装/尾巴，以及由短动作段落组成的自主时间线。 |
| 让外部 Agent 制作或返修 | 结构化规格 → 只读计划 → 分部执行；每个部位返回准确 revision、局部前后对比、连续运动表、阻断项和最终验证。 |
| 自己检查和微调 | 可编辑图层、轴心、网格、权重与响应参数的桌面编辑器；草稿可恢复，保存、接受、拒绝和恢复都会留下历史。 |
| 驱动和录制角色 | 鼠标、摄像头、麦克风、快捷键和外部来源按优先级、混合权重与 TTL 合成；保存可回放输入 JSON 和可恢复 WebM。 |
| 批量管理角色 | 制作中心统一处理单图分层任务、多项目体检、能力缺口、环境检查和更新；跨项目分析只从重复问题与已接受证据提出候选。 |
| 做直播与演出 | 左右眼、眉毛、笑容、脸颊、A/I/U/E/O、上半身和双手输入；服装/道具/预设、碰撞约束、非破坏 Take 以及 OSC/VMC、MIDI、手柄和控制面板适配。 |
| 发布到网页或 OBS | 导出透明 Web/OBS 目录和单文件 Web SDK；状态与动作可以继续由网页 API 控制。 |
| 交给 Cubism | exp3、motion3、physics3、cdi3 侧车，官方 API 可写结构的检查与同步，以及以 Editor 导出 moc3/model3 为真源的新运行时目录。 |

项目保留 PSD 的可见图层、顺序、坐标、透明度和混合模式记录，支持标准/自定义参数、一维与二维关键形态、变形器、表情、参数物理和具名行为。头部转向会收窄并移动远侧眼睛，但眼睛和眉毛始终保持完全不透明；只有耳朵、侧发等外围部件会在接近脸缘时降低可见度，近远侧发的绘制深度也可以随方向交换。

对于现有项目，`extensions plan/apply` 可以用下一条可恢复 revision 接入多房束头发、六点侧脸深度和显式躯干体积曲线，不必重新创建项目。`actions plan/apply` 按真实图层补齐标准表情、点头、摇头、鞠躬、观察、短说话、身体弹动、挥手、踏步、耳朵轻弹和尾巴摇摆，并逐部位报告已完成、不存在或缺少素材。

## 快速开始

当前只验收 Windows x64。普通用户可以使用项目生成的 NSIS 安装器；从源码运行需要 Node.js 24 或更高版本、npm 11，以及支持 WebGL2 的显卡。

```powershell
git clone https://github.com/CheshireMew/PuppetLoom.git
cd PuppetLoom
npm ci
npm run build
npm run desktop
```

仓库根目录的 `启动PuppetLoom.cmd` 提供同一桌面入口，缺少编译产物时会自动构建。用户数据、缓存和日志写入配置的 PuppetLoom 数据根，不把本机状态混进仓库。

## 创建并运行一个角色

1. 把分层角色 PSD 拖入创建窗口。原始角色图可选，只用于比较重新合成是否改变角色。
2. 查看 Alpha 连通域、高置信度噪点、保留的疑似绘画细节，以及自动拆分和回退拆分结果。
3. 选择一个新目录或空目录。PuppetLoom 会先在旁路目录完成创建与强验证，成功后才一次性发布到目标目录。
4. 进入校准编辑器检查或修改，也可以直接打开透明角色窗口。

角色窗口支持置顶、鼠标穿透、系统级鼠标跟随、本机摄像头面捕、麦克风口型，以及当前项目真实具有的表情和动作。主窗口会恢复上次的位置、大小和最大化状态；角色窗口按项目恢复位置、大小、置顶、跟随模式和缩放，换显示器后会自动移回可见区域。鼠标穿透不会在重启后恢复，避免窗口变得无法操作。摄像头先记录自然睁眼和闭口基线，过滤非零中立分数、单眼误检与重连残留，避免眼睛或嘴型长期停在半透明交叉淡化状态。

视频录制可以选择透明、黑、白、绿幕或自定义纯色背景，设置输出分辨率、24/30/60 FPS、手动或定时停止，并可录入已经开启的麦克风。录制时显示已用时间，定时录制同时显示剩余时间；停止后会明确显示文件收尾阶段，成功后由视频预览统一承载保存结果。普通录制只生成 WebM；需要复现或调试时可额外勾选动作数据，保存鼠标跟随、面捕、口型、表情、动作和外部控制的可回放 JSON。回放会校验项目 revision 并暂时隔离实时输入。窗口意外关闭时保留 `.partial.webm` 和中断报告，不静默丢失录制。

## 交给外部 Agent 制作

让能够运行仓库 CLI 的外部 Agent 读取 [`skills/live2d-puppet/SKILL.md`](skills/live2d-puppet/SKILL.md)，再提供 PSD 或现有 PuppetLoom 项目，以及以结果为中心的要求：

> 使用仓库里的 live2d-puppet Skill，把这份分层 PSD 创建为 PuppetLoom 项目。只使用现有素材；先展示基线证据，再按部位制作，并保留所有已经接受的 revision。

改善现有角色时，不需要告诉 Agent 顶点编号，直接描述你想看到的变化：

> 改善转头和前发跟随。脸部体积要稳定，发根不能脱离，回弹再小一点；不要改动已经接受的眼睛和嘴部结果。

正式写入路径是 `agent specification` → `agent plan --spec` → `agent apply --spec`。外部 Agent 负责理解自然语言和查看视觉证据；PuppetLoom 负责确定性执行结构化规格、验证结果，并把每个部位记录为 `completed`、`not-present`、`needs-assets` 或 `blocked`。完整流程见 [Agent 调用说明](docs/AGENT_USAGE.md)。

需要配合录屏或快速证明外部控制时，运行 `.\skills\live2d-puppet\scripts\demo_puppetloom.ps1 -Project D:\Puppets\my-character -KeepOpen`。它先展示五个编辑工作区，再通过公共 runtime CLI 驱动角色窗口；整个演示只读，不改变 revision 或校准草稿。详细边界由同一 Skill 的实时演示流程维护。

## CLI：完成第一个项目

所有确定性命令都可以返回 JSON。下面的连续路径会检查 PSD，在 Git 忽略的 `workspace` 目录中创建项目，验证后打开角色窗口：

```powershell
$input = "D:\Characters\my-character.psd"
$project = Join-Path $PWD "workspace\my-character"

node .\apps\cli\dist\index.js inspect --input $input --json
node .\apps\cli\dist\index.js create --input $input --output $project --seed 42 --json
node .\apps\cli\dist\index.js verify --project $project --json
node .\apps\cli\dist\index.js play --project $project
```

用 `describe`、`render`、`record`、`compare` 和 `history` 检查准确 revision；用 `calibrate`、`author`、`actions`、`extensions` 或结构化 `agent` 流程创建下一条可恢复 revision。只有源 PSD 确实更新时才使用 `migrate` 创建新项目；`export` 会把当前有效 revision 烘焙到新的可移植目录。完整命令与退出码见 [Agent 调用说明](docs/AGENT_USAGE.md)。

日常批量生产使用 `source`、`doctor`、`library scan`、`tracking-assets`、`production-config`、`take`、`improvements analyze` 和 `export-web`。这些命令与桌面制作中心共用项目格式，具体流程见 [制作中心与批量生产](docs/PRODUCTION_WORKFLOW.md)。

## 项目、revision 与证据

PuppetLoom 项目是普通目录，不使用私有压缩包。它包含项目清单、源 PSD、纹理、当前校准、revision session、报告、可选素材请求，以及输入与表演录制。写入操作核对 base revision 和项目锁，在验证与证据全部完成后才切换一次 current revision；恢复同样创建新的可追踪 revision，不删除历史。

```text
my-character/
  puppetloom.json
  source/source.psd
  textures/
  calibration/current.json
  calibration/sessions/
  reports/
  requests/
  supplements/
```

字段与兼容规则见 [项目格式](docs/PROJECT_FORMAT.md)，人和 Agent 共用的审查循环见 [校准证据说明](docs/CALIBRATION_EVIDENCE.md)，产物生命周期见 [版本与产物管理](docs/VERSIONING.md)。

## Cubism 的真实边界

PuppetLoom 可以准备并同步 Cubism Editor 官方 API 已公开的结构，也能生成表情、动作、物理和显示信息侧车；真正的 `.moc3` 只能由 Cubism Editor 导出。当官方 API 无法写入 ArtMesh 顶点或 Warp 控制点时，桥接会明确报告限制，不会把结构校验写成完整视觉兼容。正式顺序、Editor 版本和验收边界见 [Cubism 官方格式桥接](docs/CUBISM_BRIDGE.md)。

## 文档

- [校准编辑器说明](docs/EDITOR_GUIDE.md)：人工检查、草稿、校准、证据和运行预览。
- [Agent 调用说明](docs/AGENT_USAGE.md)：结构化规格、分部返修、authoring、迁移与退出码。
- [架构说明](docs/ARCHITECTURE.md)：core、renderer、CLI、desktop 与外部 Agent 的职责边界。
- [验收记录](docs/VALIDATION.md) 与 [测试说明](docs/TESTING.md)：已经验证的链路，以及仍需真实素材或人工判断的范围。
- [统一姿态模型](docs/COHERENT_POSE_MODEL.md)：头部、身体、视线、透视、遮挡和次级运动关系。
- [Cubism 官方格式桥接](docs/CUBISM_BRIDGE.md)：官方格式交接与兼容限制。
- [制作中心与批量生产](docs/PRODUCTION_WORKFLOW.md)：来源准备、多项目医生、追踪 2.0、角色状态、约束、Take 与跨项目分析。
- [Runtime 适配器与 Web SDK](docs/RUNTIME_INTEGRATION.md)：OSC/VMC、MIDI、手柄、控制面板、OBS 与网页嵌入。
- [Windows 安装、更新与环境检查](docs/WINDOWS_DISTRIBUTION.md)：NSIS 安装器、D 盘缓存、更新通道和环境医生。

## 开发与验收

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

`build`、`typecheck` 和 `test` 都会重建当前核心与渲染源码，避免旧声明文件产生假绿。测试 PSD 全部由脚本生成，不包含用户角色。运行产物在写入前检查预算与磁盘余量，并保存清单和哈希；`artifacts:report` 只报告可处理候选，不自动删除。真实角色基准通过带素材用途声明和 revision 锁定的清单运行。仓库中唯一明确登记的角色美术例外是 `skills/live2d-puppet/assets/blue-whale-maid-reference/` 长期参考包；它不是测试 fixture、runtime 产物或私人用户项目，其它真实角色素材仍不得提交。贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## Star History

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/CheshireMew/PuppetLoom/star-history/star-history-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/CheshireMew/PuppetLoom/star-history/star-history.svg">
  <img alt="PuppetLoom 的 GitHub Star History" src="https://raw.githubusercontent.com/CheshireMew/PuppetLoom/star-history/star-history.svg">
</picture>

## 许可证与第三方资源

PuppetLoom 使用 [Apache License 2.0](LICENSE)。借鉴项目、依赖用途、运行时模型下载边界和完整致谢见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。仓库不提交用户角色图或下载的第三方角色样例。
