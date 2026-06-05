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
 * Resolve the enrichment scope a provider wants for a repo-relative path.
 * Computes the FileClassification (generated/test/doc/source) and delegates to
 * the provider's policy. Providers without `shouldEnrich` get "full".
 */
export function enrichmentScope(provider: EnrichmentProvider, relPath: string, contentHead?: string): EnrichmentScope {
  if (!provider.shouldEnrich) return "full";
  const classification = classify(relPath, { isDocumentation: isDocumentationPath(relPath), contentHead });
  return provider.shouldEnrich({ relPath, classification });
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
