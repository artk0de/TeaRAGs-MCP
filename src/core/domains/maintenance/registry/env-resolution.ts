/**
 * Registry-first environment resolution for an indexing run.
 *
 * An index run bootstraps its embedding / codegraph / tuning config from env
 * (`parseAppConfig`). Rather than forcing the operator to re-export EMBEDDING_*
 * by hand, the run pulls the actual config from the project registry — the same
 * register-first source `prime` reads. For a brand-new project (no entry yet) it
 * borrows the BACKEND of the most recently indexed project — never its indexing
 * env (`pickRegistryEnvSeed`) — so a fresh index "just works" against the same
 * backend the operator last used. Ambient env
 * still wins, preserving explicit overrides.
 *
 * Both entry points consume this: the CLI seeds the resolved map into its forked
 * worker's env, while the long-lived MCP server — whose process env is fixed for
 * its lifetime — applies it per request through `ProjectIngestFactory`.
 */

import { EMBEDDED_MARKER } from "../../../adapters/qdrant/embedded/daemon.js";
import { resolveGitCommonDir } from "../../../adapters/vcs/git/common-dir.js";
import type { CollectionEntry } from "../../../contracts/types/registry.js";
import { canonicalRegistryEnvKeys, isBackendRegistryEnvKey, isThroughputTunedEnvKey } from "./env-groups.js";
import { outerEnvForRegistryStamp, replayRegistryEnv, type AmbientEnvRole } from "./env-replay.js";
import { resolveRegistryQdrantBackend } from "./qdrant-backend-resolution.js";

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
 * 3. else an entry for ANOTHER working tree of the SAME repository — a linked
 *    worktree is the same codebase as its checkout, so that entry's backend and
 *    tuning are a far better seed than whatever was indexed last,
 * 4. else the most recently indexed project (new project — borrow last config;
 *    an env seed narrows it to the backend, see {@link pickRegistryEnvSeed}),
 * 5. else null (empty registry → fall back to ambient env / defaults).
 */
export function pickRegistryEntry(
  registry: RegistryLookup,
  target: { project?: string; path?: string },
): CollectionEntry | null {
  return pickRegistryEntryWithProvenance(registry, target)?.entry ?? null;
}

/**
 * The entry whose stamp an index run of `target` replays — {@link pickRegistryEntry}
 * with the borrow of rule 4 narrowed to the BACKEND (bd tea-rags-mcp-h4l6k).
 *
 * The named project, the path's own entry and a sibling worktree's entry are
 * the same codebase, so their whole stamp applies. The most recent entry of an
 * UNRELATED repository is not: its `env` records how THAT project was indexed —
 * a `TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES=777` set for one repo was inherited by
 * every project indexed next, and then pinned into its own entry. A new project
 * borrows only what reaches the operator's backends ({@link isBackendRegistryEnvKey}
 * plus the dedicated identity fields) and takes code defaults for the rest.
 */
export function pickRegistryEnvSeed(
  registry: RegistryLookup,
  target: { project?: string; path?: string },
): CollectionEntry | null {
  const picked = pickRegistryEntryWithProvenance(registry, target);
  if (!picked) return null;
  if (picked.provenance !== "foreign-repo") return picked.entry;
  const { tuning: _legacy, ...entry } = picked.entry;
  const stamp = picked.entry.env ?? picked.entry.tuning ?? {};
  return {
    ...entry,
    env: Object.fromEntries(Object.entries(stamp).filter(([key]) => isBackendRegistryEnvKey(key))),
  };
}

/** Where {@link pickRegistryEntry}'s choice came from — only a `foreign-repo` borrow is another codebase. */
type RegistryEntryProvenance = "named" | "own-path" | "same-repo" | "foreign-repo";

function pickRegistryEntryWithProvenance(
  registry: RegistryLookup,
  target: { project?: string; path?: string },
): { entry: CollectionEntry; provenance: RegistryEntryProvenance } | null {
  if (target.project) {
    const named = registry.findByName(target.project);
    return named ? { entry: named, provenance: "named" } : null;
  }
  if (target.path) {
    const byPath = registry.findByPath(target.path);
    if (byPath) return { entry: byPath, provenance: "own-path" };
  }
  const all = registry.list();
  if (all.length === 0) return null;
  const newest = (entries: CollectionEntry[]): CollectionEntry =>
    entries.reduce((latest, e) => (e.indexedAt > latest.indexedAt ? e : latest));

  const sameRepo = target.path ? entriesSharingRepo(all, target.path) : [];
  if (sameRepo.length > 0) return { entry: newest(sameRepo), provenance: "same-repo" };
  return { entry: newest(all), provenance: "foreign-repo" };
}

/**
 * Entries whose path is a working tree of the same repository as `path` — the
 * one sibling rule, shared by the env borrow above and by the worktree seed
 * (`findWorktreeSeedCandidates`), so a new worktree seeds from the same family
 * it borrowed its config from.
 */
export function entriesSharingRepo(entries: CollectionEntry[], path: string): CollectionEntry[] {
  const identity = resolveGitCommonDir(path);
  // Not a repo → `resolveGitCommonDir` echoes the path back; an echo would
  // match only itself, and that case is already handled by `findByPath`.
  if (identity === path) return [];
  return entries.filter((e) => resolveGitCommonDir(e.path) === identity);
}

