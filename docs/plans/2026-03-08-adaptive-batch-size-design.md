# Adaptive GPU Batch Size — Design

## Goal

Automatically find the optimal GPU batch size for any hardware (M3 Pro, CUDA A100, etc.) via calibration probe at startup, adapt at runtime if GPU pressure changes, and propagate the result to the pipeline so it sends optimally-sized batches.

## Architecture

### Calibration (worker.ts)

Fire-and-forget probe after model load:

1. Worker loads model, sends `ready` immediately
2. In background, runs probe: bs=[1, 4, 8, 16, 32, 64, 128...]
3. Each probe: embed N short texts, measure ms/text
4. Stop when msPerText > bestMsPerText * 1.5 — previous level = calibrated size
5. Send `{ type: "calibrated", batchSize: N }` to daemon
6. Cache result to `~/.tea-rags-mcp/onnx-calibration.json`:
   ```json
   { "model": "jinaai/...", "device": "webgpu", "batchSize": 64, "timestamp": 1741... }
   ```
7. On next startup: if cache exists and model+device match — skip probe, send `calibrated` immediately
8. On model change — cache invalidated, probe re-runs

### BatchSizeController (batch-size-controller.ts)

Standalone class, easy to unit test:

- `constructor(calibratedSize: number, minSize = 2)`
- `report(durationMs: number, batchSize: number)` — updates rolling average (window=10)
- `currentBatchSize(): number` — returns current optimal size
- Logic:
  - msPerText > rollingAvg * 2 → halve (floor at minSize)
  - msPerText < rollingAvg * 1.2 → double (cap at calibratedSize)
  - Otherwise → keep current

### Daemon (daemon.ts)

- Receives `calibrated` from worker → creates `BatchSizeController(calibratedSize)`
- Before calibration arrives: uses `DEFAULT_GPU_BATCH_SIZE` (8) as fallback
- `connected` response includes `recommendedBatchSize` (calibrated value or undefined)
- `handleEmbed` splits by `controller.currentBatchSize()` instead of `GPU_BATCH_SIZE`
- After each sub-batch worker response (which includes `durationMs`): `controller.report(durationMs, batchSize)`

### Worker (worker.ts)

- `handleEmbed` measures inference duration, returns in result:
  `{ type: "result", id, embeddings, durationMs }`
- Probe runs as fire-and-forget after `ready`

### Client (onnx.ts)

- Receives `recommendedBatchSize` from `connected` response
- Exposes `recommendedBatchSize?: number` public property

### EmbeddingProvider interface (contracts/)

- Add optional `recommendedBatchSize?: number` to `EmbeddingProvider`

### Pipeline integration (factory.ts)

- After embedding provider init: check `provider.recommendedBatchSize`
- If present AND user did not explicitly set `EMBEDDING_TUNE_BATCH_SIZE` → use it as pipeline batch size

## Data Flow

```
Startup (fire-and-forget):
  Worker: load model → send "ready" → probe [1,4,8,16,32...] → send "calibrated(64)"
  Daemon: starts with DEFAULT_GPU_BATCH_SIZE=8
  Daemon: receives calibrated → BatchSizeController(64)
  Client connects → { connected, recommendedBatchSize: 64 }
  OnnxEmbeddings.recommendedBatchSize = 64
  Pipeline: batchSize = 64 (if not explicitly configured)

Cached startup (no probe):
  Worker: load model → cache hit (model+device match) → send "calibrated(64)" → send "ready"
  (no delay)

Runtime:
  Pipeline → embedBatch(texts[64]) → socket → daemon
  → controller.currentBatchSize() = 64 → no split → worker
  → worker returns { result, durationMs: 3200 }
  → controller.report(3200, 64) → msPerText=50, within bounds
  ... GPU thermal throttle ...
  → worker returns { result, durationMs: 8000 }
  → controller.report(8000, 64) → msPerText=125, > avg*2
  → controller halves → currentBatchSize() = 32
  → next 64-text batch splits → [32, 32]
  ... stabilizes ...
  → controller doubles → back to 64
```

## Constants

- `DEFAULT_GPU_BATCH_SIZE = 8` (renamed from `GPU_BATCH_SIZE`, fallback if calibration fails)
- `PROBE_BATCH_SIZES = [1, 4, 8, 16, 32, 64, 128]`
- `PROBE_PRESSURE_THRESHOLD = 1.5` (msPerText ratio to detect pressure during probe)
- `RUNTIME_PRESSURE_THRESHOLD = 2.0` (msPerText ratio to halve at runtime)
- `RUNTIME_STABLE_THRESHOLD = 1.2` (msPerText ratio to double at runtime)
- `ROLLING_WINDOW = 10` (number of recent reports for rolling avg)
- `CALIBRATION_CACHE_FILE = "onnx-calibration.json"` (in tea-rags data dir)

## Files Changed

| File | Change |
|------|--------|
| `onnx/constants.ts` | `GPU_BATCH_SIZE` → `DEFAULT_GPU_BATCH_SIZE`, add probe/threshold constants |
| `onnx/batch-size-controller.ts` | NEW: rolling avg, halve/double logic |
| `onnx/worker-types.ts` | Add `durationMs` to result, add `calibrated` response |
| `onnx/worker.ts` | Probe during warm-up (fire-and-forget), measure durationMs in handleEmbed |
| `onnx/daemon-types.ts` | Add `calibrated` to DaemonResponse |
| `onnx/daemon.ts` | Use BatchSizeController, pass durationMs through |
| `onnx.ts` | Store `recommendedBatchSize` from connected response |
| `contracts/types/provider.ts` | Add `recommendedBatchSize?: number` to EmbeddingProvider |
| `bootstrap/factory.ts` | Use `recommendedBatchSize` if batch size not explicitly set |
| Tests for each file above |
