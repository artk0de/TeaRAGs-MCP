import { basename, dirname, join, resolve } from "node:path";

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { WorktreeCreateInput, WorktreeCreateResult, WorktreeRemoveInput } from "../../../contracts/index.js";
import {
  collectionAliasOfRegistryEntry,
  resolveCollectionName,
  resolvePhysicalCollection,
  validatePathSync,
  versionedPhysicalCollectionName,
} from "../../../infra/collection-name.js";
import { WorktreeCollectionExistsError, WorktreeNotFoundError, WorktreeSourceNotFoundError } from "../errors.js";
import { cloneCollectionFootprint } from "../footprint/clone-saga.js";
import type { CollectionFootprintFactory, ResolvedCollection } from "../footprint/index.js";
import type { CollectionRegistry } from "../registry/index.js";
import {
  ensureGitWorktree as defaultEnsureGitWorktree,
  removeGitWorktree as defaultRemoveGitWorktree,
} from "./git-worktree.js";

export interface WorktreeProvisionerDeps {
  registry: CollectionRegistry;
  qdrant: QdrantManager;
  footprintFactory: CollectionFootprintFactory;
  dataDir: string;
  /** Injectable for testing — defaults to the real git-worktree implementation. */
  ensureGitWorktree?: (repoRoot: string, name: string, targetPath: string, branch?: string) => boolean;
  /** Injectable for testing — defaults to the real git-worktree implementation. */
  removeGitWorktree?: (repoRoot: string, targetPath: string, force: boolean) => void;
}

/**
 * WorktreeProvisioner — the maintenance-domain command service for per-worktree
 * index clones. Owns the two state-mutating operations (clone with rollback /
 * teardown); read queries (list / info) live in the api layer over the registry
 * (CQS). Reached by the CLI exclusively through the `WorktreeOps` facade in
 * `api/internal/ops` — never directly (domain boundary).
 */
export class WorktreeProvisioner {
  private readonly ensureGitWorktree: NonNullable<WorktreeProvisionerDeps["ensureGitWorktree"]>;
  private readonly removeGitWorktree: NonNullable<WorktreeProvisionerDeps["removeGitWorktree"]>;

  constructor(private readonly deps: WorktreeProvisionerDeps) {
    this.ensureGitWorktree = deps.ensureGitWorktree ?? defaultEnsureGitWorktree;
    this.removeGitWorktree = deps.removeGitWorktree ?? defaultRemoveGitWorktree;
  }

