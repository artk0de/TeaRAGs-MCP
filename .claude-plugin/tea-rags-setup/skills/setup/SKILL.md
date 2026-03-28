---
name: setup
description:
  Automated TeaRAGs installation wizard. Detects environment, installs
  dependencies (Node.js, tea-rags, Ollama/ONNX, Qdrant), tunes performance,
  configures MCP server. Progress saves to ~/.tea-rags/setup-progress.json for
  resumable installation.
argument-hint: [project path]
---

# TeaRAGs Setup Wizard

Automated installation and configuration of TeaRAGs MCP server.

## Script Location

All scripts are in `${CLAUDE_PLUGIN_ROOT}/scripts/setup/`.

**First: determine OS to select script set.**

Run: `uname -s` (or check via Bash tool)

- Output contains "Darwin" or "Linux" → use `unix/` scripts (`.sh`)
- Output contains "MINGW", "MSYS", "CYGWIN" → use `unix/` scripts (running in
  Git Bash)
- If PowerShell detected (Windows native) → use `windows/` scripts (`.ps1`)

Store the chosen prefix (e.g.,
`SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts/setup/unix"`) and use it for all
subsequent script calls.

## Step 0: Check Progress

Run: `$SCRIPTS/progress.sh get`

- If progress file exists → find first step with `status != "completed"` →
  resume from there
- If no progress file → run `$SCRIPTS/progress.sh init` → start from Step 1

## Step 1: Detect Environment

Run: `$SCRIPTS/detect-environment.sh`

Parse JSON result. Save all fields to progress:

```
$SCRIPTS/progress.sh set platform "<platform>"
$SCRIPTS/progress.sh set arch "<arch>"
$SCRIPTS/progress.sh set versionManager "<activeManager>"
$SCRIPTS/progress.sh set packageManager "<packageManager>"
$SCRIPTS/progress.sh set nodePath "<nodePath>"
$SCRIPTS/progress.sh set npmPath "<npmPath>"
$SCRIPTS/progress.sh set gpu '<gpu json>'
$SCRIPTS/progress.sh set steps.detect '{"status":"completed","at":"<now>"}'
```

If `nodePath` is null → Node.js is not installed, Step 2 will handle it.

## Step 2: Install Node.js

Run: `$SCRIPTS/install-node.sh <versionManager>`

**Interpret result:**

- `already_done` → update progress, move to Step 3
- `installed` → update nodePath in progress, move to Step 3
- `manual_required` (exit code 2) → use AskUserQuestion:
  ```
  question: "Node.js 22+ is required but not installed. Please install it and respond when done."
  options: [
    { label: "Installed", description: "I've installed Node.js 22+" },
    { label: "Help", description: "Show me how to install Node.js" }
  ]
  ```
  If "Help" → show platform-specific instructions. If "Installed" → re-run
  detect-environment.sh to get new paths, verify version >= 22.

## Step 3: Install tea-rags

Run: `$SCRIPTS/install-tea-rags.sh <packageManager> <npmPath>`

**Interpret result:**

- `already_done` → show version, ask if update wanted via AskUserQuestion
- `installed` → update progress
- `error` → show stderr, suggest permissions fix, retry

## Step 4: Choose & Install Embedding Provider

**4a: Determine project path.** If argument was provided, use it. Otherwise
check if cwd looks like a project (has package.json, .git, src/, etc.). If not →
AskUserQuestion:

```
question: "Specify the project directory you are configuring tea-rags for"
```

Save projectPath to progress.

**4b: Estimate project size.** Run `$SCRIPTS/analyze-project.sh <projectPath>`
and extract `locEstimate`. Save to progress as `projectLocEstimate`.

**4c: Build recommendation.** Use the GPU info from progress and locEstimate:

| Platform | GPU vendor         | LOC   | Recommend                              |
| -------- | ------------------ | ----- | -------------------------------------- |
| darwin   | apple              | any   | Ollama app (Metal GPU)                 |
| linux    | nvidia             | any   | Ollama (CUDA)                          |
| linux    | amd                | any   | Ollama (ROCm)                          |
| linux    | none/intel         | ≤100k | ONNX (beta, zero-setup)                |
| linux    | none/intel         | >100k | Ollama (CPU faster for large projects) |
| windows  | nvidia             | any   | Ollama app (CUDA)                      |
| windows  | amd (RDNA2/3)      | any   | Ollama + PRO driver                    |
| windows  | amd (pre-RDNA2)    | ≤100k | ONNX (beta, DirectML)                  |
| windows  | intel              | ≤100k | ONNX (beta, DirectML)                  |
| windows  | none/intel/old amd | >100k | Ollama app                             |

**4d: Ask user.** AskUserQuestion with recommendation:

```
question: "Choose embedding provider. {recommendation_reason}"
options: [
  { label: "Ollama", description: "Recommended for {reason}" },
  { label: "ONNX (beta)", description: "Built-in embedded process, zero-setup, up to ~100k LOC" }
]
```

If project > 100k LOC and user picks ONNX → warn: "Project is ~{N}k LOC. ONNX
recommended up to ~100k LOC, indexing may be slow. Continue anyway?"

**4e: Install.**

