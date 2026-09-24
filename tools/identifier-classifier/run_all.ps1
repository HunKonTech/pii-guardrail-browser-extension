<#
.SYNOPSIS
  Build the identifier classifier end to end on Windows: clone, label, cut snippets, train, export.

.EXAMPLE
  .\run_all.ps1                      # everything, with dependency restore
  .\run_all.ps1 -NoRestore           # do not run npm install / dotnet restore
  .\run_all.ps1 -From train          # start at a later step
  .\run_all.ps1 -Hours 48                # give training two days
  .\run_all.ps1 -From train              # resume an interrupted training run

  Training checkpoints about once an hour. If the PC restarts or the window
  is closed, run `.\run_all.ps1 -From train` again and it continues.
#>
param(
  [ValidateSet('fetch', 'label', 'dataset', 'train', 'export')]
  [string]$From = 'fetch',
  [switch]$NoRestore,
  [string]$BaseModel = 'huggingface/CodeBERTa-small-v1',
  [double]$Epochs = 3,
  [double]$Hours = 36,
  [int]$BatchSize = 16,
  [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$work = Join-Path $here 'work'
$repos = Join-Path $work 'repos'
$labels = Join-Path $work 'labels'
$dataset = Join-Path $work 'dataset'
$model = Join-Path $work 'model'
$export = Join-Path $work 'export\code-identifier-classifier'
$steps = @('fetch', 'label', 'dataset', 'train', 'export')
$start = $steps.IndexOf($From)

function Step([string]$name) { return $steps.IndexOf($name) -ge $start }
function Invoke-Checked([scriptblock]$block) {
  & $block
  if ($LASTEXITCODE -ne 0) { throw "Step failed with exit code $LASTEXITCODE" }
}

if (Step 'fetch') {
  Write-Host '== 1/5 Cloning repositories' -ForegroundColor Cyan
  # Build the argument list explicitly: a one-element array assigned from an
  # `if` expression unwraps to a string, and splatting a string passes it
  # character by character.
  $fetchArgs = @((Join-Path $here 'fetch_repos.py'), '--out', $repos)
  if (-not $NoRestore) { $fetchArgs += '--restore' }
  Invoke-Checked { & $Python @fetchArgs }
}

if (Step 'label') {
  Write-Host '== 2/5 Labelling identifiers' -ForegroundColor Cyan
  New-Item -ItemType Directory -Force $labels | Out-Null
  Push-Location (Join-Path $here 'extract-ts')
  try {
    Invoke-Checked { npm install --no-audit --no-fund --loglevel=error }
    Invoke-Checked { node --max-old-space-size=12288 extract.mjs --repos (Join-Path $repos 'typescript') --out (Join-Path $labels 'typescript.jsonl') }
  } finally { Pop-Location }
  Push-Location (Join-Path $here 'extract-cs')
  try {
    Invoke-Checked { dotnet run -c Release -- --repos (Join-Path $repos 'csharp') --out (Join-Path $labels 'csharp.jsonl') }
  } finally { Pop-Location }
}

if (Step 'dataset') {
  Write-Host '== 3/5 Cutting snippets' -ForegroundColor Cyan
  Invoke-Checked { & $Python (Join-Path $here 'build_dataset.py') --inputs (Join-Path $labels '*.jsonl') --out $dataset }
}

if (Step 'train') {
  Write-Host '== 4/5 Training' -ForegroundColor Cyan
  Invoke-Checked { & $Python (Join-Path $here 'train.py') --data $dataset --out $model --base-model $BaseModel --epochs $Epochs --hours $Hours --batch-size $BatchSize }
}

if (Step 'export') {
  Write-Host '== 5/5 Exporting to ONNX' -ForegroundColor Cyan
  Invoke-Checked { & $Python (Join-Path $here 'export_onnx.py') --model (Join-Path $model 'final') --out $export --test (Join-Path $dataset 'test.jsonl') }
  Write-Host "Done. Model: $export" -ForegroundColor Green
}
