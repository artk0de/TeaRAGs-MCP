# ONNX Worker Thread Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Move ONNX embedding inference to a dedicated Node.js worker thread so
the main thread event loop stays responsive.

**Architecture:** `OnnxEmbeddings` becomes a thin proxy that spawns a worker
thread on first use. The worker loads `@huggingface/transformers`, runs
inference, and sends results back via `postMessage`. The `EmbeddingProvider`
interface is unchanged — consumers see no difference.

**Tech Stack:** Node.js `worker_threads`, `@huggingface/transformers`, vitest

**Design doc:** `docs/plans/2026-03-06-onnx-worker-thread-design.md`

---

## Context for Implementer

**Project:** ESM (`"type": "module"` in package.json, `"module": "NodeNext"` in
tsconfig).

**Current ONNX provider:** `src/core/adapters/embeddings/onnx.ts` — loads model
lazily via `ensureLoaded()`, runs inference in-process, blocks event loop during
CPU inference.

**Key files:**

- `src/core/adapters/embeddings/onnx.ts` — current provider (will become proxy)
- `src/core/adapters/embeddings/onnx/coreml.ts` — CoreML monkey-patch (stays
  unchanged)
- `src/core/adapters/embeddings/onnx/device.ts` — device detection (stays
  unchanged)
- `src/core/adapters/embeddings/base.ts` — `EmbeddingProvider` interface
- `src/core/adapters/embeddings/factory.ts` — creates `OnnxEmbeddings`
- `tests/core/adapters/embeddings/onnx.test.ts` — existing tests

**ESM + worker_threads:** Workers in ESM projects need
`new Worker(url, { type: 'module' })` or a compiled `.js` file path. Since we
compile TS → JS, the worker file path must point to the compiled output (`dist/`
or resolved via `import.meta.url`).

**Message protocol (from design):**

```typescript
// Main → Worker
{ type: "init", model: string, cacheDir?: string, device?: string }
{ type: "embed", id: number, texts: string[] }
{ type: "terminate" }

// Worker → Main
{ type: "ready" }
{ type: "result", id: number, embeddings: number[][] }
{ type: "error", id: number, message: string }
{ type: "log", level: "error", message: string }
```

---

### Task 1: Message Types

**Files:**

- Create: `src/core/adapters/embeddings/onnx/worker-types.ts`

**Step 1: Create the shared message types file**

This file defines the protocol between main thread and worker. No tests needed —
it's pure types.

```typescript
/** Messages from main thread to worker */
export type WorkerRequest =
  | { type: "init"; model: string; cacheDir?: string; device?: string }
  | { type: "embed"; id: number; texts: string[] }
  | { type: "terminate" };

/** Messages from worker to main thread */
export type WorkerResponse =
  | { type: "ready" }
  | { type: "result"; id: number; embeddings: number[][] }
  | { type: "error"; id: number; message: string }
  | { type: "log"; level: "error"; message: string };
```

**Step 2: Run type-check**

Run: `npx tsc --noEmit` Expected: PASS (no errors)

**Step 3: Commit**

```bash
git add src/core/adapters/embeddings/onnx/worker-types.ts
git commit -m "feat(onnx): add worker thread message types"
```

---

### Task 2: Worker Thread Entry Point

**Files:**

- Create: `src/core/adapters/embeddings/onnx/worker.ts`
- Test: `tests/core/adapters/embeddings/onnx-worker.test.ts`

This is the worker thread script. It receives messages, loads the model, runs
inference, sends results back.

**Step 1: Write the failing test**

The test creates a real `Worker` pointing at the compiled worker file. We test
the message protocol directly.

