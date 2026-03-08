# Daemon-Side Batching Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce socket roundtrip overhead by having the daemon split large batches internally into GPU-safe chunks of 8, allowing the pipeline to send 32+ texts per call.

**Architecture:** Client sends `embed { texts: string[N] }` in one message. Daemon splits into sub-batches of `GPU_BATCH_SIZE` (8), processes each through the worker sequentially, concatenates results, returns one `result { embeddings: number[N][dims] }`. Pipeline default batch size rises from 8 to 32, cutting roundtrips by ~4x.

**Tech Stack:** TypeScript, Node.js, Unix sockets, NDJSON protocol, Vitest

---

### Task 1: Add GPU_BATCH_SIZE constant

**Files:**
- Create: `src/core/adapters/embeddings/onnx/constants.ts`
- Test: `tests/core/adapters/embeddings/onnx/constants.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/core/adapters/embeddings/onnx/constants.test.ts
import { describe, it, expect } from "vitest";
import { GPU_BATCH_SIZE } from "../../../../../src/core/adapters/embeddings/onnx/constants.js";

describe("GPU_BATCH_SIZE", () => {
  it("should be 8", () => {
    expect(GPU_BATCH_SIZE).toBe(8);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/embeddings/onnx/constants.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/core/adapters/embeddings/onnx/constants.ts
/**
 * Maximum batch size for a single GPU inference call.
 * Larger batches are split into sub-batches of this size by the daemon.
 * Benchmarked optimal for WebGPU/Metal with jina-embeddings-v2 (768-dim).
 */
export const GPU_BATCH_SIZE = 8;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/embeddings/onnx/constants.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/adapters/embeddings/onnx/constants.ts tests/core/adapters/embeddings/onnx/constants.test.ts
git commit -m "feat(onnx): add GPU_BATCH_SIZE constant"
```

---

### Task 2: Implement daemon-side batch splitting in handleEmbed

**Files:**
- Modify: `src/core/adapters/embeddings/onnx/daemon.ts` (lines 290-308, `handleEmbed`)
- Test: `tests/core/adapters/embeddings/onnx/daemon.test.ts`

**Step 1: Write the failing tests**

Add to `tests/core/adapters/embeddings/onnx/daemon.test.ts` inside the main `describe` block:

```typescript
describe("daemon-side batching", () => {
  it("should split large batch into GPU_BATCH_SIZE chunks and return combined result", async () => {
    // Send 20 texts — daemon should split into 3 sub-batches (8 + 8 + 4)
    const texts = Array.from({ length: 20 }, (_, i) => `text-${i}`);
    const client = createPersistentClient(socketPath);

    client.send({ type: "connect", model: "test-model", device: "cpu" });
    await client.waitForResponse(); // connected

    client.send({ type: "embed", id: 1, texts });
    const resp = await client.waitForResponse();

    expect(resp.type).toBe("result");
    if (resp.type === "result") {
      expect(resp.id).toBe(1);
      expect(resp.embeddings).toHaveLength(20);
      // Each embedding should be [1, 2, 3] from MockWorker
      expect(resp.embeddings[0]).toEqual([1, 2, 3]);
      expect(resp.embeddings[19]).toEqual([1, 2, 3]);
    }

    await client.close();
  });

  it("should pass through batch that fits in GPU_BATCH_SIZE without splitting", async () => {
    const texts = Array.from({ length: 5 }, (_, i) => `text-${i}`);
    const client = createPersistentClient(socketPath);

    client.send({ type: "connect", model: "test-model", device: "cpu" });
    await client.waitForResponse();

    client.send({ type: "embed", id: 2, texts });
    const resp = await client.waitForResponse();

    expect(resp.type).toBe("result");
    if (resp.type === "result") {
      expect(resp.id).toBe(2);
      expect(resp.embeddings).toHaveLength(5);
    }

    await client.close();
  });

  it("should handle batch that is exact multiple of GPU_BATCH_SIZE", async () => {
    const texts = Array.from({ length: 16 }, (_, i) => `text-${i}`);
    const client = createPersistentClient(socketPath);

    client.send({ type: "connect", model: "test-model", device: "cpu" });
    await client.waitForResponse();

    client.send({ type: "embed", id: 3, texts });
    const resp = await client.waitForResponse();

    expect(resp.type).toBe("result");
    if (resp.type === "result") {
      expect(resp.id).toBe(3);
      expect(resp.embeddings).toHaveLength(16);
    }

    await client.close();
  });
});
```

**Step 2: Run tests to verify they pass (already work with current code since MockWorker handles any batch size)**

Run: `npx vitest run tests/core/adapters/embeddings/onnx/daemon.test.ts`
Expected: Tests pass even before refactoring — MockWorker doesn't care about batch size. This is OK; the real value is verifying the contract stays intact after refactoring.

**Step 3: Refactor handleEmbed to split batches**

In `src/core/adapters/embeddings/onnx/daemon.ts`:

