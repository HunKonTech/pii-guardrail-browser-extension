# Build the Microsoft Edge package on Windows.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\edge\build-edge.ps1 [--skip-build] [--require-model]
$ErrorActionPreference = 'Stop'

$RootDir = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $RootDir

# rustup installs cargo and wasm-bindgen here without always adding it to PATH.
$CargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if ((Test-Path $CargoBin) -and -not ($env:Path -split ';' -contains $CargoBin)) {
  $env:Path = "$CargoBin;$env:Path"
}

if (-not (Test-Path 'node_modules')) {
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

node scripts/edge/build-edge.js @args
exit $LASTEXITCODE
