# Runs the external-dataset TRANSFORMER experiments sequentially on this laptop (CPU, offline, pinned
# DistilRoBERTa revision), using the project's existing .venv. Nothing is installed or downloaded.
#
#   cd D:\Thisula\Research\J26-IT-353\ai-service
#   powershell -ExecutionPolicy Bypass -File event_intel\external_experiments\run_transformer_plans.ps1            # everything (about 4-5 h)
#   powershell -ExecutionPolicy Bypass -File event_intel\external_experiments\run_transformer_plans.ps1 -Plans C_dt_intermediate,E2_news_plus_dt_mapped
#   powershell -ExecutionPolicy Bypass -File event_intel\external_experiments\run_transformer_plans.ps1 -SmokeOnly
#
# Order: smoke checks (tiny, meaningless results; exercise each new code path) -> plans x seeds 42,13,7 -> summary.
# Stops at the first failure. Close browsers/IDEs first: training refuses to start with < 3 GB free RAM.
# Each full run saves a ~330 MB checkpoint under data\external_experiments\runs\<run_id>\ (git-ignored).
param(
    [string[]]$Plans = @("C_dt_intermediate", "B_humaid_intermediate", "E2_news_plus_dt_mapped",
                         "D_bbc_intermediate", "E1_news_plus_humaid_mapped", "E3_news_plus_all_mapped"),
    [switch]$SmokeOnly,
    [switch]$SkipSmoke
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))   # ai-service\
$py = ".venv\Scripts\python.exe"
$logs = "data\external_experiments\logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$env:PYTHONDONTWRITEBYTECODE = "1"

function Invoke-Step([string]$name, [string[]]$arguments) {
    $log = Join-Path $logs ("{0}_{1}.log" -f $name, (Get-Date -Format "yyyyMMddTHHmmss"))
    Write-Host ">>> $name  (log: $log)"
    # Windows PowerShell 5.1 turns native stderr (e.g. Hugging Face progress bars) into errors under
    # ErrorActionPreference=Stop, so relax it while Python runs and check the real exit code instead.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $py @arguments 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $log
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previous
    if ($code -ne 0) { throw "$name failed with exit code $code - see $log" }
}

Invoke-Step "unit_tests" @("-m", "unittest", "tests.test_external_experiments", "tests.test_experiments")
if (-not $SkipSmoke) {
    Invoke-Step "smoke_B" @("-m", "event_intel.external_experiments.train_eval", "--model", "transformer", "--plan", "B_humaid_intermediate", "--smoke")
    Invoke-Step "smoke_D" @("-m", "event_intel.external_experiments.train_eval", "--model", "transformer", "--plan", "D_bbc_intermediate", "--smoke", "--no-checkpoint")
    Invoke-Step "smoke_E2" @("-m", "event_intel.external_experiments.train_eval", "--model", "transformer", "--plan", "E2_news_plus_dt_mapped", "--smoke", "--no-checkpoint")
}
if ($SmokeOnly) { Write-Host "Smoke checks passed."; exit 0 }
foreach ($plan in $Plans) {
    foreach ($seed in 42, 13, 7) {
        Invoke-Step ("{0}_seed{1}" -f $plan, $seed) @("-m", "event_intel.external_experiments.train_eval", "--model", "transformer", "--plan", $plan, "--seed", "$seed")
    }
}
Invoke-Step "summary" @("-m", "event_intel.external_experiments.summarize")
Write-Host "Done. Summary: data\external_experiments\summary\ (newest file)."
