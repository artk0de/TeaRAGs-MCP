/**
 * Which registered sibling may seed a new working tree's first index, and
 * whether its index is interchangeable with what the current run would build
 * (bd tea-rags-mcp-k8gac).
 *
 * A linked worktree and its main checkout share one object database, and most
 * of their files are byte-identical — on a taxdome worktree 49% of the files
 * matched the parent HEAD while the embedding phase alone took 34 of a first
 * index's 46 minutes. Cloning the sibling's footprint and letting the ordinary
 * incremental sync re-embed only what differs saves that phase, PROVIDED the
 * sibling's data is exactly what this run would have written for those files.
 * This module decides that — a pure comparison of the stamps the drift monitors
 * read, so a seeded collection reports no drift a fresh index would not:
 *
 * - the embedding model (a different model's vectors must never mix in),
 * - the payload keys the sibling's stats recorded (`SchemaDriftMonitor`),
 * - the per-language code versions of every language the sibling holds, plus
 *   `*` (`LanguageVersionDriftMonitor`),
 * - every non-runtime env group of the sibling's stamp (`EnvDriftMonitor`'s
 *   vocabulary) and the codegraph flag,
 * - the Qdrant backend, since the clone is a snapshot within ONE backend.
 *
 * What it does NOT decide — whether the sibling is indexed, busy, or clonable —
 * needs live reads the api layer owns (`WorktreeSeedOps`).
 */

import { resolveGitCommonDir } from "../../../adapters/vcs/git/common-dir.js";
import type { LanguageCodeVersions } from "../../../contracts/types/language.js";
import type { CollectionEntry } from "../../../contracts/types/registry.js";
import type { WorktreeSeedRejectionReason } from "../../../contracts/types/worktree.js";
import { LanguageVersionDriftMonitor } from "../drift/language-version-drift-monitor.js";
import { checkSchemaDrift } from "../drift/schema-drift.js";
import { REGISTRY_ENV_GROUPS } from "../registry/env-groups.js";
import { entriesSharingRepo } from "../registry/env-resolution.js";
import { resolveRegistryQdrantBackend } from "../registry/qdrant-backend-resolution.js";

export interface WorktreeSeedRejection {
  reason: WorktreeSeedRejectionReason;
  /** Human-readable specifics — which key, which versions. */
  detail: string;
}

/** What the CURRENT run would stamp onto a collection it indexes from scratch. */
export interface WorktreeSeedBuildIdentity {
  /** Keys the stats writer records for this build (descriptor keys + `navigation`). */
  payloadFieldKeys: readonly string[];
  /** Per-language code versions of this build; omitted → the axis is not stamped, so not compared. */
  languageCodeVersions?: ReadonlyMap<string, LanguageCodeVersions>;
  /** The env snapshot this run records (canonical keys); omitted → the axis is not compared. */
  envSnapshot?: Readonly<Record<string, string>>;
  embeddingModel: string;
  codegraphEnabled: boolean;
  /** The Qdrant this process talks to. */
  qdrant: { embedded: boolean; url: string };
}

/** The sibling's recorded stamps: its registry entry and its stats cache. */
export interface WorktreeSeedSourceStamps {
  entry: CollectionEntry;
  stats: { payloadFieldKeys?: string[]; distributions?: { language?: Record<string, number> } } | null;
}

/**
 * Other working trees of `target`'s repository that the registry knows, newest
 * index first — the order `pickRegistryEntry` borrows config in, so the first
 * candidate is normally the entry this run's env came from. The target is never
 * its own candidate, whether it is registered by collection (a `--name` stub)
 * or by path.
 */
export function findWorktreeSeedCandidates(
  registry: { list: () => CollectionEntry[] },
  target: { path: string; collectionName: string },
): CollectionEntry[] {
  // Not a repository → no siblings. `entriesSharingRepo` answers that too, but
  // only by echo; saying it here keeps the rule readable at the call.
  if (resolveGitCommonDir(target.path) === target.path) return [];
  return entriesSharingRepo(registry.list(), target.path)
    .filter((e) => e.collectionName !== target.collectionName && e.path !== target.path)
    .sort((a, b) => (a.indexedAt < b.indexedAt ? 1 : a.indexedAt > b.indexedAt ? -1 : 0));
}

/** The first stamp on which the sibling differs from this run, or `undefined` when it may seed. */
export function checkWorktreeSeedCompatibility(
  source: WorktreeSeedSourceStamps,
  build: WorktreeSeedBuildIdentity,
): WorktreeSeedRejection | undefined {
  return (
    checkQdrantBackend(source.entry, build) ??
    checkEmbeddingModel(source.entry, build) ??
    checkPayloadKeys(source.stats, build) ??
    checkLanguageVersions(source, build) ??
    checkIndexEnv(source.entry, build)
  );
}

