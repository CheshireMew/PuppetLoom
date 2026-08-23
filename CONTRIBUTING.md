# Contributing to PuppetLoom

感谢你愿意改进 PuppetLoom。这个仓库同时包含桌面应用、确定性 CLI、角色项目格式、渲染器和供外部 Agent 使用的 Skill。提交前先确认改动属于哪一层，并让测试和文档跟随真正的消费者。

## 开始之前

当前项目只验收 Windows。需要 Node.js 24 或更高版本、npm 11，以及支持 WebGL2 的显卡。

```powershell
git clone https://github.com/CheshireMew/PuppetLoom.git
cd PuppetLoom
npm ci
npm run build
```

请从小而完整的问题开始。行为改动需要同时说明输入、用户可观察结果、兼容边界和验证方式；格式或 CLI 合同改动还要同步迁移正式消费者。

## 选择正确的修改位置

- PSD 解析、项目格式、网格、绑定、revision、安全验证和 Cubism 侧车属于 `packages/core`。
- WebGL2 绘制、自主动作、次级运动和运行时控制混合属于 `packages/renderer`。
- 结构化命令、JSON 输出和退出码属于 `apps/cli`。
- 创建器、编辑器、透明角色窗口、输入设备与录制链属于 `apps/desktop`。
- 外部 Agent 的自然语言理解、证据审查与返修流程属于 `skills/live2d-puppet`，不要把这部分职责塞进桌面应用。

## 验证

先运行直接覆盖改动的检查。跨包合同或公共格式发生变化时，再运行完整链：

```powershell
npm run build
npm run typecheck
npm test
```

桌面窗口、真实角色、运动或录制行为发生变化时，还应运行相应的 `test:e2e`、`test:real-project`、`test:motion-evidence`、`test:visual` 或 `test:performance`。测试通过只证明自动检查成立；依赖观感的角色结果仍要提供准确 revision 的证据并交给人确认。

## 素材、产物与隐私

不要提交私人用户角色、未经授权的第三方素材、运行日志、录制视频、缓存或本机凭据。当前唯一登记在仓库中的角色美术例外是 `skills/live2d-puppet/assets/blue-whale-maid-reference/` 长期参考包；新增或替换这类源资产必须同时说明用途、权利边界和消费者，不能把用户项目或下载样例伪装成参考包。测试 PSD 应由仓库脚本生成，真实素材基准只在本地按授权登记。生成产物写入受管报告目录；`npm run artifacts:report` 只报告候选，不会自动删除文件。

## Pull Request

PR 请说明：

1. 改动解决的用户结果与适用边界。
2. 触及的生产者、格式或传输边界、消费者。
3. 实际运行的命令、退出状态和未验证项。
4. 可见行为变化对应的 revision、报告或证据位置。
5. 是否改变许可证、第三方声明、项目格式或向后兼容性。

代码以 [Apache License 2.0](LICENSE) 提交；第三方内容继续遵守自己的许可证，并在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中保留准确来源与范围。

---

## English summary

PuppetLoom currently accepts changes on Windows. Use Node.js 24+, npm 11, and a WebGL2-capable GPU. Keep core model and format logic in `packages/core`, rendering and motion in `packages/renderer`, structured commands in `apps/cli`, desktop workflows in `apps/desktop`, and agent reasoning in `skills/live2d-puppet`.

Run the checks that directly cover your change; use `npm run build`, `npm run typecheck`, and `npm test` for cross-package changes. Do not commit user characters, unlicensed media, logs, recordings, caches, or credentials. A PR should state the user-visible result, affected producer-to-consumer chain, commands actually run, evidence for visual changes, and any compatibility or licensing impact.