- If Ollama chosen → run `$SCRIPTS/install-ollama.sh <platform> '<gpu_json>'`
  - If `manual_required` with method `app` → AskUserQuestion checkpoint:
    "Download Ollama from https://ollama.com/download, install, and launch.
    Respond when done."
  - If method `pro_driver` (Windows + AMD RDNA2/3) → AskUserQuestion: "For GPU
    acceleration, install AMD Radeon PRO driver first:
    https://www.amd.com/en/support/professional-graphics Then install Ollama
    app. Respond when done."
  - After user confirms → verify: run `ollama --version`. If fails → repeat
    checkpoint.
  - After Ollama verified → model pull happens inside the script.
- If ONNX chosen → nothing to install. Save `embeddingProvider: "onnx"` to
  progress.

Save `embeddingProvider` and mark step completed.

## Step 5: Choose & Setup Qdrant

AskUserQuestion:

```
question: "Choose Qdrant deployment mode"
options: [
  { label: "Embedded", description: "Recommended. Built-in, zero configuration. Starts automatically with tea-rags." },
  { label: "Docker", description: "Separate container. Requires Docker." },
  { label: "Native", description: "System install via {brew|apt|binary}." }
]
```

Run: `$SCRIPTS/setup-qdrant.sh <mode> <platform>`

**Interpret result:**

- `already_done` or `installed` → save qdrantMode and url to progress
- `error` with exit code 2 (Docker not found) → AskUserQuestion checkpoint:
  "Docker is required but not installed. Install Docker Desktop and respond when
  done." After confirm → re-run.
- `error` → show stderr, suggest alternative mode

## Step 6: Tune Performance

Run: `$SCRIPTS/tune.sh <embeddingProvider>`

**Interpret result:**

- `completed` → save tuned values to progress
- `skipped` (ONNX beta) → save default values, inform user
- `error` → save defaults, warn user, continue (non-critical)

## Step 7: Analyze Project (git recommendations)

The analyze-project.sh was already run in Step 4b for LOC. Use its full output
for git recommendations now.

If `isGitRepo` is true → AskUserQuestion:

```
question: "Enable git analytics? Provides authorship, churn, and bug-fix rate signals for code search."
options: [
  { label: "Yes", description: "Recommended — git repository detected" },
  { label: "No", description: "Skip git enrichment" }
]
```

If git enabled AND `hasFrequentCommits` is true → AskUserQuestion:

```
question: "Enable squash-aware sessions? Detected frequent commits from {topAuthor} (median {avgGapMinutes}min gap). Groups rapid commits into logical sessions for cleaner analytics."
options: [
  { label: "Yes", description: "Recommended for this commit pattern" },
  { label: "No", description: "Keep individual commit granularity" }
]
```

Save choices to progress.

## Step 8: Configure MCP

**8a: Choose scope.** AskUserQuestion:

```
question: "MCP server scope — where should tea-rags be available?"
options: [
  { label: "Global (user)", description: "Available in all projects. Recommended for personal use." },
  { label: "Project", description: "Only for the current project. Creates .mcp.json in project root." }
]
```

Save scope choice to progress (`mcpScope: "user"` or `"project"`).

**8b: Assemble env vars** from progress:

- `EMBEDDING_PROVIDER` — from step 4
- `QDRANT_URL` — from step 5 (omit if embedded)
- `EMBEDDING_BATCH_SIZE` — from step 6
- `QDRANT_UPSERT_BATCH_SIZE` — from step 6
- `INGEST_PIPELINE_CONCURRENCY` — from step 6
- `TRAJECTORY_GIT_ENABLED` — from step 7
- `TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS` — from step 7 (if applicable)

**8c: Dispatch MCP integrator agent.** Use the Agent tool to dispatch
`${CLAUDE_PLUGIN_ROOT}/agents/mcp-server-integrator.md` with a prompt like:

```
Agent tool:
  description: "Configure tea-rags MCP server"
  prompt: |
    Add the tea-rags MCP server with the following configuration:

    Server name: tea-rags
    Scope: <user|project>
    Command: npx tea-rags server
    Environment variables:
      EMBEDDING_PROVIDER=<value>
      QDRANT_URL=<value or omit>
      EMBEDDING_BATCH_SIZE=<value>
      QDRANT_UPSERT_BATCH_SIZE=<value>
      INGEST_PIPELINE_CONCURRENCY=<value>
      TRAJECTORY_GIT_ENABLED=<value>
      TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS=<value or omit>

    Use `claude mcp add tea-rags -s <scope> ...` to configure.
    After adding, verify with `claude mcp get tea-rags`.
    Report the full verification output.
```

The agent handles: building the correct `claude mcp add` command, executing it,
and verifying via `claude mcp get` that the server shows as connected.

## Step 9: Verify

Run: `claude mcp get tea-rags`

Check output for "connected" status.

- If connected → SUCCESS. Show summary: "TeaRAGs setup complete! Configuration:
  - Embedding: {provider}
  - Qdrant: {mode}
  - Git analytics: {enabled/disabled}

  Restart your Claude Code session to activate the MCP server. After restart,
  run `/tea-rags:index` to index your codebase."

- If not connected → AskUserQuestion: "MCP server not yet connected. This
  usually resolves after restarting the session. Restart Claude Code and run
  `/tea-rags:setup` again to verify."

Mark all steps completed in progress.

## Error Recovery

At any point if a script fails (exit code 1):

1. Show the error from stderr to the user
2. The progress file retains the last successful state
3. Suggest re-running `/tea-rags:setup` — it will resume from the failed step

## Do NOT

- Run scripts without checking progress first
- Skip AskUserQuestion for user choices (embedding, qdrant)
- Proceed past a checkpoint without verification
- Modify MCP config for other servers
- Run indexing — that is `/tea-rags:index` after restart
