# Agent 调用说明

Agent 的职责是选择输入、调用命令并阅读结果，不需要操作绑定编辑器，也不应修改 PSD 来追求更复杂动作。最可靠的调用顺序如下。

## 1. 检查输入

```powershell
node E:\Code\PuppetLoom\apps\cli\dist\index.js inspect --input E:\Input\character.psd --json
```

只有退出码 2 表示 PSD 本身不可用。`suggestedRigLevel` 为 `grouped` 或 `minimal` 不是失败：它表示程序会减少局部变形，仍可继续创建。

## 2. 创建项目

输出必须是不存在的新目录或空目录，防止把生成文件混入用户现有资料。

```powershell
node E:\Code\PuppetLoom\apps\cli\dist\index.js create `
  --input E:\Input\character.psd `
  --reference E:\Input\character.png `
  --output E:\Puppets\CharacterName `
  --seed 42 `
  --json
```

参考图不是创建前提。若用户只提供 PSD，省略 `--reference`；不得自行找一张不对应的图代替。成功时读取 `report.rigLevel`、`report.disabledFeatures`、`report.warnings` 和 `report.assetRequestCount`，不要把关闭眨眼或视线说成整个项目失败。

## 3. 独立复核

```powershell
node E:\Code\PuppetLoom\apps\cli\dist\index.js verify --project E:\Puppets\CharacterName --json
```

`valid: true` 表示纹理齐全且 13 个姿态通过。不要通过手工放大动作上限绕过自动收缩或降级；那会让生成报告与实际运行状态失去一致性。

## 4. 处理可选素材请求

先读取：

```text
E:\Puppets\CharacterName\requests\asset-requests.json
```

若调用外部图像生成能力，必须把对应裁切图、单项提示词和约束一起提供，并将透明 PNG 写到请求的 `output.path`。PuppetLoom 自身不调用任何图像 API。生成失败、身份变化或尺寸不符时可以直接停止，当前角色仍能运行。

素材准备完成后：

```powershell
node E:\Code\PuppetLoom\apps\cli\dist\index.js enhance `
  --project E:\Puppets\CharacterName `
  --assets E:\Puppets\CharacterName\supplements `
  --json
```

只把 `accepted` 中的项目视为接入成功。`rejected` 不需要人工强塞进项目，也不能覆盖原眼睛纹理。

## 5. 运行

```powershell
node E:\Code\PuppetLoom\apps\cli\dist\index.js play --project E:\Puppets\CharacterName
```

角色窗口由用户关闭后命令结束。窗口开启鼠标穿透后，按 `Ctrl+Shift+P` 恢复交互。

## 退出码

| 退出码 | 含义 | Agent 行为 |
| --- | --- | --- |
| `0` | 命令完成；任一安全绑定等级都算成功 | 继续读取 JSON 或打开角色 |
| `2` | PSD 无效、空白或参数本身无效 | 请求用户重新提供 PSD |
| `3` | 文件系统、项目结构或运行时错误 | 保留错误信息，检查路径与构建状态 |

不要把命令标准输出和标准错误混在一起解析。成功 JSON 在标准输出，结构化错误 JSON 在标准错误。
