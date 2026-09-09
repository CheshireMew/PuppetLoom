[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("capabilities", "assets", "inspect", "create", "verify", "describe", "migrate", "render", "performance", "psd", "agent", "author", "actions", "calibrate", "compare", "history", "restore", "evidence", "enhance", "record", "play", "edit", "runtime", "cubism", "extensions")]
  [string]$Command,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$ErrorActionPreference = "Stop"
$puppetLoomRoot = if ($env:PUPPETLOOM_ROOT) { $env:PUPPETLOOM_ROOT } else { Join-Path $PSScriptRoot "..\..\.." }
$puppetLoomRoot = (Resolve-Path -LiteralPath $puppetLoomRoot).Path
$cliPath = Join-Path $puppetLoomRoot "apps\cli\dist\index.js"
$nodePath = if ($env:PUPPETLOOM_NODE) { (Resolve-Path -LiteralPath $env:PUPPETLOOM_NODE).Path } else { (Get-Command node.exe -ErrorAction Stop).Source }

$buildScript = Join-Path $puppetLoomRoot "scripts\build-cli.mjs"
if (-not (Test-Path -LiteralPath $buildScript)) { throw "PUPPETLOOM_ROOT must contain scripts/build-cli.mjs." }
$buildCheck = & $nodePath $buildScript --check
if ($LASTEXITCODE -ne 0) {
  [Console]::Error.WriteLine("CLI build is missing or stale; building current source.")
  & $nodePath $buildScript | ForEach-Object { [Console]::Error.WriteLine($_) }
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& $nodePath $cliPath $Command @Arguments
exit $LASTEXITCODE
