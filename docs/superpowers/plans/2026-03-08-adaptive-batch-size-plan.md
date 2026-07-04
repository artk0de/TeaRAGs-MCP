# Adaptive GPU Batch Size Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Auto-detect optimal GPU batch size via calibration probe, adapt at
runtime on pressure, propagate recommendation to pipeline.

**Architecture:** Worker probes GPU capacity at startup (fire-and-forget,
cached), reports `calibrated` batch size to daemon. Daemon uses
`BatchSizeController` to split incoming batches and adapt at runtime. Client
exposes `recommendedBatchSize` to pipeline. Pipeline uses it if batch size not
explicitly configured.

**Tech Stack:** TypeScript, Vitest, Node.js worker_threads, NDJSON protocol

---

### Task 1: Update constants

**Files:**

- Modify: `src/core/adapters/embeddings/onnx/constants.ts`
- Modify: `tests/core/adapters/embeddings/onnx/constants.test.ts`

**Step 1: Update constants file**

Replace contents of `src/core/adapters/embeddings/onnx/constants.ts`:

```typescript
/**
 * Default GPU batch size — used as fallback if calibration fails.
 * Benchmarked optimal for WebGPU/Metal with jina-embeddings-v2 (768-dim).
 */
export const DEFAULT_GPU_BATCH_SIZE = 8;

/** Batch sizes to probe during calibration, ascending order */
export const PROBE_BATCH_SIZES = [1, 4, 8, 16, 32, 64, 128];

/** During probe: if msPerText > bestMsPerText * this, stop probing */
export const PROBE_PRESSURE_THRESHOLD = 1.5;

/** At runtime: if msPerText > rollingAvg * this, halve batch size */
export const RUNTIME_PRESSURE_THRESHOLD = 2.0;

/** At runtime: if msPerText < rollingAvg * this, double batch size */
export const RUNTIME_STABLE_THRESHOLD = 1.2;

/** Number of recent reports for rolling average */
export const ROLLING_WINDOW = 10;

/** Absolute minimum batch size (floor for adaptive reduction) */
export const MIN_BATCH_SIZE = 2;
```

**Step 2: Update constant test**

Replace contents of `tests/core/adapters/embeddings/onnx/constants.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  DEFAULT_GPU_BATCH_SIZE,
  MIN_BATCH_SIZE,
  PROBE_BATCH_SIZES,
  PROBE_PRESSURE_THRESHOLD,
  ROLLING_WINDOW,
  RUNTIME_PRESSURE_THRESHOLD,
  RUNTIME_STABLE_THRESHOLD,
} from "../../../../../src/core/adapters/embeddings/onnx/constants.js";

describe("ONNX constants", () => {
  it("DEFAULT_GPU_BATCH_SIZE should be 8", () => {
    expect(DEFAULT_GPU_BATCH_SIZE).toBe(8);
  });

  it("PROBE_BATCH_SIZES should be ascending", () => {
    for (let i = 1; i < PROBE_BATCH_SIZES.length; i++) {
      expect(PROBE_BATCH_SIZES[i]).toBeGreaterThan(PROBE_BATCH_SIZES[i - 1]);
    }
  });

  it("thresholds should be sensible", () => {
    expect(PROBE_PRESSURE_THRESHOLD).toBeGreaterThan(1);
    expect(RUNTIME_PRESSURE_THRESHOLD).toBeGreaterThan(
      RUNTIME_STABLE_THRESHOLD,
    );
    expect(ROLLING_WINDOW).toBeGreaterThanOrEqual(5);
    expect(MIN_BATCH_SIZE).toBeGreaterThanOrEqual(1);
  });
});
```

**Step 3: Update daemon.ts import**

In `src/core/adapters/embeddings/onnx/daemon.ts`, change:

```typescript
import { GPU_BATCH_SIZE } from "./constants.js";
```

to:

```typescript
import { DEFAULT_GPU_BATCH_SIZE } from "./constants.js";
```

