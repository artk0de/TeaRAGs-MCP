/**
 * The extraction pass-runner (E1 seam 0, bd tea-rags-mcp-pss0q) — the one
 * mechanism every language uses to add an extraction facet, and the first
 * component the Ruby and Python verticals visibly share.
 *
 * Model A (`docs/superpowers/specs/2026-06-18-plugin-system-design.md`, key
 * decision 5): the native walker runs FIRST and unchanged, then an ordered list
 * of passes, each returning a `Partial<FileExtraction>` that `mergeExtraction`
 * folds in append-only. A monolith is never re-sliced to add a facet — the facet
 * is a new pass. That is what keeps wiring an existing language through here a
 * relocation: with an EMPTY pass list `composeExtractionWalker(...).walk(input)`
 * returns the native walker's own object BY IDENTITY, so nothing downstream can
 * tell the difference, not even a JSON comparison of the spilled payload.
 *
 * The pass list is a static export of the language module
 * (`<lang>/walker/passes.ts`, composed in `<lang>/index.ts`) and never an
 * injected argument: nothing crosses `postMessage` as an object, and both
 * AST-walking workers reach a language by `import(modulePath)` in-thread
 * (`.claude/rules/domains-language.md` §2).
 */

import type { AstNode } from "../../../contracts/types/ast.js";
import type { FileExtraction } from "../../../contracts/types/codegraph.js";
import type { ExtractionPass, LanguageWalker, WalkContext, WalkInput } from "../../../contracts/types/language.js";
import { mergeExtraction } from "./merge-extraction.js";

/**
 * An `ExtractionPass` that contributes to one file's `FileExtraction`.
 *
 * Not to be confused with `FileExtractionPass1Telemetry`
 * (`contracts/types/provider.ts`), which is about PASS 1 of the codegraph's
 * two-pass RUN. This is a pass over a single file's AST.
 */
export type ExtractionFacetPass = ExtractionPass<Partial<FileExtraction>>;

/**
 * Fold every pass's partial into the native extraction, in list order, so a later
 * pass merges onto what earlier passes already produced. Returns `native`
 * untouched — by identity — when there are no passes.
 */
export function runExtractionPasses(
  native: FileExtraction,
  passes: readonly ExtractionFacetPass[],
  root: AstNode,
  ctx: WalkContext,
): FileExtraction {
  if (passes.length === 0) return native;
  let merged = native;
  for (const pass of passes) {
    merged = mergeExtraction(merged, pass.run(root, ctx));
  }
  return merged;
}

/**
 * Project a `WalkInput` onto the context passes receive — everything but the
 * parsed tree, which they get as a root node instead.
 *
 * `dispatchTableNames` is deliberately left ABSENT: it is the one data dependency
 * between facets INSIDE a native walker (the table pass feeding the call pass),
 * and the native monolith owns it. A pass that needs it re-derives it.
 */
export function toWalkContext(input: WalkInput): WalkContext {
  const ctx: WalkContext = {
    code: input.code,
    relPath: input.relPath,
    language: input.language,
    chunks: input.chunks,
  };
  // Assigned only when present: an absent key and an explicit `undefined` read
  // the same to a consumer, but only the absent key keeps the shape a run with
  // no Gemfile would have had.
  if (input.gemfileContent !== undefined) {
    ctx.gemfileContent = input.gemfileContent;
  }
  return ctx;
}

/** The pieces a language supplies to build its `LanguageWalker`. */
export interface ExtractionWalkerParts {
  /** The language's native extraction monolith, unchanged. */
  walk: (input: WalkInput) => FileExtraction;
  /** The language's node → symbol descriptor mapping, passed through as-is. */
  nameOf: LanguageWalker["nameOf"];
  /** Ordered extra facets. Empty for a language that has not pulled on one yet. */
  passes: readonly ExtractionFacetPass[];
}

/**
 * Build the `LanguageWalker` a provider exposes: the native walk, then the
 * passes. With no passes the native result is returned directly and no
 * `WalkContext` is even allocated — the zero-pass path costs nothing per file.
 */
export function composeExtractionWalker(parts: ExtractionWalkerParts): LanguageWalker {
  return {
    walk: (input) => {
      const native = parts.walk(input);
      if (parts.passes.length === 0) return native;
      return runExtractionPasses(native, parts.passes, input.tree.rootNode, toWalkContext(input));
    },
    nameOf: parts.nameOf,
  };
}
