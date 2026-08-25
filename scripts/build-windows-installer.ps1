$ErrorActionPreference = "Stop"
$workspacePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$version = (Get-Content -LiteralPath (Join-Path $workspacePath "apps\desktop\package.json") -Raw | ConvertFrom-Json).version
$buildId = Get-Date -Format "yyyyMMdd-HHmmss"
$releasePath = Join-Path $workspacePath ("release\" + $version + "-" + $buildId)
if (Test-Path -LiteralPath $releasePath) { throw "Unique release path already exists: $releasePath" }
if (-not $releasePath.StartsWith($workspacePath, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Release path is outside workspace: $releasePath" }
$env:npm_config_cache = "D:\Tools\npm-cache"
$env:ELECTRON_BUILDER_CACHE = "D:\Tools\electron-builder-cache"
Push-Location $workspacePath
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
  node scripts/prepare-installer-assets.mjs
  if ($LASTEXITCODE -ne 0) { throw "installer asset preparation failed with exit code $LASTEXITCODE" }
  $outputArgument = "--config.directories.output=" + $releasePath
  npx electron-builder --projectDir apps/desktop --config ../../build/windows/electron-builder.yml $outputArgument --win nsis
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with exit code $LASTEXITCODE" }
  $installer = Get-ChildItem -LiteralPath $releasePath -Filter "PuppetLoom-*-Windows-x64.exe" -File | Select-Object -First 1
  if (-not $installer) { throw "Windows installer was not produced in $releasePath" }
  node scripts/generate-update-manifest.mjs --installer $installer.FullName --version $version
  if ($LASTEXITCODE -ne 0) { throw "update manifest generation failed with exit code $LASTEXITCODE" }
  Write-Output $installer.FullName
} finally {
  Pop-Location
}
