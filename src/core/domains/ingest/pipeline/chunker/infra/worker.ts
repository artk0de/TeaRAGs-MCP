/**
 * Chunker worker thread entry point — the SECOND composition root (spec §5),
 * relocated next to the `ChunkerPool` inside `domains/ingest` (it spawns the
 * thread, so the entry is its ingest-local sibling).
 *
 * A worker thread cannot receive the main process's DI graph (functions /
 * native handles are not structured-cloneable across `postMessage`), so the
 * chunker engine is wired HERE, symmetric to the main composition root. The
 * engine needs three things the leaf `domains/language` domain owns — the
 * concrete `LanguageFactoryImpl`, the `DefaultSymbolIdComposer`, and the native
 * `RubyLanguage` provider (built by the factory). `domains/ingest` MUST NOT
 * import `domains/language` (eslint leaf-domain guard), so they are loaded at
 * RUNTIME via a dynamic `import(path)` where `path` is an injected string
 * (`ChunkerConfig.languageModulePath`, threaded through `workerData` by the
 * composition root). A runtime variable path is invisible to the import guard —
 * NO static import, NO exemption. ALL languages are native `domains/language/<lang>`
 * providers built by the factory itself. See `.claude/rules/domain-boundaries.md`
 * + spec §5.
 *
 * Each worker thread creates its own `TreeSitterChunker` with independent
 * Parser instances (tree-sitter native bindings are per-thread).
 *
 * Protocol (`./worker-protocol.ts`):
 *   Receives: WorkerRequest { filePath, code, language }
 *   Returns:  WorkerResponse { filePath, chunks, error? }
 */

import { parentPort, workerData } from "node:worker_threads";

import type {
  LanguageFactory,
  SymbolIdComposer,
} from "../../../../../contracts/types/language.js";
import type { ChunkerConfig } from "../../../../../types.js";
import { TreeSitterChunker } from "../tree-sitter.js";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol.js";

/**
 * Runtime shape of the dynamically-imported `domains/language` barrel. Typed
 * against the `contracts/` interfaces only — never the concrete classes — so
 * this file carries no static `domains/language` dependency. The composition
 * layer guarantees these exports exist (`domains/language/index.ts`).
 */
interface LanguageModule {
  LanguageFactoryImpl: new () => LanguageFactory;
  DefaultSymbolIdComposer: new () => SymbolIdComposer;
}

/**
 * Build the chunker engine in-thread. Loads the concrete language module from
 * the injected path, constructs the factory (which builds every native language
 * provider itself), and wires the engine. The `ambiguousResolveMode` is
 * irrelevant here — the worker only chunks, never invokes a codegraph resolver —
 * so the factory is constructed with no options.
 */
async function buildChunker(config: ChunkerConfig): Promise<TreeSitterChunker> {
  if (!config.languageModulePath) {
    // Programming error: the pool composition root must inject the path. The
    // worker cannot import the module statically, so there is no fallback.
    throw new Error("ChunkerConfig.languageModulePath is required in the worker thread");
  }
  const lang = (await import(config.languageModulePath)) as LanguageModule;
  const languageFactory = new lang.LanguageFactoryImpl();
  return new TreeSitterChunker(config, new lang.DefaultSymbolIdComposer(), languageFactory);
}

if (parentPort) {
  const config = workerData as ChunkerConfig;
  // Build the engine once per thread. The async load is awaited before the
  // first request is serviced: requests that arrive during load queue behind
  // the promise, preserving order.
  const chunkerPromise = buildChunker(config);

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
        const chunker = await chunkerPromise;
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
