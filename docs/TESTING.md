# 测试说明

## 生成素材

```powershell
npm run fixtures
```

脚本生成的几何角色 PSD 覆盖扁平与分组结构、分组透明度、图层蒙版、混合模式、标准与中日文名称、左右眼拆分和合并、缺失脸部或头发、未知图层、透明噪点、空 PSD、损坏输入，以及 1280×1280/23 层性能项目。它们没有外部美术版权问题，可以提交和重复生成。

## 自动检查

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

- `npm test`：除分类、网格、控制笼、参数/关键形/变形器、物理、行为、校准、证据、迁移、项目完整性和 CLI 契约外，还覆盖 Alpha 连通区域的确定噪点/疑似细节分级、默认自动清理、全部保留与激进清理，合并眼部的智能拆分及回退，多房束识别与独立弹簧、附着/释放权重重投影、现有项目原位扩展、六点脸部深度曲线、可选躯干体积曲线和中立姿态不变性。运行链还覆盖最近项目的存在性过滤和显示名称、控制协议的优先级、混合、TTL 与释放，摄像头/麦克风输入映射和校准，驱动输入会话记录/回放，标准表情与肢体动作规划，姿态相关轮廓、遮挡与深度顺序，WebM 追加写入/完成/中断恢复，真实角色基准清单，以及 revision/指纹锁定的 Cubism 交接和 Editor 验证。
- `test:e2e`：用真实 Electron 主进程检查创建器和编辑器明确声明一体化 `frame: false` 外壳，实际拖动窗口，执行最大化、还原、最小化与自定义关闭，并分别保存只能证明渲染内容的 Playwright 截图和通过 Windows `desktopCapturer` 得到的目标 BrowserWindow 整窗截图；整窗状态还会记录外框与内容边界，防止把原生标题栏误当成应用界面。随后从最近项目进入编辑器，完成显示/锁定、网格编辑、分部响应、草稿恢复、撤销/重做、修订保存和五种证据检查；再打开透明窗口，验证动作面板、外部运行时输入、驱动输入 JSON、实际 VP9 WebM 表演录制、默认自主运动、系统光标目标、跟随开关、缩放、暂停、置顶、鼠标穿透、重复启动复用和非等比窗口不拉伸。
- `test:launcher`：通过用户实际双击入口调用的 Windows PowerShell 脚本启动编译后的 Electron，使用隔离的 D 盘外配置，确认抵达 `app-ready` 并正常退出。
- `test:real-project`：复制本机唯一正式项目 `workspace/models/blue-whale-maid` 到新的测试产物目录，在真实 29 层角色上完成满幅安全检查、AI authoring 检查面板、分部响应修改、草稿重启恢复、revision 保存、叠加证据和透明窗口实际渲染；不修改正式项目。可用 `PUPPETLOOM_CANONICAL_PROJECT` 覆盖本机路径。
- `test:motion-evidence`：通过公开 `record` 命令分别录制 autonomous 和 secondary 透明 WebM，检查准确 revision、项目指纹、窗口比例、非零帧差、局部视频、接触表和报告；secondary 还要求头、身体、视线、呼吸、眨眼和嘴部极值全部为零。
- `test:visual`：确定性渲染两个相反头部姿态，并在同一次 WebGL 提交中读取像素和导出 PNG；这与高性能运行时的 `preserveDrawingBuffer: false` 语义一致。检查透明/可见像素、模板缓冲和实际姿态差异。Windows 系统截窗会把透明区保存为不透明黑色，因此不作为 Alpha 真源。
- `test:performance`：运行 1280×1280、23 层项目，预热后采样 329 帧；要求平均帧率至少 57 FPS、95 分位帧时不超过 25 ms，并确认 WebGL2 可用。报告同时给出帧时分桶以及 90 次同步姿态渲染的平均/95 分位 CPU 耗时，方便区分形变计算、GPU 提交和系统负载。

鼠标跟随单元测试覆盖屏幕四个方向、安全范围、角色脸部原点、视线先行、头部阻尼、头与上半身同步起动、横轴俯仰的表面深度差、颈部两端分别连接头部与运动中的衣领、静止光标下仍有可见待机头部动作，以及关闭跟随后平滑回到自主运动。眼部测试明确要求转头时近侧眼变宽、远侧眼收窄；俯仰测试要求鼻部变化大于脸缘，防止再次把上下观察误写成整头升降。性能测试保持鼠标目标读取开启，确保穿透模式所需的系统级光标 IPC 不会把 60 FPS 渲染链拖慢。

## 真实角色基准库

`benchmarks/real-characters/corpus.json` 是可提交的基准清单，角色 PSD、纹理和本机项目仍可留在仓库外。每个条目必须说明素材用途，并锁定项目路径、revision、预期部件/语义、表情/行为、姿态数、安全系数和问题上限。新增素材后运行：

```powershell
node apps/cli/dist/index.js benchmark validate --manifest benchmarks/real-characters/corpus.json --json
node apps/cli/dist/index.js benchmark run --manifest benchmarks/real-characters/corpus.json --output <report-dir> --json
```

