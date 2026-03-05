# ONNX Worker Thread Design

**Goal:** Move ONNX embedding inference to a dedicated `worker_threads` thread so the main thread event loop stays responsive during CPU-bound inference.

**Problem:** ONNX is the only in-process embedding provider. When it runs inference on CPU, it blocks the Node.js event loop for seconds to minutes. This causes:
- MCP server becomes unresponsive (client kills it on timeout)
- `child_process.execFile` native timeouts can't fire (git log timeout bug)
- Backpressure and pipeline coordination stall

All other providers (Ollama, OpenAI, Cohere, Voyage) use HTTP APIs and don't block the event loop.

## Architecture

```
Main thread                          Worker thread
┌─────────────────┐                 ┌─────────────────────┐
│ OnnxEmbeddings   │  postMessage   │ onnx-worker.ts       │
│ (proxy)          │ ───────────►   │                      │
│                  │  {texts}       │ - loads model lazily  │
│ embed()          │                │ - runs pipeline()     │
│ embedBatch()     │  ◄───────────  │ - sends results back  │
│                  │  {embeddings}  │                      │
└─────────────────┘                 └─────────────────────┘
     implements                        @huggingface/transformers
     EmbeddingProvider                 onnxruntime-node
```

- `OnnxEmbeddings` keeps the same public API (`EmbeddingProvider` interface) — no changes for consumers
- Worker loads `@huggingface/transformers` and model lazily on first request
- Adaptive batch size logic (halving on failure) lives in the worker
- CoreML patch will also move to worker when CoreML support is implemented

## Message Protocol

```typescript
// Main → Worker
{ type: "embed", id: number, texts: string[], options: { pooling: "mean", normalize: true } }
{ type: "init", model: string, cacheDir?: string, device?: string }
{ type: "terminate" }

// Worker → Main
{ type: "result", id: number, embeddings: number[][] }
{ type: "error", id: number, message: string }
{ type: "log", level: "error", message: string }
```

## Lifecycle

1. Worker created lazily on first `embed()`/`embedBatch()` call
2. `init` message sent with model config
3. Model loaded in worker on first `embed` message (lazy, ~5-10s, may download ~70MB)
4. Request correlation via `id` field (supports sequential calls)
5. `worker.on('exit')` — recreate worker if it unexpectedly exits
6. `terminate` message on graceful shutdown (if needed)

## Scope

**In scope (MVP):**
- Worker thread with `postMessage` communication
- Lazy worker + lazy model loading
- Adaptive batch size in worker (existing halving logic)
- Worker crash recovery (`on('exit')` → recreate)
- `console.error` forwarding from worker via `log` messages

**Out of scope:**
- Memory monitoring / resource limits
- SharedArrayBuffer (unnecessary for ~1.5MB per batch)
- Worker pool (ONNX already uses all CPU cores internally)
- CoreML support (separate issue)

## Files

- **Create:** `src/core/adapters/embeddings/onnx/worker.ts` — worker thread entry point
- **Modify:** `src/core/adapters/embeddings/onnx.ts` — proxy that delegates to worker
- **Keep:** `src/core/adapters/embeddings/onnx/coreml.ts` — unchanged (will move to worker later)
- **Test:** `tests/core/adapters/embeddings/onnx-worker.test.ts`

## Trade-offs

- **Pro:** Main thread event loop never blocked, MCP server stays responsive
- **Pro:** Git timeouts work correctly, pipeline coordination unblocked
- **Pro:** No API changes — transparent to all consumers
- **Con:** Structured clone overhead for embeddings (~1.5MB per batch of 256×768) — negligible
- **Con:** Worker startup adds ~50-100ms on first call — acceptable for lazy init

## Decision: Worker Thread vs Child Process

Worker thread chosen over `child_process.fork()` because:
- Lower overhead (shared memory space, faster message passing)
- ONNX crashes from event loop blocking, not OOM — isolation not needed
- Simpler lifecycle management
