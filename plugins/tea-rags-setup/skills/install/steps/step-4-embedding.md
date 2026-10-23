# Step 4: Choose & Install Embedding Provider

## 4a: Determine project path

Resolution order:

1. Progress `projectPath` (resume) — set + dir exists → use
2. Skill argument (`/tea-rags-setup:install /path/to/project`)
3. cwd if it looks like a project (package.json, .git, src/, Makefile,
   Cargo.toml, go.mod, etc.)
4. cwd not a project (home dir, `/tmp`) → AskUserQuestion:
   ```
   question: "Current directory doesn't look like a project. Specify the project path."
   ```
   **Validate path exists**; missing → show error, re-ask.

Save projectPath to progress.

## 4b: Estimate project size

`$SCRIPTS/analyze-project.sh <projectPath>` → `locEstimate` → progress
`projectLocEstimate`.

## 4c: Build recommendation

GPU info (progress) + locEstimate → `reference.md` "Embedding Provider
Recommendation" table.

llama-server gate: `projectLocEstimate` ≥ 3M lines → AskUserQuestion "Is there a
GPU host (this machine or a LAN box) to serve embeddings?". Yes → recommend
llama-server (~2× Ollama texts/s, one server per GPU). Else per table — Ollama
default.

## 4d: Ask user

Option descriptions from `reference.md` ONNX/Ollama description tables per
platform/GPU.

```
question: "Choose embedding provider. {recommendation_reason}"
options: [
  { label: "Ollama", description: "{ollama_description}" },
  { label: "ONNX", description: "{onnx_description}" },
  { label: "llama-server", description: "{llama_server_description}" }
]
```

llama-server option only when ≥3M + GPU host gate passed, or user asks.

Project > 100k LOC + ONNX on CPU-only → warn: "Project is ~{N}k LOC. ONNX on CPU
recommended up to ~100k LOC, indexing may be slow. Continue anyway?" ONNX w/ GPU
(DirectML/CUDA) → no warning.

## 4e: Install

- Ollama → `$SCRIPTS/install-ollama.sh <platform> '<gpu_json>'` (`"linux"` for
  WSL)
  - `manual_required` w/ method `app` → install instructions per platform:
    - **macOS**: normally unreachable (script auto-installs via curl). Fails →
      `! brew install --cask ollama` (hasBrew=true), else "Download from
      https://ollama.com/download"
    - **Windows**: hasWinget → `! winget install Ollama.Ollama`, else "Download
      from https://ollama.com/download"
    - **Linux**: unreachable (script auto-installs via curl).

    Install method shown → AskUserQuestion:
    ```
    question: "Install Ollama, restart terminal, launch it, then confirm."
    options: [
      { label: "Done", description: "Ollama installed and running" },
      { label: "Problem", description: "Something went wrong" }
    ]
    ```
  - Windows AND gpu.vendor "amd" AND gpu.architecture "RDNA2"/"RDNA3" → before
    install AskUserQuestion, note: "For GPU acceleration with AMD {gpu.model},
    install AMD Radeon PRO driver first:
    https://www.amd.com/en/support/professional-graphics Then install Ollama."
  - Confirmed → `ollama --version`; fails → remind restart terminal, retry.
  - Verified → re-run install-ollama.sh to pull model.
- llama-server → `steps/step-4-llama-server.md`, return here to mark completed.
- ONNX → nothing to install; progress `embeddingProvider: "onnx"`.

Save `embeddingProvider`, mark step completed.
