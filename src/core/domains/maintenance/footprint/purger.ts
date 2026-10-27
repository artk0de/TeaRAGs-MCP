import type { QdrantAliasAdmin, QdrantCollectionCatalog } from "../../../adapters/qdrant/ports.js";
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type { CollectionEntry } from "../../../contracts/types/registry.js";
import { resolvePhysicalCollection } from "../../../primitives/ids/index.js";
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
export type PurgeQdrantSurface = Pick<QdrantCollectionCatalog, "listCollections"> & {
  aliases: Pick<QdrantAliasAdmin, "listAliases">;
};

export interface CollectionFootprintPurgerDeps {
  qdrant: PurgeQdrantSurface;
  /** Builds the artifact saga; the purge drives the same artifacts a worktree teardown does. */
  footprintFactory: CollectionFootprintFactory;
  /** Enumerates codegraph generations on disk, database or cross-pass input spill (`listCollectionGenerationNames`). */
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

export interface CollectionGenerationPurgeInput {
  /** The alias the generation belongs to, e.g. `code_8b243ffe`. */
  logicalName: string;
  /** The stale generation itself, e.g. `code_8b243ffe_v1`. */
  physicalName: PhysicalCollectionName;
}

export interface StoreLeftoverPurgeReport {
  /** Logical names whose every alias-keyed store was cleared. */
  purged: string[];
  /** Refusals and per-store failures; a name listed here is not in `purged`. */
  failures: CollectionPurgeFailure[];
}

const GENERATION_SUFFIX = /_v\d+$/;

/** Store leftovers swept at once — independent file I/O per name. */
const STORE_LEFTOVER_CONCURRENCY = 32;

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

    const { qdrantTargets: qdrantTargetPhysicalCollectionNames, aliasTarget: aliasTargetPhysicalCollectionName } =
      await this.enumerateQdrant(logical, failures);
    const codegraphTargetPhysicalCollectionNames = this.enumerateCodegraph(logical, failures);

    // Union, not intersection: a DuckDB file whose Qdrant collection is already
    // gone is exactly the leak this purge exists to close (bd 6goqa / snbzk).
    const generationPhysicalCollectionNames = [
      ...new Set([...qdrantTargetPhysicalCollectionNames, ...codegraphTargetPhysicalCollectionNames]),
    ].sort();

    for (const physicalCollectionName of generationPhysicalCollectionNames) {
      await this.removeArtifacts(
        "physical",
        this.contextFor(logical, physicalCollectionName, input.path),
        physicalCollectionName,
        failures,
      );
    }

    // The alias-keyed artifacts are one per collection, so they are torn down
    // once — after the generations, mirroring the reverse-order saga.
    // The logical artifacts never read the physical half; with no generation
    // left to name, the logical name resolved against no aliases stands in.
    const logicalContext = this.contextFor(
      logical,
      aliasTargetPhysicalCollectionName ??
        generationPhysicalCollectionNames[0] ??
        resolvePhysicalCollection(logical, []),
      input.path,
    );
    const clearedStores = await this.removeArtifacts("logical", logicalContext, logical, failures);

