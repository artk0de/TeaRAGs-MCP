# tune.ps1
# Runs the tea-rags tuning process for the given embedding provider
# Input:  $1 = embedding provider (onnx|ollama)
# Output: JSON -> stdout   errors -> stderr
# Exit:   0=success (always — errors return status:"error" but exit 0)

param(
    [Parameter(Position=0)]
    [string]$EmbeddingProvider = 'onnx'
)

$ErrorActionPreference = 'Stop'

$DefaultsJson = '{"EMBEDDING_BATCH_SIZE":"32","QDRANT_UPSERT_BATCH_SIZE":"100","INGEST_PIPELINE_CONCURRENCY":"1"}'
$OllamaDefaultsJson = '{"EMBEDDING_BATCH_SIZE":"256","QDRANT_UPSERT_BATCH_SIZE":"100","INGEST_PIPELINE_CONCURRENCY":"1"}'

# ─── onnx → skip ──────────────────────────────────────────────────────────────

if ($EmbeddingProvider -eq 'onnx') {
    Write-Output "{`"status`":`"skipped`",`"values`":$DefaultsJson}"
    exit 0
}

# ─── ollama → run tune ────────────────────────────────────────────────────────

if ($EmbeddingProvider -eq 'ollama') {
    $EnvFile = 'tuned_environment_variables.env'

    # Run tune — non-critical, capture exit code
    try {
        $env:EMBEDDING_PROVIDER = 'ollama'
        & npx tea-rags tune 2>&1 | Out-Null
    } catch {
        Write-Host 'tune command failed, using ollama defaults' -ForegroundColor Yellow
        Write-Output "{`"status`":`"error`",`"values`":$OllamaDefaultsJson}"
        exit 0
    }

    if (-not (Test-Path $EnvFile)) {
        Write-Host 'tuned_environment_variables.env not found after tune, using ollama defaults' -ForegroundColor Yellow
        Write-Output "{`"status`":`"error`",`"values`":$OllamaDefaultsJson}"
        exit 0
    }

    # Parse KEY=VALUE lines from env file into JSON object
    $pairs = [System.Collections.Generic.List[string]]::new()
    try {
        Get-Content $EnvFile | ForEach-Object {
            if ($_ -match '^([A-Z_][A-Z0-9_]*)=(.*)$') {
                $key = $Matches[1]
                $val = $Matches[2] -replace '"', '\"'
                $pairs.Add("`"$key`":`"$val`"")
            }
        }
    } finally {
        if (Test-Path $EnvFile) { Remove-Item $EnvFile -Force -ErrorAction SilentlyContinue }
    }

    if ($pairs.Count -eq 0) {
        Write-Host 'Failed to parse tune env file, using ollama defaults' -ForegroundColor Yellow
        Write-Output "{`"status`":`"error`",`"values`":$OllamaDefaultsJson}"
        exit 0
    }

    $valuesJson = '{' + ($pairs -join ',') + '}'
    Write-Output "{`"status`":`"completed`",`"values`":$valuesJson}"
    exit 0
}

# ─── Unknown provider ─────────────────────────────────────────────────────────

Write-Host "Unknown embedding provider: $EmbeddingProvider. Expected: ollama|onnx" -ForegroundColor Yellow
Write-Output "{`"status`":`"error`",`"values`":$DefaultsJson}"
exit 0
