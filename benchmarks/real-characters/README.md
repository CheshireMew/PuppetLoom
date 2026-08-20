# 真实角色基准库

这里保存的是基准清单和验收规则，不要求把 PSD、参考图或角色项目复制进仓库。每个角色仍放在素材授权允许的位置，清单中的 `project` 可以写相对路径或绝对路径。`materialUse` 必须明确写成仅本机测试或允许再分发，避免以后把“能测试”误当成“能公开”。

收到真实素材后，先通过正常制作流程得到 PuppetLoom 项目，再在 `corpus.json` 增加一项并锁定当前 revision。`tags` 用来覆盖不同难点，例如 `full-body`、`asymmetric-hair`、`glasses`、`long-skirt`、`dark-line-art` 或 `many-accessories`；`expected` 写该样本必须保住的部件、动作和质量门槛。基准程序不会修改角色项目。

清单示例：

```json
{
  "id": "example-character",
  "label": "示例角色",
  "project": "../../../workspace/models/example-character",
  "revision": 12,
  "materialUse": "local-benchmark-only",
  "tags": ["full-body", "asymmetric-hair"],
  "expected": {
    "allowedRigLevels": ["semantic"],
    "minLayerCount": 20,
    "requiredRoles": ["face", "frontHair", "eyeWhite", "iris", "mouth", "arm", "leg"],
    "minArtMeshRatio": 0.9,
    "requiredParameterSemantics": ["head-yaw", "head-pitch", "blink", "mouth-open"],
    "requiredExpressionIds": ["soft", "surprised"],
    "requiredBehaviorIds": ["wave-left", "nod"],
    "minPoseValidationCount": 13,
    "minSafetyScale": 0.75,
    "maxQualityIssueCount": 0,
    "requirePoseField": true,
    "requirePoseOcclusion": true
  }
}
```

先检查清单：

```powershell
npm run build
npm run cli -- benchmark validate --manifest benchmarks/real-characters/corpus.json
```

再生成一次不可覆盖的批量报告：

```powershell
npm run cli -- benchmark run --manifest benchmarks/real-characters/corpus.json --output D:\Tools\PuppetLoom\benchmarks\run-2026-08-20
```

报告同时包含机器可读的 `benchmark-report.json` 和方便人工查看的 `benchmark-summary.md`。每个结果都带项目 revision、内容指纹、源文件与历史验证结果、语义覆盖、ArtMesh 比例、表情动作、13 姿态质量以及姿势壳层和遮挡能力。空清单会明确返回 `readyForMaterials: true`，表示设施已经就绪而不是已有真实样本通过。
