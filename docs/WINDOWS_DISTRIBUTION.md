# Windows 安装、更新与环境检查

当前发行目标是 Windows x64。安装器使用 Electron Builder 与 NSIS，允许选择安装目录，按当前用户安装，创建开始菜单和桌面快捷方式；卸载不会删除 PuppetLoom 用户数据。MediaPipe 模型、WASM、Web Runtime SDK 和 Spout2 x64 原生发送器会随应用打入资源目录，用户运行安装版不需要 Node.js。

## 环境医生

桌面制作中心的“环境与更新”和 CLI 会检查 Windows/架构、Node.js、D 盘工具目录写入、三份 MediaPipe 模型大小与 SHA-256、FFmpeg、图形设备、桌面/Web 构建和安装器工具：

```powershell
node .\apps\cli\dist\index.js environment-doctor --workspace . --json
```

FFmpeg 仅影响动态证据和部分离线转换，因此缺失是警告；模型哈希或受支持平台错误会让报告 `ready` 为 false。

## 生成安装器

```powershell
npm run dist:win
```

脚本先完整构建，再生成图标和 NSIS 安装器。npm 缓存固定到 `D:\Tools\npm-cache`，Electron Builder/NSIS 缓存固定到 `D:\Tools\electron-builder-cache`。每次构建写入独立的 `release\<version>-<构建时间>` 目录，因此不会删除、覆盖或移动仍被系统占用的旧安装器。随后生成包含版本、字节数、SHA-256、发布时间和发布说明的 `update-manifest.json`。

正式发布时可把清单 URL 改成安装器的 HTTPS 地址：

```powershell
node .\scripts\generate-update-manifest.mjs --installer .\release\0.1.0-20260825-003000\PuppetLoom-0.1.0-Windows-x64.exe --version 0.1.0 --url https://downloads.example.com/puppetloom/PuppetLoom-0.1.0-Windows-x64.exe
```

## 配置更新通道

把 [`examples/update-channel.json`](../examples/update-channel.json) 复制到 `D:\Tools\PuppetLoom\user-data\update-channel.json`，将 `manifest` 改成 HTTPS 清单地址或本机清单绝对路径。桌面端会比较语义版本，下载到 `D:\Tools\PuppetLoom\updates\<version>`，并同时校验清单字节数和 SHA-256。无效的同名下载会改名保留；用户明确点击安装后，应用才启动静默安装器并退出。

更新清单格式如下：

```json
{
  "version": "0.2.0",
  "url": "https://downloads.example.com/puppetloom/PuppetLoom-0.2.0-Windows-x64.exe",
  "sha256": "64 位小写十六进制 SHA-256",
  "bytes": 123456789,
  "publishedAt": "2026-08-24T12:00:00.000Z",
  "releaseNotes": "PuppetLoom 0.2.0 Windows 安装版"
}
```
