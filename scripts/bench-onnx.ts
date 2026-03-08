/**
 * Synthetic ONNX embedding benchmark.
 *
 * Measures raw embedding latency with random ~600-char chunks,
 * bypassing the full indexing pipeline.
 *
 * Usage:
 *   npx tsx scripts/bench-onnx.ts [--warmup] [--session-opts] [--batches N] [--bs N]
 */

import { Worker } from "node:worker_threads";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { WorkerRequest, WorkerResponse } from "../src/core/adapters/embeddings/onnx/worker-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, "../build/core/adapters/embeddings/onnx/worker.js");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    warmup: { type: "boolean", default: false },
    "session-opts": { type: "boolean", default: false },
    batches: { type: "string", default: "20" },
    bs: { type: "string", default: "8" },
  },
});

const ENABLE_WARMUP = values.warmup ?? false;
const ENABLE_SESSION_OPTS = values["session-opts"] ?? false;
const NUM_BATCHES = parseInt(values.batches ?? "20", 10);
const BATCH_SIZE = parseInt(values.bs ?? "8", 10);

// ---------------------------------------------------------------------------
// Random text generation
// ---------------------------------------------------------------------------

function randomText(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n(){}[];:.,/\\-_+=!@#$%^&*";
  let result = "";
  for (let i = 0; i < len; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Worker wrapper
// ---------------------------------------------------------------------------

class BenchWorker {
  private worker: Worker;
  private pending = new Map<number, { resolve: (emb: number[][]) => void; reject: (err: Error) => void }>();
  private readyResolve: (() => void) | null = null;
  private nextId = 0;

  constructor() {
    this.worker = new Worker(WORKER_PATH);
    this.worker.on("message", (msg: WorkerResponse) => this.onMessage(msg));
    this.worker.on("error", (err) => {
      console.error("Worker error:", err);
      process.exit(1);
    });
  }

  private onMessage(msg: WorkerResponse): void {
    switch (msg.type) {
      case "ready":
        this.readyResolve?.();
        break;
      case "result": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg.embeddings);
        }
        break;
      }
      case "error": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.reject(new Error(msg.message));
        } else {
          console.error("Worker init error:", msg.message);
          process.exit(1);
        }
        break;
      }
      case "log":
        console.error(`[worker] ${msg.message}`);
        break;
    }
  }

  async init(model: string, device: string): Promise<void> {
    const p = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    const msg: WorkerRequest = { type: "init", model, device };
    this.worker.postMessage(msg);
    await p;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const id = this.nextId++;
    return new Promise<number[][]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg: WorkerRequest = { type: "embed", id, texts };
      this.worker.postMessage(msg);
    });
  }

  async terminate(): Promise<void> {
    await this.worker.terminate();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const MODEL = process.env.EMBEDDING_MODEL ?? "jinaai/jina-embeddings-v2-base-code-fp16";
  const DEVICE = process.env.EMBEDDING_DEVICE ?? "auto";

  console.error(`\n=== ONNX Embedding Benchmark ===`);
  console.error(`Model: ${MODEL}`);
  console.error(`Device: ${DEVICE}`);
  console.error(`Warm-up: ${ENABLE_WARMUP}`);
  console.error(`Session opts: ${ENABLE_SESSION_OPTS}`);
  console.error(`Batches: ${NUM_BATCHES} × ${BATCH_SIZE} texts`);
  console.error(`Total texts: ${NUM_BATCHES * BATCH_SIZE}`);
  console.error(`Text length: ~600 chars each\n`);

  // Generate all texts upfront
  const allBatches: string[][] = [];
  for (let i = 0; i < NUM_BATCHES; i++) {
    const batch: string[] = [];
    for (let j = 0; j < BATCH_SIZE; j++) {
      batch.push(randomText(600));
    }
    allBatches.push(batch);
  }

  const worker = new BenchWorker();

  // Init
  const initStart = performance.now();
  await worker.init(MODEL, DEVICE);
  const initTime = performance.now() - initStart;
  console.error(`Model loaded in ${initTime.toFixed(0)}ms`);

  // Optional warm-up
  if (ENABLE_WARMUP) {
    const warmStart = performance.now();
    await worker.embed(["warm-up text for GPU cache priming"]);
    const warmTime = performance.now() - warmStart;
    console.error(`Warm-up batch: ${warmTime.toFixed(0)}ms`);
  }

  // Benchmark
  const times: number[] = [];
  const totalStart = performance.now();

  for (let i = 0; i < NUM_BATCHES; i++) {
    const batchStart = performance.now();
    const result = await worker.embed(allBatches[i]);
    const batchTime = performance.now() - batchStart;
    times.push(batchTime);

    if (i === 0) {
      console.error(`  First batch: ${batchTime.toFixed(0)}ms (${result.length} embeddings × ${result[0].length} dims)`);
    }
  }

  const totalTime = performance.now() - totalStart;

  // Stats
  times.sort((a, b) => a - b);
  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const p99 = times[Math.floor(times.length * 0.99)];
  const min = times[0];
  const max = times[times.length - 1];

  console.error(`\n--- Results ---`);
  console.error(`Total: ${totalTime.toFixed(0)}ms`);
  console.error(`Avg:   ${avg.toFixed(0)}ms/batch`);
  console.error(`P50:   ${p50.toFixed(0)}ms`);
  console.error(`P95:   ${p95.toFixed(0)}ms`);
  console.error(`P99:   ${p99.toFixed(0)}ms`);
  console.error(`Min:   ${min.toFixed(0)}ms`);
  console.error(`Max:   ${max.toFixed(0)}ms`);
  console.error(`Throughput: ${((NUM_BATCHES * BATCH_SIZE) / (totalTime / 1000)).toFixed(1)} texts/sec`);

  await worker.terminate();
}

await main();