And replace both occurrences of `GPU_BATCH_SIZE` with `DEFAULT_GPU_BATCH_SIZE`
in `handleEmbed`.

**Step 4: Run tests, build, commit**

```bash
npx vitest run tests/core/adapters/embeddings/onnx/
npm run build
git add src/core/adapters/embeddings/onnx/constants.ts src/core/adapters/embeddings/onnx/daemon.ts tests/core/adapters/embeddings/onnx/constants.test.ts
git commit -m "refactor(onnx): rename GPU_BATCH_SIZE to DEFAULT_GPU_BATCH_SIZE, add adaptive constants"
```

---

### Task 2: BatchSizeController

**Files:**

- Create: `src/core/adapters/embeddings/onnx/batch-size-controller.ts`
- Create: `tests/core/adapters/embeddings/onnx/batch-size-controller.test.ts`

**Step 1: Write tests**

```typescript
// tests/core/adapters/embeddings/onnx/batch-size-controller.test.ts
import { describe, expect, it } from "vitest";

import { BatchSizeController } from "../../../../../src/core/adapters/embeddings/onnx/batch-size-controller.js";

describe("BatchSizeController", () => {
  it("should start at calibrated size", () => {
    const c = new BatchSizeController(32);
    expect(c.currentBatchSize()).toBe(32);
  });

  it("should halve on pressure (msPerText > rollingAvg * 2)", () => {
    const c = new BatchSizeController(16);
    // Build baseline: 10ms/text for 10 reports
    for (let i = 0; i < 10; i++) {
      c.report(80, 8); // 10ms/text
    }
    expect(c.currentBatchSize()).toBe(16);

    // Pressure: 25ms/text > 10 * 2.0
    c.report(200, 8);
    expect(c.currentBatchSize()).toBe(8);
  });

  it("should double on stability (msPerText < rollingAvg * 1.2)", () => {
    const c = new BatchSizeController(32);
    // Start at 32, force halve to 16
    for (let i = 0; i < 10; i++) c.report(80, 8); // 10ms/text baseline
    c.report(200, 8); // pressure → halves to 16
    expect(c.currentBatchSize()).toBe(16);

    // Stable reports at ~10ms/text (< baseline * 1.2 = 12)
    for (let i = 0; i < 10; i++) {
      c.report(80, 8); // 10ms/text
    }
    // Should grow back to 32
    expect(c.currentBatchSize()).toBe(32);
  });

  it("should not go below minSize", () => {
    const c = new BatchSizeController(8, 4);
    for (let i = 0; i < 10; i++) c.report(80, 8);
    // Massive pressure multiple times
    c.report(500, 8); // halve 8→4
    expect(c.currentBatchSize()).toBe(4);
    c.report(500, 4); // would halve to 2, but min is 4
    expect(c.currentBatchSize()).toBe(4);
  });

  it("should not go above calibrated size", () => {
    const c = new BatchSizeController(16);
    // All stable, try to grow
    for (let i = 0; i < 20; i++) c.report(80, 8);
    expect(c.currentBatchSize()).toBe(16); // capped at calibrated
  });

  it("should not adjust before rolling window is filled", () => {
    const c = new BatchSizeController(16);
    c.report(1000, 8); // extreme pressure, but window not full
    expect(c.currentBatchSize()).toBe(16); // no change
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/core/adapters/embeddings/onnx/batch-size-controller.test.ts
```

**Step 3: Implement BatchSizeController**

