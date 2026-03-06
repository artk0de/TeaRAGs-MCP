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