```typescript
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import type {
  WorkerRequest,
  WorkerResponse,
} from "../../../../src/core/adapters/embeddings/onnx/worker-types.js";

// Resolve worker path relative to this test file
// In tests, we use tsx to run .ts files directly
const workerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../src/core/adapters/embeddings/onnx/worker.ts",
);

function createTestWorker(): Worker {
  return new Worker(workerPath, {
    execArgv: ["--import", "tsx"],
  });
}

function sendAndWait(
  worker: Worker,
  msg: WorkerRequest,
): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Worker response timeout")),
      10000,
    );
    worker.once("message", (response: WorkerResponse) => {
      clearTimeout(timeout);
      resolve(response);
    });
    worker.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    worker.postMessage(msg);
  });
}

describe("ONNX Worker Thread", () => {
  let worker: Worker | null = null;

  afterEach(async () => {
    if (worker) {
      worker.postMessage({ type: "terminate" });
      await new Promise<void>((resolve) => {
        worker!.once("exit", () => resolve());
        setTimeout(resolve, 1000);
      });
      worker = null;
    }
  });

  it("should respond with ready after init", async () => {
    worker = createTestWorker();
    const response = await sendAndWait(worker, {
      type: "init",
      model: "jinaai/jina-embeddings-v2-base-code-q8",
    });
    expect(response.type).toBe("ready");
  });

  it("should return error for embed before init", async () => {
    worker = createTestWorker();
    const response = await sendAndWait(worker, {
      type: "embed",
      id: 1,
      texts: ["hello"],
    });
    expect(response.type).toBe("error");
    expect((response as { message: string }).message).toContain(
      "not initialized",
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/embeddings/onnx-worker.test.ts`
Expected: FAIL — worker.ts doesn't exist yet

**Step 3: Implement the worker**

Create `src/core/adapters/embeddings/onnx/worker.ts`:

```typescript
import { parentPort } from "node:worker_threads";

import { buildPipelineOptions, patchInferenceSession } from "./coreml.js";
import type { WorkerRequest, WorkerResponse } from "./worker-types.js";

type Pipeline = (
  texts: string[],
  options: Record<string, unknown>,
) => Promise<{ tolist: () => number[][] }>;

const KNOWN_DTYPES = ["q4", "q8", "fp16", "fp32", "int8", "bnb4"] as const;
type Dtype = (typeof KNOWN_DTYPES)[number];

const MIN_BATCH_SIZE = 4;
const INITIAL_BATCH_SIZE = 32;

let extractor: Pipeline | null = null;
let maxBatchSize: number | null = null;

function parseModelSpec(model: string): {
  baseModel: string;
  dtype: Dtype | undefined;
} {
  const lastDash = model.lastIndexOf("-");
  if (lastDash === -1) return { baseModel: model, dtype: undefined };
  const suffix = model.slice(lastDash + 1);
  if (KNOWN_DTYPES.includes(suffix as Dtype)) {
    return { baseModel: model.slice(0, lastDash), dtype: suffix as Dtype };
  }
  return { baseModel: model, dtype: undefined };
}

function send(msg: WorkerResponse): void {
  parentPort?.postMessage(msg);
}

function log(message: string): void {
  send({ type: "log", level: "error", message });
}

async function handleInit(
  model: string,
  cacheDir?: string,
  device?: string,
): Promise<void> {
  try {
    const { baseModel, dtype } = parseModelSpec(model);
    const { pipeline, env } = await import("@huggingface/transformers");

    if (cacheDir) {
      env.cacheDir = cacheDir;
    }

    const label = dtype ? `${baseModel} (${dtype})` : baseModel;
    const deviceLabel = device ?? "cpu";

    // CoreML: patch onnxruntime-node to inject CoreMLExecutionProvider
    let restorePatch: (() => void) | undefined;
    if (device === "coreml") {
      const ort = await import("onnxruntime-node");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const IS =
        (ort as any).InferenceSession ?? (ort as any).default?.InferenceSession;
      restorePatch = patchInferenceSession(IS);
    }

    log(
      `[ONNX] Loading model ${label} [${deviceLabel}]... (first time, may download ~70MB)`,
    );
    log(`[ONNX] Cache dir: ${env.cacheDir}`);

    const pipelineDevice = device === "coreml" ? undefined : device;
    const pipelineOpts = buildPipelineOptions(dtype, pipelineDevice);
    extractor = (await pipeline(
      "feature-extraction",
      baseModel,
      pipelineOpts,
    )) as unknown as Pipeline;

    restorePatch?.();
    log("[ONNX] Model loaded.");
    send({ type: "ready" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Send as error with id=-1 (init error, not a request error)
    send({
      type: "error",
      id: -1,
      message: `Failed to load model: ${message}`,
    });
  }
}

async function handleEmbed(id: number, texts: string[]): Promise<void> {
  if (!extractor) {
    send({
      type: "error",
      id,
      message: "Worker not initialized — send init first",
    });
    return;
  }

  try {
    const allEmbeddings: number[][] = [];
    const batchSize = maxBatchSize ?? INITIAL_BATCH_SIZE;
    let i = 0;

    while (i < texts.length) {
      const currentBatch = maxBatchSize ?? batchSize;
      const chunk = texts.slice(i, i + currentBatch);
      try {
        const output = await extractor(chunk, {
          pooling: "mean",
          normalize: true,
        });
        const vectors = output.tolist();
        for (const vec of vectors) {
          allEmbeddings.push(vec);
        }
        i += chunk.length;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        const prev = maxBatchSize ?? chunk.length;
        if (prev <= MIN_BATCH_SIZE) {
          send({ type: "error", id, message: msg });
          return;
        }
        maxBatchSize = Math.max(MIN_BATCH_SIZE, Math.floor(prev / 2));
        log(
          `[ONNX] Batch of ${prev} failed (${msg}), reducing to ${maxBatchSize}`,
        );
      }
    }

    send({ type: "result", id, embeddings: allEmbeddings });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    send({ type: "error", id, message });
  }
}

parentPort?.on("message", (msg: WorkerRequest) => {
  switch (msg.type) {
    case "init":
      void handleInit(msg.model, msg.cacheDir, msg.device);
      break;
    case "embed":
      void handleEmbed(msg.id, msg.texts);
      break;
    case "terminate":
      process.exit(0);
      break;
  }
});
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/embeddings/onnx-worker.test.ts`
Expected: PASS — but may need adjustment for tsx/ESM worker loading. If
`--import tsx` doesn't work, try `execArgv: ["--loader", "tsx"]` or compile
first.