/**
 * Map a registry entry's stored config to worker env-var overrides.
 *
 * QDRANT_URL is seeded too: a brand-new `--name` index from a bare shell would
 * otherwise leave QDRANT_URL unset, so the worker probes localhost:6333 and then
 * spawns / attaches the embedded daemon — racing its RocksDB lock (SIGSEGV).
 *
 * Which backend the entry addresses is `resolveRegistryQdrantBackend`'s call —
 * it weighs the stored flag against the URL's shape according to how much the
 * writing release can be trusted. An EMBEDDED verdict seeds the marker rather
 * than the stored port: the daemon rebinds an ephemeral port on restart, so the
 * frozen `qdrantUrl` can be stale, and pinning it would force external mode —
 * losing the embedded reconnect path. The marker keeps the worker in embedded
 * mode (`resolveQdrantUrl` → `ensureDaemon`), re-resolving the daemon fresh.
 *
 * An EXTERNAL verdict seeds the stored `qdrantUrl` so the worker connects
 * directly to the same backend the operator last indexed against. Empty-string
 * values (recovered registry stubs) resolve as `unaddressed` and seed nothing,
 * so they don't poison the env.
 *
 * @throws RegistryQdrantBackendUnresolvedError when the entry's own records of
 *   its backend contradict each other beyond rescue.
 */
export function resolveRegistryEnv(
  entry: CollectionEntry | null,
  ambient: NodeJS.ProcessEnv | Record<string, string> = process.env,
  /**
   * Where `ambient` came from (`AmbientEnvRole`). Pass `server` only for a
   * project's OWN entry in a long-lived server — a borrowed seed has no stamp
   * of this project's index to stay consistent with.
   */
  role: AmbientEnvRole = "invocation",
): Record<string, string> {
  if (!entry) return {};
  // ONE replay set, ONE rule (outer env > registry env > code default):
  // the entry's stamp plus the Qdrant backend, then applied through the single
  // alias-group-aware replay — an externally-set deprecated spelling
  // (OLLAMA_URL, EMBEDDING_CONCURRENCY) beats the stored canonical key instead
  // of being shadowed after the later `{...env, ...process.env}` merge.
  const replaySet = registryStampOf(entry);
  const backend = resolveRegistryQdrantBackend(entry);
  if (backend.kind === "embedded") replaySet.QDRANT_URL = EMBEDDED_MARKER;
  else if (backend.kind === "external") replaySet.QDRANT_URL = backend.url;

  const env: Record<string, string> = {};
  replayRegistryEnv(replaySet, env, outerEnvForRegistryStamp(replaySet, ambient, role));
  return env;
}

/**
 * The env a process DETACHED by a long-lived server must inherit to index
 * `entry`'s project the way the server itself would (tea-rags-mcp-o0qsw).
 *
 * The auto-update run a server spawns replays the registry as a CLI
 * invocation, so a raw inherited spawn env would override the project's
 * stamped index shape all over again. Handing it this env instead leaves the
 * replay nothing to lose. Returns `ambient` itself when nothing is dropped, so
 * the spawner can keep plain inheritance for that case.
 *
 * Never throws: the Qdrant backend, the one part of the replay set that can,
 * is a runtime group and plays no part here.
 */
export function outerEnvForRegistryEntry(
  entry: CollectionEntry | null,
  ambient: NodeJS.ProcessEnv | Record<string, string>,
  role: AmbientEnvRole,
): NodeJS.ProcessEnv | Record<string, string> {
  return entry ? outerEnvForRegistryStamp(registryStampOf(entry), ambient, role) : ambient;
}

/**
 * What the entry recorded about its last run: identity keys from their
 * dedicated CollectionEntry fields composed with the general env snapshot
 * (`entry.env`; legacy entries stored it as `entry.tuning`). The Qdrant backend
 * is left to `resolveRegistryEnv`, which weighs it separately.
 */
function registryStampOf(entry: CollectionEntry): Record<string, string> {
  const stamp: Record<string, string> = { ...replayableRegistryEnv(entry) };
  if (entry.embeddingModel) stamp.EMBEDDING_MODEL = entry.embeddingModel;
  if (entry.embeddingBaseUrl) stamp.EMBEDDING_BASE_URL = entry.embeddingBaseUrl;
  if (entry.embeddingFallbackUrl) stamp.EMBEDDING_FALLBACK_URL = entry.embeddingFallbackUrl;
  if (entry.codegraphEnabled) stamp.CODEGRAPH_ENABLED = "true";
  return stamp;
}

/**
 * The part of `entry`'s env stamp (`env`, legacy `tuning`) a run may replay:
 * everything except a throughput-tuned key (`isThroughputTunedEnvKey`) the
 * operator did not pin (`operatorPinnedEnvKeys`, bd tea-rags-mcp-y1ynz).
 *
 * Every reader that replays a stamp into a run's env goes through here —
 * `resolveRegistryEnv`, and the `prime` / `tune` commands that replay into
 * `process.env` — because the config parser cannot tell a replayed value from
 * one the operator exported: whatever lands in the env is an explicit setting,
 * and for these keys an explicit setting is the throughput tuner's hard
 * ceiling. Filtering on the READ side leaves the stamp on disk untouched; an
 * entry written before pins existed simply stops replaying its tuned values.
 *
 * Undefined when the entry carries no stamp at all, like `entry.env ?? entry.tuning`.
 */
export function replayableRegistryEnv(
  entry: Pick<CollectionEntry, "env" | "tuning" | "operatorPinnedEnvKeys"> | null | undefined,
): Record<string, string> | undefined {
  const stamp = entry?.env ?? entry?.tuning;
  if (stamp === undefined) return undefined;
  const pinned = new Set(entry?.operatorPinnedEnvKeys);
  const isReplayable = (key: string): boolean =>
    !isThroughputTunedEnvKey(key) || canonicalRegistryEnvKeys(key).some((canonical) => pinned.has(canonical));
  return Object.fromEntries(Object.entries(stamp).filter(([key]) => isReplayable(key)));
}
