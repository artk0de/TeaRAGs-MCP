/**
 * Chunker worker thread entry point — the SECOND composition root (spec §5),
 * relocated next to the `ChunkerPool` inside `domains/ingest` (it spawns the
 * thread, so the entry is its ingest-local sibling).
 *
 * A worker thread cannot receive the main process's DI graph (functions /
 * native handles are not structured-cloneable across `postMessage`), so the
 * chunker engine is wired HERE, symmetric to the main composition root. The
 * engine needs three things the leaf `domains/language` domain owns — the
 * concrete `LanguageFactory`, the `DefaultSymbolIdComposer`, and the native
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
 * Parser instances. node-tree-sitter's native parse is process-globally
 * thread-unsafe (concurrent parses across threads corrupt the tree), so the
 * single-flight discipline is enforced UPSTREAM by the pool (one parse worker)
 * — not by per-thread isolation (yl9tv).
 *
 * Protocol (`./worker-protocol.ts`):
 *   Receives: WorkerRequest { filePath, code, language, emitExtraction? }
 *   Returns:  WorkerResponse { filePath, chunks, extraction?, error? }
 *
 * When `emitExtraction` is set (codegraph enabled), the worker runs the
 * language walker on the SAME parse it chunked with and returns a codegraph
 * `FileExtraction` alongside the chunks — eliminating the main-thread re-parse.
 */

import { parentPort, workerData } from "node:worker_threads";

import type { FileExtraction } from "../../../../../contracts/types/codegraph.js";
import type {
  CollectSymbolsFn,
  LanguageFactoryDescriptor,
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
  LanguageFactory: new () => LanguageFactoryDescriptor;
  DefaultSymbolIdComposer: new () => SymbolIdComposer;
  /** yl9tv — pure kernel symbol-range collector, run on the chunk parse when
   *  a request asks for a codegraph extraction. */
  collectSymbols: CollectSymbolsFn;
}

/**
 * In-thread chunker engine: the `TreeSitterChunker` plus the language
 * capabilities needed to emit a codegraph `FileExtraction` from the SAME parse
 * (yl9tv). `languageFactory.create(lang)` yields the walker + kernel config;
 * `collectSymbols` + `composer` compose the symbol ranges the walker consumes.
 */
interface ChunkerEngine {
  chunker: TreeSitterChunker;
  languageFactory: LanguageFactoryDescriptor;
  composer: SymbolIdComposer;
  collectSymbols: CollectSymbolsFn;
}

/**
 * Build the chunker engine in-thread. Loads the concrete language module from
 * the injected path, constructs the factory (which builds every native language
 * provider itself), and wires the engine. The `ambiguousResolveMode` is
 * irrelevant here — the worker only chunks, never invokes a codegraph resolver —
 * so the factory is constructed with no options.
 */
async function buildChunker(config: ChunkerConfig): Promise<ChunkerEngine> {
  if (!config.languageModulePath) {
    // Programming error: the pool composition root must inject the path. The
    // worker cannot import the module statically, so there is no fallback.
    throw new Error("ChunkerConfig.languageModulePath is required in the worker thread");
  }
  const lang = (await import(config.languageModulePath)) as LanguageModule;
  const languageFactory = new lang.LanguageFactory();
  const composer = new lang.DefaultSymbolIdComposer();
  const chunker = new TreeSitterChunker(config, composer, languageFactory);
  return { chunker, languageFactory, composer, collectSymbols: lang.collectSymbols };
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
        const engine = await chunkerPromise;
        const { chunks, tree } = await engine.chunker.chunkWithTree(request.code, request.filePath, request.language);
        // yl9tv — when codegraph is enabled the request sets `emitExtraction`;
        // run the walker on the SAME parse instead of re-parsing on the main
        // thread. `tree` is non-null iff the parse succeeded for a code
        // language; a missing walker (doc/unsupported) yields no extraction.
        let extraction: FileExtraction | undefined;
        if (request.emitExtraction && tree) {
          const provider = engine.languageFactory.create(request.language);
          const { walker, kernel } = provider;
          if (walker) {
            const symbolRanges = engine.collectSymbols(
              tree,
              walker.nameOf,
              kernel.scopeSeparator ?? ".",
              kernel.disambiguateOverloads ?? false,
              engine.composer,
            );
            extraction = walker.walk({
              tree,
              code: request.code,
              relPath: request.filePath,
              language: request.language,
              chunks: symbolRanges,
            });
          }
        }
        parentPort?.postMessage({
          filePath: request.filePath,
          chunks,
          ...(extraction ? { extraction } : {}),
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
