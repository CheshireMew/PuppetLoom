$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$runtimeRoot = "D:\Tools\PuppetLoom"
$logDirectory = Join-Path $runtimeRoot "logs"
$logPath = Join-Path $logDirectory ("launcher-{0}.log" -f (Get-Date -Format "yyyyMMdd"))

function Show-LaunchError([string]$message) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($message, "PuppetLoom 无法启动", "OK", "Error") | Out-Null
}

try {
  $launchStarted = Get-Date
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  "[$(Get-Date -Format o)] 正在从 $projectRoot 启动 PuppetLoom" | Add-Content -LiteralPath $logPath -Encoding UTF8
  Write-Host "正在检查 PuppetLoom 运行文件…" -ForegroundColor Cyan
  Write-Host "启动日志：$logPath" -ForegroundColor DarkGray

  $electron = Join-Path $projectRoot "node_modules\electron\dist\electron.exe"
  $desktopMain = Join-Path $projectRoot "apps\desktop\dist\electron\main.js"
  $rendererIndex = Join-Path $projectRoot "apps\desktop\dist\renderer\index.html"
  if (-not (Test-Path -LiteralPath $electron)) {
    throw "缺少 Electron 运行文件。请先在 $projectRoot 执行 npm install。"
  }

  $sourceRoots = @(
    (Join-Path $projectRoot "apps\desktop\electron"),
    (Join-Path $projectRoot "apps\desktop\src"),
    (Join-Path $projectRoot "packages\core\src"),
    (Join-Path $projectRoot "packages\renderer\src")
  )
  $sourceFiles = @(
    (Join-Path $projectRoot "package.json"),
    (Join-Path $projectRoot "package-lock.json"),
    (Join-Path $projectRoot "tsconfig.base.json"),
    (Join-Path $projectRoot "apps\desktop\package.json"),
    (Join-Path $projectRoot "apps\desktop\tsconfig.electron.json"),
    (Join-Path $projectRoot "apps\desktop\tsconfig.renderer.json"),
    (Join-Path $projectRoot "apps\desktop\vite.config.ts"),
    (Join-Path $projectRoot "packages\core\package.json"),
    (Join-Path $projectRoot "packages\core\tsconfig.json"),
    (Join-Path $projectRoot "packages\renderer\package.json"),
    (Join-Path $projectRoot "packages\renderer\tsconfig.json")
  )
  foreach ($sourceRoot in $sourceRoots) {
    if (Test-Path -LiteralPath $sourceRoot) {
      $sourceFiles += Get-ChildItem -LiteralPath $sourceRoot -Recurse -File
    }
  }

  $needsBuild = -not (Test-Path -LiteralPath $desktopMain) -or -not (Test-Path -LiteralPath $rendererIndex)
  if (-not $needsBuild) {
    $oldestOutputTime = @($desktopMain, $rendererIndex) |
      ForEach-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } |
      Sort-Object |
      Select-Object -First 1
    $needsBuild = @($sourceFiles | Where-Object {
      (Test-Path -LiteralPath $_) -and (Get-Item -LiteralPath $_).LastWriteTimeUtc -gt $oldestOutputTime
    }).Count -gt 0
  }

  if ($needsBuild) {
    "[$(Get-Date -Format o)] 检测到源码变化，开始重新构建 PuppetLoom" | Add-Content -LiteralPath $logPath -Encoding UTF8
    Write-Host "检测到源码变化，正在重新构建。首次构建可能需要一些时间…" -ForegroundColor Yellow
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    & $npm run build 2>&1 | Tee-Object -FilePath $logPath -Append
    $buildExitCode = $LASTEXITCODE
    if ($buildExitCode -ne 0 -or -not (Test-Path -LiteralPath $desktopMain) -or -not (Test-Path -LiteralPath $rendererIndex)) {
      throw "桌面应用构建失败。详细信息已写入 $logPath。"
    }
    $buildElapsed = [Math]::Round(((Get-Date) - $launchStarted).TotalSeconds, 1)
    Write-Host "构建完成，用时 $buildElapsed 秒。" -ForegroundColor Green
  } else {
    Write-Host "运行文件已是最新，无需重新构建。" -ForegroundColor Green
  }

  $buildTime = (Get-Item -LiteralPath $desktopMain).LastWriteTimeUtc
  $staleRunningProcess = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($desktopMain) } |
    Where-Object { $_.CreationDate.ToUniversalTime() -lt $buildTime } |
    Select-Object -First 1
  if ($staleRunningProcess) {
    "[$(Get-Date -Format o)] 旧进程 $($staleRunningProcess.ProcessId) 早于当前构建" | Add-Content -LiteralPath $logPath -Encoding UTF8
    Show-LaunchError "PuppetLoom 已更新，但旧窗口仍在运行。请先关闭现有 PuppetLoom 窗口，再重新启动。`n`n日志：$logPath"
    exit 0
  }

  Write-Host "正在打开 PuppetLoom…" -ForegroundColor Cyan
  Start-Process -FilePath $electron -ArgumentList @($desktopMain) -WorkingDirectory $projectRoot
  exit 0
} catch {
  $message = $_.Exception.Message
  "[$(Get-Date -Format o)] ERROR $message" | Add-Content -LiteralPath $logPath -Encoding UTF8
  Show-LaunchError "$message`n`n日志：$logPath"
  exit 1
}
