/**
 * Worker thread for ONNX embedding inference.
 *
 * Runs @huggingface/transformers pipeline off the main thread so the
 * event loop stays unblocked during heavy inference.
 *
 * Uses WebGPU device (Metal on macOS, D3D12 on Windows, Vulkan on Linux).
 */

import { parentPort } from "node:worker_threads";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { detectDevice } from "./device.js";
import {
  DEFAULT_GPU_BATCH_SIZE,
  PROBE_BATCH_SIZES,
  PROBE_PRESSURE_THRESHOLD,
} from "./constants.js";
import type { WorkerRequest, WorkerResponse } from "./worker-types.js";

// Sequential lock: ensures only one embed runs at a time on GPU
let embedQueue: Promise<void> = Promise.resolve();

type Pipeline = (texts: string[], options: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>;
type TransformersModule = { pipeline: (...args: unknown[]) => Promise<unknown>; env: { cacheDir: string } };
type PipelineFn = TransformersModule["pipeline"];

const KNOWN_DTYPES = ["q4", "q8", "fp16", "fp32", "int8", "bnb4"] as const;
type Dtype = (typeof KNOWN_DTYPES)[number];

function parseModelSpec(model: string): { baseModel: string; dtype: Dtype | undefined } {
  const lastDash = model.lastIndexOf("-");
  if (lastDash === -1) return { baseModel: model, dtype: undefined };

  const suffix = model.slice(lastDash + 1);
  if (KNOWN_DTYPES.includes(suffix as Dtype)) {
    return { baseModel: model.slice(0, lastDash), dtype: suffix as Dtype };
  }
  return { baseModel: model, dtype: undefined };
}

let extractor: Pipeline | null = null;

const port = parentPort;

function post(msg: WorkerResponse): void {
  port?.postMessage(msg);
}

// Forward console.error to main thread
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  post({ type: "log", level: "error", message });
  originalConsoleError.apply(console, args);
};

async function importTransformers(): Promise<TransformersModule> {
  try {
    return (await import("@huggingface/transformers")) as unknown as TransformersModule;
  } catch {
    throw new Error(
      "ONNX provider requires additional packages. Install them with:\n" +
        "  npm install @huggingface/transformers@next",
    );
  }
}

function formatAuthError(baseModel: string): string {
  return (
    `Model access denied: ${baseModel}. This model may require authentication.\n` +
    `  Set the HF_TOKEN environment variable: export HF_TOKEN=hf_your_token\n` +
    `  Get your token at: https://huggingface.co/settings/tokens`
  );
}

async function loadPipeline(
  pipelineFn: PipelineFn,
  baseModel: string,
  pipelineOpts: Record<string, unknown>,
): Promise<Pipeline> {
  return (await pipelineFn("feature-extraction", baseModel, pipelineOpts)) as Pipeline;
}

function calibrationCachePath(): string | null {
  const dataDir = process.env.TEA_RAGS_DATA_DIR ?? (process.env.HOME ? `${process.env.HOME}/.tea-rags-mcp` : null);
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

function writeCalibrationCache(model: string, device: string, batchSize: number): void {
  const path = calibrationCachePath();
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ model, device, batchSize }), "utf-8");
  } catch {
    // non-fatal
  }
}