`validate` 只检查清单；`run` 会加载每个有效 revision，重新执行项目验证，记录项目指纹和实际指标，并写出不覆盖旧结果的 JSON 与 Markdown 报告。空清单表示框架已经就绪、仍在等待真实素材，不表示已经获得多角色质量结论。

真实项目可额外执行 `npm run test:turns -- <project-dir>`，直接渲染左右 `0.55`、`0.85` 和中立姿态的头部对照图，用于检查远近眼边界、脸型与头发在转头时是否仍然贴合。

语义项目创建时自动输出 `semantic-cage-head.png` 和 `landmark-report.json`。前者用于直观看到 23 个控制点是否落在正确的脸部、眼角、嘴角、头骨和颈部位置，后者用于核对定位来源、置信度、自动修正和实际受作用图层。单元测试还会在左右 `0.85`、上下 `0.45` 的组合姿态检查每个脸部与头骨三角形没有翻面。

`npm run test:idle-motion -- <project-dir> 12` 会把头部、身体、视线、呼吸和表情全部冻结，只运行前后发、呆毛、衣服、尾巴与饰品的持续驱动，以及按时间触发的呆毛强弹和耳朵连弹事件，并输出 12 秒视频、上半身放大视频、六帧对照图和状态峰值报告。它用于确认静止时确实存在自然风动，也用于确认耳朵每次连续抬落三至四次后回到中立，而不是把主运动造成的整体位移算成部件摆动。

在命令末尾加入 `--primary` 会改为渲染完整自主段落，并把对照图采样点放在前四次观察动作的峰值。该模式用于检查左右转头、抬头、低头、短促说话动作与全身次级运动是否形成连贯表演；输入参考视频只用于比较动作关系，不会写入项目或由运行时播放。

`npm run test:secondary-directions -- <project-dir>` 会定格输出裙摆左摆、中立、裙摆右摆、尾巴上摆和尾巴下摆五帧全身对照图。它用于直接检查裙摆与尾巴的根部是否固定、主要运动轴是否正确以及实际幅度是否可见。

`npm run test:ear-hinges -- <project-dir>` 会输出耳朵抬起、中立和落下三格定格图，并把项目中实际保存的两个耳根固定点以红点叠加显示。它用于确认合并头饰图层的中央发箍不被拉扯、两个钉点不漂移、左右耳尖围绕各自钉点同向抬落。

真实项目还可执行 `node scripts/report-secondary-motion.mjs <project-dir> 26`。它以 60 Hz 采样呆毛、前后发、头饰、耳朵、衣摆、尾巴和饰品，分别报告状态峰值、横纵轴像素位移、固定区与自由端位移；前发还单独报告呆毛根与刘海根之间的头皮保护区最大位移，尾巴额外报告旋转过程中各点到根部的最大半径漂移，用来区分真实转轴摆动和伸缩。最后再用当前变形代码重新检查 13 个安全姿态。

所有正式测试运行先由 `scripts/lib/managed-run.mjs` 在 `test/artifacts/runs/` 创建托管目录。预检会在第一份大文件前核对调用方声明的峰值、2 GiB 默认总预算和 2 GiB 最低磁盘余量；未知峰值或预算不足直接阻止。`run.json` 先以 pending 写入，并要求生产者说明本轮产物是否可复用：固定 PSD 输入直接读取仓库中唯一的 `test/fixtures` 真源；截图、视频、运行日志和可修改项目副本属于一次具体验收，不能拿旧结果冒充新运行。结束时统一写入 succeeded 或 failed、分类字节数、峰值口径、完整文件清单和 SHA-256；所有者异常退出后，下一轮把记录标成 interrupted，补齐残留清单并保留文件。`npm run artifacts:report` 会列出历史非托管目录和终态运行，清理始终是 report-only，不自动删除。`.project-steward/storage-contract.json` 和 Windows CI 固化了同一约定。

## Cubism 真实格式复验

自动测试使用隔离目录验证 `cubism plan/prepare/finalize/verify`，并用模拟 RPC 检查 External API 1.1.0 请求、成功提交和失败回滚。真实格式复验另从 Live2D 官方 `CubismWebSamples` 稀疏检出 Mao 资源到 D 盘非仓库目录，直接验证原始 `Mao.model3.json`、`Mao.moc3`、纹理、pose、physics、8 个 expression 和 9 个 motion 引用。官方样例和合并结果都不提交仓库。

该复验证明 PuppetLoom 能读取、复制、合并并结构校验真实官方运行时目录；它不证明 PuppetLoom 程序化网格已写入 moc3。后者必须以 `plan.strictReady`、Editor 同步结果和 Viewer 视觉检查共同判断，详见 [Cubism 官方格式桥接](CUBISM_BRIDGE.md)。

## 当前机器验收基线

Windows、RTX 2080 Super、1280×1280/23 层性能样本的通过线是稳定 60 FPS。具体测量值由 `test:performance` 每次输出，不把一次历史数值硬编码进文档。

## 真实角色验收

程序化测试全部通过后再使用真实角色素材。原图和 See-through PSD 必须一一对应，真实素材不提交仓库。`test:real-project` 始终复制源项目后操作；若要验收其它角色，可把项目目录作为脚本参数传入。自动结果只能证明数据链和窗口链成立，最终仍需查看真实截图中的轮廓、五官、遮挡和部件连接。