```typescript
// src/core/adapters/embeddings/onnx/batch-size-controller.ts
import {
  MIN_BATCH_SIZE,
  ROLLING_WINDOW,
  RUNTIME_PRESSURE_THRESHOLD,
  RUNTIME_STABLE_THRESHOLD,
} from "./constants.js";

/**
 * Adaptive GPU batch size controller.
 *
 * Tracks per-text latency via rolling average and adjusts batch size:
 * - Halves on pressure (msPerText > rollingAvg * RUNTIME_PRESSURE_THRESHOLD)
 * - Doubles on stability (msPerText < rollingAvg * RUNTIME_STABLE_THRESHOLD)
 * - Bounded by [minSize, calibratedSize]
 */
export class BatchSizeController {
  private readonly calibratedSize: number;
  private readonly minSize: number;
  private current: number;
  private readonly history: number[] = []; // msPerText values

  constructor(calibratedSize: number, minSize = MIN_BATCH_SIZE) {
    this.calibratedSize = calibratedSize;
    this.minSize = minSize;
    this.current = calibratedSize;
  }

  /** Report a completed sub-batch inference */
  report(durationMs: number, batchSize: number): void {
    const msPerText = durationMs / Math.max(batchSize, 1);
    this.history.push(msPerText);
    if (this.history.length > ROLLING_WINDOW) {
      this.history.shift();
    }

    // Don't adjust until we have enough data
    if (this.history.length < ROLLING_WINDOW) return;

    const avg = this.history.reduce((s, v) => s + v, 0) / this.history.length;

    if (msPerText > avg * RUNTIME_PRESSURE_THRESHOLD) {
      // Pressure detected — halve
      this.current = Math.max(this.minSize, Math.floor(this.current / 2));
    } else if (msPerText < avg * RUNTIME_STABLE_THRESHOLD) {
      // Stable — try to grow
      this.current = Math.min(this.calibratedSize, this.current * 2);
    }
  }

  /** Current recommended batch size for GPU inference */
  currentBatchSize(): number {
    return this.current;
  }
}
```

**Step 4: Run tests, build, commit**

```bash
npx vitest run tests/core/adapters/embeddings/onnx/batch-size-controller.test.ts
npm run build
git add src/core/adapters/embeddings/onnx/batch-size-controller.ts tests/core/adapters/embeddings/onnx/batch-size-controller.test.ts
git commit -m "feat(onnx): add BatchSizeController for adaptive GPU batch sizing"
```

---

### Task 3: Worker — durationMs in result + fire-and-forget probe

**Files:**

- Modify: `src/core/adapters/embeddings/onnx/worker-types.ts`
- Modify: `src/core/adapters/embeddings/onnx/worker.ts`
- Modify: `tests/core/adapters/embeddings/onnx/daemon.test.ts` (MockWorker must
  return durationMs)

**Step 1: Update worker-types.ts**

```typescript
/** Messages from main thread to worker */
export type WorkerRequest =
  | { type: "init"; model: string; cacheDir?: string; device?: string }
  | { type: "embed"; id: number; texts: string[] }
  | { type: "terminate" };

/** Messages from worker to main thread */
export type WorkerResponse =
  | { type: "ready" }
  | { type: "calibrated"; batchSize: number }
  | { type: "result"; id: number; embeddings: number[][]; durationMs: number }
  | { type: "error"; id: number; message: string }
  | { type: "log"; level: "error"; message: string };
```

**Step 2: Update worker.ts — add durationMs to handleEmbed**

In `handleEmbed` (line 129-141), wrap the inference in timing:

```typescript
async function handleEmbed(id: number, texts: string[]): Promise<void> {
  if (!extractor) {
    post({ type: "error", id, message: "Worker not initialized" });
    return;
  }

  try {
    const start = performance.now();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    const durationMs = Math.round(performance.now() - start);
    post({ type: "result", id, embeddings: output.tolist(), durationMs });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: "error", id, message });
  }
}
```

**Step 3: Update worker.ts — add fire-and-forget probe + calibration cache**

Add imports at top of worker.ts:

```typescript
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  DEFAULT_GPU_BATCH_SIZE,
  PROBE_BATCH_SIZES,
  PROBE_PRESSURE_THRESHOLD,
} from "./constants.js";
```

Add calibration cache path and probe function after `loadPipeline`:

```typescript
function calibrationCachePath(): string | null {
  const dataDir =
    process.env.TEA_RAGS_DATA_DIR ??
    (process.env.HOME ? `${process.env.HOME}/.tea-rags-mcp` : null);
  return dataDir ? `${dataDir}/onnx-calibration.json` : null;
}

interface CalibrationCache {
  model: string;
  device: string;
  batchSize: number;
}

function readCalibrationCache(model: string, device: string): number | null {
  const path = calibrationCachePath();
  if (!path) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as CalibrationCache;
    if (data.model === model && data.device === device) {
      return data.batchSize;
    }
  } catch {
    // no cache or invalid
  }
  return null;
}

function writeCalibrationCache(
  model: string,
  device: string,
  batchSize: number,
): void {
  const path = calibrationCachePath();
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ model, device, batchSize }), "utf-8");
  } catch {
    // non-fatal
  }
}

async function runProbe(
  pipeline: Pipeline,
  model: string,
  device: string,
): Promise<void> {
  const cachedSize = readCalibrationCache(model, device);
  if (cachedSize !== null) {
    console.error(`[ONNX] Calibration cache hit: batchSize=${cachedSize}`);
    post({ type: "calibrated", batchSize: cachedSize });
    return;
  }

  console.error("[ONNX] Running GPU batch size calibration...");
  const probeText =
    "The quick brown fox jumps over the lazy dog. function main() { return 42; }";
  let bestMsPerText = Infinity;
  let calibratedSize = DEFAULT_GPU_BATCH_SIZE;

  for (const bs of PROBE_BATCH_SIZES) {
    const texts = Array.from({ length: bs }, () => probeText);
    try {
      const start = performance.now();
      await pipeline(texts, { pooling: "mean", normalize: true });
      const elapsed = performance.now() - start;
      const msPerText = elapsed / bs;

      console.error(
        `[ONNX] Probe bs=${bs}: ${elapsed.toFixed(0)}ms total, ${msPerText.toFixed(1)}ms/text`,
      );

      if (msPerText < bestMsPerText) {
        bestMsPerText = msPerText;
        calibratedSize = bs;
      }

      if (msPerText > bestMsPerText * PROBE_PRESSURE_THRESHOLD) {
        console.error(`[ONNX] Pressure at bs=${bs}, optimal=${calibratedSize}`);
        break;
      }
    } catch {
      console.error(`[ONNX] Probe failed at bs=${bs}, stopping`);
      break;
    }
  }

  writeCalibrationCache(model, device, calibratedSize);
  console.error(`[ONNX] Calibrated GPU batch size: ${calibratedSize}`);
  post({ type: "calibrated", batchSize: calibratedSize });
}
```

**Step 4: Update handleInit — fire-and-forget probe after ready**

In `handleInit`, change the warm-up + ready section to:

```typescript
console.error(`[ONNX] Model loaded on ${resolvedDevice}.`);

// Warm-up: prime GPU caches and JIT before accepting real work
try {
  await extractor(["warm-up"], { pooling: "mean", normalize: true });
  console.error("[ONNX] Warm-up complete.");
} catch {
  // non-fatal
}

// Send ready immediately — daemon can start accepting requests
post({ type: "ready" });

// Fire-and-forget: calibrate GPU batch size in background
void runProbe(extractor, model, resolvedDevice);
```

Note: probe runs AFTER `ready` — it uses the `embedQueue` implicitly since it
runs async after ready.

**Step 5: Update MockWorker in daemon.test.ts**

In `tests/core/adapters/embeddings/onnx/daemon.test.ts`, update MockWorker to
return `durationMs` and `calibrated`:

