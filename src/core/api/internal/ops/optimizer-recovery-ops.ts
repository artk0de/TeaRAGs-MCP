/**
 * `tea-rags qdrant recover` — clear a failed Qdrant optimizer (bd tea-rags-mcp-ye5o).
 *
 * Qdrant 1.18 (#8767) recreates a collection's optimizer on a collection update
 * and clears the error the old one recorded. This op is the ONE write path for
 * that recovery, run on explicit operator request: `get_index_status` and
 * `prime` only report a failed optimizer and print {@link renderOptimizerRecoveryCommand},
 * so a read never mutates Qdrant.
 *
 * The op addresses the PHYSICAL collection: the registry holds the alias, and
 * the update is a config write, which belongs on the collection the alias
 * currently points at.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { QdrantOptimizerErrorPersistsError } from "../../../adapters/qdrant/errors.js";
import {
  isOptimizerFailure,
  type OptimizerRecoveryOutcome,
  type OptimizerRecoveryTarget,
} from "../../../contracts/optimizer-recovery.js";
import { NotIndexedError } from "../../../domains/ingest/errors.js";
import type { CollectionRegistry } from "../../../domains/maintenance/registry/collection-registry.js";
import { resolveCollection } from "../collection-resolver.js";

export interface OptimizerRecoveryDeps {
  registry: CollectionRegistry;
  qdrant: Pick<QdrantManager, "reapplyOptimizerConfig" | "collectionExists"> & {
    getCollectionInfo: (name: string) => Promise<{ optimizerStatus: string }>;
    aliases: Pick<QdrantManager["aliases"], "resolveActive">;
  };
}

export class OptimizerRecoveryOps {
  constructor(private readonly deps: OptimizerRecoveryDeps) {}

  /**
   * Re-apply the optimizer config when — and only when — the optimizer failed,
   * then re-read the status to prove the error is gone.
   *
   * @throws NotIndexedError when the project has no collection — a path that
   *   was never indexed still resolves to a derived name, and reading it would
   *   surface Qdrant's raw 404 instead (bd tea-rags-mcp-61bwb).
   * @throws QdrantOptimizerErrorPersistsError when the recreated optimizer
   *   still reports an error.
   */
  async recover(target: OptimizerRecoveryTarget): Promise<OptimizerRecoveryOutcome> {
    const { collectionName: alias, path } = resolveCollection(this.deps.registry, target);
    const collectionName = await this.deps.qdrant.aliases.resolveActive(alias);
    if (!(await this.deps.qdrant.collectionExists(collectionName))) {
      throw new NotIndexedError(path ?? target.project ?? alias);
    }

    const before = (await this.deps.qdrant.getCollectionInfo(collectionName)).optimizerStatus;
    if (!isOptimizerFailure(before)) {
      return { outcome: "nothing-to-do", collectionName, optimizerStatus: before };
    }

    await this.deps.qdrant.reapplyOptimizerConfig(collectionName);

    const after = (await this.deps.qdrant.getCollectionInfo(collectionName)).optimizerStatus;
    if (isOptimizerFailure(after)) {
      throw new QdrantOptimizerErrorPersistsError(collectionName, after);
    }
    return { outcome: "cleared", collectionName, previousOptimizerStatus: before, optimizerStatus: after };
  }
}
