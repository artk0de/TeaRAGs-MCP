# ONNX GPU Auto-Detection

**Issue:** tea-5eff
**Priority:** P1
**Context:** ONNX WASM/CPU = 3.7 chunks/sec (501s for 134 texts). Ollama GPU = full index in 12s.

## Problem

`@huggingface/transformers` v3 in Node.js defaults to CPU. GPU acceleration exists but only for specific platforms. No auto-detection.

## Current device support in transformers.js v3

| Device | EP | Platform | GPU type |
|--------|-----|----------|----------|
| `"cpu"` | CPU | All | - |
| `"cuda"` | CUDA | Linux x64 | NVIDIA |
| `"dml"` | DirectML | Windows x64/arm64 | NVIDIA, AMD, Intel |
| `"auto"` | auto-detect | - | → picks best available |

**Missing from transformers.js (but available in onnxruntime-node):**

| Device | EP | Platform | GPU type |
|--------|-----|----------|----------|
| CoreML | CoreML | macOS arm64 | Apple GPU + ANE |
| ROCm | ROCm | Linux x64 | AMD Radeon |
| TensorRT | TensorRT | Linux x64 | NVIDIA (faster than CUDA) |
| OpenVINO | OpenVINO | Linux/Win | Intel GPU/CPU/NPU |

## Plan

### Phase 1: Wire `device` through and use `"auto"`

`"auto"` already exists in transformers.js — it picks the best EP for the platform.
This alone enables CUDA on Linux + DirectML on Windows without any custom logic.

1. Add `device` param to `OnnxEmbeddings` constructor
2. Pass `device` to `pipeline()` options
3. Add `EMBEDDING_DEVICE` env var (default: `"auto"`)
4. Config schema: `embedding.device?: "auto" | "cpu" | "cuda" | "dml"`
5. Factory passes device from config

### Phase 2: Test `"auto"` on each platform

1. macOS arm64: `"auto"` → likely `"cpu"` (no CoreML mapping)
2. Linux x64 + NVIDIA: `"auto"` → `"cuda"` (if CUDA libs present)
3. Windows x64: `"auto"` → `"dml"` (DirectML for any GPU: NVIDIA, AMD, Intel Arc)
4. Benchmark each

### Phase 3: CoreML for macOS (requires onnxruntime-node bypass)

transformers.js doesn't map `"coreml"`. Two options:

**Option A: Patch transformers.js mapping** (fragile)
- Monkey-patch `DEVICE_TO_EXECUTION_PROVIDER_MAPPING` at runtime
- Add `"coreml" → "coreml"` entry before pipeline init

**Option B: Use onnxruntime-node directly** (robust, more code)
- Skip `pipeline()` API for embedding
- Load model + tokenizer manually
- Create `InferenceSession` with `executionProviders: ["coreml", "cpu"]`
- Run inference directly
- More control, but lose transformers.js conveniences

**Option C: Open feature request upstream**
- No existing issue for CoreML in transformers.js
- Open FR: add `"coreml"` to `DEVICE_TO_EXECUTION_PROVIDER_MAPPING`
- `onnxruntime-node` already supports CoreML EP, just needs mapping

### Phase 4: Benchmark + tune

1. Measure throughput per platform/device
2. Set `INITIAL_BATCH_SIZE` per device (GPU handles larger batches)
3. Document recommended configs

## Auto-detection matrix (target state)

| Platform | GPU | `"auto"` resolves to | Expected speedup |
|----------|-----|---------------------|-----------------|
| macOS arm64 | Apple M1/M2/M3 | `"cpu"` (Phase 3: `"coreml"`) | Phase 1: 1x, Phase 3: 10-50x |
| Linux x64 | NVIDIA | `"cuda"` | 20-50x |
| Linux x64 | AMD Radeon | `"cpu"` (no ROCm in mapping) | 1x |
| Windows x64 | NVIDIA | `"dml"` | 10-30x |
| Windows x64 | AMD Radeon | `"dml"` | 10-30x |
| Windows x64 | Intel Arc | `"dml"` | 5-15x |
| Windows arm64 | Qualcomm | `"dml"` | 5-10x |
| Linux arm64 | - | `"cpu"` | 1x |

## Risks

- `"auto"` may fail silently and fall back to CPU without warning
  - Mitigation: log detected device + EP on model load
- CUDA requires CUDA toolkit installed on the system
  - Mitigation: document prereqs, graceful fallback
- DirectML perf varies wildly by GPU vendor
  - Mitigation: allow manual override via `EMBEDDING_DEVICE`
- CoreML not in transformers.js mapping — macOS stays on CPU until Phase 3
  - Mitigation: Phase 1 still improves Linux/Windows users

## Success criteria

- `device: "auto"` works out of the box on Linux+NVIDIA and Windows
- macOS: Phase 3 enables CoreML (or upstream adds it)
- Manual override via `EMBEDDING_DEVICE` for all platforms
- Full index < 60s on any GPU platform
