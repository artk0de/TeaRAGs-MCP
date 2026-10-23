# Step 1: Detect Environment

Run: `$SCRIPTS/detect-environment.sh`

Parse JSON, save all fields to progress:

```
$SCRIPTS/progress.sh set platform "<platform>"
$SCRIPTS/progress.sh set arch "<arch>"
$SCRIPTS/progress.sh set versionManager "<activeManager>"
$SCRIPTS/progress.sh set packageManager "<packageManager>"
$SCRIPTS/progress.sh set nodePath "<nodePath>"
$SCRIPTS/progress.sh set npmPath "<npmPath>"
$SCRIPTS/progress.sh set gpu '<gpu json>'
$SCRIPTS/progress.sh set hasDocker <true|false>
$SCRIPTS/progress.sh set hasOllama <true|false>
$SCRIPTS/progress.sh set hasBrew <true|false>
$SCRIPTS/progress.sh set hasWinget <true|false>
$SCRIPTS/progress.sh set steps.detect '{"status":"completed","at":"<now>"}'
```

**WSL:** detect-environment.sh reports `platform: "wsl"` — save as-is. Pass
`"linux"` to scripts (install-ollama.sh, setup-qdrant.sh); `"wsl"` only for
recommendation logic (GPU, embedding provider descriptions).

`nodePath` null → Node.js not installed, Step 2 handles it.