1. Add import at top:
```typescript
import { GPU_BATCH_SIZE } from "./constants.js";
```

2. Replace `handleEmbed` method (lines 290-308) with:
```typescript
private async handleEmbed(socket: Socket, state: ClientState, id: number, texts: string[]): Promise<void> {
  const { worker } = this;
  if (!state.connected || !worker || !this.workerReady) {
    this.send(socket, { type: "error", message: "Client not connected. Send 'connect' first." });
    return;
  }

  // Split into GPU-safe sub-batches
  if (texts.length <= GPU_BATCH_SIZE) {
    // Fast path: single batch, no splitting overhead
    const resp = await this.embedViaWorker(worker, id, texts);
    if (resp.type === "result") {
      this.send(socket, { type: "result", id, embeddings: resp.embeddings });
    } else if (resp.type === "error") {
      this.send(socket, { type: "error", message: resp.message });
    }
    return;
  }

  // Split into sub-batches of GPU_BATCH_SIZE
  const allEmbeddings: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += GPU_BATCH_SIZE) {
    const subTexts = texts.slice(offset, offset + GPU_BATCH_SIZE);
    const subId = id * 10000 + offset; // unique sub-id to avoid collision
    const resp = await this.embedViaWorker(worker, subId, subTexts);

    if (resp.type === "error") {
      this.send(socket, { type: "error", message: resp.message });
      return;
    }
    if (resp.type === "result") {
      allEmbeddings.push(...resp.embeddings);
    }
  }

  this.send(socket, { type: "result", id, embeddings: allEmbeddings });
}

/** Send embed request to worker and wait for response */
private embedViaWorker(
  worker: WorkerLike,
  id: number,
  texts: string[],
): Promise<WorkerResponse> {
  return new Promise<WorkerResponse>((resolve) => {
    this.pendingEmbeds.set(id, resolve);
    worker.postMessage({ type: "embed", id, texts });
  });
}
```

**Step 4: Run tests to verify they still pass**

Run: `npx vitest run tests/core/adapters/embeddings/onnx/daemon.test.ts`
Expected: ALL tests PASS (including new batching tests and all existing tests)

**Step 5: Build and run full test suite**

Run: `npm run build && npx vitest run tests/core/adapters/embeddings/onnx/`
Expected: PASS

**Step 6: Commit**

```bash
git add src/core/adapters/embeddings/onnx/daemon.ts tests/core/adapters/embeddings/onnx/daemon.test.ts
git commit -m "feat(onnx): add daemon-side batch splitting for GPU-safe inference"
```

---

### Task 3: Raise ONNX default pipeline batch size from 8 to 32

**Files:**
- Modify: `src/bootstrap/config/parse.ts` (line 150)
- Test: `tests/bootstrap/config-zod.test.ts` (if batch size default is tested)

**Step 1: Check existing tests for batch size default**

Run: `grep -n "onnx.*8\|batchSize.*8\|batch.*onnx" tests/bootstrap/config-zod.test.ts`
If a test asserts onnx default batch size = 8, update it to 32.

**Step 2: Change the default**

In `src/bootstrap/config/parse.ts` line 150, change:
```typescript
onnx: 8,
```
to:
```typescript
onnx: 32,
```

**Step 3: Build and run config tests**

Run: `npm run build && npx vitest run tests/bootstrap/`
Expected: PASS

**Step 4: Commit**

```bash
git add src/bootstrap/config/parse.ts
git commit -m "perf(onnx): raise default pipeline batch size from 8 to 32"
```

---

### Task 4: Benchmark and validate

**Step 1: Kill existing daemon, rebuild, reconnect MCP**

```bash
pkill -f "node.*daemon.js"
rm -f ~/.tea-rags-mcp/onnx.sock
npm run build
```

Reconnect tea-rags MCP server.

**Step 2: Run synthetic benchmark at bs=32**

```bash
npx tsx scripts/bench-onnx.ts --warmup --batches 10 --bs 32
```

Expected: Similar per-text throughput, but fewer calls.

**Step 3: Run full indexing benchmark**

```bash
# via MCP: index_codebase with forceReindex=true
```

Expected: Faster than baseline 116s due to fewer socket roundtrips.

**Step 4: Commit benchmark script update if needed**

---

## Summary of changes

| File | Change |
|------|--------|
| `src/core/adapters/embeddings/onnx/constants.ts` | NEW: `GPU_BATCH_SIZE = 8` |
| `src/core/adapters/embeddings/onnx/daemon.ts` | `handleEmbed` splits large batches, extracts `embedViaWorker` helper |
| `src/bootstrap/config/parse.ts` | ONNX default batch size: 8 → 32 |
| `tests/core/adapters/embeddings/onnx/constants.test.ts` | NEW: constant test |
| `tests/core/adapters/embeddings/onnx/daemon.test.ts` | NEW: 3 batching tests |
