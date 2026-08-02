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
 * `"policy"` is the catch-all for a provider that declined without any
 * classification flag explaining it. Every declined point MUST get a value:
 * an unstamped decline stays in the recovery scan forever, which is the whole
 * defect this vocabulary exists to close.
 *
 * Distinct from `skipReason` in `pipeline/infra/debug-logger.ts`, which records
 * why a file never reached the chunker at all.
 */
export type EnrichmentSkipReason = "generated" | "test" | "documentation" | "policy";

function classifyPath(relPath: string, contentHead?: string) {
  return classify(relPath, { isDocumentation: isDocumentationPath(relPath), contentHead });
}

/**
 * Resolve the enrichment scope a provider wants for a repo-relative path.
 * Computes the FileClassification (generated/test/doc/source) and delegates to
 * the provider's policy. Providers without `shouldEnrich` get "full".
 */
export function enrichmentScope(provider: EnrichmentProvider, relPath: string, contentHead?: string): EnrichmentScope {
  if (!provider.shouldEnrich) return "full";
  return provider.shouldEnrich({ relPath, classification: classifyPath(relPath, contentHead) });
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
 */
export function enrichmentSkipReason(
  provider: EnrichmentProvider,
  relPath: string,
  level: "file" | "chunk",
  contentHead?: string,
): EnrichmentSkipReason | null {
  if (!provider.shouldEnrich) return null;
  const classification = classifyPath(relPath, contentHead);
  const scope = provider.shouldEnrich({ relPath, classification });
  const declined = level === "file" ? scope === "none" : scope !== "full";
  if (!declined) return null;
  if (classification.isGenerated) return "generated";
  if (classification.isTest) return "test";
  if (classification.isDocumentation) return "documentation";
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
 * Providers without `shouldEnrich` get the map unchanged.
 */
export function filterChunkEnrichMap<T>(provider: EnrichmentProvider, map: Map<string, T>): Map<string, T> {
  if (!provider.shouldEnrich) return map;
  const out = new Map<string, T>();
  for (const [rel, value] of map) {
    if (enrichmentScope(provider, rel) === "full") out.set(rel, value);
  }
  return out;
}
