$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$runtimeRoot = "D:\Tools\PuppetLoom"
$logDirectory = Join-Path $runtimeRoot "logs"
$logPath = Join-Path $logDirectory ("launcher-{0}.log" -f (Get-Date -Format "yyyyMMdd"))

function Show-LaunchError([string]$message) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($message, "PuppetLoom could not start", "OK", "Error") | Out-Null
}

try {
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  "[$(Get-Date -Format o)] Starting PuppetLoom from $projectRoot" | Add-Content -LiteralPath $logPath -Encoding UTF8

  $electron = Join-Path $projectRoot "node_modules\electron\dist\electron.exe"
  $desktopMain = Join-Path $projectRoot "apps\desktop\dist\electron\main.js"
  $rendererIndex = Join-Path $projectRoot "apps\desktop\dist\renderer\index.html"
  if (-not (Test-Path -LiteralPath $electron)) {
    throw "Electron is missing. Run npm install in $projectRoot first."
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
    "[$(Get-Date -Format o)] Sources changed; rebuilding PuppetLoom" | Add-Content -LiteralPath $logPath -Encoding UTF8
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    & $npm run build *>> $logPath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $desktopMain) -or -not (Test-Path -LiteralPath $rendererIndex)) {
      throw "The desktop build failed. See $logPath for details."
    }
  }

  $buildTime = (Get-Item -LiteralPath $desktopMain).LastWriteTimeUtc
  $staleRunningProcess = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($desktopMain) } |
    Where-Object { $_.CreationDate.ToUniversalTime() -lt $buildTime } |
    Select-Object -First 1
  if ($staleRunningProcess) {
    "[$(Get-Date -Format o)] Existing process $($staleRunningProcess.ProcessId) predates the current build" | Add-Content -LiteralPath $logPath -Encoding UTF8
    Show-LaunchError "PuppetLoom has been updated, but an older window is still running. Close the existing PuppetLoom window, then launch it again.`n`nLog: $logPath"
    exit 0
  }

  Start-Process -FilePath $electron -ArgumentList @($desktopMain) -WorkingDirectory $projectRoot
  exit 0
} catch {
  $message = $_.Exception.Message
  "[$(Get-Date -Format o)] ERROR $message" | Add-Content -LiteralPath $logPath -Encoding UTF8
  Show-LaunchError "$message`n`nLog: $logPath"
  exit 1
}
