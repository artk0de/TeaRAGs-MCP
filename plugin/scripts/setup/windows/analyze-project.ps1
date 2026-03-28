# analyze-project.ps1
# Analyzes a project directory: file count, LOC estimate, git history
# Input:  $1 = project path (default: current directory)
# Output: JSON -> stdout   errors -> stderr
# Exit:   0=success  1=error

param(
    [Parameter(Position=0)]
    [string]$ProjectPath = '.'
)

$ErrorActionPreference = 'Stop'

# Resolve to absolute path
$ProjectPath = (Resolve-Path $ProjectPath).Path

# ─── Excluded directories ─────────────────────────────────────────────────────

$ExcludeDirs = @('node_modules', '.git', 'vendor', 'dist', 'build')

function Test-Excluded {
    param([string]$Path)
    foreach ($dir in $ExcludeDirs) {
        if ($Path -like "*\$dir\*" -or $Path -like "*\$dir") { return $true }
        if ($Path -like "*/$dir/*" -or $Path -like "*/$dir")  { return $true }
    }
    return $false
}

# ─── File count ───────────────────────────────────────────────────────────────

$fileCount = 0
try {
    Get-ChildItem -Path $ProjectPath -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
        if (-not (Test-Excluded $_.FullName)) { $fileCount++ }
    }
} catch { }

# ─── LOC estimate ─────────────────────────────────────────────────────────────

$sourceExtensions = @('.ts', '.js', '.py', '.rb', '.java', '.go', '.rs', '.cs',
                      '.c', '.cpp', '.h', '.hpp', '.kt', '.scala', '.swift', '.php')

$locEstimate = 0
try {
    Get-ChildItem -Path $ProjectPath -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
        if (-not (Test-Excluded $_.FullName) -and $sourceExtensions -contains $_.Extension) {
            $lines = (Get-Content $_.FullName -ErrorAction SilentlyContinue | Measure-Object -Line).Lines
            $locEstimate += $lines
        }
    }
} catch { }

# ─── Git analysis ─────────────────────────────────────────────────────────────

$isGitRepo          = $false
$topAuthor          = $null
$authorCommitCount  = $null
$hasFrequentCommits = $false
$avgGapMinutes      = $null
$gitEnabled         = $false
$squashAware        = $false

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) {
    try {
        $checkRepo = & git -C $ProjectPath rev-parse --is-inside-work-tree 2>$null
        if ($checkRepo -eq 'true') {
            $isGitRepo  = $true
            $gitEnabled = $true

            # Get last 200 commits: "AuthorName|UnixTimestamp"
            $gitLog = & git -C $ProjectPath log --format='%an|%at' -200 2>$null
            $gitLines = $gitLog | Where-Object { $_ -and $_.Trim() }

            if ($gitLines) {
                # Find dominant author
                $authorCounts = $gitLines |
                    ForEach-Object { ($_ -split '\|')[0] } |
                    Group-Object |
                    Sort-Object Count -Descending |
                    Select-Object -First 1

                if ($authorCounts) {
                    $topAuthorName    = $authorCounts.Name
                    $authorCommitCount = $authorCounts.Count
                    $topAuthor        = $topAuthorName

                    # Get timestamps for dominant author, sorted ascending
                    $authorTimestamps = $gitLines |
                        ForEach-Object {
                            $parts = $_ -split '\|'
                            if ($parts[0] -eq $topAuthorName -and $parts.Count -ge 2) {
                                [long]$parts[1]
                            }
                        } |
                        Where-Object { $_ } |
                        Sort-Object

                    if ($authorTimestamps -and $authorTimestamps.Count -gt 1) {
                        $gaps = [System.Collections.Generic.List[double]]::new()
                        $tsArr = @($authorTimestamps)
                        for ($i = 1; $i -lt $tsArr.Count; $i++) {
                            $gap = ($tsArr[$i] - $tsArr[$i-1]) / 60.0
                            if ($gap -ge 0) { $gaps.Add($gap) }
                        }

                        if ($gaps.Count -gt 0) {
                            # Median gap
                            $sorted = ($gaps | Sort-Object)
                            $mid    = [int](($gaps.Count + 1) / 2) - 1
                            $median = [math]::Round($sorted[$mid], 0)

                            $avgGapMinutes = $median

                            if ($median -lt 30) {
                                $hasFrequentCommits = $true
                                $squashAware        = $true
                            }
                        }
                    }
                }
            }
        }
    } catch { }
}

# ─── recommendedEnv ───────────────────────────────────────────────────────────

$recommendedEnv = [ordered]@{
    TRAJECTORY_GIT_ENABLED = $gitEnabled.ToString().ToLower()
}
if ($squashAware) {
    $recommendedEnv['TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS'] = 'true'
}

# ─── Output JSON ──────────────────────────────────────────────────────────────

if ($isGitRepo) {
    $output = [ordered]@{
        isGitRepo           = $true
        fileCount           = $fileCount
        locEstimate         = $locEstimate
        topAuthor           = $topAuthor
        authorCommitCount   = $authorCommitCount
        hasFrequentCommits  = $hasFrequentCommits
        avgGapMinutes       = $avgGapMinutes
        recommendedEnv      = $recommendedEnv
    }
} else {
    $output = [ordered]@{
        isGitRepo           = $false
        fileCount           = $fileCount
        locEstimate         = $locEstimate
        topAuthor           = $null
        authorCommitCount   = $null
        hasFrequentCommits  = $false
        avgGapMinutes       = $null
        recommendedEnv      = $recommendedEnv
    }
}

Write-Output ($output | ConvertTo-Json -Depth 5 -Compress)
