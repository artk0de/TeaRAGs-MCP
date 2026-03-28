# detect-environment.ps1
# Detects platform, arch, version managers, node, package managers, tools, GPU
# Output: JSON -> stdout   errors -> stderr
# Exit:   0=success  1=error

$ErrorActionPreference = 'Stop'

# ─── Platform ────────────────────────────────────────────────────────────────

$platform = 'windows'

# ─── Architecture ────────────────────────────────────────────────────────────

$rawArch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture
$arch = switch ($rawArch) {
    'X64'   { 'x86_64' }
    'Arm64' { 'arm64' }
    default { $rawArch.ToString().ToLower() }
}

# ─── Version manager inventory ───────────────────────────────────────────────

$availableManagers = [System.Collections.Generic.List[string]]::new()

$managerCandidates = @('volta', 'fnm', 'nodenv', 'n')
foreach ($mgr in $managerCandidates) {
    if (Get-Command $mgr -ErrorAction SilentlyContinue) {
        $availableManagers.Add($mgr)
    }
}

# nvm-windows: check NVM_HOME env var
if ($env:NVM_HOME -and (Test-Path $env:NVM_HOME)) {
    $availableManagers.Add('nvm')
}

# ─── Active manager (via resolved node path) ──────────────────────────────────

$activeManager = 'none'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $nodePath = $nodeCmd.Source

    # Resolve symlinks when possible
    try {
        $item = Get-Item $nodePath -ErrorAction Stop
        if ($item.LinkType) {
            $nodePath = $item.Target
        }
    } catch { }

    $activeManager = switch -Wildcard ($nodePath) {
        "*\.volta\*"  { 'volta'; break }
        "*\fnm\*"     { 'fnm';   break }
        "*\.nvm\*"    { 'nvm';   break }
        "*\nvm\*"     { 'nvm';   break }
        default       { 'none' }
    }

    # Check known Windows paths explicitly
    if ($activeManager -eq 'none') {
        if ($nodePath -like "$env:USERPROFILE\.volta\*")  { $activeManager = 'volta' }
        elseif ($nodePath -like "$env:APPDATA\fnm\*")     { $activeManager = 'fnm' }
        elseif ($env:NVM_HOME -and $nodePath -like "$env:NVM_HOME\*") { $activeManager = 'nvm' }
    }
}

# ─── Node info ────────────────────────────────────────────────────────────────

$nodeVersion = $null
$nodePathOut  = $null
$npmPathOut   = $null

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $rawVer = & node --version 2>$null
    $nodeVersion = $rawVer -replace '^v', ''
    $nodePathOut = $nodeCmd.Source

    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCmd) {
        $npmPathOut = $npmCmd.Source
    }
}

# ─── Package manager ─────────────────────────────────────────────────────────

$packageManager = 'none'
if (Get-Command npm  -ErrorAction SilentlyContinue) { $packageManager = 'npm'  }
elseif (Get-Command pnpm -ErrorAction SilentlyContinue) { $packageManager = 'pnpm' }
elseif (Get-Command yarn -ErrorAction SilentlyContinue) { $packageManager = 'yarn' }
elseif (Get-Command bun  -ErrorAction SilentlyContinue) { $packageManager = 'bun'  }

# ─── Tool checks ─────────────────────────────────────────────────────────────

$hasGit    = [bool](Get-Command git    -ErrorAction SilentlyContinue)
$hasDocker = [bool](Get-Command docker -ErrorAction SilentlyContinue)
$hasOllama = [bool](Get-Command ollama -ErrorAction SilentlyContinue)
$hasBrew   = [bool](Get-Command brew   -ErrorAction SilentlyContinue)

# ─── GPU detection ───────────────────────────────────────────────────────────

$gpuVendor = 'none'
$gpuModel  = $null
$gpuArch   = $null

try {
    $gpuControllers = Get-CimInstance Win32_VideoController -ErrorAction Stop
    $primary = $gpuControllers | Select-Object -First 1

    if ($primary) {
        $name = $primary.Name

        if ($name -match 'NVIDIA|GeForce|Quadro|Tesla') {
            $gpuVendor = 'nvidia'
            $gpuModel  = $name
        } elseif ($name -match 'AMD|Radeon|ATI') {
            $gpuVendor = 'amd'
            $gpuModel  = $name
            # RDNA generation from model number (RX 6xxx = RDNA2, RX 7xxx = RDNA3)
            if ($name -match 'RX\s*7[0-9]{3}') {
                $gpuArch = 'RDNA3'
            } elseif ($name -match 'RX\s*6[0-9]{3}') {
                $gpuArch = 'RDNA2'
            }
        } elseif ($name -match 'Intel') {
            $gpuVendor = 'intel'
            $gpuModel  = $name
        }
    }
} catch {
    # GPU detection is best-effort — silently continue
}

# ─── Emit JSON ───────────────────────────────────────────────────────────────

$output = [ordered]@{
    platform          = $platform
    arch              = $arch
    availableManagers = @($availableManagers)
    activeManager     = $activeManager
    packageManager    = $packageManager
    nodeVersion       = $nodeVersion
    nodePath          = $nodePathOut
    npmPath           = $npmPathOut
    hasGit            = $hasGit
    hasDocker         = $hasDocker
    hasOllama         = $hasOllama
    hasBrew           = $hasBrew
    gpu               = [ordered]@{
        vendor       = $gpuVendor
        model        = $gpuModel
        architecture = $gpuArch
    }
}

Write-Output ($output | ConvertTo-Json -Depth 5 -Compress)
