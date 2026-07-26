import { resolve } from "node:path";

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { WorktreeCreateInput, WorktreeCreateResult, WorktreeRemoveInput } from "../../../contracts/index.js";
import { resolveCollectionName } from "../../../infra/collection-name.js";
import type { CollectionRegistry } from "../registry/index.js";
import { WorktreeCollectionExistsError, WorktreeNotFoundError, WorktreeSourceNotFoundError } from "../errors.js";
import type { CollectionArtifact, CollectionFootprintFactory, ResolvedCollection } from "../footprint/index.js";
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

    const worktreePath = resolve(input.path ?? input.name);
    const targetLogical = resolveCollectionName(worktreePath);

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
      physicalName: `${targetLogical}_v1`,
      path: worktreePath,
    };

    // C1: track whether we actually created a new git worktree (vs attached).
    const gitCreated = input.createGit
      ? this.ensureGitWorktree(sourceEntry.path, input.name, worktreePath, input.branch)
      : false;

    const { context, artifacts } = footprintFactory.build(source, target);
    const done: CollectionArtifact[] = [];
    try {
      for (const a of artifacts) {
        // C2: push BEFORE clone so the failing artifact participates in rollback.
        done.push(a);
        await a.clone(context);
      }
    } catch (err) {
      for (const a of [...done].reverse()) await a.remove(context).catch(() => undefined);
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
      .catch(() => entry.worktreeOf as string);

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
      .catch(() => `${entry.collectionName}_v1`);

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
