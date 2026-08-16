# Agent 调用说明

Agent 通过 CLI 完成从 PSD 到可运行角色的确定性工作，也可以用同一校准接口和桌面编辑器与用户协作。软件负责格式、渲染、安全检查和历史；Agent 负责观察证据、判断应改哪个稳定控制量，以及把“当前角色校准”和“通用算法缺陷”分开。

下面用 `$cli = "E:\Code\PuppetLoom\apps\cli\dist\index.js"` 表示入口。

## 从零创建

先运行 `inspect --input <psd> --json`，再运行 `create --input <psd> [--reference <image>] --output <new-directory> --seed 42 --json`。参考图必须与 PSD 对应；没有就省略，不得找别的图片代替。`grouped` 或 `minimal` 是保守的可用结果，不是失败。

创建后依次运行：

```powershell
node $cli verify --project E:\Puppets\CharacterName --json
node $cli describe --project E:\Puppets\CharacterName --json
node $cli render --project E:\Puppets\CharacterName --output E:\Puppets\CharacterName\reports\agent-baseline --suite calibration --json
```

`verify.valid` 证明文件和安全约束通过，不能代替视觉检查。Agent 必须实际查看 `pose-sheet.png` 与 `motion-sheet.png`，重点比较中立、左右转、上下看、四个组合方向，以及前后发、呆毛、耳朵、衣摆和尾巴的独立运动。

## 校准闭环

先从 `describe` 读取稳定的图层 ID、控制点、轴心、网格规模和当前 revision。只提交需要改变的稀疏字段，不复制整份 `puppetloom.json`。补丁示例：

```json
{
  "label": "固定呆毛根部并降低头部作用",
  "overrides": {
    "layers": {
      "layer-000-front-hair": {
        "vertexInfluences": {
          "pin": { "0": 1 },
          "head": { "0": 0.2 }
        }
      }
    }
  }
}
```

保存与比较：

```powershell
node $cli calibrate --project E:\Puppets\CharacterName --patch E:\Puppets\change.json --json
node $cli compare --project E:\Puppets\CharacterName --from 0 --to 1 --output E:\Puppets\Compare --json
node $cli history --project E:\Puppets\CharacterName --json
```

`calibrate` 会先验证坐标、图层、顶点和 13 个姿态；不安全的补丁不会落盘。成功时它自动在项目内生成修改前后证据。Agent 要查看人物本身，而不是只看差异图：差异图能证明哪里改变了，不能证明改变自然。

如果用户在桌面编辑器中拖动了控制点，Agent 重新运行 `history` 和 `compare` 就能读取精确前后数值并看到对应渲染。用户确认效果后，用 `evidence --session <id> --status accepted --json` 标记；不满意则标记 `rejected`。这只是当前角色的可靠证据，不得因为一次接受就改写所有角色的通用规则。

需要回到旧状态时运行 `restore --revision <n> --json`。恢复本身会创建新 revision，因此所有尝试仍可追踪。用户想直接操作时运行 `edit --project <directory>`。

## 应该改哪里

- 只在一个角色上出现，且可由控制点、轴心、网格或权重解决：保存项目校准。
- 多个结构相似角色重复出现，自动结果方向一致地错误：修改 PuppetLoom 算法，加入通用夹具和视觉回归测试。
- Agent 经常选错命令、跳过视觉检查或把局部校准误当通用知识：在用户确认后改进 `live2d-puppet` Skill。

不要直接编辑 `puppetloom.json`，不要绕过安全缩放，不要为了“更多动作”凭空生成未知脸部内容。左右转头需要检查近大远小、两侧眼角和脸缘关系；上下看是俯视/仰视，不是整颗头上下平移；头、脖子和上半身是结构连接，前后发、呆毛、耳朵、裙摆和尾巴才有独立惯性。视频参考用于学习关系，除非用户明确要求，不把视频复制进项目运行素材。

## 可选补充素材

`requests/asset-requests.json` 中的闭眼和嘴形请求不阻塞可动结果。若使用图像模型，必须提供对应裁切。不要相信提示词能直接保证透明通道：先验证文件 Alpha；不透明结果要按纯色背景抠图，再交给 `enhance`。只有 `accepted` 的素材算接入成功，失败文件不能覆盖安全回退。

## 运行和退出码

`play --project <directory>` 打开透明角色窗口；鼠标穿透后按 `Ctrl+Shift+P` 恢复。退出码 0 表示命令或任一安全绑定成功，2 表示输入/补丁无效，3 表示文件系统、项目结构或运行时错误。成功 JSON 在标准输出，结构化错误在标准错误，不能混合解析。
