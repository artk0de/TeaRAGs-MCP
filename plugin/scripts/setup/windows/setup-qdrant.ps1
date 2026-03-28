# setup-qdrant.ps1
# Sets up Qdrant in embedded, docker, or native mode
# Input:  $1 = mode (embedded|docker|native)
# Output: JSON -> stdout   errors -> stderr
# Exit:   0=success  1=error  2=manual_required

param(
    [Parameter(Position=0)]
    [string]$Mode = 'embedded'
)

$ErrorActionPreference = 'Stop'

$BinaryPath = Join-Path $env:USERPROFILE '.tea-rags\qdrant\bin\qdrant.exe'
$HealthzUrl = 'http://localhost:6333/healthz'

# ─── Helpers ──────────────────────────────────────────────────────────────────

function Wait-ForHealthz {
    param([string]$Url, [int]$MaxSeconds = 30)
    for ($i = 0; $i -lt $MaxSeconds; $i++) {
        try {
            $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) { return $true }
        } catch { }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Emit-Result {
    param([string]$Status, [string]$Mode, [string]$Url)
    $obj = [ordered]@{
        status = $Status
        mode   = $Mode
        url    = $Url
    }
    Write-Output ($obj | ConvertTo-Json -Compress)
}

# ─── Modes ────────────────────────────────────────────────────────────────────

switch ($Mode) {

    'embedded' {
        if (Test-Path $BinaryPath) {
            Emit-Result 'already_done' 'embedded' 'embedded'
            exit 0
        }

        # Trigger postinstall download
        try { & npx tea-rags --version 2>$null | Out-Null } catch { }

        if (Test-Path $BinaryPath) {
            Emit-Result 'installed' 'embedded' 'embedded'
            exit 0
        }

        Write-Error 'Embedded Qdrant binary not found after postinstall trigger'
        Emit-Result 'error' 'embedded' 'embedded'
        exit 1
    }

    'docker' {
        $dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
        if (-not $dockerCmd) {
            Write-Error 'Docker is not installed or not in PATH'
            exit 2
        }

        # Check if already running
        $running = & docker ps --filter 'name=qdrant' --filter 'status=running' --format '{{.Names}}' 2>$null
        if ($running) {
            Emit-Result 'already_done' 'docker' 'http://localhost:6333'
            exit 0
        }

        # Check if stopped container exists
        $stopped = & docker ps -a --filter 'name=qdrant' --filter 'status=exited' --format '{{.Names}}' 2>$null
        if ($stopped) {
            & docker start qdrant 2>&1 | Out-Null
        } else {
            & docker run -d `
                --name qdrant `
                -p 6333:6333 `
                -v qdrant_storage:/qdrant/storage `
                qdrant/qdrant:latest 2>&1 | Out-Null
        }

        if (Wait-ForHealthz $HealthzUrl) {
            Emit-Result 'installed' 'docker' 'http://localhost:6333'
            exit 0
        } else {
            Write-Error 'Qdrant did not become healthy within 30 seconds'
            Emit-Result 'error' 'docker' 'http://localhost:6333'
            exit 1
        }
    }

    'native' {
        # Download qdrant.exe from GitHub releases for Windows x86_64
        $arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture
        $qdrantArch = switch ($arch) {
            'X64'   { 'x86_64-pc-windows-msvc' }
            default {
                Write-Error "Unsupported architecture: $arch"
                Emit-Result 'error' 'native' 'http://localhost:6333'
                exit 1
            }
        }

        # Fetch latest version from GitHub API
        try {
            $releaseInfo = Invoke-RestMethod -Uri 'https://api.github.com/repos/qdrant/qdrant/releases/latest' -ErrorAction Stop
            $latestVersion = $releaseInfo.tag_name
        } catch {
            Write-Error 'Failed to fetch latest Qdrant version from GitHub'
            Emit-Result 'error' 'native' 'http://localhost:6333'
            exit 1
        }

        if (-not $latestVersion) {
            Write-Error 'Failed to parse latest Qdrant version from GitHub response'
            Emit-Result 'error' 'native' 'http://localhost:6333'
            exit 1
        }

        $downloadUrl = "https://github.com/qdrant/qdrant/releases/download/$latestVersion/qdrant-$qdrantArch.zip"
        $installDir  = Join-Path $env:USERPROFILE '.local\bin'
        $qdrantExe   = Join-Path $installDir 'qdrant.exe'

        if (-not (Test-Path $installDir)) {
            New-Item -ItemType Directory -Path $installDir -Force | Out-Null
        }

        $tmpZip = Join-Path $env:TEMP "qdrant-$latestVersion.zip"
        try {
            Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpZip -UseBasicParsing -ErrorAction Stop
            Expand-Archive -Path $tmpZip -DestinationPath $env:TEMP -Force
            Move-Item -Path (Join-Path $env:TEMP 'qdrant.exe') -Destination $qdrantExe -Force
        } finally {
            if (Test-Path $tmpZip) { Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue }
        }

        $storagePath = Join-Path $env:USERPROFILE '.tea-rags\qdrant-native-storage'
        if (-not (Test-Path $storagePath)) {
            New-Item -ItemType Directory -Path $storagePath -Force | Out-Null
        }

        Start-Process -FilePath $qdrantExe -ArgumentList "--storage-path `"$storagePath`"" -WindowStyle Hidden

        if (Wait-ForHealthz $HealthzUrl) {
            Emit-Result 'installed' 'native' 'http://localhost:6333'
            exit 0
        } else {
            Write-Error 'Qdrant did not become healthy within 30 seconds'
            Emit-Result 'error' 'native' 'http://localhost:6333'
            exit 1
        }
    }

    default {
        Write-Error "Unknown mode: $Mode. Expected: embedded|docker|native"
        exit 1
    }
}
