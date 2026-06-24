import { resolve } from "node:path";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { resolveCollectionName } from "../../../infra/collection-name.js";
import type { CollectionRegistry } from "../../../infra/registry/index.js";
import type { CollectionArtifact, ResolvedCollection } from "../footprint/index.js";
import type { CollectionFootprintFactory } from "../footprint/index.js";
import {
  WorktreeCollectionExistsError,
  WorktreeNotFoundError,
  WorktreeSourceNotFoundError,
} from "../errors.js";
import { ensureGitWorktree as defaultEnsureGitWorktree, removeGitWorktree as defaultRemoveGitWorktree } from "./git-worktree.js";

export interface WorktreeOpsDeps {
  registry: CollectionRegistry;
  qdrant: QdrantManager;
  footprintFactory: CollectionFootprintFactory;
  dataDir: string;
  /** Injectable for testing — defaults to the real git-worktree implementation. */
  ensureGitWorktree?: (repoRoot: string, name: string, targetPath: string, branch?: string) => boolean;
  /** Injectable for testing — defaults to the real git-worktree implementation. */
  removeGitWorktree?: (repoRoot: string, targetPath: string, force: boolean) => void;
}

export interface WorktreeCreateResult {
  collectionName: string;
  alias: string;
  sourceProject: string;
  worktreePath: string;
}

export interface WorktreeInfo {
  isWorktree: boolean;
  collectionName?: string;
  alias?: string;
  worktreeOf?: string;
  worktreeName?: string;
  chunksCount?: number;
}

export class WorktreeOps {
  private readonly ensureGitWorktree: NonNullable<WorktreeOpsDeps["ensureGitWorktree"]>;
  private readonly removeGitWorktree: NonNullable<WorktreeOpsDeps["removeGitWorktree"]>;

  constructor(private readonly deps: WorktreeOpsDeps) {
    this.ensureGitWorktree = deps.ensureGitWorktree ?? defaultEnsureGitWorktree;
    this.removeGitWorktree = deps.removeGitWorktree ?? defaultRemoveGitWorktree;
  }

  async create(input: {
    name: string;
    from?: string;
    path?: string;
    createGit: boolean;
    branch?: string;
  }): Promise<WorktreeCreateResult> {
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
    const gitCreated = input.createGit ? this.ensureGitWorktree(sourceEntry.path, input.name, worktreePath, input.branch) : false;

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
      codegraphEnabled: source.codegraphEnabled,
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

  async remove(input: { name: string; force: boolean; keepGit: boolean }): Promise<{ removed: boolean }> {
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

    const target: ResolvedCollection = {
      ...source,
      logicalName: entry.collectionName,
      physicalName: `${entry.collectionName}_v1`,
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

  list(): WorktreeInfo[] {
    return this.deps.registry.listWorktrees().map((e) => ({
      isWorktree: true,
      collectionName: e.collectionName,
      alias: e.name ?? undefined,
      worktreeOf: e.worktreeOf,
      worktreeName: e.worktreeName,
      chunksCount: e.chunksCount,
    }));
  }

  info(cwd: string): WorktreeInfo {
    const entry = this.deps.registry.findByPath(resolve(cwd));
    if (!entry || entry.worktreeOf === undefined) return { isWorktree: false };
    return {
      isWorktree: true,
      collectionName: entry.collectionName,
      alias: entry.name ?? undefined,
      worktreeOf: entry.worktreeOf,
      worktreeName: entry.worktreeName,
      chunksCount: entry.chunksCount,
    };
  }
}
