/** Messages from main thread to worker */
export type WorkerRequest =
  | { type: "init"; model: string; cacheDir?: string; device?: string }
  | { type: "embed"; id: number; texts: string[] }
  | { type: "terminate" };

/** Messages from worker to main thread */
export type WorkerResponse =
  | { type: "ready"; dimensions?: number; contextLength?: number }
  /** The model load (the "init" request) failed — the terminal alternative to
   *  "ready". Not an "error": those answer an embed request id, and an init
   *  failure has none (bd tea-rags-mcp-a3wk). */
  | { type: "initFailed"; message: string }
  | { type: "calibrated"; batchSize: number }
  | { type: "result"; id: number; embeddings: number[][]; durationMs: number }
  | { type: "error"; id: number; message: string }
  | { type: "log"; level: "error" | "info"; message: string };
