# install-tea-rags.ps1
# Installs or updates the tea-rags global package
# Input:  $1 = package manager (npm|yarn|pnpm|bun)
#         $2 = path to the package manager binary (optional)
# Output: JSON -> stdout   errors -> stderr
# Exit:   0=success  1=error

param(
    [Parameter(Position=0)]
    [string]$PackageManager = 'npm',

    [Parameter(Position=1)]
    [string]$PmBinPath = ''
)

$ErrorActionPreference = 'Stop'

# If caller gave us a binary path, prepend its directory to PATH
if ($PmBinPath -and (Test-Path $PmBinPath)) {
    $pmDir = Split-Path $PmBinPath -Parent
    $env:PATH = "$pmDir;$env:PATH"
}

# ─── Helpers ──────────────────────────────────────────────────────────────────

function Get-TeaRagsBin {
    $cmd = Get-Command tea-rags -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Get-TeaRagsVersion {
    $bin = Get-TeaRagsBin
    if (-not $bin) { return $null }
    try {
        $raw = & $bin --version 2>$null
        if ($raw) { return ($raw -replace '^[^0-9]*', '').Trim() }
    } catch { }
    return $null
}

function Get-LatestNpmVersion {
    try {
        $raw = & npm view tea-rags version 2>$null
        if ($raw) { return $raw.Trim() }
    } catch { }
    return $null
}

function Emit-Result {
    param([string]$Status, [string]$BinPath, [string]$Version)
    $obj = [ordered]@{
        status  = $Status
        binPath = if ($BinPath) { $BinPath } else { $null }
        version = if ($Version) { $Version } else { $null }
    }
    Write-Output ($obj | ConvertTo-Json -Compress)
}

# ─── npm prefix permission warning ────────────────────────────────────────────

function Test-NpmPrefixWritable {
    if ($PackageManager -eq 'npm') {
        try {
            $prefix = (& npm prefix -g 2>$null).Trim()
            if ($prefix -and -not (Test-Path $prefix -PathType Container)) {
                Write-Error "WARNING: npm global prefix $prefix may not be writable"
            }
        } catch { }
    }
}

# ─── Install / update commands ────────────────────────────────────────────────

function Invoke-Install {
    switch ($PackageManager) {
        'npm'  { & npm  install -g tea-rags         2>&1 | ForEach-Object { Write-Host $_ } }
        'yarn' { & yarn global add tea-rags          2>&1 | ForEach-Object { Write-Host $_ } }
        'pnpm' { & pnpm add     -g tea-rags          2>&1 | ForEach-Object { Write-Host $_ } }
        'bun'  { & bun  add     -g tea-rags          2>&1 | ForEach-Object { Write-Host $_ } }
        default {
            Write-Error "Unknown package manager: $PackageManager"
            exit 1
        }
    }
}

function Invoke-Update {
    switch ($PackageManager) {
        'npm'  { & npm  install -g tea-rags@latest   2>&1 | ForEach-Object { Write-Host $_ } }
        'yarn' { & yarn global upgrade tea-rags       2>&1 | ForEach-Object { Write-Host $_ } }
        'pnpm' { & pnpm update  -g tea-rags           2>&1 | ForEach-Object { Write-Host $_ } }
        'bun'  { & bun  add     -g tea-rags@latest    2>&1 | ForEach-Object { Write-Host $_ } }
        default {
            Write-Error "Unknown package manager: $PackageManager"
            exit 1
        }
    }
}

# ─── Main logic ───────────────────────────────────────────────────────────────

$currentBin = Get-TeaRagsBin

if ($currentBin) {
    $currentVer = Get-TeaRagsVersion
    $latestVer  = Get-LatestNpmVersion

    if ($latestVer -and $currentVer -eq $latestVer) {
        Emit-Result 'already_done' $currentBin $currentVer
        exit 0
    } else {
        Test-NpmPrefixWritable
        Invoke-Update
    }
} else {
    Test-NpmPrefixWritable
    Invoke-Install
}

# ─── Verify ───────────────────────────────────────────────────────────────────

$finalBin = Get-TeaRagsBin
if (-not $finalBin) {
    Write-Error 'tea-rags not found after install'
    exit 1
}

$finalVer = Get-TeaRagsVersion
Emit-Result 'installed' $finalBin $finalVer
