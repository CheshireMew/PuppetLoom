# Runtime 适配器与 Web SDK

PuppetLoom 的外部集成分成控制和画面两条链路。控制端统一写入桌面 Runtime Control Service，并继续服从来源优先级、混合权重和 TTL；画面端可以直接使用透明 Web/OBS 导出，也可以从角色窗口开启 Windows Spout2 共享纹理。核心渲染器不依赖直播软件或硬件厂商 SDK。

## 启动适配器 Host

先在角色窗口中确认目标窗口 ID，再复制并修改 [`examples/runtime-adapter-host.json`](../examples/runtime-adapter-host.json)：

```powershell
node .\apps\runtime-adapters\dist\host.js --config .\examples\runtime-adapter-host.json
```

Host 默认只监听本机 `127.0.0.1`：OSC UDP 为 39540，HTTP 为 39541。配置未写 `runtimeUrl` 时，它读取 `D:\Tools\PuppetLoom\user-data\runtime-control.json` 中桌面应用发布的地址。

支持的输入包括：

- 原生 OSC 地址 `/puppetloom/motion/<字段>`，例如 `/puppetloom/motion/headYaw`。
- VMC `/VMC/Ext/Blend/Val` 的 Blink、Blink_L、Blink_R、A/I/U/E/O、Joy/Fun，以及 `/VMC/Ext/Bone/Pos` 的头部四元数。
- `POST /v1/midi` 的 MIDI CC 三字节消息，按配置映射到动作字段；`GET /` 页面可以直接授权 Web MIDI 设备，不需要另写转发脚本。
- `GET /` 的浏览器 Gamepad 桥，左摇杆控制头部、右摇杆控制视线、扳机控制手臂。
- `POST /v1/control` 的动作、参数、表情与角色状态。仓库同时提供 `apps/runtime-adapters/stream-deck/com.puppetloom.runtime.sdPlugin`，复制到 Stream Deck 插件目录后，每个按键都能在属性面板编辑 Host 地址和准确 JSON 负载。

`GET /v1/status` 返回端口和目标窗口，`POST /v1/release` 释放当前来源。`GET /v1/obs-source` 返回可直接创建 OBS Browser Source 的地址、尺寸和透明背景信息。

## Web/OBS 运行时

桌面导出中心的“Web / OBS”会复制当前有效项目、纹理、单文件 SDK、透明 `index.html` 和带 SHA-256 的清单，不包含源 PSD 与校准历史。必须使用静态 HTTP 服务打开，不能直接双击 HTML：

```powershell
npx http-server D:\Exports\alice-web -p 8080
```

OBS 中添加浏览器源并填写 `http://127.0.0.1:8080/`，宽高使用项目需要的输出尺寸，页面背景保持透明。网页中最简单的嵌入方式是：

```html
<puppetloom-player src="./project/puppetloom.json"></puppetloom-player>
<script type="module" src="./puppetloom-web.js"></script>
```

需要代码控制时，监听 `puppetloom-ready`，从元素的 `player` 读取 `PuppetLoomWebPlayer`，调用 `setMotion()`、`setCharacterState()`、`pause()`、`play()` 或 `dispose()`。默认启用指针视线；元素添加 `no-pointer-look` 可关闭，添加 `paused` 可禁止自动播放。

## Spout2 共享纹理

角色窗口的录制面板可以按当前宽高和 24/30/60 FPS 启动 Spout2。PuppetLoom 会创建一个隐藏的透明输出窗口，复用可见角色窗口的项目、准确 revision 和运行时控制快照，通过 Electron 共享纹理事件把 D3D11 纹理零拷贝交给 Spout2 发送器。界面会显示发送器名、尺寸、帧数、丢帧数和最近的共享纹理缺陷；关闭来源角色、停止输出或退出应用都会释放发送器与隐藏窗口。

OBS 使用 Spout2 时需要安装支持 Spout 的来源插件，然后选择界面显示的发送器名；TouchDesigner、Resolume 等 Spout 接收端同样直接选择该名称。没有接收端插件或需要远程网页时，继续使用上面的透明 Browser Source。

`@puppetloom/runtime-adapters` 仍暴露 `RuntimeFrameOutputAdapter`，供独立宿主实现同样的 `open → publish → close` 生命周期。桌面内置实现走 GPU 共享纹理，不使用 `capturePage` 或逐帧 RGBA IPC。