**Step 5: Commit**

```bash
git add src/core/adapters/embeddings/onnx/worker.ts tests/core/adapters/embeddings/onnx-worker.test.ts
git commit -m "feat(onnx): add worker thread entry point with message protocol"
```

---

### Task 3: Refactor OnnxEmbeddings into Worker Proxy

**Files:**

- Modify: `src/core/adapters/embeddings/onnx.ts` (full rewrite to proxy)
- Modify: `tests/core/adapters/embeddings/onnx.test.ts` (adapt tests)

**Step 1: Write new failing tests for worker proxy behavior**

Add to `tests/core/adapters/embeddings/onnx.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ONNX_MODEL,
  OnnxEmbeddings,
} from "../../../../src/core/adapters/embeddings/onnx.js";

describe("OnnxEmbeddings (worker proxy)", () => {
  let provider: OnnxEmbeddings;

  afterEach(async () => {
    if (provider) {
      await provider.terminate();
    }
  });

  describe("constructor", () => {
    it("should use default model", () => {
      provider = new OnnxEmbeddings();
      expect(provider.getModel()).toBe(DEFAULT_ONNX_MODEL);
      expect(provider.getDimensions()).toBe(768);
    });

    it("should accept custom model and dimensions", () => {
      provider = new OnnxEmbeddings("Xenova/all-MiniLM-L6-v2", 384);
      expect(provider.getModel()).toBe("Xenova/all-MiniLM-L6-v2");
      expect(provider.getDimensions()).toBe(384);
    });
  });

  describe("embed (integration — uses real worker)", () => {
    it("should return embedding result via worker", async () => {
      provider = new OnnxEmbeddings();
      const result = await provider.embed("function hello() {}");

      expect(result.embedding).toHaveLength(768);
      expect(result.dimensions).toBe(768);
      expect(typeof result.embedding[0]).toBe("number");
    }, 30000); // model loading may take time

    it("should lazy-init worker on first call", async () => {
      provider = new OnnxEmbeddings();
      // No worker created yet — just constructor
      const result = await provider.embed("test");
      expect(result.dimensions).toBe(768);
    }, 30000);
  });

  describe("embedBatch (integration)", () => {
    it("should return empty array for empty input", async () => {
      provider = new OnnxEmbeddings();
      const result = await provider.embedBatch([]);
      expect(result).toEqual([]);
    });

    it("should embed multiple texts via worker", async () => {
      provider = new OnnxEmbeddings();
      const results = await provider.embedBatch(["text1", "text2"]);
      expect(results).toHaveLength(2);
      expect(results[0].dimensions).toBe(768);
    }, 30000);
  });

  describe("worker lifecycle", () => {
    it("should recover from worker crash", async () => {
      provider = new OnnxEmbeddings();
      // First call initializes worker
      await provider.embed("test");
      // Force kill worker
      await provider.terminate();
      // Next call should recreate worker
      const result = await provider.embed("test again");
      expect(result.dimensions).toBe(768);
    }, 60000);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/embeddings/onnx.test.ts` Expected: FAIL