async function runProbe(pipeline: Pipeline, model: string, device: string): Promise<void> {
  const cachedSize = readCalibrationCache(model, device);
  if (cachedSize !== null) {
    console.error(`[ONNX] Calibration cache hit: batchSize=${cachedSize}`);
    post({ type: "calibrated", batchSize: cachedSize });
    return;
  }

  console.error("[ONNX] Running GPU batch size calibration...");
  // Use diverse texts to simulate real workload — identical texts let GPU cache aggressively
  const probeTexts = [
    "export class UserService { constructor(private db: Database) {} async findById(id: string) { return this.db.query('SELECT * FROM users WHERE id = ?', [id]); } }",
    "The authentication middleware validates JWT tokens and extracts user claims before passing control to route handlers.",
    "function fibonacci(n: number): number { if (n <= 1) return n; return fibonacci(n - 1) + fibonacci(n - 2); }",
    "import { useState, useEffect } from 'react'; export default function App() { const [data, setData] = useState(null); useEffect(() => { fetch('/api').then(r => r.json()).then(setData); }, []); }",
    "CREATE TABLE orders (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), total DECIMAL(10,2), created_at TIMESTAMP DEFAULT NOW());",
    "async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> { for (let i = 0; i < maxRetries; i++) { try { return await fn(); } catch (e) { if (i === maxRetries - 1) throw e; await sleep(Math.pow(2, i) * 1000); } } throw new Error('unreachable'); }",
    "# Configuration Guide\n\nSet environment variables before starting the server. Required: `DATABASE_URL`, `API_KEY`. Optional: `LOG_LEVEL` (default: info), `PORT` (default: 3000).",
    "describe('PaymentProcessor', () => { it('should charge the correct amount', async () => { const processor = new PaymentProcessor(mockGateway); const result = await processor.charge(100, 'USD'); expect(result.success).toBe(true); }); });",
  ];
  let bestMsPerText = Infinity;
  let calibratedSize = DEFAULT_GPU_BATCH_SIZE;

  for (const bs of PROBE_BATCH_SIZES) {
    const texts = Array.from({ length: bs }, (_, i) => probeTexts[i % probeTexts.length]);
    try {
      const start = performance.now();
      await pipeline(texts, { pooling: "mean", normalize: true });
      const elapsed = performance.now() - start;
      const msPerText = elapsed / bs;

      console.error(`[ONNX] Probe bs=${bs}: ${elapsed.toFixed(0)}ms total, ${msPerText.toFixed(1)}ms/text`);

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

async function handleInit(model: string, cacheDir?: string, device?: string): Promise<void> {
  const { baseModel, dtype } = parseModelSpec(model);
  const resolvedDevice = detectDevice(device);

  try {
    const { pipeline, env } = await importTransformers();

    const resolvedCacheDir = process.env.HF_CACHE_DIR ?? cacheDir;
    if (resolvedCacheDir) env.cacheDir = resolvedCacheDir;

    const label = dtype ? `${baseModel} (${dtype})` : baseModel;
    console.error(`[ONNX] Loading model ${label} [${resolvedDevice}]...`);
    console.error(`[ONNX] Cache dir: ${env.cacheDir}`);

    const pipelineOpts: Record<string, unknown> = {
      session_options: {
        graphOptimizationLevel: "all",
        enableCpuMemArena: true,
        enableMemPattern: true,
        ...(resolvedDevice === "webgpu" ? { enableGraphCapture: true } : {}),
        extra: {
          optimization: { enable_gelu_approximation: "1" },
          session: { set_denormal_as_zero: "1" },
        },
      },
    };
    if (dtype) pipelineOpts.dtype = dtype;
    if (resolvedDevice !== "cpu") pipelineOpts.device = resolvedDevice;

    extractor = await loadPipeline(pipeline, baseModel, pipelineOpts);

    console.error(`[ONNX] Model loaded on ${resolvedDevice}.`);

    // Warm-up: prime GPU caches and JIT before accepting real work
    try {
      await extractor(["warm-up"], { pooling: "mean", normalize: true });
      console.error("[ONNX] Warm-up complete.");
    } catch {
      // non-fatal
    }

    post({ type: "ready" });

    // Fire-and-forget: calibrate GPU batch size in background (queued to avoid GPU contention)
    embedQueue = embedQueue.then(() => runProbe(extractor!, model, resolvedDevice));
  } catch (error: unknown) {
    const raw = error instanceof Error ? error.message : String(error);
    const isAuthError = raw.includes("Unauthorized") || raw.includes("401") || raw.includes("403");
    const message = isAuthError ? formatAuthError(baseModel) : raw;
    post({ type: "error", id: -1, message });
  }
}

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

port?.on("message", (msg: WorkerRequest) => {
  switch (msg.type) {
    case "init":
      void handleInit(msg.model, msg.cacheDir, msg.device);
      break;
    case "embed":
      embedQueue = embedQueue.then(async () => handleEmbed(msg.id, msg.texts));
      break;
    case "terminate":
      process.exit(0);
  }
});
