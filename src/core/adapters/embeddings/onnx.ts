import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { EmbeddingProvider, EmbeddingResult } from "./base.js";
import type { WorkerRequest, WorkerResponse } from "./onnx/worker-types.js";

export const DEFAULT_ONNX_MODEL = "jinaai/jina-embeddings-v2-base-code-fp16";
export const DEFAULT_ONNX_DIMENSIONS = 768;

export class OnnxEmbeddings implements EmbeddingProvider {
  private readonly model: string;
  private readonly dimensions: number;
  private readonly cacheDir: string | undefined;
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private nextId = 0;

  constructor(model = DEFAULT_ONNX_MODEL, dimensions = DEFAULT_ONNX_DIMENSIONS, cacheDir?: string) {
    this.model = model;
    this.dimensions = dimensions;
    this.cacheDir = cacheDir;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const workerPath = join(dirname(fileURLToPath(import.meta.url)), "onnx", "worker.js");
    this.worker = new Worker(workerPath);

    this.worker.on("message", (msg: WorkerResponse) => {
      if (msg.type === "log") {
        console.error(msg.message);
      }
    });

    this.worker.on("exit", (code) => {
      if (code !== 0) {
        console.error(`[ONNX] Worker exited with code ${code}, will recreate on next call`);
      }
      this.worker = null;
      this.initPromise = null;
    });

    return this.worker;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    const worker = this.ensureWorker();

    this.initPromise = new Promise<void>((resolve, reject) => {
      const onMessage = (msg: WorkerResponse) => {
        if (msg.type === "ready") {
          worker.removeListener("message", onMessage);
          resolve();
        } else if (msg.type === "error" && msg.id === -1) {
          worker.removeListener("message", onMessage);
          this.initPromise = null;
          reject(new Error(msg.message));
        }
      };
      worker.on("message", onMessage);

      worker.postMessage({
        type: "init",
        model: this.model,
        cacheDir: this.cacheDir,
      } satisfies WorkerRequest);
    });

    return this.initPromise;
  }

  private async sendRequest(worker: Worker, texts: string[]): Promise<number[][]> {
    const id = this.nextId++;

    return new Promise<number[][]>((resolve, reject) => {
      const onMessage = (msg: WorkerResponse) => {
        if (msg.type === "result" && msg.id === id) {
          worker.removeListener("message", onMessage);
          resolve(msg.embeddings);
        } else if (msg.type === "error" && msg.id === id) {
          worker.removeListener("message", onMessage);
          reject(new Error(msg.message));
        }
      };
      worker.on("message", onMessage);

      worker.postMessage({
        type: "embed",
        id,
        texts,
      } satisfies WorkerRequest);
    });
  }

  async embed(text: string): Promise<EmbeddingResult> {
    await this.ensureInitialized();
    const embeddings = await this.sendRequest(this.worker!, [text]);
    return {
      embedding: embeddings[0],
      dimensions: this.dimensions,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];

    await this.ensureInitialized();
    const embeddings = await this.sendRequest(this.worker!, texts);
    return embeddings.map((embedding) => ({
      embedding,
      dimensions: this.dimensions,
    }));
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModel(): string {
    return this.model;
  }

  async terminate(): Promise<void> {
    if (!this.worker) return;

    const { worker } = this;
    const exitPromise = new Promise<void>((resolve) => {
      worker.once("exit", () => {
        resolve();
      });
    });

    worker.postMessage({ type: "terminate" } satisfies WorkerRequest);
    await exitPromise;
  }
}
