/**
 * RecomputeProviderDeferral — the providers a `--force-enrichments` sync leg
 * leaves to the recompute that follows it in the same operation
 * (bd tea-rags-mcp-b4drg).
 *
 * `IndexingOps#recomputeEnrichments` runs an ordinary incremental first, then
 * `EnrichmentCoordinator#recomputeEnrichments`, whose forced provider repair
 * re-extracts every eligible file of its languages (bd tea-rags-mcp-cneu7) and
 * whose run finalizes and completes the collection for the selected providers.
 * Whatever the sync leg did for those providers — per-file extraction of the
 * changed files, their finalize, the codegraph heal, the collection completion
 * — the recompute redoes from scratch. Only that caller builds one; MCP
 * `index_codebase` and the auto-updater pass none and enrich every provider.
 */

import { detectLanguage } from "../chunker/utils/language-detector.js";

export interface RecomputeProviderDeferral {
  /** The recompute's provider selectors, resolved by the coordinator against its providers. */
  readonly selectors: readonly string[];
  /** The languages the recompute covers; empty covers every language. */
  readonly languages: readonly string[];
}

/**
 * A sync leg's deferral as `EnrichmentCoordinator#runRepairPass` applies it:
 * the provider keys it resolved to, and the scope the recompute covers. A
 * deferred provider's drift repair still PRUNES orphans — the recompute's
 * selector-forced repair never does — but walks nothing the recompute will
 * re-extract. A drifted path outside the recompute's scope keeps the ordinary
 * walk, and the provider is then no longer deferred: `onDeclined` tells the
 * caller, which must enrich and complete it in the sync leg's own run.
 */
export interface RepairPassRecomputeDeferral {
  readonly providerKeys: ReadonlySet<string>;
  readonly languages: readonly string[];
  readonly onDeclined: (providerKey: string) => void;
}

/**
 * Whether a recompute restricted to `languages` (empty = every language)
 * reaches `relPath`. ONE predicate for both sides: the recompute's forced
 * repair narrows the working-tree scan with it
 * (`EnrichmentCoordinator#recomputeEnrichments`), and the sync leg declines a
 * deferral for any path it rejects — such a path is one only the sync leg can
 * enrich.
 */
export function recomputeLanguagesCoverPath(languages: readonly string[] | undefined, relPath: string): boolean {
  return !languages || languages.length === 0 || languages.includes(detectLanguage(relPath));
}
