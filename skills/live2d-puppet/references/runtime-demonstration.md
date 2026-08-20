# CLI 实时演示

## 适用范围

用户要求外部 Agent 配合录制 PuppetLoom 功能演示、快速证明角色受 Agent 控制，或明确要求“先编辑器、后角色窗口、演示结束不要关窗”时使用本流程。这里的控制入口是 Skill 脚本和 PuppetLoom 公共 CLI，不是 Windows 鼠标模拟，也不把临时 Playwright 片段当成正式入口。

## 唯一演示入口

先用 `history` 读取规范项目当前 revision；不能从会话记忆、旧窗口标题或报告目录猜版本。默认演示当前 revision，用户明确点名 revision 时也必须与编辑器实际打开的当前 revision 一致：

```powershell
& <skill>\scripts\invoke_puppetloom.ps1 history --project E:\Puppets\Character --json
& <skill>\scripts\demo_puppetloom.ps1 -Project E:\Puppets\Character -Revision 41 -PaceMs 320 -KeepOpen
```

`demo_puppetloom.ps1` 是确定性的 CLI 演示入口。它通过真实 Electron 驱动依次展示 `01 项目总览`、`02 结构与网格`、`03 参数与姿态`、`04 表情与物理`、`05 预览与验收`，只操作预览、姿态和播放控件；随后才打开角色窗口。不要另写一次性内联 Playwright 脚本，也不要绕过 `invoke_puppetloom.ps1` 直接调用 `apps/cli/dist/index.js`。

角色窗口出现后，脚本通过包装入口执行 `runtime inspect`，按返回的 viewer ID、实际表情和实际行为决定可演示内容，再使用 `runtime set/trigger/release`。姿态段覆盖左右、上下、侧倾、眨眼、嘴部和中立；表情与动作不存在时按真实能力跳过，不因固定中文按钮或固定动作名缺失而让整场演示失败。控制来源使用独立 source ID，结束时必须 `release`，让角色回到自主运动。

`PaceMs` 控制每一步可见时长，录屏中的快速证明通常使用 240–420 毫秒；不能快到画面尚未更新就进入下一项。`-KeepOpen` 表示脚本在输出 `{"demo":"ready"}` 后继续等待真实 Electron 进程，编辑器和角色窗口都保持打开，直到用户自己关闭。保活必须等待 Electron 的关闭事件，不能使用没有活动进程句柄的悬空顶层 Promise。

## 只读与失败边界

演示不调整校准滑杆、不保存草稿、不执行 `apply/calibrate/actions apply/extensions apply`，也不增加 revision。开始时记录 revision 与现有草稿，结束前再次读取；任一发生变化都判为失败。脚本为独立演示进程使用 `D:\Tools\PuppetLoom\agent-demo` 下的运行配置，不把缓存或日志写进角色项目和调用仓库。

每个编辑器工作区和运行时动作完成后都会输出结构化进度。只有依次看到 editor-ready、五个 editor-workspace、viewer-ready、runtime-pose/表情/动作以及最终 ready，且再次核对 revision 未变，才算演示链完成。选择器或运行时步骤失败时如实输出 failed；用户要求保留窗口时仍等待当前 Electron 进程，不通过关闭重开掩盖失败。修复入口或脚本后从完整演示重新验证，不能拿普通 E2E 测试通过代替这条真实路径。
