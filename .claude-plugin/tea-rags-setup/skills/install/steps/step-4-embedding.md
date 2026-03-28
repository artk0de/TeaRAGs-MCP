# Step 4: Choose & Install Embedding Provider

## 4a: Determine project path

Resolution order:

1. Check progress file for existing `projectPath` (resume case) — if set and the
   directory still exists, use it
2. Skill argument (if `/tea-rags-setup:install /path/to/project` was invoked)
3. Current working directory (cwd) — use if it looks like a project (has
   package.json, .git, src/, Makefile, Cargo.toml, go.mod, etc.)
4. Only if cwd is not a project (e.g. home dir, `/tmp`) → AskUserQuestion:
   ```
   question: "Current directory doesn't look like a project. Specify the project path."
   ```
   **Validate the path exists** before proceeding. If it doesn't → show error,
   re-ask.

Save projectPath to progress.

## 4b: Estimate project size

Run `$SCRIPTS/analyze-project.sh <projectPath>` and extract `locEstimate`. Save
to progress as `projectLocEstimate`.

## 4c: Build recommendation

Use GPU info from progress and locEstimate. Look up the recommendation in
`reference.md` "Embedding Provider Recommendation" table.

## 4d: Ask user

Build option descriptions dynamically from `reference.md` ONNX/Ollama
description tables based on platform/GPU.

```
question: "Choose embedding provider. {recommendation_reason}"
options: [
  { label: "Ollama", description: "{ollama_description}" },
  { label: "ONNX", description: "{onnx_description}" }
]
```

If project > 100k LOC and user picks ONNX on CPU-only config → warn: "Project is
~{N}k LOC. ONNX on CPU recommended up to ~100k LOC, indexing may be slow.
Continue anyway?" No warning needed for ONNX with GPU (DirectML/CUDA handles
large projects).

## 4e: Install

- If Ollama chosen → run `$SCRIPTS/install-ollama.sh <platform> '<gpu_json>'`
  (use `"linux"` for WSL platform)
  - If `manual_required` with method `app` → install instructions by platform:
    - **macOS**: suggest `! brew install --cask ollama` (if hasBrew=true),
      otherwise "Download from https://ollama.com/download"
    - **Windows**: if hasWinget → suggest `! winget install Ollama.Ollama`,
      otherwise "Download from https://ollama.com/download"
    - **Linux**: should not reach here (script auto-installs via curl) After
      showing install method, AskUserQuestion:
    ```
    question: "Install Ollama, restart terminal, launch it, then confirm."
    options: [
      { label: "Done", description: "Ollama installed and running" },
      { label: "Problem", description: "Something went wrong" }
    ]
    ```
  - If platform is Windows AND gpu.vendor is "amd" AND gpu.architecture is
    "RDNA2" or "RDNA3" → before the standard install AskUserQuestion, show
    additional note: "For GPU acceleration with AMD {gpu.model}, install AMD
    Radeon PRO driver first:
    https://www.amd.com/en/support/professional-graphics Then install Ollama."
  - After user confirms → verify: run `ollama --version`. If fails → remind to
    restart terminal and retry.
  - After Ollama verified → re-run install-ollama.sh to pull model.
- If ONNX chosen → nothing to install. Save `embeddingProvider: "onnx"` to
  progress.

Save `embeddingProvider` and mark step completed.
