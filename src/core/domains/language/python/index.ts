/**
 * `PythonLanguage` — the native per-language facade for Python, the fourth
 * vertical migrated off the composition-root legacy adapter into
 * `domains/language/` (spec §2, §4; bd tea-rags-mcp-cen6, following ruby +
 * typescript + javascript). Thin: it composes the four capability sub-modules,
 * all of which are pure module-level logic + config that any instance merely
 * references.
 *
 *   kernel        ← ./kernel.ts            (parser load, scopeSeparator ".", detection)
 *   chunkerHooks  ← (inline below)         (generic chunking — NO language-specific
 *                                           hooks; Python's LANGUAGE_DEFINITIONS
 *                                           entry declares none)
 *   walker        ← ./walker/              (extractFromPythonFile + pyNameOf)
 *   resolver      ← ./resolver/            (PythonCallResolver — module-path mapping)
 *
 * Created per-context by `LanguageFactoryDescriptor` (each owns its own tree-sitter
 * `Parser`, spec §5). The capability logic here is stateless, so the only
 * per-instance cost is the Parser the chunker/codegraph engines build.
 *
 * Unlike the JavaScript vertical, Python has NO `chunkSymbols` capability and NO
 * `hooks[]` chain — its `LANGUAGE_DEFINITIONS.python` entry uses the generic
 * chunker driven solely by `chunkableTypes` / `childChunkTypes` /
 * `alwaysExtractChildren` (with `decorated_definition` covering
 * `@classmethod`/`@staticmethod` methods, unwrapped by
 * `tree-sitter.ts:unwrapDecoratedDefinition`). One grammar, one extension: `.py`
 * maps to language "python" (`LANGUAGE_MAP`) and both the chunker and codegraph
 * engines share the single `tree-sitter-python` grammar.
 *
 * symbolId coverage convergence: the chunker emits the class/method shapes via
 * the generic chunker (engine `tree-sitter.ts`), while the codegraph emits them
 * via `walker.nameOf` (`pyNameOf`). Both route instance/static classification
 * through `classifyMethod`, so they stay in lockstep per
 * `.claude/rules/symbolid-convention.md`.
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type DispatchEdge,
  type FileExtraction,
  type SymbolResolutionTarget,
} from "../../../contracts/types/codegraph.js";
import type {
  LanguageChunkerHooks,
  LanguageProvider,
  LanguageSymbolResolver,
  LanguageWalker,
} from "../../../contracts/types/language.js";
import { pythonKernel } from "./kernel.js";
import { PythonCallResolver } from "./resolver/index.js";
import { pyNameOf } from "./walker/name-of.js";
import { extractFromPythonFile, type PythonExtractInput } from "./walker/walker.js";

/**
 * Chunk-boundary config for Python — mirrors the chunker slice of the legacy
 * `LANGUAGE_DEFINITIONS.python` entry 1:1 (chunkableTypes, childChunkTypes,
 * alwaysExtractChildren). No `hooks` / `nameExtractor` / `keepShortChildChunkTypes`
 * / `macroSymbols` / `chunkSymbols` — Python declares none (generic chunking,
 * driven by node types alone). `decorated_definition` in both chunkable + child
 * type lists covers `@classmethod`/`@staticmethod` methods; the engine unwraps
 * them for name + static detection (bd tea-rags-mcp-t6sr).
 */
const pythonChunkerHooks: LanguageChunkerHooks = {
  chunkableTypes: ["function_definition", "class_definition", "decorated_definition"],
  childChunkTypes: ["function_definition", "decorated_definition"],
  alwaysExtractChildren: true,
};

/**
 * Native Python `LanguageProvider`. Construction is cheap — the resolver is a
 * pure object (no codegraph / tsconfig deps, unlike TypeScript); the chunker
 * worker simply never invokes it. `mode` controls ambiguous-resolution
 * behaviour, matching the legacy adapter's `PythonCallResolver` default.
 */
export class PythonLanguage implements LanguageProvider {
  readonly kernel = pythonKernel;
  readonly chunkerHooks: LanguageChunkerHooks = pythonChunkerHooks;
  readonly walker: LanguageWalker = {
    walk: (input) => extractFromPythonFile(input),
    nameOf: (node) => pyNameOf(node),
  };
  readonly resolver: LanguageSymbolResolver;

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const callResolver: CallResolver = new PythonCallResolver(mode);
    this.resolver = {
      resolve: (call: CallRef, ctx: CallContext): SymbolResolutionTarget | null => callResolver.resolve(call, ctx),
      resolveDispatch: (call: CallRef, ctx: CallContext): DispatchEdge[] =>
        callResolver.resolveDispatch?.(call, ctx) ?? [],
      targetsExternalImport: (call: CallRef, ctx: CallContext): boolean =>
        callResolver.targetsExternalImport?.(call, ctx) ?? false,
    };
  }
}

export { pythonKernel } from "./kernel.js";
export { extractFromPythonFile, pyNameOf } from "./walker/index.js";
export { PythonCallResolver, mapPythonImportToFile } from "./resolver/index.js";
export type { FileExtraction, PythonExtractInput };
