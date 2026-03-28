# install-node.ps1
# Installs Node.js >= 22 via the given version manager
# Input:  $1 = version manager (volta|fnm|nvm|none)
# Output: JSON -> stdout   errors -> stderr
# Exit:   0=success  1=error  2=manual_required

param(
    [Parameter(Position=0)]
    [string]$VersionManager = 'none'
)

$ErrorActionPreference = 'Stop'

$MIN_MAJOR = 22

# ─── Helpers ──────────────────────────────────────────────────────────────────

function Get-NodeVersion {
    try {
        $raw = & node --version 2>$null
        if ($raw) { return ($raw -replace '^v', '') }
    } catch { }
    return $null
}

function Get-NodeMajor {
    $ver = Get-NodeVersion
    if (-not $ver) { return 0 }
    return [int]($ver -split '\.')[0]
}

function Get-NodePath {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Emit-Result {
    param([string]$Status, [string]$NodePath, [string]$NodeVersion)
    $obj = [ordered]@{
        status      = $Status
        nodePath    = if ($NodePath) { $NodePath } else { $null }
        nodeVersion = if ($NodeVersion) { $NodeVersion } else { $null }
    }
    Write-Output ($obj | ConvertTo-Json -Compress)
}

# ─── Check if already satisfied ───────────────────────────────────────────────

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $major = Get-NodeMajor
    if ($major -ge $MIN_MAJOR) {
        $ver  = Get-NodeVersion
        $path = Get-NodePath
        Emit-Result 'already_done' $path $ver
        exit 0
    }
}

# ─── Install via version manager ──────────────────────────────────────────────

switch ($VersionManager) {

    'volta' {
        & volta install node@22 2>&1 | ForEach-Object { Write-Host $_ }
    }

    'fnm' {
        & fnm install 22 2>&1 | ForEach-Object { Write-Host $_ }
        & fnm default 22 2>&1 | ForEach-Object { Write-Host $_ }
        # Reload fnm env for current process
        try {
            $fnmEnv = & fnm env --shell powershell 2>$null
            if ($fnmEnv) { Invoke-Expression ($fnmEnv -join '; ') }
        } catch { }
    }

    'nvm' {
        # nvm-windows uses a separate executable
        $nvmExe = Get-Command nvm -ErrorAction SilentlyContinue
        if (-not $nvmExe) {
            Write-Error 'nvm (nvm-windows) not found in PATH'
            exit 1
        }
        & nvm install 22.0.0 2>&1 | ForEach-Object { Write-Host $_ }
        & nvm use 22.0.0 2>&1 | ForEach-Object { Write-Host $_ }
    }

    'none' {
        $result = [ordered]@{
            status      = 'manual_required'
            nodePath    = $null
            nodeVersion = $null
        }
        Write-Output ($result | ConvertTo-Json -Compress)
        exit 2
    }

    default {
        Write-Error "Unknown version manager: $VersionManager"
        exit 1
    }
}

# ─── Verify installation ──────────────────────────────────────────────────────

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Error 'node not found after install'
    exit 1
}

$ver   = Get-NodeVersion
$major = Get-NodeMajor
if ($major -lt $MIN_MAJOR) {
    Write-Error "installed node $ver is below required $MIN_MAJOR"
    exit 1
}

$path = Get-NodePath
Emit-Result 'installed' $path $ver
