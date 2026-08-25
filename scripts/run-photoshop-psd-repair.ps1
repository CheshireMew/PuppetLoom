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

$runningPhotoshop = @(Get-Process -Name Photoshop -ErrorAction SilentlyContinue)
if ($runningPhotoshop.Count -gt 0) {
    $runningTitles = @($runningPhotoshop | ForEach-Object {
        if ([string]::IsNullOrWhiteSpace($_.MainWindowTitle)) { "PID $($_.Id)" }
        else { "PID $($_.Id): $($_.MainWindowTitle)" }
    }) -join '; '
    throw "Photoshop is already running; refusing to attach to or change the user's active session. Save and close Photoshop before retrying PSD repair. Running: $runningTitles"
}
$wasRunning = $false
$application = $null
$previousVisible = $null
$previousPhotoshopRecipe = ''
$previousPhotoshopOutput = ''
$previousRecipe = [Environment]::GetEnvironmentVariable('PUPPETLOOM_PSD_REPAIR_RECIPE', 'Process')
$previousOutput = [Environment]::GetEnvironmentVariable('PUPPETLOOM_PSD_REPAIR_OUTPUT', 'Process')

function ConvertTo-JavaScriptString([string]$Value) {
    return '"' + $Value.Replace('\', '\\').Replace('"', '\"').Replace("`r", '\r').Replace("`n", '\n') + '"'
}

function Invoke-PhotoshopCom([scriptblock]$Action, [string]$Label) {
    $maximumAttempts = 20
    for ($attempt = 1; $attempt -le $maximumAttempts; $attempt += 1) {
        try { return & $Action }
        catch [Runtime.InteropServices.COMException] {
            $retryable = $_.Exception.HResult -eq -2147417846 -or $_.Exception.HResult -eq -2147418111
            if (-not $retryable -or $attempt -eq $maximumAttempts) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
    throw "Photoshop COM action failed after retries: $Label"
}

try {
    [Environment]::SetEnvironmentVariable('PUPPETLOOM_PSD_REPAIR_RECIPE', $recipePath, 'Process')
    [Environment]::SetEnvironmentVariable('PUPPETLOOM_PSD_REPAIR_OUTPUT', $outputPath, 'Process')
    $application = Invoke-PhotoshopCom { New-Object -ComObject Photoshop.Application } 'connect'
    $previousVisible = Invoke-PhotoshopCom { $application.Visible } 'read visibility'
    if ($ShowPhotoshop) { Invoke-PhotoshopCom { $application.Visible = $true } 'show Photoshop' | Out-Null }
    elseif (-not $wasRunning) { Invoke-PhotoshopCom { $application.Visible = $false } 'hide newly launched Photoshop' | Out-Null }
    $previousPhotoshopRecipe = Invoke-PhotoshopCom { $application.DoJavaScript('$.getenv("PUPPETLOOM_PSD_REPAIR_RECIPE") || "";') } 'read recipe environment'
    $previousPhotoshopOutput = Invoke-PhotoshopCom { $application.DoJavaScript('$.getenv("PUPPETLOOM_PSD_REPAIR_OUTPUT") || "";') } 'read output environment'
    $setEnvironment = '$.setenv("PUPPETLOOM_PSD_REPAIR_RECIPE", ' + (ConvertTo-JavaScriptString $recipePath) + ');' +
        '$.setenv("PUPPETLOOM_PSD_REPAIR_OUTPUT", ' + (ConvertTo-JavaScriptString $outputPath) + ');'
    Invoke-PhotoshopCom { $application.DoJavaScript($setEnvironment) } 'set repair environment' | Out-Null
    $result = Invoke-PhotoshopCom { $application.DoJavaScriptFile($scriptPath) } 'run repair script'
    if (-not $result) { throw 'Photoshop automation script returned no result.' }
    Write-Output $result
}
finally {
    [Environment]::SetEnvironmentVariable('PUPPETLOOM_PSD_REPAIR_RECIPE', $previousRecipe, 'Process')
    [Environment]::SetEnvironmentVariable('PUPPETLOOM_PSD_REPAIR_OUTPUT', $previousOutput, 'Process')
    if ($null -ne $application) {
        try {
            $restoreEnvironment = '$.setenv("PUPPETLOOM_PSD_REPAIR_RECIPE", ' + (ConvertTo-JavaScriptString $previousPhotoshopRecipe) + ');' +
                '$.setenv("PUPPETLOOM_PSD_REPAIR_OUTPUT", ' + (ConvertTo-JavaScriptString $previousPhotoshopOutput) + ');'
            Invoke-PhotoshopCom { $application.DoJavaScript($restoreEnvironment) } 'restore repair environment' | Out-Null
        }
        catch {}
        if ($wasRunning -and $null -ne $previousVisible) {
            try { Invoke-PhotoshopCom { $application.Visible = [bool]$previousVisible } 'restore visibility' | Out-Null } catch {}
        }
        if (-not $wasRunning) {
            try {
                $remainingDocuments = Invoke-PhotoshopCom { $application.Documents.Count } 'count remaining documents'
                if ($remainingDocuments -eq 0) {
                    Invoke-PhotoshopCom { $application.Quit() } 'quit automation-owned Photoshop' | Out-Null
                }
                else {
                    Invoke-PhotoshopCom { $application.Visible = $true } 'show Photoshop with remaining documents' | Out-Null
                    Write-Warning "Photoshop still has $remainingDocuments document(s); leaving it open and visible instead of quitting."
                }
            }
            catch {
                try { $application.Visible = $true } catch {}
            }
        }
        [Runtime.InteropServices.Marshal]::FinalReleaseComObject($application) | Out-Null
    }
}