    return {
      collectionName: logical,
      qdrantAlias: aliasTargetPhysicalCollectionName,
      qdrantCollections: await this.verifyQdrantGone(qdrantTargetPhysicalCollectionNames, failures),
      codegraphDatabases: this.verifyCodegraphGone(logical, codegraphTargetPhysicalCollectionNames, failures),
      clearedStores,
      kept: this.describeKept(logical, input.path),
      failures,
    };
  }

  /**
   * Removes ONE stale generation of a collection whose alias stays live — the
   * `code_a_v1` left behind while `code_a` points at `code_a_v2`. Only the
   * physical half of the saga runs, and it runs with the generation standing in
   * for the logical name too: `QdrantArtifact#remove` drops the alias named by
   * `logicalName` before the collection, so handing it the real alias would cut
   * the live project loose. The alias-keyed stores are never touched.
   *
   * Refuses — records a failure and removes nothing — when the name is not a
   * `_vN` generation of `logicalName`, when it is the alias target, or when the
   * aliases cannot be read and the generation therefore cannot be proven dead.
   */
  async purgeGeneration(input: CollectionGenerationPurgeInput): Promise<CollectionPurgeReport> {
    const { logicalName, physicalName } = input;
    const failures: CollectionPurgeFailure[] = [];
    const report = (aliasTarget: PhysicalCollectionName | null, qdrantCollections: string[], codegraph: string[]) => ({
      collectionName: logicalName,
      qdrantAlias: aliasTarget,
      qdrantCollections,
      codegraphDatabases: codegraph,
      clearedStores: [] as ArtifactId[],
      kept: [] as string[],
      failures,
    });

    if (!new RegExp(`^${escapeRegExp(logicalName)}_v\\d+$`).test(physicalName)) {
      failures.push({
        artifact: "qdrant",
        target: physicalName,
        reason: `'${physicalName}' is not a versioned generation of '${logicalName}'`,
      });
      return report(null, [], []);
    }

    let aliasTarget: PhysicalCollectionName | null;
    try {
      const aliases = await this.deps.qdrant.aliases.listAliases();
      aliasTarget = aliases.find((a) => a.aliasName === logicalName)?.collectionName ?? null;
    } catch (err) {
      failures.push({
        artifact: "qdrant",
        target: physicalName,
        reason: `cannot read aliases (${describe(err)}) — refusing`,
      });
      return report(null, [], []);
    }
    if (aliasTarget === physicalName) {
      failures.push({
        artifact: "qdrant",
        target: physicalName,
        reason: `live generation of '${logicalName}' — refusing to purge it`,
      });
      return report(aliasTarget, [], []);
    }

    const onDisk = this.enumerateCodegraph(logicalName, failures).includes(physicalName);
    await this.removeArtifacts("physical", this.contextFor(physicalName, physicalName), physicalName, failures);
    return report(
      aliasTarget,
      await this.verifyQdrantGone([physicalName], failures),
      onDisk ? this.verifyCodegraphGone(logicalName, [physicalName], failures) : [],
    );
  }

  /**
   * Clears the alias-keyed stores (snapshot, stats, quarantine, skip record,
   * a dead run's lock, residual verdicts) of collections that have nothing left
   * in Qdrant — one logical half of the saga per name, with Qdrant read ONCE for
   * the whole batch. `purge` would list collections and aliases per name, which
   * on a store polluted with ~130k leftovers is minutes of round-trips.
   *
   * A name that still has an alias or a `^<name>(_v\d+)?$` collection is not a
   * leftover and is refused, as is every name when Qdrant cannot be read.
   */
  async purgeStoreLeftovers(
    logicalNames: readonly string[],
    options: {
      progressEvery?: number;
      onProgress?: (done: number, total: number) => void;
      /** Snapshot-dir entries per logical name, already listed by the caller (see `knownStoreEntries`). */
      storeEntries?: ReadonlyMap<string, readonly string[]>;
    } = {},
  ): Promise<StoreLeftoverPurgeReport> {
    const failures: CollectionPurgeFailure[] = [];
    const purged: string[] = [];
    let aliasNames: Set<string>;
    const generationByBase = new Map<string, string>();
    try {
      const [collections, aliases] = await Promise.all([
        this.deps.qdrant.listCollections(),
        this.deps.qdrant.aliases.listAliases(),
      ]);
      aliasNames = new Set(aliases.map((a) => a.aliasName));
      for (const name of collections) generationByBase.set(name.replace(GENERATION_SUFFIX, ""), name);
    } catch (err) {
      const reason = `cannot read Qdrant (${describe(err)}) — refusing`;
      return { purged, failures: logicalNames.map((target) => ({ artifact: "snapshot", target, reason })) };
    }

    const total = logicalNames.length;
    const every = options.progressEvery ?? 1000;
    // Per-name outcomes land in input order whatever order the pool finishes in.
    const outcomes = new Array<{ purged: boolean; failures: CollectionPurgeFailure[] }>(total);
    let done = 0;
    let next = 0;
    const sweepOne = async (logical: string): Promise<{ purged: boolean; failures: CollectionPurgeFailure[] }> => {
      const generation = generationByBase.get(logical);
      if (aliasNames.has(logical)) {
        const reason = `alias '${logical}' is live — not a store leftover`;
        return { purged: false, failures: [{ artifact: "snapshot", target: logical, reason }] };
      }
      if (generation !== undefined) {
        const reason = `Qdrant still holds ${generation} — not a store leftover`;
        return { purged: false, failures: [{ artifact: "snapshot", target: logical, reason }] };
      }
      const own: CollectionPurgeFailure[] = [];
      const { storeEntries } = options;
      const context = {
        ...this.contextFor(logical, resolvePhysicalCollection(logical, [])),
        ...(storeEntries ? { knownStoreEntries: storeEntries.get(logical) ?? [] } : {}),
      };
      await this.removeArtifacts("logical", context, logical, own);
      return { purged: own.length === 0, failures: own };
    };
    const worker = async (): Promise<void> => {
      while (next < total) {
        const index = next++;
        outcomes[index] = await sweepOne(logicalNames[index] ?? "");
        done += 1;
        if (options.onProgress && (done % every === 0 || done === total)) options.onProgress(done, total);
      }
    };
    // Every name is independent file I/O; a small pool overlaps the syscalls.
    await Promise.all(Array.from({ length: Math.min(STORE_LEFTOVER_CONCURRENCY, total) }, worker));
    outcomes.forEach((outcome, index) => {
      if (outcome.purged) purged.push(logicalNames[index] ?? "");
      failures.push(...outcome.failures);
    });
    return { purged, failures };
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
    let physicalCollectionNames: PhysicalCollectionName[];
    try {
      physicalCollectionNames = (await this.deps.qdrant.listCollections()).filter((physicalCollectionName) =>
        pattern.test(physicalCollectionName),
      );
    } catch (err) {
      failures.push({ artifact: "qdrant", target: logical, reason: describe(err) });
      physicalCollectionNames = [resolvePhysicalCollection(logical, [])];
    }

    let aliasTargetPhysicalCollectionName: PhysicalCollectionName | null = null;
    try {
      const aliases = await this.deps.qdrant.aliases.listAliases();
      aliasTargetPhysicalCollectionName = aliases.find((a) => a.aliasName === logical)?.collectionName ?? null;
    } catch {
      // Older servers have no alias API, and an unreachable one already failed
      // above. The pattern match stands on its own.
    }

    const qdrantTargetPhysicalCollectionNames = [
      ...new Set([
        ...physicalCollectionNames,
        ...(aliasTargetPhysicalCollectionName ? [aliasTargetPhysicalCollectionName] : []),
      ]),
    ];
    return { qdrantTargets: qdrantTargetPhysicalCollectionNames, aliasTarget: aliasTargetPhysicalCollectionName };
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
  private contextFor(
    logicalName: string,
    physicalCollectionName: PhysicalCollectionName,
    path?: string,
  ): FootprintContext {
    const resolved: ResolvedCollection = {
      logicalName,
      physicalName: physicalCollectionName,
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
