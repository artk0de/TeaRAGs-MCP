# Install Wizard Reference Tables

## Embedding Provider Recommendation

| Platform | GPU vendor      | LOC   | Recommend                              |
| -------- | --------------- | ----- | -------------------------------------- |
| darwin   | apple           | any   | Ollama (Metal GPU)                     |
| darwin   | intel           | ≤100k | ONNX (CPU)                             |
| darwin   | intel           | >100k | Ollama (CPU)                           |
| wsl      | nvidia          | any   | Ollama (CUDA via WSL2 GPU passthrough) |
| wsl      | none/intel      | ≤100k | ONNX (CPU)                             |
| wsl      | none/intel      | >100k | Ollama (CPU)                           |
| linux    | nvidia          | any   | Ollama (CUDA)                          |
| linux    | amd             | any   | Ollama (ROCm)                          |
| linux    | none/intel      | ≤100k | ONNX (CPU)                             |
| linux    | none/intel      | >100k | Ollama (CPU faster for large projects) |
| windows  | nvidia          | any   | ONNX (DirectML/CUDA) or Ollama (CUDA)  |
| windows  | amd (RDNA2/3)   | any   | ONNX (DirectML) or Ollama + PRO driver |
| windows  | amd (pre-RDNA2) | any   | ONNX (DirectML)                        |
| windows  | intel           | any   | ONNX (DirectML)                        |
| windows  | none            | any   | ONNX (CPU)                             |

## ONNX Description by Platform + GPU

- Windows + nvidia → "Built-in (beta), GPU via DirectML or CUDA. No external
  process."
- Windows + amd/intel → "Built-in (beta), GPU via DirectML. No external
  process."
- Windows + none → "Built-in (beta), CPU only. No external process."
- macOS (Apple Silicon) → "Built-in (beta), CPU only. No Metal support yet."
- macOS (Intel) → "Built-in (beta), CPU only."
- WSL + any → "Built-in (beta), CPU only. No DirectML in WSL."
- Linux + nvidia → "Built-in (beta), CPU only. CUDA support planned."
- Linux + no GPU → "Built-in (beta), CPU only. No external process."

## Ollama Description by Platform + GPU

- Windows + nvidia → "Separate process. CUDA GPU acceleration."
- Windows + amd RDNA2/3 → "Separate process. Requires AMD PRO driver for GPU."
- macOS (Apple Silicon) → "Separate process. Metal GPU acceleration."
- macOS (Intel) → "Separate process. CPU mode."
- WSL + nvidia → "Separate process. CUDA via WSL2 GPU passthrough."
- WSL + no GPU → "Separate process. CPU mode."
- Linux + nvidia → "Separate process. CUDA GPU acceleration."
- Linux + amd → "Separate process. ROCm GPU acceleration."
- Any + no GPU → "Separate process. CPU mode."

## Version Manager Options by Platform

### Windows (Git Bash / PowerShell)

| Manager     | Install (winget)                           | Install (no winget)                         |
| ----------- | ------------------------------------------ | ------------------------------------------- |
| fnm         | `winget install Schniz.fnm`                | github.com/Schniz/fnm/releases              |
| volta       | `winget install Volta.Volta`               | github.com/volta-cli/volta/releases         |
| nvm-windows | `winget install CoreyButler.NVMforWindows` | github.com/coreybutler/nvm-windows/releases |

### macOS

| Manager | Install                                                                            |
| ------- | ---------------------------------------------------------------------------------- |
| fnm     | `brew install fnm`                                                                 |
| volta   | `curl https://get.volta.sh \| bash`                                                |
| mise    | `brew install mise`                                                                |
| asdf    | `brew install asdf`                                                                |
| nvm     | `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh \| bash` |
| nodenv  | `brew install nodenv`                                                              |

Note: `n` only available if hasBrew=true (`brew install n`) or node exists
(`npm install -g n`).

### Linux / WSL

| Manager | Install                                                                            |
| ------- | ---------------------------------------------------------------------------------- |
| fnm     | `curl -fsSL https://fnm.vercel.app/install \| bash`                                |
| volta   | `curl https://get.volta.sh \| bash`                                                |
| mise    | `curl https://mise.run \| sh`                                                      |
| asdf    | `git clone https://github.com/asdf-vm/asdf.git ~/.asdf`                            |
| nvm     | `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh \| bash` |
| nodenv  | `git clone https://github.com/nodenv/nodenv.git ~/.nodenv`                         |

Note: `n` only if node exists (`npm install -g n`) or direct
(`curl ... | bash -s install lts`).

## Direct Node.js Install by Platform

| Platform              | Command                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| Windows + hasWinget   | `! winget install OpenJS.NodeJS.LTS`                                                                     |
| Windows + no winget   | `! scoop install nodejs-lts` (if scoop) or download https://nodejs.org                                   |
| macOS + hasBrew       | `! brew install node@22`                                                                                 |
| macOS + no brew       | Download from https://nodejs.org                                                                         |
| Linux (Debian/Ubuntu) | `! curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - && sudo apt-get install -y nodejs` |
| Linux (other)         | Download from https://nodejs.org                                                                         |

## Tune Defaults (used when tune fails)

```json
{
  "EMBEDDING_BATCH_SIZE": "64",
  "EMBEDDING_CONCURRENCY": "2",
  "QDRANT_UPSERT_BATCH_SIZE": "128",
  "QDRANT_BATCH_ORDERING": "weak",
  "QDRANT_FLUSH_INTERVAL_MS": "1000",
  "BATCH_FORMATION_TIMEOUT_MS": "5000",
  "INGEST_TUNE_CHUNKER_POOL_SIZE": "2",
  "INGEST_TUNE_FILE_CONCURRENCY": "20",
  "INGEST_TUNE_IO_CONCURRENCY": "20",
  "TRAJECTORY_GIT_CHUNK_CONCURRENCY": "4"
}
```

## All Env Vars for MCP Configuration

| Variable                               | Source                    |
| -------------------------------------- | ------------------------- |
| `EMBEDDING_PROVIDER`                   | step 4                    |
| `QDRANT_URL`                           | step 5 (omit if embedded) |
| `EMBEDDING_BATCH_SIZE`                 | tuneValues                |
| `EMBEDDING_CONCURRENCY`                | tuneValues                |
| `QDRANT_UPSERT_BATCH_SIZE`             | tuneValues                |
| `QDRANT_BATCH_ORDERING`                | tuneValues                |
| `QDRANT_FLUSH_INTERVAL_MS`             | tuneValues                |
| `BATCH_FORMATION_TIMEOUT_MS`           | tuneValues                |
| `QDRANT_DELETE_BATCH_SIZE`             | tuneValues                |
| `QDRANT_DELETE_CONCURRENCY`            | tuneValues                |
| `INGEST_TUNE_CHUNKER_POOL_SIZE`        | tuneValues                |
| `INGEST_TUNE_FILE_CONCURRENCY`         | tuneValues                |
| `INGEST_TUNE_IO_CONCURRENCY`           | tuneValues                |
| `QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS`  | tuneValues                |
| `EMBEDDING_TUNE_MIN_BATCH_SIZE`        | tuneValues                |
| `TRAJECTORY_GIT_CHUNK_CONCURRENCY`     | tuneValues                |
| `TRAJECTORY_GIT_ENABLED`               | step 7                    |
| `TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS` | step 7 (if applicable)    |

Omit any key that is null or missing.
