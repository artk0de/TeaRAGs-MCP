/**
 * Worker thread for ONNX embedding inference.
 *
 * Runs @huggingface/transformers pipeline off the main thread so the
 * event loop stays unblocked during heavy inference.
 *
 * Uses WebGPU device (Metal on macOS, D3D12 on Windows, Vulkan on Linux).
 */

import { parentPort } from "node:worker_threads";

import { detectDevice } from "./device.js";
import type { WorkerRequest, WorkerResponse } from "./worker-types.js";

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
  pipelineOpts: Record<string, string>,
  device: string,
): Promise<Pipeline> {
  try {
    return (await pipelineFn("feature-extraction", baseModel, pipelineOpts)) as Pipeline;
  } catch (gpuError: unknown) {
    if (device === "cpu") throw gpuError;

    const gpuMsg = gpuError instanceof Error ? gpuError.message : String(gpuError);
    console.error(`[ONNX] ${device} failed (${gpuMsg}), falling back to cpu`);
    delete pipelineOpts.device;
    return (await pipelineFn("feature-extraction", baseModel, pipelineOpts)) as Pipeline;
  }
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

    const pipelineOpts: Record<string, string> = {};
    if (dtype) pipelineOpts.dtype = dtype;
    if (resolvedDevice !== "cpu") pipelineOpts.device = resolvedDevice;

    extractor = await loadPipeline(pipeline, baseModel, pipelineOpts, resolvedDevice);

    console.error(`[ONNX] Model loaded.`);
    post({ type: "ready" });
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
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    post({ type: "result", id, embeddings: output.tolist() });
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
