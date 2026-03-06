/**
 * Worker thread for ONNX embedding inference.
 *
 * Runs @huggingface/transformers pipeline off the main thread so the
 * event loop stays unblocked during heavy inference.
 *
 * Uses WebGPU device (Metal on macOS, D3D12 on Windows, Vulkan on Linux).
 */

import { parentPort } from "node:worker_threads";

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

let extractor: Pipeline | null = null;

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

async function handleInit(model: string, cacheDir?: string): Promise<void> {
  const { baseModel, dtype } = parseModelSpec(model);
  try {
    // Dynamic import of optional dependency — type annotation requires import() syntax
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    let transformers: typeof import("@huggingface/transformers");
    try {
      transformers = await import("@huggingface/transformers");
    } catch {
      throw new Error(
        "ONNX provider requires additional packages. Install them with:\n" +
          "  npm install @huggingface/transformers@next",
      );
    }

    const { pipeline, env } = transformers;

    const resolvedCacheDir = process.env.HF_CACHE_DIR ?? cacheDir;
    if (resolvedCacheDir) {
      env.cacheDir = resolvedCacheDir;
    }

    const label = dtype ? `${baseModel} (${dtype})` : baseModel;

    console.error(`[ONNX] Loading model ${label} [webgpu]...`);
    console.error(`[ONNX] Cache dir: ${env.cacheDir}`);

    const pipelineOpts: Record<string, string> = { device: "webgpu" };
    if (dtype) pipelineOpts.dtype = dtype;

    extractor = (await pipeline("feature-extraction", baseModel, pipelineOpts)) as unknown as Pipeline;

    console.error(`[ONNX] Model loaded.`);
    post({ type: "ready" });
  } catch (error: unknown) {
    const raw = error instanceof Error ? error.message : String(error);
    const message =
      raw.includes("Unauthorized") || raw.includes("401") || raw.includes("403")
        ? `Model access denied: ${baseModel}. This model may require authentication.\n` +
          `  Set the HF_TOKEN environment variable: export HF_TOKEN=hf_your_token\n` +
          `  Get your token at: https://huggingface.co/settings/tokens`
        : raw;
    post({ type: "error", id: -1, message });
  }
}

async function handleEmbed(id: number, texts: string[]): Promise<void> {
  if (!extractor) {
    post({ type: "error", id, message: "Worker not initialized" });
    return;
  }

  try {
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    const embeddings = output.tolist();
    post({ type: "result", id, embeddings });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: "error", id, message });
  }
}

parentPort!.on("message", (msg: WorkerRequest) => {
  switch (msg.type) {
    case "init":
      void handleInit(msg.model, msg.cacheDir);
      break;
    case "embed":
      void handleEmbed(msg.id, msg.texts);
      break;
    case "terminate":
      process.exit(0);
      break;
  }
});
