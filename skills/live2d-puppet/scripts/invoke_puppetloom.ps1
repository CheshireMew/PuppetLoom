[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("inspect", "create", "verify", "describe", "migrate", "render", "agent", "author", "calibrate", "compare", "history", "restore", "evidence", "enhance", "record", "play", "edit", "cubism", "extensions")]
  [string]$Command,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$ErrorActionPreference = "Stop"
$puppetLoomRoot = if ($env:PUPPETLOOM_ROOT) { $env:PUPPETLOOM_ROOT } else { "E:\Code\PuppetLoom" }
$puppetLoomRoot = (Resolve-Path -LiteralPath $puppetLoomRoot).Path
$cliPath = Join-Path $puppetLoomRoot "apps\cli\dist\index.js"
$nodePath = "D:\Tools\NodeJS\node.exe"

if (-not (Test-Path -LiteralPath $nodePath)) {
  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
}

if (-not (Test-Path -LiteralPath $cliPath)) {
  $npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
  & $npmPath run build --prefix $puppetLoomRoot
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& $nodePath $cliPath $Command @Arguments
exit $LASTEXITCODE