  async create(input: WorktreeCreateInput): Promise<WorktreeCreateResult> {
    const { registry, qdrant, footprintFactory } = this.deps;

    const sourceEntry = input.from ? registry.findByName(input.from) : registry.findByPath(process.cwd());
    if (!sourceEntry) throw new WorktreeSourceNotFoundError(input.from ?? "cwd");

    // The clone's path is written into the registry and read back BY PATH by
    // every collection resolver, and `findByPath` is an exact compare against
    // realpath'd entries — so the spelling recorded here has to be canonical
    // (bd tea-rags-mcp-dxa9w). The worktree directory does not exist yet, so
    // canonicalize as far as the filesystem can answer: through the PARENT,
    // which does. That is what catches a symlinked ancestor (macOS `/var` →
    // `/private/var`), the case a bare `resolve` leaves as a spelling no reader
    // ever resolves to.
    const requestedPath = resolve(input.path ?? input.name);
    const worktreePath = join(validatePathSync(dirname(requestedPath)), basename(requestedPath));

    // "Already provisioned" is asked TWICE, because the two questions are
    // different and each catches what the other cannot.
    //
    // By PATH: a relocated entry's collection is not what its path hashes to,
    // so `get(hash)` alone would clone a second index on top of a live one.
    const occupant = registry.findByPath(worktreePath);
    if (occupant) throw new WorktreeCollectionExistsError(occupant.collectionName);

    const targetLogical = resolveCollectionName(worktreePath);

    // By NAME: the mirror case — an entry whose collectionName IS this hash but
    // whose path has moved away reads as a FREE directory, yet the clone would
    // land on its collection. The saga's tail is what makes that unrecoverable:
    // `record` overwrites the live project's entry, `setName` takes its alias,
    // and `setWorktreeProvenance` stamps it a clone — and `worktreeOf` is the
    // only thing standing between `worktree remove` and a real project.
    if (registry.get(targetLogical)) throw new WorktreeCollectionExistsError(targetLogical);

    const srcPhysical = await qdrant.aliases.resolveActive(sourceEntry.collectionName);

    const source: ResolvedCollection = {
      logicalName: sourceEntry.collectionName,
      physicalName: srcPhysical,
      path: sourceEntry.path,
      embeddingModel: sourceEntry.embeddingModel,
      embeddingDimensions: sourceEntry.embeddingDimensions,
      qdrantUrl: sourceEntry.qdrantUrl,
      codegraphEnabled: sourceEntry.codegraphEnabled ?? false,
    };

    const target: ResolvedCollection = {
      ...source,
      logicalName: targetLogical,
      // A clone is a brand-new collection: its first generation.
      physicalName: versionedPhysicalCollectionName(targetLogical, 1),
      path: worktreePath,
    };

    // C1: track whether we actually created a new git worktree (vs attached).
    const gitCreated = input.createGit
      ? this.ensureGitWorktree(sourceEntry.path, input.name, worktreePath, input.branch)
      : false;

    try {
      // C2 lives in the saga: each artifact joins the rollback BEFORE its clone.
      await cloneCollectionFootprint(footprintFactory, source, target);
    } catch (err) {
      // C1: roll back the git worktree if we created it.
      if (gitCreated) {
        try {
          this.removeGitWorktree(sourceEntry.path, worktreePath, true);
        } catch {
          /* best-effort */
        }
      }
      throw err;
    }

    const alias = `${sourceEntry.name ?? sourceEntry.collectionName}-worktree-${input.name}`;

    registry.record({
      collectionName: targetLogical,
      path: worktreePath,
      embeddingModel: source.embeddingModel,
      embeddingDimensions: source.embeddingDimensions,
      qdrantUrl: source.qdrantUrl,
      // The clone fronts the same Qdrant backend as its source, so inherit the
      // embedded flag — keeps a worktree reindex on the daemon marker, not the
      // source's frozen ephemeral port. Mirrors qdrantUrl propagation above.
      qdrantEmbedded: sourceEntry.qdrantEmbedded,
      // The clone indexes the same code against the same embedding backend, so
      // it inherits the endpoints its source was indexed against (mirrors
      // qdrantUrl / qdrantEmbedded above). Dropping them sent a worktree
      // reindex to the built-in default instead: on a remote-Ollama setup that
      // host is dead, so the run burned its recovery budget and died before
      // enrichment — the clone's graph then stayed exactly as stale as it was
      // cloned, with no repair pass and no recovery ever reached.
      ...(sourceEntry.embeddingBaseUrl !== undefined ? { embeddingBaseUrl: sourceEntry.embeddingBaseUrl } : {}),
      ...(sourceEntry.embeddingFallbackUrl !== undefined
        ? { embeddingFallbackUrl: sourceEntry.embeddingFallbackUrl }
        : {}),
      codegraphEnabled: source.codegraphEnabled,
      // The env snapshot travels with the clone — a worktree reindex in a
      // fresh shell re-applies the source project's index-time env set
      // registry-first (mirrors qdrantEmbedded / codegraphEnabled above).
      // Legacy sources carry it in the deprecated `tuning` field.
      ...(sourceEntry.env !== undefined || sourceEntry.tuning !== undefined
        ? { env: sourceEntry.env ?? sourceEntry.tuning }
        : {}),
      indexedAt: sourceEntry.indexedAt,
      teaRagsVersion: sourceEntry.teaRagsVersion,
      chunksCount: sourceEntry.chunksCount,
    });
    registry.setName(targetLogical, alias);
    registry.setWorktreeProvenance(targetLogical, sourceEntry.collectionName, input.name);
    // The clone's points ARE the source's — `cloneCollectionFootprint` copied
    // them — so the source's corpus-wide language stamp describes the clone as
    // exactly as it describes the source. It cannot ride along in `record()`:
    // that stickiness preserves an EXISTING entry's stamp (bd
    // tea-rags-mcp-frwka), and a fresh clone has no prior entry. Without this
    // the clone reads as version 1 for every language, and the drift monitor
    // tells the user to `--force` a full rebuild of data that is already
    // current — which is the one thing cloning exists to avoid.
    if (sourceEntry.languageVersions) {
      registry.stampLanguageVersions(targetLogical, sourceEntry.languageVersions);
    }

    return {
      collectionName: targetLogical,
      alias,
      sourceProject: sourceEntry.name ?? sourceEntry.collectionName,
      worktreePath,
    };
  }

  async remove(input: WorktreeRemoveInput): Promise<{ removed: boolean }> {
    const { registry, qdrant, footprintFactory } = this.deps;

    const entry = registry.findWorktree(input.name);
    if (!entry) throw new WorktreeNotFoundError(input.name);

    const srcPhysical = await qdrant.aliases
      .resolveActive(entry.worktreeOf as string)
      .catch(() => resolvePhysicalCollection(entry.worktreeOf as string, []));

    // Resolve source repo root for git worktree removal.
    const sourceEntry = registry.get(entry.worktreeOf as string);
    const sourceRepoRoot = sourceEntry?.path;

    const source: ResolvedCollection = {
      logicalName: entry.worktreeOf as string,
      physicalName: srcPhysical,
      path: sourceRepoRoot ?? "",
      embeddingModel: entry.embeddingModel,
      embeddingDimensions: entry.embeddingDimensions,
      qdrantUrl: entry.qdrantUrl,
      codegraphEnabled: entry.codegraphEnabled ?? false,
    };

    const targetPhysical = await qdrant.aliases
      .resolveActive(entry.collectionName)
      .catch(() => versionedPhysicalCollectionName(collectionAliasOfRegistryEntry(entry), 1));

    const target: ResolvedCollection = {
      ...source,
      logicalName: entry.collectionName,
      physicalName: targetPhysical,
      path: entry.path,
    };

    const { context, artifacts } = footprintFactory.build(source, target);
    for (const a of [...artifacts].reverse()) await a.remove(context).catch(() => undefined);

    registry.remove(entry.collectionName);

    if (!input.keepGit && sourceRepoRoot && entry.path) {
      this.removeGitWorktree(sourceRepoRoot, entry.path, input.force);
    }

    return { removed: true };
  }
}
