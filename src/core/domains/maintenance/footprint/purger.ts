import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type { CollectionEntry } from "../../../contracts/types/registry.js";
import { resolvePhysicalCollection } from "../../../infra/collection-name.js";
import type { ArtifactId, FootprintContext, ResolvedCollection } from "./artifact.js";
import type { CollectionFootprintFactory } from "./factory.js";

/**
 * Reads the SHARED codegraph daemon's liveness. There is one daemon process per
 * machine with one global refs counter — not one per collection — so a purge
 * cannot ask it to let go of a single graph file. What it can do is say whether
 * something still holds a handle, and never take the daemon down on behalf of
 * whoever else is using it.
 */
export interface CodegraphDaemonLiveness {
  /** The running daemon's pid, or undefined when none is up. */
  pid: () => number | undefined;
  /** How many clients the daemon is currently serving, across all collections. */
  refs: () => number;
}

/** The narrow Qdrant surface a purge needs: enumerate generations, resolve the alias. */
export type PurgeQdrantSurface = Pick<QdrantManager, "listCollections"> & {
  aliases: Pick<QdrantManager["aliases"], "listAliases">;
};

export interface CollectionFootprintPurgerDeps {
  qdrant: PurgeQdrantSurface;
  /** Builds the artifact saga; the purge drives the same artifacts a worktree teardown does. */
  footprintFactory: CollectionFootprintFactory;
  /** Enumerates codegraph DB generations on disk (the pool's `listCollectionDbNames`). */
  listCodegraphDbs: (baseCollectionName: string) => PhysicalCollectionName[];
  /** Used only to name worktree clones derived from the purged project — never mutated. */
  registry?: { listWorktrees: () => CollectionEntry[] };
  daemon?: CodegraphDaemonLiveness;
}

export interface CollectionPurgeInput {
  /** Registry alias / logical collection name, e.g. `code_8b243ffe`. */
  logicalName: string;
  /** The project directory the entry pointed at. Reported as kept; never touched. */
  path?: string;
}

export interface CollectionPurgeFailure {
  artifact: ArtifactId;
  /** Physical generation for `physical` artifacts, logical name for the rest. */
  target: string;
  reason: string;
}

export interface CollectionPurgeReport {
  /** The logical collection that was purged. */
  collectionName: string;
  /** Physical collection the alias pointed at, or null when the name was not an alias. */
  qdrantAlias: string | null;
  /** Qdrant generations that are confirmed gone (verified by re-listing). */
  qdrantCollections: string[];
  /** Codegraph DuckDB generations that are confirmed gone (verified by re-listing). */
  codegraphDatabases: string[];
  /** Alias-keyed artifacts whose teardown completed. */
  clearedStores: ArtifactId[];
  /** What the purge deliberately left in place, each line saying why. */
  kept: string[];
  /** Everything that failed. The purge continued past each one. */
  failures: CollectionPurgeFailure[];
}

/** Escape regex metacharacters so a collection name can be embedded in the generation pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Removes the FULL per-collection footprint of one registered project: every
 * Qdrant generation, every codegraph DuckDB generation, the snapshot, the stats
 * cache, the quarantine file and a dead run's indexing lock. A live run's lock is
 * left in place and reported as a failure naming its holder.
 *
 * It exists because `projects unregister --purge` used to delete exactly one
 * thing — the collection named by the registry entry — and that name is the
 * ALIAS. Everything addressed by the versioned `_vN` physical name survived,
 * and so did every alias-keyed file that is not a Qdrant collection at all. Two
 * separate cleanup passes (2026-08-15 and 2026-08-17) removed the remains by
 * hand: `code_<hash>_v1/_v2` collections, `~/.tea-rags/codegraph/*.duckdb` plus
 * their `.wal` sidecars, the snapshot directory, and `<collection>.stats.json`.
 *
 * The teardown reuses the artifact saga rather than re-implementing it, and
 * splits the sweep by {@link ArtifactAddressing}: `physical` artifacts run once
 * per generation, `logical` artifacts once for the whole collection. Every step
 * is best-effort — a failure is recorded and the sweep continues, because a
 * purge that aborts halfway leaves a worse mess than the one it was fixing.
 */
