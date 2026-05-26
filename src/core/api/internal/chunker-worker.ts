/**
 * Chunker worker thread entry point — the SECOND composition root (spec §5).
 *
 * A worker thread cannot receive the main process's DI graph (functions /
 * native handles are not structured-cloneable across `postMessage`), so the
 * chunker engine is wired here, symmetric to the main composition root. This
 * entry lives in `api/internal/` (the composition layer) — NOT in
 * `domains/ingest/` — because it imports BOTH the chunker engine (from ingest;
 * api→domain is allowed) AND the concrete `DefaultSymbolIdComposer` (from
 * `domains/language`; api→domain is allowed). Keeping the wiring here is what
 * lets the `no-restricted-imports` leaf-domain guard stay exception-free:
 * `domains/ingest` never touches `domains/language`. See
 * `.claude/rules/domain-boundaries.md` + spec §5.
 *
 * Each worker thread creates its own `TreeSitterChunker` with independent
 * Parser instances (tree-sitter native bindings are per-thread).
 *
 * Protocol (`chunker/infra/worker-protocol.ts`):
 *   Receives: WorkerRequest { filePath, code, language }
 *   Returns:  WorkerResponse { filePath, chunks, error? }
 */

import { parentPort, workerData } from "node:worker_threads";

import type { ChunkerConfig } from "../../types.js";
import type {
  WorkerRequest,
  WorkerResponse,
} from "../../domains/ingest/pipeline/chunker/infra/worker-protocol.js";
import { TreeSitterChunker } from "../../domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactoryImpl } from "../../domains/language/index.js";
import { buildLegacyLanguageRegistry } from "./legacy-language-adapter.js";

if (parentPort) {
  const config = workerData as ChunkerConfig;
  // The worker is a SECOND composition root (spec §5): functions / native
  // handles can't cross the `postMessage` boundary, so the LanguageFactory is
  // built HERE rather than received from the main process. The chunker needs no
  // codegraph resolvers — the registry serves walker/chunker capabilities only.
  const languageFactory = new LanguageFactoryImpl(buildLegacyLanguageRegistry());
  const chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), languageFactory);

  parentPort.on("message", (msg: WorkerRequest | { type: "shutdown" }) => {
    // Graceful shutdown: close the port so the thread exits cleanly,
    // letting tree-sitter NAPI destructors run in the correct thread
    // instead of crashing with libc++abi when worker.terminate() kills it.
    if ("type" in msg && msg.type === "shutdown") {
      parentPort?.close();
      return;
    }

    const request = msg as WorkerRequest;
    void (async () => {
      try {
        const chunks = await chunker.chunk(request.code, request.filePath, request.language);
        parentPort?.postMessage({
          filePath: request.filePath,
          chunks,
        } satisfies WorkerResponse);
      } catch (error) {
        parentPort?.postMessage({
          filePath: request.filePath,
          chunks: [],
          error: error instanceof Error ? error.message : String(error),
        } satisfies WorkerResponse);
      }
    })();
  });
}
