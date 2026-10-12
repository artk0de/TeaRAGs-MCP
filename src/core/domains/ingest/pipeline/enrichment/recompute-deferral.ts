/**
 * RecomputeProviderDeferral — the providers a `--force-enrichments` sync leg
 * leaves to the recompute that follows it in the same operation
 * (bd tea-rags-mcp-b4drg).
 *
 * `IndexingOps#recomputeEnrichments` runs an ordinary incremental first, then
 * `EnrichmentCoordinator#recomputeEnrichments`, whose forced provider repair
 * re-extracts every eligible file of its scope (bd tea-rags-mcp-cneu7) and
 * whose run finalizes and completes the collection for the selected providers.
 * Whatever the sync leg did for those providers — per-file extraction of the
 * changed files, their finalize, the codegraph heal, the collection completion
 * — the recompute redoes from scratch. Only that caller builds one; MCP
 * `index_codebase` and the auto-updater pass none and enrich every provider.
 *
 * The recompute's SCOPE is its `--languages` plus the paths the sync leg hands
 * over (bd tea-rags-mcp-zdg3y). A path the languages do not reach — a changed
 * `.md` under `--languages typescript,ruby`, a drifted file of another
 * language — used to decline the whole deferral, and since nearly every real
 * change set carries a doc or config file, that reinstated the double pass the
 * deferral exists to remove. Now the sync leg records such a path in
 * {@link RecomputeHandedOverPaths} and the recompute admits it by name, so
 * every file is enriched for a deferred provider exactly once, by the
 * recompute. {@link recomputeScopeCoversPath} is the one predicate both sides
 * judge membership by.
 */

import { anyOfOnTextIndexed, type TextIndexedAnyOf } from "../../../../adapters/qdrant/filters/text-indexed-exact.js";
import { detectLanguage } from "../chunker/language-config/index.js";

/**
 * The relative paths a `--force-enrichments` sync leg left to the recompute
 * although the recompute's languages do not reach them. Created by
 * `IndexingOps#recomputeEnrichments`, filled by the sync leg
 * (`EnrichmentCoordinator#resolveRecomputeDeferredProviderKeys` for the work
 * set, `EnrichmentCoordinator#runRepairPass` for drifted paths), then handed to
 * `EnrichmentCoordinator#recomputeEnrichments` as explicit extra scope.
 */
export type RecomputeHandedOverPaths = Set<string>;

export interface RecomputeProviderDeferral {
  /** The recompute's provider selectors, resolved by the coordinator against its providers. */
  readonly selectors: readonly string[];
  /** The languages the recompute covers; empty covers every language. */
  readonly languages: readonly string[];
  /** Filled by the sync leg with every path it leaves to the recompute outside `languages`. */
  readonly handedOverRelPaths: RecomputeHandedOverPaths;
}

/**
 * A sync leg's deferral as `EnrichmentCoordinator#runRepairPass` applies it:
 * the provider keys it resolved to, and the recompute's scope. A deferred
 * provider's drift repair still PRUNES orphans — the recompute's
 * selector-forced repair never does — but walks nothing: a drifted path the
 * languages do not reach is handed over through `handedOverRelPaths`. The one
 * remaining decline is a handed-off recovery chunk (bd tea-rags-mcp-fxio5),
 * which needs THIS run's walk and seed; `onDeclined` tells the caller, which
 * must then enrich and complete that provider in the sync leg's own run.
 */
export interface RepairPassRecomputeDeferral {
  readonly providerKeys: ReadonlySet<string>;
  readonly languages: readonly string[];
  readonly handedOverRelPaths: RecomputeHandedOverPaths;
  readonly onDeclined: (providerKey: string) => void;
}

/**
 * Whether a recompute restricted to `languages` (empty = every language) and
 * extended by `handedOverRelPaths` reaches `relPath`. ONE predicate for both
 * sides: the recompute's forced repair narrows the working-tree scan with it
 * (`EnrichmentCoordinator#recomputeEnrichments`), and the sync leg hands over
 * every path it rejects (`handOverUncoveredPaths`).
 */
export function recomputeScopeCoversPath(
  languages: readonly string[] | undefined,
  handedOverRelPaths: ReadonlySet<string> | undefined,
  relPath: string,
): boolean {
  return (
    !languages ||
    languages.length === 0 ||
    languages.includes(detectLanguage(relPath)) ||
    (handedOverRelPaths?.has(relPath) ?? false)
  );
}

type RecomputeLanguageCondition = { key: "language"; match: { any: string[] } };

/** The `must` part of a recompute's point filter; `{}` when it covers every point. */
export type RecomputeScopePointFilter = {
  must?: [RecomputeLanguageCondition] | [{ should: [RecomputeLanguageCondition, TextIndexedAnyOf] }];
};

/**
 * {@link recomputeScopeCoversPath} as a Qdrant point filter, for the reads and
 * writes the recompute narrows server-side (its scroll and its skip-stamp
 * retirement). An EMPTY language list means "no restriction" — `match:
 * { any: [] }` selects nothing in Qdrant, which would turn the run into a
 * silent no-op that still reports success. Handed-over paths join the language
 * condition as an OR branch, as text-indexed exact pairs (`anyOfOnTextIndexed`)
 * rather than a `relativePath` MatchAny scan.
 */
export function recomputeScopePointFilter(
  languages: readonly string[] | undefined,
  handedOverRelPaths: ReadonlySet<string> | undefined,
): RecomputeScopePointFilter {
  if (!languages || languages.length === 0) return {};
  const languageCondition: RecomputeLanguageCondition = { key: "language", match: { any: [...languages] } };
  if (!handedOverRelPaths || handedOverRelPaths.size === 0) return { must: [languageCondition] };
  return { must: [{ should: [languageCondition, anyOfOnTextIndexed("relativePath", [...handedOverRelPaths])] }] };
}

/**
 * Record in `handedOverRelPaths` every path the recompute's scope does not
 * reach yet. Returns how many were added.
 */
export function handOverUncoveredPaths(
  languages: readonly string[],
  handedOverRelPaths: RecomputeHandedOverPaths,
  relPaths: Iterable<string>,
): number {
  let added = 0;
  for (const relPath of relPaths) {
    if (recomputeScopeCoversPath(languages, handedOverRelPaths, relPath)) continue;
    handedOverRelPaths.add(relPath);
    added++;
  }
  return added;
}