```typescript
class MockWorker extends EventEmitter {
  postMessage(msg: WorkerRequest): void {
    switch (msg.type) {
      case "init":
        // Simulate async ready + calibration
        setImmediate(() =>
          this.emit("message", { type: "ready" } satisfies WorkerResponse),
        );
        setImmediate(() =>
          this.emit("message", {
            type: "calibrated",
            batchSize: 8,
          } satisfies WorkerResponse),
        );
        break;
      case "embed":
        // Return fake embeddings with durationMs
        setImmediate(() =>
          this.emit("message", {
            type: "result",
            id: msg.id,
            embeddings: msg.texts.map(() => [1, 2, 3]),
            durationMs: 50,
          } satisfies WorkerResponse),
        );
        break;
      case "terminate":
        setImmediate(() => this.emit("exit", 0));
        break;
    }
  }

  async terminate(): Promise<number> {
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}
```

**Step 6: Run tests, build, commit**

```bash
npx vitest run tests/core/adapters/embeddings/onnx/
npm run build
git add src/core/adapters/embeddings/onnx/worker-types.ts src/core/adapters/embeddings/onnx/worker.ts tests/core/adapters/embeddings/onnx/daemon.test.ts
git commit -m "feat(onnx): add worker timing, calibration probe, and cache"
```

---

### Task 4: Daemon — use BatchSizeController + forward recommendedBatchSize

**Files:**

- Modify: `src/core/adapters/embeddings/onnx/daemon.ts`
- Modify: `src/core/adapters/embeddings/onnx/daemon-types.ts`
- Modify: `tests/core/adapters/embeddings/onnx/daemon.test.ts`

**Step 1: Update daemon-types.ts — add recommendedBatchSize to connected**

```typescript
/** Daemon → Client */
export type DaemonResponse =
  | {
      type: "connected";
      model: string;
      clients: number;
      recommendedBatchSize?: number;
    }
  | { type: "result"; id: number; embeddings: number[][] }
  | { type: "error"; message: string }
  | { type: "pong" }
  | {
      type: "status";
      model: string;
      device: string;
      clients: number;
      idleMs: number;
      uptime: number;
    }
  | { type: "bye" }
  | { type: "log"; level: "error"; message: string };
```

**Step 2: Update daemon.ts**

1. Change import:

```typescript
import { BatchSizeController } from "./batch-size-controller.js";
import { DEFAULT_GPU_BATCH_SIZE } from "./constants.js";
```

2. Add instance properties to OnnxDaemon class:

```typescript
private batchController: BatchSizeController | null = null;
private calibratedBatchSize: number | undefined;
```

3. In `handleWorkerMessage`, add `calibrated` case:

```typescript
case "calibrated": {
  if ("batchSize" in msg) {
    const bs = (msg as { batchSize: number }).batchSize;
    this.calibratedBatchSize = bs;
    this.batchController = new BatchSizeController(bs);
    console.error(`[OnnxDaemon] Calibrated GPU batch size: ${bs}`);
  }
  break;
}
```

4. In `handleConnect`, include `recommendedBatchSize` in connected response:

```typescript
this.send(socket, {
  type: "connected",
  model: this.loadedModel,
  clients: this.connectedClientCount(),
  recommendedBatchSize: this.calibratedBatchSize,
});
```

5. Refactor `handleEmbed` to use controller:

```typescript
private async handleEmbed(socket: Socket, state: ClientState, id: number, texts: string[]): Promise<void> {
  const { worker } = this;
  if (!state.connected || !worker || !this.workerReady) {
    this.send(socket, { type: "error", message: "Client not connected. Send 'connect' first." });
    return;
  }

  const batchSize = this.batchController?.currentBatchSize() ?? DEFAULT_GPU_BATCH_SIZE;

  // Fast path: single batch fits in GPU limit
  if (texts.length <= batchSize) {
    const resp = await this.embedViaWorker(worker, id, texts);
    if (resp.type === "result") {
      this.batchController?.report(resp.durationMs, texts.length);
      this.send(socket, { type: "result", id, embeddings: resp.embeddings });
    } else if (resp.type === "error") {
      this.send(socket, { type: "error", message: resp.message });
    }
    return;
  }

  // Split into sub-batches
  const allEmbeddings: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const subTexts = texts.slice(offset, offset + batchSize);
    const subId = id * 10000 + offset;
    const resp = await this.embedViaWorker(worker, subId, subTexts);

    if (resp.type === "error") {
      this.send(socket, { type: "error", message: resp.message });
      return;
    }
    if (resp.type === "result") {
      this.batchController?.report(resp.durationMs, subTexts.length);
      allEmbeddings.push(...resp.embeddings);
    }
  }

  this.send(socket, { type: "result", id, embeddings: allEmbeddings });
}
```

