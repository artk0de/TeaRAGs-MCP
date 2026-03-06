/**
 * Worker thread for ONNX embedding inference.
 *
 * Runs @huggingface/transformers pipeline off the main thread so the
 * event loop stays unblocked during heavy inference.
 */

import { parentPort } from "node:worker_threads";

import { buildPipelineOptions, patchInferenceSession } from "./coreml.js";
import type { WorkerRequest, WorkerResponse } from "./worker-types.js";

type Pipeline = (texts: string[], options: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>;

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

const MIN_BATCH_SIZE = 4;
const INITIAL_BATCH_SIZE = 32;

let extractor: Pipeline | null = null;
let maxBatchSize: number | null = null;

function post(msg: WorkerResponse): void {
  parentPort!.postMessage(msg);
}

// Forward console.error to main thread
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  post({ type: "log", level: "error", message });
  originalConsoleError.apply(console, args);
};

async function handleInit(model: string, cacheDir?: string, device?: string): Promise<void> {
  try {
    const { baseModel, dtype } = parseModelSpec(model);
    const { pipeline, env } = await import("@huggingface/transformers");

    const resolvedCacheDir = process.env.HF_CACHE_DIR ?? cacheDir;
    if (resolvedCacheDir) {
      env.cacheDir = resolvedCacheDir;
    }

    const label = dtype ? `${baseModel} (${dtype})` : baseModel;
    const deviceLabel = device ?? "cpu";

    // CoreML: patch onnxruntime-node to inject CoreMLExecutionProvider
    let restorePatch: (() => void) | undefined;
    if (device === "coreml") {
      const ort = await import("onnxruntime-node");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const IS = (ort as any).InferenceSession ?? (ort as any).default?.InferenceSession;
      restorePatch = patchInferenceSession(IS);
    }

    console.error(`[ONNX] Loading model ${label} [${deviceLabel}]... (first time, may download ~70MB)`);
    console.error(`[ONNX] Cache dir: ${env.cacheDir}`);

    const pipelineDevice = device === "coreml" ? undefined : device;
    const pipelineOpts = buildPipelineOptions(dtype, pipelineDevice);
    extractor = (await pipeline("feature-extraction", baseModel, pipelineOpts)) as unknown as Pipeline;

    restorePatch?.();
    console.error(`[ONNX] Model loaded.`);
    post({ type: "ready" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: "error", id: -1, message });
  }
}

async function handleEmbed(id: number, texts: string[]): Promise<void> {
  if (!extractor) {
    post({ type: "error", id, message: "Worker not initialized" });
    return;
  }

  try {
    const batchSize = maxBatchSize ?? INITIAL_BATCH_SIZE;
    const allEmbeddings: number[][] = [];
    let i = 0;

    while (i < texts.length) {
      const currentBatch = maxBatchSize ?? batchSize;
      const chunk = texts.slice(i, i + currentBatch);
      try {
        const output = await extractor(chunk, { pooling: "mean", normalize: true });
        const vectors = output.tolist();
        allEmbeddings.push(...vectors);
        i += chunk.length;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        const prev = maxBatchSize ?? chunk.length;
        if (prev <= MIN_BATCH_SIZE) throw error;
        maxBatchSize = Math.max(MIN_BATCH_SIZE, Math.floor(prev / 2));
        console.error(`[ONNX] Batch of ${prev} failed (${msg}), reducing to ${maxBatchSize}`);
      }
    }

    post({ type: "result", id, embeddings: allEmbeddings });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: "error", id, message });
  }
}

parentPort!.on("message", (msg: WorkerRequest) => {
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