export class CollectionFootprintPurger {
  constructor(private readonly deps: CollectionFootprintPurgerDeps) {}

  async purge(input: CollectionPurgeInput): Promise<CollectionPurgeReport> {
    const logical = input.logicalName;
    const failures: CollectionPurgeFailure[] = [];

    const { qdrantTargets, aliasTarget } = await this.enumerateQdrant(logical, failures);
    const codegraphTargets = this.enumerateCodegraph(logical, failures);

    // Union, not intersection: a DuckDB file whose Qdrant collection is already
    // gone is exactly the leak this purge exists to close (bd 6goqa / snbzk).
    const generations = [...new Set([...qdrantTargets, ...codegraphTargets])].sort();

    for (const generation of generations) {
      await this.removeArtifacts("physical", this.contextFor(logical, generation, input.path), generation, failures);
    }

    // The alias-keyed artifacts are one per collection, so they are torn down
    // once — after the generations, mirroring the reverse-order saga.
    // The logical artifacts never read the physical half; with no generation
    // left to name, the logical name resolved against no aliases stands in.
    const logicalContext = this.contextFor(
      logical,
      aliasTarget ?? generations[0] ?? resolvePhysicalCollection(logical, []),
      input.path,
    );
    const clearedStores = await this.removeArtifacts("logical", logicalContext, logical, failures);

    return {
      collectionName: logical,
      qdrantAlias: aliasTarget,
      qdrantCollections: await this.verifyQdrantGone(qdrantTargets, failures),
      codegraphDatabases: this.verifyCodegraphGone(logical, codegraphTargets, failures),
      clearedStores,
      kept: this.describeKept(logical, input.path),
      failures,
    };
  }

  /**
   * Qdrant generations of the collection: every live collection matching
   * `^<logical>(_v\d+)?$`, plus whatever the alias actually resolves to (a
   * force reindex can leave the alias pointing at a name the pattern misses).
   *
   * When Qdrant cannot be listed at all, fall back to the logical name: the
   * registry entry proves something was indexed under it, so attempting that
   * one delete beats attempting none.
   */
  private async enumerateQdrant(
    logical: string,
    failures: CollectionPurgeFailure[],
  ): Promise<{ qdrantTargets: PhysicalCollectionName[]; aliasTarget: PhysicalCollectionName | null }> {
    const pattern = new RegExp(`^${escapeRegExp(logical)}(?:_v\\d+)?$`);
    let listed: PhysicalCollectionName[];
    try {
      listed = (await this.deps.qdrant.listCollections()).filter((name) => pattern.test(name));
    } catch (err) {
      failures.push({ artifact: "qdrant", target: logical, reason: describe(err) });
      listed = [resolvePhysicalCollection(logical, [])];
    }

    let aliasTarget: PhysicalCollectionName | null = null;
    try {
      const aliases = await this.deps.qdrant.aliases.listAliases();
      aliasTarget = aliases.find((a) => a.aliasName === logical)?.collectionName ?? null;
    } catch {
      // Older servers have no alias API, and an unreachable one already failed
      // above. The pattern match stands on its own.
    }

    const qdrantTargets = [...new Set([...listed, ...(aliasTarget ? [aliasTarget] : [])])];
    return { qdrantTargets, aliasTarget };
  }

  private enumerateCodegraph(logical: string, failures: CollectionPurgeFailure[]): PhysicalCollectionName[] {
    try {
      return this.deps.listCodegraphDbs(logical);
    } catch (err) {
      failures.push({ artifact: "codegraph", target: logical, reason: describe(err) });
      return [];
    }
  }

