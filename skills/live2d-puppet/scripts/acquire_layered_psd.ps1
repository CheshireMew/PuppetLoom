[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$InputImage,

  [ValidateRange(768, 1600)]
  [int]$Resolution = 1024,

  [ValidateRange(0, 9999)]
  [int]$Seed = 42,

  [switch]$SplitLimbs,

  [string]$ReviewPsd,

  [string]$FinalizeReview,

  [string]$OutputRoot,

  [string]$ServiceUrl = "https://ljsabc-see-through.ms.show",

  [ValidateRange(30, 3600)]
  [int]$TimeoutSeconds = 900,

  [switch]$Check
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path $PSScriptRoot "..\runtime\see-through"
}
$pythonPath = "D:\Tools\Python310\python.exe"
if (-not (Test-Path -LiteralPath $pythonPath)) {
  $pythonPath = (Get-Command python.exe -ErrorAction Stop).Source
}

$scriptPath = Join-Path $PSScriptRoot "acquire_layered_psd.py"
$pythonArguments = @($scriptPath)

if ($Check -and -not [string]::IsNullOrWhiteSpace($FinalizeReview)) {
  throw "Check and FinalizeReview are mutually exclusive."
}

if ($Check) {
  $pythonArguments += "--check"
} elseif (-not [string]::IsNullOrWhiteSpace($FinalizeReview)) {
  if (-not [string]::IsNullOrWhiteSpace($InputImage) -or -not [string]::IsNullOrWhiteSpace($ReviewPsd)) {
    throw "InputImage and ReviewPsd cannot be used with FinalizeReview."
  }
  $pythonArguments += @("--finalize-review", (Resolve-Path -LiteralPath $FinalizeReview).Path)
} else {
  if ([string]::IsNullOrWhiteSpace($InputImage)) {
    throw "InputImage is required unless -Check is used."
  }
  $resolvedInput = (Resolve-Path -LiteralPath $InputImage).Path
  $pythonArguments += $resolvedInput
  if (-not [string]::IsNullOrWhiteSpace($ReviewPsd)) {
    $pythonArguments += @("--review-psd", (Resolve-Path -LiteralPath $ReviewPsd).Path)
  }
  if ($SplitLimbs) {
    $pythonArguments += "--split-limbs"
  }
}

$pythonArguments += @(
  "--resolution", $Resolution,
  "--seed", $Seed,
  "--output-root", [System.IO.Path]::GetFullPath($OutputRoot),
  "--service-url", $ServiceUrl,
  "--timeout", $TimeoutSeconds
)

& $pythonPath @pythonArguments
exit $LASTEXITCODE
