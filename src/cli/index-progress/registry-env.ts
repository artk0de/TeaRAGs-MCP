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

import { EMBEDDED_MARKER, type CollectionEntry } from "../../core/api/public/index.js";

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

/** External Qdrant's conventional port; the embedded daemon never binds it. */
const EXTERNAL_QDRANT_DEFAULT_PORT = "6333";

/**
 * Backward-compat shim for registry entries written BEFORE the `qdrantEmbedded`
 * flag existed (the field is absent → `undefined`). The embedded daemon always
 * binds `127.0.0.1` on an OS-assigned free port — never 6333, the external
 * default — so a flagless entry whose `qdrantUrl` matches that exact shape was
 * the embedded daemon. Its frozen port is stale after a daemon restart, so the
 * worker must re-resolve via the marker rather than pin the dead port. Scoped to
 * the daemon's exact host so a user's external `localhost` / `127.0.0.1:6333`
 * Qdrant is never misread as embedded. Consulted ONLY when `qdrantEmbedded` is
 * absent — an explicit flag (true or false) always wins over this heuristic.
 */
function isLegacyEmbeddedLoopback(qdrantUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(qdrantUrl);
  } catch {
    return false;
  }
  return parsed.hostname === "127.0.0.1" && parsed.port !== "" && parsed.port !== EXTERNAL_QDRANT_DEFAULT_PORT;
}

/**
 * Map a registry entry's stored config to worker env-var overrides.
 *
 * QDRANT_URL is seeded too: a brand-new `--name` index from a bare shell would
 * otherwise leave QDRANT_URL unset, so the worker probes localhost:6333 and then
 * spawns / attaches the embedded daemon — racing its RocksDB lock (SIGSEGV).
 *
 * For an EMBEDDED entry (`qdrantEmbedded`), seed the embedded marker rather than
 * the stored port: the daemon rebinds an ephemeral port on restart, so the
 * frozen `qdrantUrl` can be stale, and pinning it would force external mode —
 * losing the embedded reconnect path. The marker keeps the worker in embedded
 * mode (`resolveQdrantUrl` → `ensureDaemon`), re-resolving the daemon fresh.
 * Legacy entries written before the flag existed (field absent) are caught by
 * the daemon's URL shape via `isLegacyEmbeddedLoopback` — same marker path.
 *
 * For an EXTERNAL entry, seed the stored `qdrantUrl` so the worker connects
 * directly (external mode) to the same backend the operator last indexed
 * against. Empty-string values (recovered registry stubs) are skipped so they
 * don't poison the env.
 */
export function resolveRegistryEnv(entry: CollectionEntry | null): Record<string, string> {
  if (!entry) return {};
  const env: Record<string, string> = {};
  if (entry.embeddingModel) env.EMBEDDING_MODEL = entry.embeddingModel;
  if (entry.embeddingBaseUrl) env.EMBEDDING_BASE_URL = entry.embeddingBaseUrl;
  if (entry.embeddingFallbackUrl) env.EMBEDDING_FALLBACK_URL = entry.embeddingFallbackUrl;
  if (
    entry.qdrantEmbedded === true ||
    (entry.qdrantEmbedded === undefined && isLegacyEmbeddedLoopback(entry.qdrantUrl))
  ) {
    env.QDRANT_URL = EMBEDDED_MARKER;
  } else if (entry.qdrantUrl) {
    env.QDRANT_URL = entry.qdrantUrl;
  }
  if (entry.codegraphEnabled) env.CODEGRAPH_ENABLED = "true";
  // Tuning snapshot re-apply: seed the worker with the exact tuning env the
  // project was last indexed with, so a fresh-shell reindex keeps the same
  // knobs instead of silently reverting to code defaults. Ambient process.env
  // still wins (the command merges process.env over these). Empty-string
  // values (hand-edited registry) are skipped like the endpoint fields above.
  for (const [key, value] of Object.entries(entry.tuning ?? {})) {
    if (value) env[key] = value;
  }
  return env;
}
