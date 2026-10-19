# Kimodo on this PC instead of RunPod (Windows, NVIDIA card).
#
#   .\local.ps1 setup                       # once: Python env + Kimodo (builds its C++ part with MSVC)
#   .\local.ps1 run --only explain --seeds 1
#   .\local.ps1 run                         # every gesture in runpod\gestures.json
#
# With less than 20 GB of VRAM the text encoder (Llama 3 8B, 16 GB) runs on
# the CPU: it needs that much free RAM, and close Lumi first (its sidecar and
# Ollama hold VRAM). Environment in %LOCALAPPDATA%\Lumi\motion, weights in
# %APPDATA%\Lumi\models\hf, clips in %LOCALAPPDATA%\Lumi\motion\out.
param(
    [Parameter(Position = 0)][ValidateSet("setup", "run")][string]$Command = "run",
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest = @()
)
# No $ErrorActionPreference = "Stop": Windows PowerShell 5.1 would stop at the
# first line Python writes to stderr (torch prints warnings there)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = "$env:LOCALAPPDATA\Lumi\motion"
$venv = "$root\venvs\kimodo"
$py = "$venv\Scripts\python.exe"

$env:LUMI_MOTION_ROOT = $root
$env:HF_HOME = "$env:APPDATA\Lumi\models\hf"
$env:PYTHONUNBUFFERED = "1"
$env:PYTHONUTF8 = "1"
$env:PATH = "$venv\Scripts;$env:PATH"  # cmake for the build
if (-not $env:HF_TOKEN) {
    # The token saved by `hf auth login` lives in the default cache, not in our HF_HOME
    $saved = "$env:USERPROFILE\.cache\huggingface\token"
    if (Test-Path $saved) { $env:HF_TOKEN = (Get-Content $saved -Raw).Trim() }
}

if ($Command -eq "setup") {
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw "uv not found: https://docs.astral.sh/uv/" }
    New-Item -ItemType Directory -Force "$root\venvs" | Out-Null
    if (-not (Test-Path $py)) { uv venv --python 3.10 $venv; if (-not $?) { exit 1 } }
    uv pip install --python $py --torch-backend auto torch cmake
    if (-not $?) { exit 1 }
    uv pip install --python $py "kimodo @ git+https://github.com/nv-tlabs/kimodo.git"
    if (-not $?) { exit 1 }
    & $py -c "import torch, kimodo, motion_correction; assert torch.cuda.is_available(), 'torch sees no GPU'; print('ready:', torch.__version__, torch.cuda.get_device_name(0))"
    if (-not $env:HF_TOKEN) { Write-Warning "No Hugging Face token: run 'hf auth login' (needs access to meta-llama/Meta-Llama-3-8B-Instruct)" }
    exit $LASTEXITCODE
}

if (-not (Test-Path $py)) { throw "Kimodo is not installed: .\local.ps1 setup" }
$gpu = (nvidia-smi --query-gpu=memory.total,memory.used --format=csv,noheader,nounits) -split ",\s*"
$total = [int]$gpu[0]; $used = [int]$gpu[1]
$env:TEXT_ENCODER_MODE = "local"  # no text encoder server to probe
if (-not $env:TEXT_ENCODER_DEVICE -and $total -lt 20000) {
    $env:TEXT_ENCODER_DEVICE = "cpu"
    Write-Host "Text encoder on the CPU ($total MB of VRAM)"
}
if ($used -gt 3000) { Write-Warning "$used MB of VRAM already in use: close Lumi and Ollama if generation runs out of memory" }
& $py "$here\runpod\generate.py" --engine kimodo @Rest
exit $LASTEXITCODE
