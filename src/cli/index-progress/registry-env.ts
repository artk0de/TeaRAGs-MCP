/**
 * Registry-first environment resolution for `index-codebase`.
 *
 * The forked worker bootstraps its embedding / codegraph config from process
 * env (`parseAppConfig`). Rather than forcing the operator to re-export
 * EMBEDDING_* by hand, the command pulls the actual config from the project
 * registry — the same register-first source `prime` reads — and injects it into
 * the worker env. For a brand-new project (no entry yet) it borrows the config
 * of the most recently indexed project, so a fresh index "just works" against
 * the same backend the operator last used. Ambient env still wins (the command
 * merges process.env over these), preserving explicit overrides.
 */

import type { CollectionEntry } from "../../core/api/public/index.js";

/** Structural subset of CollectionRegistry used here — keeps tests fake-friendly. */
export interface RegistryLookup {
  findByName: (name: string) => CollectionEntry | null;
  findByPath: (path: string) => CollectionEntry | null;
  list: () => CollectionEntry[];
}

/**
 * Pick the registry entry whose config should seed the worker env:
 * 1. the named project (`--project`),
 * 2. else the entry for this exact path (re-indexing a known project),
 * 3. else the most recently indexed project (new project — borrow last config),
 * 4. else null (empty registry → fall back to ambient env / defaults).
 */
export function pickRegistryEntry(
  registry: RegistryLookup,
  target: { project?: string; path?: string },
): CollectionEntry | null {
  if (target.project) return registry.findByName(target.project);
  if (target.path) {
    const byPath = registry.findByPath(target.path);
    if (byPath) return byPath;
  }
  const all = registry.list();
  if (all.length === 0) return null;
  return all.reduce((latest, e) => (e.indexedAt > latest.indexedAt ? e : latest));
}

/** Map a registry entry's stored config to worker env-var overrides. */
export function resolveRegistryEnv(entry: CollectionEntry | null): Record<string, string> {
  if (!entry) return {};
  const env: Record<string, string> = {};
  if (entry.embeddingModel) env.EMBEDDING_MODEL = entry.embeddingModel;
  if (entry.embeddingBaseUrl) env.EMBEDDING_BASE_URL = entry.embeddingBaseUrl;
  if (entry.embeddingFallbackUrl) env.EMBEDDING_FALLBACK_URL = entry.embeddingFallbackUrl;
  if (entry.codegraphEnabled) env.CODEGRAPH_ENABLED = "true";
  return env;
}