— `terminate()` method doesn't exist, worker proxy not implemented

**Step 3: Rewrite OnnxEmbeddings as worker proxy**

Replace `src/core/adapters/embeddings/onnx.ts`:

```typescript
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { EmbeddingProvider, EmbeddingResult } from "./base.js";
import type { WorkerRequest, WorkerResponse } from "./onnx/worker-types.js";

export const DEFAULT_ONNX_MODEL = "jinaai/jina-embeddings-v2-base-code-q8";
export const DEFAULT_ONNX_DIMENSIONS = 768;

const WORKER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "onnx",
  "worker.js",
);

export class OnnxEmbeddings implements EmbeddingProvider {
  private readonly model: string;
  private readonly dimensions: number;
  private readonly cacheDir: string | undefined;
  private readonly device: string | undefined;
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private nextId = 0;

  constructor(
    model = DEFAULT_ONNX_MODEL,
    dimensions = DEFAULT_ONNX_DIMENSIONS,
    cacheDir?: string,
    device?: string,
  ) {
    this.model = model;
    this.dimensions = dimensions;
    this.cacheDir = cacheDir;
    this.device = device && device !== "cpu" ? device : undefined;
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(WORKER_PATH);
      this.worker.on("message", (msg: WorkerResponse) => {
        if (msg.type === "log") {
          console.error(msg.message);
        }
      });
      this.worker.on("exit", (code) => {
        if (code !== 0) {
          console.error(
            `[ONNX] Worker exited with code ${code}, will recreate on next call`,
          );
        }
        this.worker = null;
        this.initPromise = null;
      });
    }
    return this.worker;
  }

  private async ensureInitialized(): Promise<Worker> {
    const worker = this.ensureWorker();

    if (!this.initPromise) {
      this.initPromise = new Promise<void>((resolve, reject) => {
        const onMessage = (msg: WorkerResponse) => {
          if (msg.type === "ready") {
            worker.removeListener("message", onMessage);
            resolve();
          } else if (
            msg.type === "error" &&
            (msg as { id: number }).id === -1
          ) {
            worker.removeListener("message", onMessage);
            this.initPromise = null;
            reject(new Error((msg as { message: string }).message));
          }
        };
        worker.on("message", onMessage);
        worker.postMessage({
          type: "init",
          model: this.model,
          cacheDir: this.cacheDir,
          device: this.device,
        } satisfies WorkerRequest);
      });
    }

    await this.initPromise;
    return worker;
  }

  private sendRequest(worker: Worker, texts: string[]): Promise<number[][]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onMessage = (msg: WorkerResponse) => {
        if (msg.type === "result" && (msg as { id: number }).id === id) {
          worker.removeListener("message", onMessage);
          resolve((msg as { embeddings: number[][] }).embeddings);
        } else if (msg.type === "error" && (msg as { id: number }).id === id) {
          worker.removeListener("message", onMessage);
          reject(new Error((msg as { message: string }).message));
        }
      };
      worker.on("message", onMessage);
      worker.postMessage({ type: "embed", id, texts } satisfies WorkerRequest);
    });
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const worker = await this.ensureInitialized();
    const embeddings = await this.sendRequest(worker, [text]);
    return { embedding: embeddings[0], dimensions: this.dimensions };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];
    const worker = await this.ensureInitialized();
    const embeddings = await this.sendRequest(worker, texts);
    return embeddings.map((embedding) => ({
      embedding,
      dimensions: this.dimensions,
    }));
  }

  async terminate(): Promise<void> {
    if (this.worker) {
      this.worker.postMessage({ type: "terminate" } satisfies WorkerRequest);
      await new Promise<void>((resolve) => {
        this.worker!.once("exit", () => resolve());
        setTimeout(resolve, 2000); // fallback timeout
      });
      this.worker = null;
      this.initPromise = null;
    }
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModel(): string {
    return this.model;
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/core/adapters/embeddings/onnx.test.ts` Expected: PASS

