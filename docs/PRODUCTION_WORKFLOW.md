# 制作中心与批量生产

PuppetLoom 的制作中心把“准备素材、检查项目、补能力、录表演、导出”放在一条可恢复链路里。桌面端适合目视检查和日常操作，CLI 适合外部 Agent、批处理与验收脚本；两边读写同一种普通目录项目，不存在桌面端专属的隐藏状态。

## 从单张原画准备分层素材

“制作中心 → 来源准备”会创建一个新的素材任务目录，保留原图并生成 See-Through 官方交接说明。PuppetLoom 不内置 See-Through 模型。拿到候选 PSD 后，复核会保存候选版本并生成原图对比、白底、黑底、棋盘格、逐图层和结构证据；最后的 `ready` 或 `needs-repair` 结论会绑定准确复核序号，旧候选不会被覆盖。

```powershell
node .\apps\cli\dist\index.js source prepare --reference D:\Art\character.png --output D:\Puppets\source-task --name character --json
node .\apps\cli\dist\index.js source review --task D:\Puppets\source-task --psd D:\Incoming\character.psd --json
node .\apps\cli\dist\index.js source finalize --task D:\Puppets\source-task --review 1 --decision ready --note "重组与原图一致，透明边缘和遮挡托底正常" --json
```

## 多角色项目库与项目医生

项目医生同时检查源文件与纹理哈希、revision 历史、证据状态、危险姿态、闭眼/嘴形能力、视频和 Take，以及服装变体、道具、状态预设、运动范围和碰撞约束。项目库扫描只进入用户选择的根目录，限制深度和项目数量，不跟随符号链接。

```powershell
node .\apps\cli\dist\index.js doctor --project D:\Puppets\alice --json
node .\apps\cli\dist\index.js library scan --root D:\Puppets --depth 4 --limit 200 --output D:\Reports\puppetloom-library-20260824 --json
```

## 追踪与口型 2.0

桌面角色窗口使用本机 MediaPipe Face、Pose 和 Hand 模型。面部输入包含左右眼独立眨眼、眉毛、笑容、脸颊和 A/I/U/E/O 视素；姿态输入包含左右手臂和双手位置/张合。麦克风口型使用本机频谱估计视素，不上传音频。模型文件由构建脚本校验固定大小与 SHA-256，开发与安装版使用同一组资源。

`tracking-assets` 可以为缺少素材的项目生成确定的补充请求。默认仍只要求闭眼、闭合/微张/张开嘴形；显式启用视素时才增加 A/I/U/E/O 请求。素材通过既有 `enhance` 流程接入，PuppetLoom 不用透明度交叉淡化伪造缺失画稿。

## 服装、道具、状态和约束

制作配置是版本 1 JSON。变体组选项引用真实图层 ID，道具声明槽位和图层，预设可以组合变体、道具、参数与表情。运动范围在语义输入进入渲染前限幅；图层碰撞使用项目空间边界、间距、强度和最大修正量，防止指定可动层穿过稳定遮挡层。

先导出当前完整配置，编辑后再原子应用：

```powershell
node .\apps\cli\dist\index.js production-config inspect --project D:\Puppets\alice --output D:\Work\alice-production.json --json
node .\apps\cli\dist\index.js production-config apply --project D:\Puppets\alice --config D:\Work\alice-production.json --json
```

可直接起步的通用示例见 [`examples/production-config.json`](../examples/production-config.json)。应用时会校验所有 ID 与引用，保留第一份修改前项目文档，并在 `production/config-history` 追加带前后哈希的配置 revision。角色窗口会按项目实际配置显示预设、变体和道具控件，外部控制也可以通过 `characterState` 设置同一状态。

## Take 库与导出中心

动作数据录制可以导入项目内 `performances/takes`。裁切、变速、移动平均平滑、来源/动作/参数/表情静音都会创建带 `parentTakeId` 的新 Take，原 Take 和原输入会话不改动。桌面角色窗口可以导入、回放和创建轻编辑版本；CLI 可以导出可回放会话 JSON 或逐事件 CSV。

```powershell
node .\apps\cli\dist\index.js take import --project D:\Puppets\alice --session D:\Recordings\alice.input.json --name "开场" --tag live --json
node .\apps\cli\dist\index.js take edit --project D:\Puppets\alice --take TAKE_ID --operations D:\Work\take-edit.json --json
node .\apps\cli\dist\index.js take export --project D:\Puppets\alice --take TAKE_ID --format events-csv --output D:\Exports\alice-events.csv --json
```

桌面“导出中心”提供可移植项目、Web/OBS 目录和 Cubism 交接包；角色窗口继续负责透明/纯色 WebM、动作输入和 Take。所有目录型导出要求目标尚不存在，避免覆盖旧交付。

## 跨项目改进候选

跨项目分析只把至少两个不同项目反复出现的问题或已接受 revision 中的相同修改列为候选。它统计能力缺口、已接受图层校正、运行参数中位数和制作模式，同时写出证据项目数、置信度、理由与建议改动；不会自动修改任何项目或默认值。

```powershell
node .\apps\cli\dist\index.js improvements analyze --root D:\Puppets --output D:\Reports\improvements-20260824 --json
```
