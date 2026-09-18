/**
 * Registry-first environment resolution for an indexing run.
 *
 * An index run bootstraps its embedding / codegraph / tuning config from env
 * (`parseAppConfig`). Rather than forcing the operator to re-export EMBEDDING_*
 * by hand, the run pulls the actual config from the project registry — the same
 * register-first source `prime` reads. For a brand-new project (no entry yet) it
 * borrows the config of the most recently indexed project, so a fresh index
 * "just works" against the same backend the operator last used. Ambient env
 * still wins, preserving explicit overrides.
 *
 * Both entry points consume this: the CLI seeds the resolved map into its forked
 * worker's env, while the long-lived MCP server — whose process env is fixed for
 * its lifetime — applies it per request through `ProjectIngestFactory`.
 */

import { EMBEDDED_MARKER } from "../../../adapters/qdrant/embedded/daemon.js";
import { resolveGitCommonDir } from "../../../adapters/vcs/git/common-dir.js";
import type { CollectionEntry } from "../../../contracts/types/registry.js";
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
 * 4. else the most recently indexed project (new project — borrow last config),
 * 5. else null (empty registry → fall back to ambient env / defaults).
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
  const newest = (entries: CollectionEntry[]): CollectionEntry =>
    entries.reduce((latest, e) => (e.indexedAt > latest.indexedAt ? e : latest));

  const sameRepo = target.path ? entriesSharingRepo(all, target.path) : [];
  return newest(sameRepo.length > 0 ? sameRepo : all);
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
  const stamp: Record<string, string> = { ...(entry.env ?? entry.tuning) };
  if (entry.embeddingModel) stamp.EMBEDDING_MODEL = entry.embeddingModel;
  if (entry.embeddingBaseUrl) stamp.EMBEDDING_BASE_URL = entry.embeddingBaseUrl;
  if (entry.embeddingFallbackUrl) stamp.EMBEDDING_FALLBACK_URL = entry.embeddingFallbackUrl;
  if (entry.codegraphEnabled) stamp.CODEGRAPH_ENABLED = "true";
  return stamp;
}