Note: The old unit tests that mock `@huggingface/transformers` at the module
level won't work anymore because the import now happens inside the worker, not
in the main thread. The new tests are integration tests that use the real
worker. Remove or adapt old tests that rely on mocking the pipeline import.

**Step 5: Run type-check**

Run: `npx tsc --noEmit` Expected: PASS

**Step 6: Commit**

```bash
git add src/core/adapters/embeddings/onnx.ts tests/core/adapters/embeddings/onnx.test.ts
git commit -m "feat(onnx): refactor OnnxEmbeddings to worker thread proxy"
```

---

### Task 4: Verify No Consumer Changes Needed

**Files:**

- Read: `src/core/adapters/embeddings/factory.ts` (should need no changes)
- Read: any files that import from `onnx.ts`

**Step 1: Verify factory still works**

Run: `npx vitest run tests/core/adapters/embeddings/factory.test.ts` Expected:
PASS — factory creates `OnnxEmbeddings` which still implements
`EmbeddingProvider`

**Step 2: Run full test suite**

Run: `npx vitest run` Expected: All tests pass. The refactored `OnnxEmbeddings`
has the same interface.

**Step 3: Commit (if any test fixups needed)**

```bash
git commit -m "test(onnx): fix test compatibility with worker thread proxy"
```

---

### Task 5: Full Integration Smoke Test

**Step 1: Build the project**

Run: `npm run build` (or `npx tsc`) Expected: Clean compilation, worker.js
exists in output directory

**Step 2: Manual smoke test**

Start the MCP server and index a small repo. Verify:

- Model loads in worker (see `[ONNX] Loading model...` in stderr)
- Embeddings complete successfully
- MCP server stays responsive during embedding (can answer ping/list_tools while
  indexing)
- Git enrichment timeout works correctly (no more event loop blocking)

**Step 3: Verify event loop is unblocked**

While indexing is running, call any MCP tool (e.g., `get_index_status`). It
should respond immediately, not wait for the current embedding batch to finish.

---

## Summary

| Task | What                   | Files                           |
| ---- | ---------------------- | ------------------------------- |
| 1    | Message types          | Create `onnx/worker-types.ts`   |
| 2    | Worker entry point     | Create `onnx/worker.ts` + tests |
| 3    | Proxy rewrite          | Rewrite `onnx.ts` + adapt tests |
| 4    | Verify consumers       | Run factory + full suite        |
| 5    | Integration smoke test | Build + manual test             |
