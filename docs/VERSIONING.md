# 版本与工作目录

PuppetLoom 同时管理软件、角色和测试，但三者使用不同的版本边界，不能再通过复制整个角色目录来代替版本管理。

## 唯一正式角色项目

本机正式角色放在 `workspace/models/<model-id>`。当前真实模型的默认入口是：

```text
workspace/models/blue-whale-maid
```

同一个 PSD 和同一角色谱系始终使用这个固定目录。`blue-whale-maid-r2`、`blue-whale-maid-r35` 之类目录名不表示 PuppetLoom revision，也不得作为新的制作流程继续产生。只有源 PSD 的结构或身份真正改变、无法沿用现有图层映射时，才通过 `migrate` 建立一个新的模型谱系目录。

测试脚本可用 `PUPPETLOOM_CANONICAL_PROJECT` 临时覆盖正式项目路径，也可把项目路径作为第一个参数传入。无论哪种方式，测试都先把正式项目复制到 `test/artifacts/runs/<run-id>`，之后只修改测试副本。

## 四种编号各自负责什么

| 名称 | 管理对象 | 是否长期保存 |
|---|---|---|
| Git commit | PuppetLoom 软件代码 | 是 |
| calibration revision | 一个角色项目内的修改历史 | 是 |
| accepted/rejected | 用户对某次 revision 证据的判断 | 是 |
| test run ID | 一次隔离测试的产物 | 否，按保留策略清理 |

`calibration/current.json` 保存当前 revision 和累计有效状态；`calibration/sessions` 保存连续的父子修改记录。写操作必须携带 `baseRevision`，过期写入会被拒绝。恢复旧 revision 会形成新的 revision，不会覆盖或重写历史。

查看历史默认使用精简输出：

```powershell
node apps\cli\dist\index.js history --project workspace\models\blue-whale-maid --json
```

只有确实需要检查完整补丁、网格和累计覆盖时才使用 `--full`。用户确认或拒绝某次结果时，使用 `evidence --status accepted|rejected`，不要复制整个项目目录作为“稳定版”。

## 测试产物保留

`test/artifacts` 只保存隔离测试、对比图和运行日志。它不是正式角色工作区。保留策略按测试类别保留最近成功结果；旧失败结果和不再被任何运行引用的内容对象可以删除。任何值得继续制作的角色都必须先回到 `workspace/models`。