Note: `resp.durationMs` requires updating the type assertion. Since
`embedViaWorker` returns `WorkerResponse`, and `result` variant now has
`durationMs`, access it with: `(resp as { durationMs: number }).durationMs`. Or
better — narrow the type properly since we already check
`resp.type === "result"`.

**Step 3: Add daemon test for adaptive batching**

Add to `tests/core/adapters/embeddings/onnx/daemon.test.ts`:

```typescript
it("should include recommendedBatchSize in connected response after calibration", async () => {
  // MockWorker sends calibrated { batchSize: 8 } after ready
  // Give daemon time to receive calibrated
  await new Promise((r) => setTimeout(r, 50));

  const client = createPersistentClient(socketPath);
  client.send({ type: "connect", model: "test-model", device: "cpu" });
  const resp = await client.waitForResponse();

  expect(resp.type).toBe("connected");
  if (resp.type === "connected") {
    expect(resp.recommendedBatchSize).toBe(8);
  }

  await client.close();
});
```

**Step 4: Run tests, build, commit**

```bash
npx vitest run tests/core/adapters/embeddings/onnx/
npm run build
git add src/core/adapters/embeddings/onnx/daemon.ts src/core/adapters/embeddings/onnx/daemon-types.ts tests/core/adapters/embeddings/onnx/daemon.test.ts
git commit -m "feat(onnx): integrate BatchSizeController into daemon"
```

---

### Task 5: Client — expose recommendedBatchSize

**Files:**

- Modify: `src/core/adapters/embeddings/onnx.ts`
- Modify: `src/core/adapters/embeddings/base.ts`

**Step 1: Add recommendedBatchSize to EmbeddingProvider interface**

In `src/core/adapters/embeddings/base.ts`:

```typescript
export interface EmbeddingProvider {
  embed: (text: string) => Promise<EmbeddingResult>;
  embedBatch: (texts: string[]) => Promise<EmbeddingResult[]>;
  getDimensions: () => number;
  getModel: () => string;
  /** Optimal batch size detected by GPU calibration. Undefined if not available. */
  recommendedBatchSize?: number;
}
```

**Step 2: Store recommendedBatchSize in OnnxEmbeddings**

In `src/core/adapters/embeddings/onnx.ts`:

1. Add public property:

```typescript
public recommendedBatchSize?: number;
```

2. In the `ensureInitialized` handshake handler, when parsing `connected`
   response, store the value:

```typescript
if (!handshakeDone && msg.type === "connected") {
  handshakeDone = true;
  clearTimeout(timeout);
  this.socket = socket;
  this.splitter = splitter;
  if (
    "recommendedBatchSize" in msg &&
    typeof msg.recommendedBatchSize === "number"
  ) {
    this.recommendedBatchSize = msg.recommendedBatchSize;
  }
  this.startHeartbeat();
  resolve();
  return;
}
```

**Step 3: Run tests, build, commit**

```bash
npx vitest run tests/core/adapters/embeddings/
npm run build
git add src/core/adapters/embeddings/base.ts src/core/adapters/embeddings/onnx.ts
git commit -m "feat(onnx): expose recommendedBatchSize from OnnxEmbeddings"
```

---

### Task 6: Pipeline — use recommendedBatchSize if batch size not explicitly configured

**Files:**

- Modify: `src/bootstrap/config/parse.ts`
- Modify: `src/bootstrap/factory.ts`

