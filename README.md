# PuppetLoom

PuppetLoom 把一份分层角色 PSD 创建为会自主运动、可以继续校准的 2D 角色项目。自动创建不要求用户绘画、手工绑点或制作动作：程序先识别图层，推导关键点和网格，验证 13 个姿态，必要时缩小动作或切换到更保守的绑定。用户随后可以在桌面编辑器中直接拖动控制点、锚点、图层轴心和网格顶点，调整作用权重并比较修改前后的确定性渲染，最后在透明桌面窗口中运行结果。

角色会呼吸、左右观察、抬头和低头，视线先于头部；脖子与上半身和头部同时进入姿态，头发、发饰、衣摆和尾巴才按各自重量延后响应。自主时间线把这些动作组织成可辨认的短段落，不把多个方向混成无意义摇摆；鼠标跟随时仍保留极轻的生命感。三态嘴形齐全时，角色偶尔以数次长短不同的开合组成一句短促说话动作，而不是长时间维持同一个张口形状；缺少任一嘴形时嘴部保持闭合。没有闭眼素材时也不会伪造眨眼。

## 当前能力

- 导入扁平或分组 PSD，保留所有可见像素图层、顺序、透明度、坐标和混合模式记录；未知图层照常绘制。
- 识别中、英、日常见图层名称，合并的左右眼部图层可按实际像素位置拆分。
- 自动生成语义、分组和最保守三档绑定；语义项目会从实际图层 Alpha 定位 23 个脸部、眼角、嘴角、头骨和颈部控制点，检查顺序、包含关系与连接关系，并在置信度允许时自动修正异常点。除损坏 PSD 或完全没有可见像素外，总会尝试给出安全结果。
- WebGL2 网格变形、眼部裁切、常见混合模式、连续的头脸脖子姿态场与同步的上半身结构联动，以及呆毛、左右前发、左右后发、耳朵、衣摆、尾巴和饰品从固定根部向自由端逐段传递的独立弹性响应。
- 自动验证中立姿态和 12 个运动姿态，检查网格翻转、过度拉伸、眼睛越界、脸发分离、颈部断开和画布越界。
- CLI、PSD 创建桌面界面、绑定与校准编辑器，以及透明、无边框、置顶的角色窗口。编辑器支持控制点、身体锚点、图层轴心、次级锚点、网格顶点、逐顶点作用权重、动作范围与响应参数；角色窗口支持拖动、缩放、暂停、置顶、鼠标穿透和系统级鼠标跟随。
- 每次校准都保存为新修订，并生成姿态、次级运动、修改前后拼图和像素差异图。用户可以接受或拒绝一次修改，Agent 可以读取同一证据继续迭代，不需要猜测界面中发生了什么。
- 缺少闭眼或三态嘴形素材时生成精确裁切图和 Agent 请求单；新的自然闭口层通过后才停用原 PSD 淡嘴层，错误补图不会覆盖安全回退。

## 环境与安装

当前只验收 Windows。需要 Node.js 24 或更高版本、npm 11，以及支持 WebGL2 的显卡。

```powershell
cd E:\Code\PuppetLoom
npm install
npm run build
```

仓库的 `.npmrc` 已把 npm 缓存指定到 `D:\Tools\npm-cache`。项目不生成安装包；开发阶段直接运行编译产物。

## 使用桌面应用

双击仓库根目录的 `启动PuppetLoom.cmd` 即可打开。它会把用户数据、缓存和启动日志放在 `D:\Tools\PuppetLoom`，缺少编译产物时自动构建；启动失败会显示明确错误和日志路径。开发时也可以运行：

```powershell
npm run desktop
```

拖入 See-through 在线版生成的 PSD；原始角色图可选，只用于检查重新合成是否改变角色。选择一个新目录或空目录后点击“创建角色项目”，右侧会显示绑定等级、安全缩放、禁用功能和补充素材请求数量。创建完成后可以进入绑定与校准编辑器，也可以直接打开透明角色窗口。首页会保留最近打开的项目。

编辑器左侧选择图层，中间直接查看角色和当前姿态，右侧调整属性。修改只先在内存中预览，点击“保存校准”后才写入项目；保存前会重新执行姿态安全检查，失败的修改不会落盘。每次保存都保留前一修订和修改前后证据，“恢复”会生成新的可追踪修订，不会删除历史。

鼠标穿透启用后，可在创建窗口中恢复，也可以按 `Ctrl+Shift+P` 让所有穿透中的角色窗口重新接收鼠标。

