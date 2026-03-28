# configure-mcp.ps1
# Configures the tea-rags MCP server via `claude mcp add`
# Input:  $1 = ENV_JSON object of KEY=VALUE pairs to pass as -e args
# Output: JSON -> stdout   errors -> stderr
# Exit:   0=success  1=error

param(
    [Parameter(Position=0)]
    [string]$EnvJson = '{}'
)

$ErrorActionPreference = 'Stop'

# ─── Build -e KEY=VALUE args from JSON ────────────────────────────────────────

$envArgs = [System.Collections.Generic.List[string]]::new()

try {
    $envObj = $EnvJson | ConvertFrom-Json -ErrorAction Stop
    $envObj.PSObject.Properties | ForEach-Object {
        $key = $_.Name
        $val = $_.Value
        # Skip null and "false" values (mirrors unix behaviour)
        if ($null -ne $val -and $val -ne 'false') {
            $envArgs.Add("-e $key=$val")
        }
    }
} catch {
    Write-Error "Failed to parse ENV_JSON: $_"
    Write-Output '{"status":"error","command":null}'
    exit 1
}

# ─── Build the full command string ────────────────────────────────────────────

$cmdParts = [System.Collections.Generic.List[string]]::new()
$cmdParts.Add('claude mcp add tea-rags -s user -- npx tea-rags server')
foreach ($arg in $envArgs) {
    $cmdParts.Add($arg)
}
$cmd = $cmdParts -join ' '

# ─── Remove existing tea-rags config ─────────────────────────────────────────

try {
    & claude mcp remove tea-rags 2>$null | Out-Null
} catch { }

# ─── Execute the add command ──────────────────────────────────────────────────

$cmdEscaped = $cmd -replace '"', '\"'

try {
    # Invoke-Expression handles the dynamic command with flags
    Invoke-Expression $cmd 2>$null
    $output = [ordered]@{
        status  = 'configured'
        command = $cmdEscaped
    }
    Write-Output ($output | ConvertTo-Json -Compress)
    exit 0
} catch {
    Write-Error "Failed to execute: $cmd"
    $output = [ordered]@{
        status  = 'error'
        command = $cmdEscaped
    }
    Write-Output ($output | ConvertTo-Json -Compress)
    exit 1
}
