/**
 * Bridges the FACT layer (infra/file-classification) and the POLICY layer
 * (EnrichmentProvider.shouldEnrich). Stateless — imported directly by
 * file-phase and chunk-phase so no DI threading touches the hot coordinator.
 *
 * isDocumentation's source of truth stays in the language layer
 * (chunker/config.ts LANGUAGE_DEFINITIONS) — derived here and passed into
 * classify(), never re-derived in infra.
 */
import { extname } from "node:path";

import type { EnrichmentProvider, EnrichmentScope } from "../../../../contracts/types/provider.js";
import { classify } from "../../../../infra/file-classification/index.js";
import { LANGUAGE_DEFINITIONS, LANGUAGE_MAP } from "../chunker/config.js";

function isDocumentationPath(relPath: string): boolean {
  const lang = LANGUAGE_MAP[extname(relPath).toLowerCase()];
  return lang ? LANGUAGE_DEFINITIONS[lang]?.isDocumentation === true : false;
}

/**
 * Why a provider's policy declined a point at one level. Persisted to
 * `<provider>.<level>.skippedAs`, which is what lets Qdrant tell a deliberate
 * skip apart from a miss server-side — see
 * `docs/superpowers/specs/2026-08-02-enrichment-skip-stamp-design.md`.
 *
 * `"oversized"` names a decline the file's line count explains and no
 * classification flag does — the git chunk walk's `chunkMaxFileLines` cap
 * (bd tea-rags-mcp-2brzq). `"policy"` is the catch-all for a provider that
 * declined with neither explaining it. Every declined point MUST get a value:
 * an unstamped decline stays in the recovery scan forever, which is the whole
 * defect this vocabulary exists to close.
 *
 * Distinct from `skipReason` in `pipeline/infra/debug-logger.ts`, which records
 * why a file never reached the chunker at all.
 */
export type EnrichmentSkipReason = "generated" | "test" | "documentation" | "oversized" | "policy";

/**
 * What the caller knows about the file beyond its path. Every field is
 * optional: a file-level caller has no chunk and so no line count.
 */
export interface EnrichmentFileFacts {
  /** First bytes of the file, for the generated-header check. */
  contentHead?: string;
  /** Physical line count as the caller knows it — see {@link fileLinesOf}. */
  fileLines?: number;
}

/**
 * The file's line count as far as a set of its chunks tells: the chunker's
 * `moduleLines` when any chunk carries it (exact, and the same whichever of
 * the file's chunks a batch holds), else the largest `endLine` — a lower bound
 * for indices predating the symbol-mass pass. Undefined for no chunks.
 */
export function fileLinesOf(
  entries: readonly { readonly endLine: number; readonly moduleLines?: number }[],
): number | undefined {
  if (entries.length === 0) return undefined;
  let lines = 0;
  for (const e of entries) lines = Math.max(lines, e.moduleLines ?? 0, e.endLine);
  return lines;
}

function classifyPath(relPath: string, contentHead?: string) {
  return classify(relPath, { isDocumentation: isDocumentationPath(relPath), contentHead });
}

/**
 * Resolve the enrichment scope a provider wants for a repo-relative path.
 * Computes the FileClassification (generated/test/doc/source) and delegates to
 * the provider's policy, with the file's line count when the caller knows it.
 * Providers without `shouldEnrich` get "full".
 */
export function enrichmentScope(
  provider: EnrichmentProvider,
  relPath: string,
  facts: EnrichmentFileFacts = {},
): EnrichmentScope {
  if (!provider.shouldEnrich) return "full";
  return provider.shouldEnrich({
    relPath,
    classification: classifyPath(relPath, facts.contentHead),
    ...(facts.fileLines !== undefined ? { fileLines: facts.fileLines } : {}),
  });
}

function declinesAt(scope: EnrichmentScope, level: "file" | "chunk"): boolean {
  return level === "file" ? scope === "none" : scope !== "full";
}

/**
 * The reason this path is NOT owed enrichment at `level`, or null when it is.
 *
 * Level-aware because the scopes are: file level is declined only by `"none"`,
 * while chunk level is declined by both `"none"` and `"file-only"` (a doc keeps
 * its file signals but never the chunk-churn walk).
 *
 * The returned reason names the classification that held at decision time, not
 * the provider's internal reasoning — `shouldEnrich` reports a scope and gains
 * no new obligation here. Recording the classification is what makes a later
 * policy change invalidatable by reason instead of wholesale.
 *
 * Classification flags win over the line count, so an oversized generated file
 * stays `"generated"`. `"oversized"` is named only when the decline disappears
 * once the count is withheld — the provider is asked a second time without it,
 * which keeps `shouldEnrich` a scope-only contract.
 */
export function enrichmentSkipReason(
  provider: EnrichmentProvider,
  relPath: string,
  level: "file" | "chunk",
  facts: EnrichmentFileFacts = {},
): EnrichmentSkipReason | null {
  if (!provider.shouldEnrich) return null;
  const classification = classifyPath(relPath, facts.contentHead);
  const { fileLines } = facts;
  const scope = provider.shouldEnrich({
    relPath,
    classification,
    ...(fileLines !== undefined ? { fileLines } : {}),
  });
  if (!declinesAt(scope, level)) return null;
  if (classification.isGenerated) return "generated";
  if (classification.isTest) return "test";
  if (classification.isDocumentation) return "documentation";
  if (fileLines !== undefined && !declinesAt(provider.shouldEnrich({ relPath, classification }), level)) {
    return "oversized";
  }
  return "policy";
}

/**
 * Drop repo-relative paths the provider declines entirely (`"none"`). Used by
 * every FILE-level dispatch site (file-phase, backfiller, recovery) so a
 * generated file is never file-enriched, no matter which path reaches it.
 * Providers without `shouldEnrich` get the list unchanged.
 */
export function filterFileEnrichPaths(provider: EnrichmentProvider, paths: readonly string[]): string[] {
  if (!provider.shouldEnrich) return [...paths];
  return paths.filter((p) => enrichmentScope(provider, p) !== "none");
}

/**
 * Keep only `"full"`-scope entries of a CHUNK map (keyed by repo-relative
 * path) — both `"none"` and `"file-only"` skip the expensive chunk-churn walk.
 * Used by every CHUNK-level dispatch site (chunk-phase, backfiller, recovery).
 * `fileLinesFor` reads the file's line count off a map value (for chunk
 * entries, {@link fileLinesOf}); without it a size-driven decline is invisible.
 * Providers without `shouldEnrich` get the map unchanged.
 */
export function filterChunkEnrichMap<T>(
  provider: EnrichmentProvider,
  map: Map<string, T>,
  fileLinesFor?: (value: T) => number | undefined,
): Map<string, T> {
  if (!provider.shouldEnrich) return map;
  const out = new Map<string, T>();
  for (const [rel, value] of map) {
    if (enrichmentScope(provider, rel, { fileLines: fileLinesFor?.(value) }) === "full") out.set(rel, value);
  }
  return out;
}
