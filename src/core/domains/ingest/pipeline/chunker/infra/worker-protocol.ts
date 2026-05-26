/**
 * Worker thread message protocol for the chunker pool.
 *
 * Pure structurally-cloneable types — no runtime, no `domains/language`
 * import — so both the ingest-side `ChunkerPool` (which dispatches requests)
 * and the `api/internal/` worker composition root (which constructs the
 * engine) can share them without crossing a layer boundary the wrong way.
 *
 * The worker ENTRY (concrete wiring: chunker engine + `SymbolIdComposer`)
 * lives in `api/internal/chunker-worker.ts` per spec §5 — `domains/ingest`
 * may not import `domains/language` (eslint leaf-domain guard), so the
 * composition that needs the concrete composer cannot live here.
 */

import type { CodeChunk } from "../../../../../types.js";

export interface WorkerRequest {
  filePath: string;
  code: string;
  language: string;
}

export interface WorkerResponse {
  filePath: string;
  chunks: CodeChunk[];
  error?: string;
}