function checkQdrantBackend(
  entry: CollectionEntry,
  build: WorktreeSeedBuildIdentity,
): WorktreeSeedRejection | undefined {
  let backend: ReturnType<typeof resolveRegistryQdrantBackend>;
  try {
    backend = resolveRegistryQdrantBackend(entry);
  } catch {
    return { reason: "qdrant-backend", detail: "the sibling's registry entry names no resolvable Qdrant backend" };
  }
  if (backend.kind === "embedded" && build.qdrant.embedded) return undefined;
  if (backend.kind === "external" && !build.qdrant.embedded && sameUrl(backend.url, build.qdrant.url)) return undefined;
  const indexedOn = backend.kind === "external" ? backend.url : backend.kind;
  return {
    reason: "qdrant-backend",
    detail: `sibling indexed on ${indexedOn}, this run uses ${build.qdrant.embedded ? "embedded" : build.qdrant.url}`,
  };
}

function checkEmbeddingModel(
  entry: CollectionEntry,
  build: WorktreeSeedBuildIdentity,
): WorktreeSeedRejection | undefined {
  if (entry.embeddingModel === build.embeddingModel) return undefined;
  return {
    reason: "embedding-model",
    detail: `sibling embedded with ${entry.embeddingModel}, this run with ${build.embeddingModel}`,
  };
}

function checkPayloadKeys(
  stats: WorktreeSeedSourceStamps["stats"],
  build: WorktreeSeedBuildIdentity,
): WorktreeSeedRejection | undefined {
  if (!stats?.payloadFieldKeys) {
    return { reason: "payload-schema", detail: "the sibling's stats record no payload keys to compare" };
  }
  const drift = checkSchemaDrift(stats.payloadFieldKeys, [...build.payloadFieldKeys]);
  if (!drift) return undefined;
  const moved = [...drift.added.map((k) => `+${k}`), ...drift.removed.map((k) => `-${k}`)];
  return { reason: "payload-schema", detail: `payload keys differ: ${moved.join(", ")}` };
}

/**
 * Compared on the languages the sibling HOLDS, plus `*`: that is the data it
 * hands over. A language only this worktree contains is embedded by this run
 * under the current build, which is why the seeded collection may then carry
 * the current build's full stamp.
 */
function checkLanguageVersions(
  source: WorktreeSeedSourceStamps,
  build: WorktreeSeedBuildIdentity,
): WorktreeSeedRejection | undefined {
  if (!build.languageCodeVersions) return undefined;
  const present = source.stats?.distributions?.language;
  if (!present) {
    return { reason: "language-versions", detail: "the sibling's stats record no language distribution" };
  }
  const drift = LanguageVersionDriftMonitor.detectDrift(
    source.entry.languageVersions,
    build.languageCodeVersions,
    Object.keys(present),
  );
  if (drift.length === 0) return undefined;
  const moved = drift.flatMap((d) => d.axes.map((a) => `${d.language}.${a.axis} ${a.indexed} → ${a.current}`));
  return { reason: "language-versions", detail: moved.join(", ") };
}

/**
 * Every group whose change reaches the indexed data — chunk set or enrichment —
 * must agree; `runtime` groups only change how a run executes. Only keys BOTH
 * sides carry can disagree, as in `EnvDriftMonitor`. The codegraph flag lives in
 * a dedicated entry field and is compared strictly: an unstamped sibling had it
 * off, and a graph it never built cannot be cloned.
 */
function checkIndexEnv(entry: CollectionEntry, build: WorktreeSeedBuildIdentity): WorktreeSeedRejection | undefined {
  const sourceCodegraph = entry.codegraphEnabled ?? false;
  if (sourceCodegraph !== build.codegraphEnabled) {
    return {
      reason: "index-env",
      detail: `CODEGRAPH_ENABLED: ${String(sourceCodegraph)} → ${String(build.codegraphEnabled)}`,
    };
  }
  const stamped = entry.env ?? entry.tuning;
  const current = build.envSnapshot;
  if (!stamped || !current) return undefined;
  const moved: string[] = [];
  for (const group of REGISTRY_ENV_GROUPS) {
    if (group.consequence === "runtime") continue;
    const indexed = stamped[group.canonical];
    const now = current[group.canonical];
    if (indexed !== undefined && now !== undefined && indexed !== now) {
      moved.push(`${group.canonical}: ${indexed} → ${now}`);
    }
  }
  return moved.length === 0 ? undefined : { reason: "index-env", detail: moved.join(", ") };
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}