鼠标跟随默认开启。角色以自动定位出的脸部中心为观察原点，眼睛先看向系统光标，头部平滑追随，脖子和上半身以较小幅度同时进入同一姿态；所以即使开启鼠标穿透，角色仍能跟随桌面上的光标。角色窗口里的“跟随中”按钮可切换为原来的自主观察，创建窗口也提供同一远程开关。

同一项目已经运行时，再次启动不会叠加第二个透明窗口；程序会把原窗口带到前面，并自动退出鼠标穿透状态。开发工作区中的 `启动角色.cmd` 只是调用这一入口的本机快捷脚本，不包含角色数据。

## 使用 CLI

```powershell
node apps\cli\dist\index.js inspect --input character.psd --json
node apps\cli\dist\index.js create --input character.psd --reference character.png --output E:\Puppets\MyCharacter --seed 42 --json
node apps\cli\dist\index.js verify --project E:\Puppets\MyCharacter --json
node apps\cli\dist\index.js describe --project E:\Puppets\MyCharacter --json
node apps\cli\dist\index.js render --project E:\Puppets\MyCharacter --output E:\Puppets\Evidence --suite calibration --json
node apps\cli\dist\index.js calibrate --project E:\Puppets\MyCharacter --patch E:\Puppets\change.json --json
node apps\cli\dist\index.js compare --project E:\Puppets\MyCharacter --from 0 --to 1 --output E:\Puppets\Compare --json
node apps\cli\dist\index.js history --project E:\Puppets\MyCharacter --json
node apps\cli\dist\index.js edit --project E:\Puppets\MyCharacter
node apps\cli\dist\index.js enhance --project E:\Puppets\MyCharacter --assets E:\Puppets\MyCharacter\supplements --json
node apps\cli\dist\index.js play --project E:\Puppets\MyCharacter
```

所有确定性命令都能返回 JSON。`describe` 提供可调整的稳定 ID 和坐标，`calibrate` 只接受经过结构与安全验证的稀疏补丁，`render` 与 `compare` 为 Agent 和用户生成同一套视觉证据。只要成功生成任一绑定等级，`create` 就返回 0；无效输入或校准补丁返回 2；文件系统、项目或运行时错误返回 3。详细流程见 [Agent 调用说明](docs/AGENT_USAGE.md)。

## 项目目录

PuppetLoom 输出普通目录，不使用私有压缩包：

```text
MyCharacter/
  puppetloom.json
  calibration/current.json
  calibration/sessions/*.json
  source/source.psd
  source/reference.png        # 仅在提供原图时存在
  textures/*.png
  reports/build-report.json
  reports/neutral.png
  reports/pose-sheet.png
  reports/calibration/<session-id>/before-after.png
  reports/calibration/<session-id>/difference.png
  reports/semantic-cage-head.png
  reports/landmark-report.json
  requests/asset-requests.json
  requests/references/*.png
  supplements/
```

格式字段和兼容约定见 [项目格式](docs/PROJECT_FORMAT.md)，编辑操作见 [校准编辑器说明](docs/EDITOR_GUIDE.md)，Agent 与用户如何通过同一证据迭代见 [校准证据说明](docs/CALIBRATION_EVIDENCE.md)，包边界与运行链见 [架构说明](docs/ARCHITECTURE.md)。转头与分层跟随的实现依据见 [统一姿态模型](docs/COHERENT_POSE_MODEL.md)，第三个视频项目中哪些机制被采用、哪些没有采用见 [视频参考结论](docs/VIDEO_REFERENCE_FINDINGS.md)，两套 Live2D 运行模型提供了哪些可迁移的运动关系见 [Live2D 运动参考结论](docs/LIVE2D_MOTION_REFERENCE.md)。

## 验证

```powershell
npm run build
npm test
npm run test:e2e
npm run test:visual
npm run test:performance
```

测试 PSD 全部由脚本生成，不包含用户角色或来源不明的示例素材。视觉检查直接读取 WebGL 画布的 Alpha 和前后帧；性能检查使用 1280×1280、23 层项目在当前机器连续采样。详见 [测试说明](docs/TESTING.md) 和 [验收记录](docs/VALIDATION.md)。

## 许可证与致谢

PuppetLoom 使用 [Apache License 2.0](LICENSE)。借鉴项目、依赖用途和完整致谢见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。仓库不提交用户角色图或下载的第三方角色样例。
