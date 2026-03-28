# progress.ps1
# CRUD operations on setup-progress.json
# Usage:
#   progress.ps1 init
#   progress.ps1 get [<dotpath>]
#   progress.ps1 set <dotpath> <value>
# Output: JSON -> stdout   errors -> stderr
# Exit:   0=success  1=error

param(
    [Parameter(Position=0)]
    [string]$Command,

    [Parameter(Position=1)]
    [string]$DotPath,

    [Parameter(Position=2)]
    [string]$Value
)

$ErrorActionPreference = 'Stop'

$ProgressDir  = Join-Path $env:USERPROFILE '.tea-rags'
$ProgressFile = Join-Path $ProgressDir 'setup-progress.json'

function Write-Usage {
    Write-Error 'Usage: progress.ps1 init'
    Write-Error '       progress.ps1 get [<dotpath>]'
    Write-Error '       progress.ps1 set <dotpath> <value>'
    exit 1
}

if (-not $Command) { Write-Usage }

# ─── Dotpath navigation helpers ──────────────────────────────────────────────

function Get-ByDotPath {
    param([object]$Obj, [string]$Path)

    $parts = $Path -split '\.'
    $current = $Obj
    foreach ($part in $parts) {
        if ($null -eq $current) { return $null }
        if ($current -is [System.Collections.IDictionary]) {
            $current = $current[$part]
        } elseif ($current.PSObject.Properties[$part]) {
            $current = $current.PSObject.Properties[$part].Value
        } else {
            return $null
        }
    }
    return $current
}

function Set-ByDotPath {
    param([object]$Obj, [string]$Path, [object]$NewValue)

    $parts = $Path -split '\.'
    $current = $Obj

    for ($i = 0; $i -lt ($parts.Count - 1); $i++) {
        $part = $parts[$i]
        if ($current -is [System.Collections.IDictionary]) {
            $current = $current[$part]
        } else {
            $current = $current.PSObject.Properties[$part].Value
        }
    }

    $lastPart = $parts[-1]
    if ($current -is [System.Collections.IDictionary]) {
        $current[$lastPart] = $NewValue
    } else {
        $current.PSObject.Properties[$lastPart].Value = $NewValue
    }

    return $Obj
}

# ─── Commands ────────────────────────────────────────────────────────────────

switch ($Command) {

    'init' {
        if (-not (Test-Path $ProgressDir)) {
            New-Item -ItemType Directory -Path $ProgressDir -Force | Out-Null
        }

        $startedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

        $progress = [ordered]@{
            version             = 1
            startedAt           = $startedAt
            platform            = $null
            arch                = $null
            versionManager      = $null
            packageManager      = $null
            nodePath            = $null
            npmPath             = $null
            embeddingProvider   = $null
            qdrantMode          = $null
            projectPath         = $null
            projectLocEstimate  = $null
            gpu                 = $null
            steps               = [ordered]@{
                detect      = [ordered]@{ status = 'pending' }
                node        = [ordered]@{ status = 'pending' }
                'tea-rags'  = [ordered]@{ status = 'pending' }
                embedding   = [ordered]@{ status = 'pending' }
                qdrant      = [ordered]@{ status = 'pending' }
                tune        = [ordered]@{ status = 'pending' }
                analyze     = [ordered]@{ status = 'pending' }
                configure   = [ordered]@{ status = 'pending' }
                verify      = [ordered]@{ status = 'pending' }
            }
        }

        $json = $progress | ConvertTo-Json -Depth 10
        $json | Set-Content -Path $ProgressFile -Encoding UTF8
        Write-Output $json
    }

    'get' {
        if (-not (Test-Path $ProgressFile)) {
            Write-Error "progress file not found: $ProgressFile"
            exit 1
        }

        $data = Get-Content -Path $ProgressFile -Raw | ConvertFrom-Json

        if (-not $DotPath) {
            Write-Output (Get-Content -Path $ProgressFile -Raw)
        } else {
            $val = Get-ByDotPath $data $DotPath
            if ($null -eq $val) {
                Write-Output 'null'
            } else {
                Write-Output ($val | ConvertTo-Json -Depth 10 -Compress)
            }
        }
    }

    'set' {
        if (-not $DotPath -or $null -eq $Value) {
            Write-Error 'set requires <dotpath> and <value>'
            exit 1
        }
        if (-not (Test-Path $ProgressFile)) {
            Write-Error "progress file not found: $ProgressFile"
            exit 1
        }

        $data = Get-Content -Path $ProgressFile -Raw | ConvertFrom-Json

        # Detect if value is valid JSON (object, array, boolean, number, null)
        $parsedValue = $null
        $isJson = $false
        try {
            $parsedValue = $Value | ConvertFrom-Json -ErrorAction Stop
            # ConvertFrom-Json succeeds for plain strings too — disambiguate:
            # If original value starts with { [ or is a known JSON literal, treat as JSON
            if ($Value -match '^[\[\{]' -or $Value -in 'true','false','null' -or $Value -match '^-?[0-9]+(\.[0-9]+)?$') {
                $isJson = $true
            }
        } catch {
            $isJson = $false
        }

        $setVal = if ($isJson) { $parsedValue } else { $Value }

        $parts = $DotPath -split '\.'
        $current = $data

        for ($i = 0; $i -lt ($parts.Count - 1); $i++) {
            $part = $parts[$i]
            $current = $current.PSObject.Properties[$part].Value
        }

        $lastPart = $parts[-1]
        $current.PSObject.Properties[$lastPart].Value = $setVal

        $json = $data | ConvertTo-Json -Depth 10
        $json | Set-Content -Path $ProgressFile -Encoding UTF8
        Write-Output '{"status":"ok"}'
    }

    default {
        Write-Usage
    }
}
