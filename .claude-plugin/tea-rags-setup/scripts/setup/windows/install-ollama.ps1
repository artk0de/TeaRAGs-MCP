# install-ollama.ps1
# Installs Ollama on Windows (always manual_required) and pulls the embedding model
# Input:  $1 = GPU JSON (optional, used to detect AMD RDNA2/3 for pro_driver method)
# Output: JSON -> stdout   errors -> stderr
# Exit:   0=success  1=error  2=manual_required

param(
    [Parameter(Position=0)]
    [string]$GpuJson = '{}'
)

$ErrorActionPreference = 'Stop'

$MODEL = 'unclemusclez/jina-embeddings-v2-base-code:latest'

# ─── Helpers ──────────────────────────────────────────────────────────────────

function Test-OllamaRunning {
    try {
        & ollama list 2>$null | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Wait-OllamaRunning {
    $retries = 10
    while ($retries -gt 0) {
        Start-Sleep -Seconds 1
        if (Test-OllamaRunning) { return $true }
        $retries--
    }
    return $false
}

function Start-OllamaServer {
    if (-not (Test-OllamaRunning)) {
        Write-Host 'Starting ollama server in background...' -ForegroundColor Gray
        Start-Process -FilePath 'ollama' -ArgumentList 'serve' -WindowStyle Hidden
        if (-not (Wait-OllamaRunning)) {
            Write-Error 'ollama server did not start in time'
            exit 1
        }
    }
}

function Test-ModelPresent {
    try {
        $list = & ollama list 2>$null
        return ($list -like "*$MODEL*")
    } catch {
        return $false
    }
}

function Pull-Model {
    Write-Host "Pulling model $MODEL ..." -ForegroundColor Gray
    & ollama pull $MODEL 2>&1 | ForEach-Object { Write-Host $_ }
}

function Emit-Result {
    param([string]$Status, [string]$Method)
    $obj = [ordered]@{
        status = $Status
        method = $Method
    }
    Write-Output ($obj | ConvertTo-Json -Compress)
}

# ─── Determine install method from GPU JSON ───────────────────────────────────

$method = 'app'
try {
    $gpu = $GpuJson | ConvertFrom-Json -ErrorAction Stop
    $arch = $gpu.architecture
    if ($arch -eq 'RDNA2' -or $arch -eq 'RDNA3') {
        $method = 'pro_driver'
    }
} catch { }

# ─── Main logic ───────────────────────────────────────────────────────────────

$ollamaCmd = Get-Command ollama -ErrorAction SilentlyContinue

if ($ollamaCmd) {
    # ollama already installed — ensure server is up, then check model
    Start-OllamaServer

    if (Test-ModelPresent) {
        Emit-Result 'already_done' 'existing'
        exit 0
    } else {
        Pull-Model
        Emit-Result 'already_done' 'existing'
        exit 0
    }
}

# ollama not installed — always manual_required on Windows
$result = [ordered]@{
    status = 'manual_required'
    method = $method
}
Write-Output ($result | ConvertTo-Json -Compress)
exit 2
