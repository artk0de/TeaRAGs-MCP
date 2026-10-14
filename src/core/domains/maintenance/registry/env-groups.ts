/**
 * Registry env vocabulary — the FULL env surface of an indexing run, persisted
 * to and replayed from the project registry (tea-rags-mcp-9vpnz).
 *
 * ONE general rule, ONE mechanism, no "tuning" category:
 * `outer env > project registry env > code default`, applied PER ALIAS GROUP.
 * Each group mirrors one alias family read by `bootstrap/config/parse.ts`
 * (canonical name + deprecated spellings, resolved by `envWithFallback` in
 * that order). The snapshot builder (`bootstrap/config/env-snapshot.ts`)
 * emits one CANONICAL key per group at its parsed effective value — code
 * defaults materialized — and replay (`cli/registry-env-replay.ts`) skips a
 * whole group when ANY spelling is set in the ambient env, so an externally
 * passed deprecated alias still overrides the stored canonical key. Which
 * ambient env counts as "outer" depends on its role — a long-lived server's
 * spawn env yields the non-runtime groups a project stamps
 * (`outerEnvForRegistryStamp` in `env-replay.ts`, tea-rags-mcp-o0qsw).
 *
 * The ONLY env kinds outside this mechanism:
 * - secrets (OPENAI/COHERE/VOYAGE/QDRANT API keys, EMBEDDING_API_KEY) — never persisted;
 * - server/process knobs (DEBUG, SERVER_TRANSPORT, ports, timeouts) —
 *   properties of the process, not of a project.
 *
 * Identity keys (DEDICATED_FIELD_ENV_KEYS) are persisted in dedicated
 * CollectionEntry fields rather than the `env` map — they carry richer
 * semantics than a verbatim string (QDRANT_URL resolves the embedded-daemon
 * sentinel, EMBEDDING_MODEL feeds the model guard) — but they REPLAY through
 * the same group-aware path: `resolveRegistryEnv` composes them with the
 * stored `env` map into one replay set, so the general precedence rule holds
 * uniformly (an external OLLAMA_URL beats the registry EMBEDDING_BASE_URL).
 */

// The vocabulary — its types (bd tea-rags-mcp-0qaht.36) and the alias-family
// table itself (bd tea-rags-mcp-umixb) — lives in contracts so the stable
// layers name it without reaching into this module; re-exported here unchanged
// for this domain's consumers.
import { REGISTRY_ENV_GROUPS } from "../../../contracts/registry-env-groups.js";
import type { EnvConsequence, RegistryEnvGroup } from "../../../contracts/types/registry.js";

export type { EnvConsequence, RegistryEnvGroup };
export type { RegistryEnvCanonicalKey } from "../../../contracts/registry-env-groups.js";
export { REGISTRY_ENV_GROUPS };

/**
 * Does this registry env key describe the operator's BACKENDS — the embedding
 * service and its vector space (`EMBEDDING_*`, `OLLAMA_*`) or the Qdrant
 * instance (`QDRANT_*`) — rather than how one project is indexed?
 *
 * That is the whole of what a new project may borrow from an unrelated entry
 * (`pickRegistryEnvSeed`, bd tea-rags-mcp-h4l6k): reaching the same backend in
 * the same vector space is what makes a fresh index "just work", while the git
 * windows, chunking, test paths and codegraph policy of another repository are
 * that repository's decisions. Canonical names only — a stamp stores nothing
 * else.
 */
export function isBackendRegistryEnvKey(canonical: string): boolean {
  return /^(EMBEDDING|OLLAMA|QDRANT)_/.test(canonical);
}

/**
 * Flat allowlist of every recognized spelling (canonical + aliases).
 * Kept for consumers that only need membership checks.
 */
export const REGISTRY_ENV_ALLOWLIST: readonly string[] = [
  ...new Set(REGISTRY_ENV_GROUPS.flatMap((g) => [g.canonical, ...g.aliases])),
];

/**
 * Both group lookups derived from the ONE table above, so no consumer has to
 * restate the alias families. A spelling shared by two groups (CODE_BATCH_SIZE
 * sits in both the embedding-batch and the qdrant-upsert family, because
 * parse.ts feeds it into both) belongs to BOTH, and every consumer treats it
 * as affecting both — conservatively, in whichever direction is safe for it.
 */
const GROUPS_BY_SPELLING: ReadonlyMap<string, readonly RegistryEnvGroup[]> = (() => {
  const byKey = new Map<string, RegistryEnvGroup[]>();
  for (const group of REGISTRY_ENV_GROUPS) {
    for (const spelling of [group.canonical, ...group.aliases]) {
      const groups = byKey.get(spelling) ?? [];
      groups.push(group);
      byKey.set(spelling, groups);
    }
  }
  return byKey;
})();

