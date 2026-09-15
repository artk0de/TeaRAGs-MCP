/**
 * EnrichmentRunSpec — what an enrichment run is asked to do, stated by the caller
 * that opens it (bd tea-rags-mcp-39xca.3).
 *
 * It replaces `beginRun`'s positional parameters, whose defaults let a call site
 * say nothing and still open a run: a run that never named its scope became a
 * `subset` over every language, which is right for a reindex and wrong for
 * anything else. Each entry point that opens a run has a factory below, so that
 * choice is made once, where it is true.
 */

import type { Ignore } from "ignore";

import type { PhysicalCollectionName } from "../../../../contracts/types/collection-identity.js";
import type { EnrichmentRunCoverage } from "../../../../contracts/types/provider.js";

/**
 * The languages a run is judged on when it spans the whole collection. A value
 * a caller passes on purpose, never what an omitted field turns into: the
 * terminal unenriched count covers exactly the run's languages
 * (bd tea-rags-mcp-9dg6s).
 */
export const ALL_LANGUAGES: readonly string[] = Object.freeze([]);

/**
 * What part of the corpus the run resolves, over which languages. `wholeCorpus`
 * only when the run is fed EVERY file of the languages it walks: codegraph lets
 * such a run replace a language's persisted resolve breakdown, where a subset's
 * batch-sized tally must not (bd tea-rags-mcp-xpmwg).
 */
export type EnrichmentRunScope =
  | { readonly kind: "wholeCorpus"; readonly languages: readonly string[] }
  | { readonly kind: "subset"; readonly languages: readonly string[] };

export interface EnrichmentRunSpec {
  /** Project root; each provider resolves its effective root from it. */
  readonly absolutePath: string;
  /** The collection the run writes: its markers, heartbeat and release key. */
  readonly collection: PhysicalCollectionName;
  readonly scope: EnrichmentRunScope;
  /** yl9tv Task 5b: the chunk pass feeds codegraph its extractions. */
  readonly crossPass: boolean;
  /** Files the run streams: the file-level progress denominator and the fan-out width. */
  readonly fileCount: number;
  /** Restrict the run to these providers; omitted means every registered provider. */
  readonly onlyProviderKeys?: readonly string[];
  /**
   * The run's per-file SHA256, for a caller that computed it itself rather than
   * through `runRepairPass` (bd tea-rags-mcp-o317j). Omitted leaves whatever the
   * repair pass captured in place; it never clears it.
   */
  readonly contentHashes?: ReadonlyMap<string, string>;
  readonly ignoreFilter?: Ignore;
}

/** A run's coverage is its scope's kind — derived, never set beside it, so the two cannot disagree. */
export function runCoverageOf(scope: EnrichmentRunScope): EnrichmentRunCoverage {
  return scope.kind;
}

/** What every pipeline run knows before its subclass decides the rest. */
export interface StreamedEnrichmentRunInput {
  absolutePath: string;
  collection: PhysicalCollectionName;
  fileCount: number;
  ignoreFilter?: Ignore;
  contentHashes?: ReadonlyMap<string, string>;
}

/** Full index or `--force`: every scanned file streams, so the run covers the whole corpus. */
export function fullIndexRunSpec(input: StreamedEnrichmentRunInput & { crossPass: boolean }): EnrichmentRunSpec {
  return { ...input, scope: { kind: "wholeCorpus", languages: ALL_LANGUAGES } };
}

/** Incremental reindex: only the delta streams — a subset, judged on the whole collection. */
export function reindexRunSpec(input: StreamedEnrichmentRunInput): EnrichmentRunSpec {
  return { ...input, crossPass: false, scope: { kind: "subset", languages: ALL_LANGUAGES } };
}

/** `--force-enrichments`: every stored point of the selected languages is fed back through the run. */
export function recomputeRunSpec(input: {
  absolutePath: string;
  collection: PhysicalCollectionName;
  fileCount: number;
  onlyProviderKeys: readonly string[];
  languages: readonly string[];
}): EnrichmentRunSpec {
  const { languages, ...rest } = input;
  return { ...rest, crossPass: false, scope: { kind: "wholeCorpus", languages } };
}

/** A reindex whose only work was the repair pass: nothing streams, the run only closes. */
export function finalizeOnlyRunSpec(input: {
  absolutePath: string;
  collection: PhysicalCollectionName;
}): EnrichmentRunSpec {
  return { ...input, crossPass: false, fileCount: 0, scope: { kind: "subset", languages: ALL_LANGUAGES } };
}
