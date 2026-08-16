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
  if (-not (Test-Path -LiteralPath $electron)) {
    throw "Electron is missing. Run npm install in $projectRoot first."
  }
  if (-not (Test-Path -LiteralPath $desktopMain)) {
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    & $npm run build *>> $logPath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $desktopMain)) {
      throw "The desktop build failed. See $logPath for details."
    }
  }

  Start-Process -FilePath $electron -ArgumentList @($desktopMain) -WorkingDirectory $projectRoot
  exit 0
} catch {
  $message = $_.Exception.Message
  "[$(Get-Date -Format o)] ERROR $message" | Add-Content -LiteralPath $logPath -Encoding UTF8
  Show-LaunchError "$message`n`nLog: $logPath"
  exit 1
}