  /**
   * Run one addressing half of the saga in reverse factory order, recording
   * rather than propagating failures. Returns the ids that completed.
   */
  private async removeArtifacts(
    addressing: "physical" | "logical",
    context: FootprintContext,
    target: string,
    failures: CollectionPurgeFailure[],
  ): Promise<ArtifactId[]> {
    const { artifacts } = this.deps.footprintFactory.build(context.source, context.target);
    const completed: ArtifactId[] = [];
    for (const artifact of [...artifacts].reverse()) {
      if (artifact.addressing !== addressing) continue;
      try {
        await artifact.remove(context);
        completed.push(artifact.id);
      } catch (err) {
        failures.push({ artifact: artifact.id, target, reason: describe(err) });
      }
    }
    return completed;
  }

  /**
   * The saga's `remove` addresses `ctx.target` only, so source and target are
   * the same collection here — there is no other side to a purge. Fields the
   * removal path does not read carry neutral values.
   */
  private contextFor(logicalName: string, physicalName: PhysicalCollectionName, path?: string): FootprintContext {
    const resolved: ResolvedCollection = {
      logicalName,
      physicalName,
      path: path ?? "",
      embeddingModel: "",
      embeddingDimensions: 0,
      qdrantUrl: "",
      codegraphEnabled: true,
    };
    return { source: resolved, target: resolved };
  }

  /**
   * A delete that resolved is not proof the collection is gone — Qdrant can ack
   * a delete the server then declines, and `QdrantArtifact.remove` swallows its
   * own errors by contract. Re-listing is the only honest source for the report.
   */
  private async verifyQdrantGone(targets: string[], failures: CollectionPurgeFailure[]): Promise<string[]> {
    if (targets.length === 0) return [];
    let live: Set<string>;
    try {
      live = new Set(await this.deps.qdrant.listCollections());
    } catch {
      // Cannot verify — report the attempted set rather than claim nothing went.
      return targets;
    }
    for (const survivor of targets.filter((name) => live.has(name))) {
      // The delete already explained itself — do not bury that reason under a
      // second, vaguer entry for the same target.
      if (failures.some((f) => f.artifact === "qdrant" && f.target === survivor)) continue;
      failures.push({ artifact: "qdrant", target: survivor, reason: "still present after delete" });
    }
    return targets.filter((name) => !live.has(name));
  }

  private verifyCodegraphGone(logical: string, targets: string[], failures: CollectionPurgeFailure[]): string[] {
    if (targets.length === 0) return [];
    let remaining: Set<string>;
    try {
      remaining = new Set(this.deps.listCodegraphDbs(logical));
    } catch {
      return targets;
    }
    for (const survivor of targets.filter((name) => remaining.has(name))) {
      if (failures.some((f) => f.artifact === "codegraph" && f.target === survivor)) continue;
      failures.push({ artifact: "codegraph", target: survivor, reason: "database file still on disk" });
    }
    return targets.filter((name) => !remaining.has(name));
  }

  /**
   * Everything a purge deliberately does NOT remove. Stated explicitly because
   * the alternative is a user assuming `--purge` reached further than it did —
   * which is how the two manual cleanup passes started.
   */
  private describeKept(logical: string, path?: string): string[] {
    const kept: string[] = [];
    if (path) kept.push(`project directory ${path} — the source tree is never touched`);

    for (const entry of this.deps.registry?.listWorktrees() ?? []) {
      if (entry.worktreeOf !== logical) continue;
      const alias = entry.name ?? entry.collectionName;
      kept.push(
        `worktree clone '${alias}' (${entry.collectionName}) — it owns its own footprint; ` +
          `remove it with 'tea-rags worktree remove ${entry.worktreeName ?? alias}'`,
      );
    }

    const pid = this.deps.daemon?.pid();
    if (pid !== undefined) {
      const refs = this.deps.daemon?.refs() ?? 0;
      kept.push(
        refs > 0
          ? `codegraph daemon (pid ${pid}) — left running, it is serving ${refs} client(s) that may belong to other projects`
          : `codegraph daemon (pid ${pid}) — left running, idle; it releases its file handles on its own`,
      );
    }
    return kept;
  }
}