**Step 1: Export userSetBatchSize flag from parse.ts**

In `src/bootstrap/config/parse.ts`, the parsed config already has the batch
size. We need to signal to factory.ts whether the user explicitly set it. Add a
property to the return type:

Change the return statement (around line 159) to include the flag:

```typescript
return {
  core: coreResult.data,
  embedding: embeddingResult.data,
  ingest: ingestResult.data,
  trajectoryGit: trajectoryGitResult.data,
  qdrantTune: qdrantTuneResult.data,
  flags: {
    userSetBatchSize: !!userSetBatchSize,
  },
};
```

**Step 2: In factory.ts, override batch size from provider**

After creating the embedding provider (line 48) and before building pipeline
config (line 57), check:

```typescript
const embeddings = EmbeddingProviderFactory.create(zodConfig.embedding);

// If user didn't explicitly set batch size, use GPU-calibrated recommendation
if (!zodConfig.flags.userSetBatchSize && embeddings.recommendedBatchSize) {
  zodConfig.embedding.tune.batchSize = embeddings.recommendedBatchSize;
}
```

Note: This requires that `ensureInitialized()` (which does the connect
handshake) runs before `createAppContext` finishes. Currently `embedBatch`
triggers lazy init. We need an explicit init call.

Add to OnnxEmbeddings:

```typescript
/** Initialize connection to daemon (called eagerly for batch size calibration) */
async initialize(): Promise<void> {
  await this.ensureInitialized();
}
```

Add to EmbeddingProvider interface:

```typescript
/** Optional eager initialization */
initialize?: () => Promise<void>;
```

In factory.ts:

```typescript
const embeddings = EmbeddingProviderFactory.create(zodConfig.embedding);

// Eagerly init ONNX to get calibrated batch size before pipeline config
if (embeddings.initialize) {
  await embeddings.initialize();
}

if (!zodConfig.flags.userSetBatchSize && embeddings.recommendedBatchSize) {
  zodConfig.embedding.tune.batchSize = embeddings.recommendedBatchSize;
}
```

This requires `createAppContext` to be async. Check if it already is — if not,
make it async.

**Step 3: Run tests, build, commit**

```bash
npm run build
npx vitest run tests/bootstrap/
git add src/bootstrap/config/parse.ts src/bootstrap/factory.ts src/core/adapters/embeddings/base.ts src/core/adapters/embeddings/onnx.ts
git commit -m "feat(onnx): pipeline uses GPU-calibrated batch size when not explicitly configured"
```

---

### Task 7: Add calibration cache path to paths.ts

**Files:**

- Modify: `src/bootstrap/config/paths.ts`

**Step 1: Add calibrationCachePath**

```typescript
export function calibrationCachePath(): string {
  return join(appDataDir(), "onnx-calibration.json");
}
```

**Step 2: Update worker.ts to use it via env var**

In the daemon CLI entry (daemon.ts bottom), pass the cache path as env var or
argv to the worker. Alternatively, worker.ts already reads `process.env.HOME` to
construct the path — this is sufficient since worker runs in the same process as
daemon.

**Step 3: Build, commit**

```bash
npm run build
git add src/bootstrap/config/paths.ts
git commit -m "feat(onnx): add calibrationCachePath to paths module"
```

---

### Task 8: Benchmark and validate

**Step 1: Rebuild and kill daemon**

```bash
pkill -f "node.*daemon.js"
rm -f ~/.tea-rags-mcp/onnx.sock ~/.tea-rags-mcp/onnx-calibration.json
npm run build
```

**Step 2: Reconnect MCP, run indexing**

First run: probe calibrates, caches result. Second run: cache hit, no probe
delay.

Compare with baseline (~115s).

**Step 3: Verify calibration cache**

```bash
cat ~/.tea-rags-mcp/onnx-calibration.json
```

Should show `{ "model": "jinaai/...", "device": "webgpu", "batchSize": N }`.
