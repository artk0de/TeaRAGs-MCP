/**
 * Model edges in a tree graph (bd tea-rags-mcp-2m83f.39). The static re-walk
 * of a changed file drops its `origin = 'model'` rows, exactly as an index run's
 * does; an index run then re-applies the cached verdicts in a `cacheOnly`
 * residual pass, and a tree build does the same — the same pass, over the
 * clone, never asking a model. The pass rebuilds the model's FULL edge set from
 * the current residual sites, so a changed file's unchanged site gets its edge
 * back, a changed menu (stale verdict) gets none, and an unchanged file's edge
 * into a symbol the tree removed is dropped with its file edge.
 *
 * The verdict store belongs to the index run, which holds it READ_WRITE for its
 * whole residual pass. The build reads it READ_ONLY, once, and closes it before
 * applying: DuckDB refuses a read-only open while another process holds the
 * file read-write (and the other way round), so the build never keeps a pass
 * from opening it longer than one read, and a refused open degrades to "no
 * model edges for the changed files" instead of failing the graph.
 */
import { existsSync } from "node:fs";

import { ResidualVerdictStore } from "../../../../adapters/duckdb/residual-verdict-store.js";
import type { GraphDbClient } from "../../../../contracts/types/codegraph-storage.js";
import { ResidualModelProviderFactory } from "../residual/residual-model-provider-factory.js";
import { ResidualResolutionPass, type ResidualPassInput } from "../residual/residual-resolution-pass.js";
import type { ResidualVerdict } from "../residual/types.js";
import { recomputeGraphMetrics } from "../symbols/index.js";

/** Where a tree build finds the project's verdicts and how the index applies them. Plain data — crosses the IPC boundary. */
export interface WorkingTreeGraphResidualInput {
  /** The codegraph root; the store is `<verdictRootDir>/residual-verdicts/<logicalName>.duckdb`. */
  verdictRootDir: string;
  logicalName: string;
  /** The model whose verdicts are re-applied. */
  model: string;
  /** Smallest `p` applied as an edge — the model's configured threshold. */
  threshold: number;
  menuLimit: number;
  minMenu: number;
  /** Smallest `p` of a "none of these" verdict that counts its site as external. */
  noneThreshold: number;
  /** The verdicts were asked with receiver-origin context; they are keyed under that variant. */
  originContext?: boolean;
}

/** What the re-apply left: the model edges the tree graph holds, or why the changed files have none. */
export type TreeModelEdges = { stored: number } | { unavailable: string };

/**
 * Re-apply the cached verdicts over `graphDb`'s current residual sites.
 * Undefined when the project has no verdict store (nothing was ever resolved).
 * Never throws: a store that cannot be read, or an apply that fails, leaves the
 * graph with the walk's static edges and says why.
 */
export async function reapplyTreeModelEdges(
  graphDb: GraphDbClient,
  residual: WorkingTreeGraphResidualInput,
): Promise<TreeModelEdges | undefined> {
  if (!existsSync(ResidualVerdictStore.pathFor(residual.verdictRootDir, residual.logicalName))) return undefined;
  const input: ResidualPassInput = {
    graphDb,
    store: new ReadOnceVerdictReader(residual),
    provider: ResidualModelProviderFactory.cacheOnly(residual.model, { kevThreshold: residual.threshold }),
    mode: "cacheOnly",
    concurrency: 1,
    menuLimit: residual.menuLimit,
    minMenu: residual.minMenu,
    noneThreshold: residual.noneThreshold,
    ...(residual.originContext === undefined ? {} : { originContext: residual.originContext }),
    retentionDays: 0,
    recomputeDerived: async () => recomputeGraphMetrics(graphDb),
    readMethodSource: async () => Promise.reject(new Error("a cacheOnly pass reads no method source")),
    now: Date.now,
  };
  try {
    const report = await new ResidualResolutionPass().run(input);
    return { stored: report.edgesApplied };
  } catch (error) {
    return { unavailable: `model edges of changed files not re-applied: ${errorMessage(error)}` };
  }
}

/**
 * The verdict store as a `cacheOnly` pass reads it: one lookup, on a READ_ONLY
 * handle opened and closed around it. Retention (`touch` / `expire`) is the
 * index run's; a tree build only reads.
 */
class ReadOnceVerdictReader implements Pick<ResidualPassInput["store"], keyof ResidualPassInput["store"]> {
  constructor(private readonly residual: WorkingTreeGraphResidualInput) {}

  async findLatest(keys: { siteKey: string; menuHash: string }[], model: string): Promise<ResidualVerdict[]> {
    let store: ResidualVerdictStore;
    try {
      store = await ResidualVerdictStore.openReadOnly(this.residual.verdictRootDir, this.residual.logicalName);
    } catch (error) {
      throw new Error(`verdict store unreadable: ${errorMessage(error)}`, { cause: error });
    }
    try {
      return await store.findLatest(keys, model);
    } finally {
      await store.close();
    }
  }

  async find(): Promise<ResidualVerdict[]> {
    return Promise.reject(new Error("a cacheOnly pass looks verdicts up by findLatest"));
  }

  async put(): Promise<void> {
    return Promise.reject(new Error("a tree build never stores verdicts"));
  }

  async touch(): Promise<void> {
    // Retention is the index run's.
  }

  async expire(): Promise<number> {
    return 0;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
