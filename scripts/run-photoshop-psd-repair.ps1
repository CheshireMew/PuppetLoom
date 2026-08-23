param(
    [Parameter(Mandatory = $true)][string]$Recipe,
    [Parameter(Mandatory = $true)][string]$Output,
    [Parameter(Mandatory = $true)][string]$Script,
    [switch]$ShowPhotoshop
)

$ErrorActionPreference = 'Stop'
$recipePath = [IO.Path]::GetFullPath($Recipe)
$outputPath = [IO.Path]::GetFullPath($Output)
$scriptPath = [IO.Path]::GetFullPath($Script)

if (-not (Test-Path -LiteralPath $recipePath -PathType Leaf)) { throw "Photoshop repair recipe not found: $recipePath" }
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw "Photoshop automation script not found: $scriptPath" }
if (Test-Path -LiteralPath $outputPath) { throw "PSD output already exists; refusing to overwrite: $outputPath" }

$wasRunning = @(Get-Process -Name Photoshop -ErrorAction SilentlyContinue).Count -gt 0
$application = $null
$previousRecipe = [Environment]::GetEnvironmentVariable('PUPPETLOOM_PSD_REPAIR_RECIPE', 'Process')
$previousOutput = [Environment]::GetEnvironmentVariable('PUPPETLOOM_PSD_REPAIR_OUTPUT', 'Process')

try {
    [Environment]::SetEnvironmentVariable('PUPPETLOOM_PSD_REPAIR_RECIPE', $recipePath, 'Process')
    [Environment]::SetEnvironmentVariable('PUPPETLOOM_PSD_REPAIR_OUTPUT', $outputPath, 'Process')
    $application = New-Object -ComObject Photoshop.Application
    $application.Visible = [bool]$ShowPhotoshop
    $result = $application.DoJavaScriptFile($scriptPath)
    if (-not $result) { throw 'Photoshop automation script returned no result.' }
    Write-Output $result
}
finally {
    [Environment]::SetEnvironmentVariable('PUPPETLOOM_PSD_REPAIR_RECIPE', $previousRecipe, 'Process')
    [Environment]::SetEnvironmentVariable('PUPPETLOOM_PSD_REPAIR_OUTPUT', $previousOutput, 'Process')
    if ($null -ne $application) {
        if (-not $wasRunning) {
            try { $application.Quit() } catch {}
        }
        [Runtime.InteropServices.Marshal]::FinalReleaseComObject($application) | Out-Null
    }
}
