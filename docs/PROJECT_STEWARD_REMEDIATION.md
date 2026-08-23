# Project Steward 问题关闭表

本表使用 2026-08-23 全面审查时固定的 finding ID。只有当前源码、当前工作区和对应门禁共同成立时才关闭；旧版 `test/artifacts` 路径不作当前证据。

| Finding | 当前处理 | 防复发门禁 | 最终证据状态 |
| --- | --- | --- | --- |
| F-CI-001 | 托管运行器不再用 120 字符硬阈值判断运行根，而是预检“运行目录 + 生产者声明的最长相对路径”是否落在 240 字符 Windows 预算内；合法长根和超预算拒绝均有回归用例。 | Windows CI 在类型检查前运行 `npm run governance:check`，完整 `npm test` 覆盖路径预算。 | 本地完整构建和 46 个测试文件、312 项测试通过；远端以提交对应的 `verify-current-source` 结果为最终证据。 |
| F-STORAGE-001 | `/runtime/` 成为完整 Git 忽略的本机状态目录；原先 16 个误跟踪运行文件已保留到本机 `archive/runtime-snapshots/2026-08-21-moonlight-yao-live2d`，没有删除。PSD 修复和桌面日志均进入生产存储合同。 | `governance:check` 阻止仍存在的 runtime 跟踪文件，并核对三类生产者合同。 | 本地门禁通过；提交后由 CI 在干净检出中再次证明 runtime 无跟踪内容。 |
| F-PSD-001 | `psd repair/review` 先写并刷新 pending `operation.json`；记录预算、路径、输入哈希、尝试、阶段、错误与恢复命令。中断或失败可用原命令继续，未确认的部分 PSD 移入 `recovery/`。自动检查只到 `awaiting-visual-review` 并返回退出码 4；只有 `psd finalize` 校验输出和所有视觉证据哈希后才能进入 accepted、accepted-with-repairs 或 rejected。 | 核心测试覆盖等待人工、证据绑定、终态和部分输出归档恢复；CLI 测试覆盖退出码 4 与 finalize。 | 定向测试和完整测试均已通过。 |
| F-EVIDENCE-001 | `run.json` 升级为 v2，pending 阶段记录 Git commit、脏工作区内容指纹、命令、验收范围、Windows/Node 环境与路径预算。历史验收文档明确旧 v1 记录不能证明当前 HEAD。 | 所有托管运行生产者必须声明 `evidence` 与 `maximumRelativePathLength`；存储合同和 `governance:check` 固定关键字段。 | `npm test` 已生成 succeeded v2 清单 `mt5i5spl-ous-94d63455`，绑定提交、120 条工作区变化及指纹 `cc0d72d13a75a1e3c1b78eb32338cac7be2219b07f72a06d33263411e4b2b0bc`。 |
| F-PKG-001 | `package.json` 和 `package-lock.json` 统一声明 `npm@11.12.1`；安装文档统一使用 `npm ci`。旧 pnpm 文件原样保留在 `archive/package-manager/pnpm`，不再是根目录输入。 | `governance:check` 核对 packageManager、workspaces、lockfile，并拒绝根目录 pnpm 文件。 | 门禁通过；npm 离线 package-lock dry-run 为 `up to date`。 |
| F-ARCH-001 | 项目核心拆为 create/store/description/calibration-store；CLI 拆为五个业务命令域和公共进程适配；编辑器把网格、参数、物理和 ArtMesh 编辑控制器移入 `useEditorEditingTools`，纯预设移入 `EditorWorkspaceModel`。 | `docs/ARCHITECTURE.md` 固定职责；全工作区 TypeScript 检查覆盖模块边界与消费者。 | 全工作区类型检查、完整 build 和完整测试均已通过；78 个源码文件的 311 条本地依赖边没有循环。 |
| F-WORKFLOW-001 | Star History 可复用工作流固定到 `f3a7998cff1e2b0855ae1c0fd4e3cbe591aae44c`，不再跟随 `main`。 | `governance:check` 拒绝该写权限工作流使用分支、HEAD 或可变标签；`main` 由 GitHub 分支保护要求 `verify-current-source` 并约束管理员。 | 本地工作流门禁已通过；保护规则以 GitHub API 的最终返回值为证据，不用工作区声明代替远端状态。 |

## 已完成的本地验证

- `npm run governance:check`
- `npm run typecheck`
- `npm run build`
- `npm test`：46 个测试文件、312 项测试全部通过
- succeeded v2 清单：`test/artifacts/runs/mt5i5spl-ous-94d63455/run.json`，命令 `npm test`，Windows x64，Node v24.15.0
- 拆分后依赖图静态复核：78 个源码文件、311 条本地依赖边、0 个循环依赖
- `npx vitest run --config vitest.config.ts packages/core/test/psd-repair.test.ts`：4/4
- `npx vitest run --config vitest.config.ts test/cli.test.ts -t "plans and reviews PSD repair work"`：1/1
- `npm install --package-lock-only --ignore-scripts --dry-run --offline --cache D:\Tools\npm-cache`
- CLI `--help`、`psd finalize --help`、`runtime --help`、`cubism --help` 和只读 `inspect` 实测通过

## 远端闭环

本地文档不会预先写入尚未发生的远端运行编号。当前工作区直接提交到 `main` 后，以该提交的 `verify-current-source` 成功结果，以及 GitHub API 返回的必需检查和管理员约束作为最终关闭证据。
