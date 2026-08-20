[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Project,

  [ValidateRange(0, 2147483647)]
  [int]$Revision = -1,

  [ValidateRange(120, 2000)]
  [int]$PaceMs = 320,

  [switch]$KeepOpen
)

$ErrorActionPreference = "Stop"
$puppetLoomRoot = if ($env:PUPPETLOOM_ROOT) { $env:PUPPETLOOM_ROOT } else { "E:\Code\PuppetLoom" }
$puppetLoomRoot = (Resolve-Path -LiteralPath $puppetLoomRoot).Path
$projectPath = (Resolve-Path -LiteralPath $Project).Path
$nodePath = "D:\Tools\NodeJS\node.exe"

if (-not (Test-Path -LiteralPath $nodePath)) {
  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
}

$cliPath = Join-Path $puppetLoomRoot "apps\cli\dist\index.js"
$desktopPath = Join-Path $puppetLoomRoot "apps\desktop\dist\electron\main.js"
if (-not (Test-Path -LiteralPath $cliPath) -or -not (Test-Path -LiteralPath $desktopPath)) {
  $npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
  & $npmPath run build --prefix $puppetLoomRoot
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$arguments = @(
  (Join-Path $PSScriptRoot "demo_puppetloom.mjs"),
  "--root", $puppetLoomRoot,
  "--project", $projectPath,
  "--pace", [string]$PaceMs
)
if ($Revision -ge 0) { $arguments += @("--revision", [string]$Revision) }
if ($KeepOpen) { $arguments += "--keep-open" }

& $nodePath @arguments
exit $LASTEXITCODE
