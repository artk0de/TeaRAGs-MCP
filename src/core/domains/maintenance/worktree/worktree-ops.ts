import { resolve } from "node:path";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { resolveCollectionName } from "../../../infra/collection-name.js";
import type { CollectionRegistry } from "../../../infra/registry/index.js";
import type { CollectionArtifact, ResolvedCollection } from "../footprint/index.js";
import type { CollectionFootprintFactory } from "../footprint/index.js";
import { ensureGitWorktree, removeGitWorktree } from "./git-worktree.js";

export interface WorktreeOpsDeps {
  registry: CollectionRegistry;
  qdrant: QdrantManager;
  footprintFactory: CollectionFootprintFactory;
  dataDir: string;
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
  constructor(private readonly deps: WorktreeOpsDeps) {}

  async create(input: {
    name: string;
    from?: string;
    path?: string;
    createGit: boolean;
    branch?: string;
  }): Promise<WorktreeCreateResult> {
    const { registry, qdrant, footprintFactory } = this.deps;

    const sourceEntry = input.from ? registry.findByName(input.from) : registry.findByPath(process.cwd());
    if (!sourceEntry) throw new Error(`Source project not found (from=${input.from ?? "cwd"})`);

    const worktreePath = resolve(input.path ?? input.name);
    const targetLogical = resolveCollectionName(worktreePath);

    if (registry.get(targetLogical)) throw new Error(`Target collection already exists: ${targetLogical}`);

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

    if (input.createGit) {
      ensureGitWorktree(sourceEntry.path, input.name, worktreePath, input.branch);
    }

    const { context, artifacts } = footprintFactory.build(source, target);
    const done: CollectionArtifact[] = [];
    try {
      for (const a of artifacts) {
        await a.clone(context);
        done.push(a);
      }
    } catch (err) {
      for (const a of [...done].reverse()) await a.remove(context).catch(() => undefined);
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
    if (!entry) throw new Error(`'${input.name}' is not a worktree clone (refusing to remove)`);

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
      removeGitWorktree(sourceRepoRoot, entry.path, input.force);
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