/**
 * Every spelling that can shadow `key`: the UNION of all alias families it
 * belongs to. Replay uses it to decide whether an externally-set spelling
 * already covers a stored key; the tune → registry write uses it to evict the
 * siblings of a key it just measured.
 *
 * A spelling outside every known group (written by a newer tea-rags) is its own
 * sole member, so callers degrade to same-key behavior instead of failing.
 */
export function registryEnvGroupMembers(key: string): readonly string[] {
  const groups = GROUPS_BY_SPELLING.get(key);
  if (!groups) return [key];
  return [...new Set(groups.flatMap((g) => [g.canonical, ...g.aliases]))];
}

/**
 * The CANONICAL key(s) `key` resolves to — the spelling the registry stores
 * (see `bootstrap/config/env-snapshot.ts`, which emits one canonical key per
 * group). A canonical key resolves to itself, an alias to its group's
 * canonical, a two-group alias to both, and an unknown spelling to itself.
 */
export function canonicalRegistryEnvKeys(key: string): readonly string[] {
  const groups = GROUPS_BY_SPELLING.get(key);
  if (!groups) return [key];
  return [...new Set(groups.map((g) => g.canonical))];
}

/**
 * Identity keys persisted in DEDICATED CollectionEntry fields (embeddingModel,
 * embeddingBaseUrl, embeddingFallbackUrl, qdrantUrl, codegraphEnabled) rather
 * than the generic `env` map — richer semantics than a verbatim string
 * (embedded-daemon sentinel resolution, model guard). The snapshot builder
 * skips them; `resolveRegistryEnv` composes them back into the ONE replay set.
 */
export const DEDICATED_FIELD_ENV_KEYS: ReadonlySet<string> = new Set([
  "EMBEDDING_MODEL",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_FALLBACK_URL",
  "QDRANT_URL",
  "CODEGRAPH_ENABLED",
]);

/**
 * Canonical keys whose code default is runtime-ADAPTIVE, not a static value:
 * GPU-calibrated embedding batch size, per-language chunk sizing
 * (indexing-ops), and embedded-mode delete tuning (factory). The snapshot
 * materializes these only when the user explicitly set them (the config
 * layer marks exactly these four via its `userSet*` flags) — pinning an
 * adaptive value would freeze behavior the default recomputes per run.
 */
export const ADAPTIVE_DEFAULT_ENV_KEYS: ReadonlySet<string> = new Set([
  "EMBEDDING_TUNE_BATCH_SIZE",
  "INGEST_CHUNK_SIZE",
  "QDRANT_TUNE_DELETE_BATCH_SIZE",
  "QDRANT_TUNE_DELETE_CONCURRENCY",
]);

/**
 * Canonical keys that bound the embedding throughput tuner
 * (`EmbeddingThroughputTuner`): the pipeline concurrency is the ceiling of its
 * concurrency climb, the batch size the ceiling of its size climb, and the
 * minimum size and formation timeout shape every batch it measures.
 *
 * A value of one of these is a fact about ONE embedding backend, so a registry
 * stamp of it replays only when the operator pinned it
 * (`CollectionEntry.operatorPinnedEnvKeys`, `replayableRegistryEnv`). A value a
 * run or `tea-rags tune` stamped was measured against whatever served that run;
 * replayed, it became an explicit setting of every later run and froze the
 * climb at a single-slot Ollama ceiling on a 16-slot llama-server cluster
 * (bd tea-rags-mcp-y1ynz). The tuner's own measured optimum, keyed by
 * embedding identity, is what carries a learnt shape from run to run.
 */
export const THROUGHPUT_TUNED_ENV_KEYS: ReadonlySet<string> = new Set([
  "INGEST_PIPELINE_CONCURRENCY",
  "EMBEDDING_TUNE_BATCH_SIZE",
  "EMBEDDING_TUNE_MIN_BATCH_SIZE",
  "EMBEDDING_TUNE_BATCH_TIMEOUT_MS",
]);

/**
 * Whether any spelling of `key` resolves to a {@link THROUGHPUT_TUNED_ENV_KEYS}
 * family. A spelling shared with another family (`CODE_BATCH_SIZE` also feeds
 * the Qdrant upsert batch) counts as tuned: replaying it would set the tuner's
 * ceiling all the same.
 */
export function isThroughputTunedEnvKey(key: string): boolean {
  return canonicalRegistryEnvKeys(key).some((canonical) => THROUGHPUT_TUNED_ENV_KEYS.has(canonical));
}
