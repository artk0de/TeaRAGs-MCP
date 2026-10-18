/**
 * Runs the residual resolution pass against one collection generation: opens
 * the project's verdict store, takes the graph's write handle, builds the
 * provider and reads method sources from the working tree. Never throws — a
 * failure of any of those ends the pass `skipped`, and indexing carries on.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import { ResidualVerdictStore } from "../../../adapters/duckdb/residual-verdict-store.js";
import { GraphClassTieReader } from "../../../domains/trajectory/codegraph/residual/interface-fanout.js";
import {
  RESIDUAL_MODELS,
  ResidualModelProviderFactory,
} from "../../../domains/trajectory/codegraph/residual/residual-model-provider-factory.js";
import { ResidualResolutionPass } from "../../../domains/trajectory/codegraph/residual/residual-resolution-pass.js";
import type {
  ResidualModelProvider,
  ResidualPassReport,
} from "../../../domains/trajectory/codegraph/residual/types.js";
import { recomputeGraphMetrics } from "../../../domains/trajectory/codegraph/symbols/index.js";
import {
  skippedResidualReport,
  type ResidualAfterIndexRequest,
  type ResidualResolvePort,
  type ResidualResolvePortRequest,
} from "./residual-resolve-port.js";

/** `codegraph.residual` as the pass reads it. */
export interface ResidualResolutionConfig {
  kevUrls?: readonly string[];
  kevThreshold: number;
  concurrency: number;
  /** Per-request Kev budget, seconds. */
  requestTimeoutSec?: number;
  /** Questions one provider request may carry. */
  maxQuestionsPerRequest?: number;
  /** Candidates one provider request may carry over all its questions. */
  maxCriteriaPerRequest?: number;
  menuLimit: number;
  /** Smallest menu the pass asks about or applies. */
  minMenu: number;
  /** Smallest `p` of a "none of these" verdict that counts its site as external. */
  noneThreshold: number;
  /** Smallest `p` of a tournament block winner that enters the next round. */
  tournamentFloor?: number;
  /** Tournament block questions one pass may send. */
  tournamentBudget?: number;
  /** Smallest `p` of a class for it to join a polymorphic-interface fan-out. */
  fanoutFloor?: number;
  /** Ask mid picks once more as `[pick, none]`; plain tournament rounds off. */
  confirmStage?: boolean;
  /** Append receiver origins to each question's state; verdicts are keyed under the variant. */
  originContext?: boolean;
  /** Accept threshold for a name-prior block-1 pick and the confirm of one; unset = `kevThreshold`. */
  namePriorAcceptThreshold?: number;
  retentionDays: number;
  /** GPU session broker; set, an `ask` pass with uncached sites leases Kev from it. */
  kevSessionUrl?: string;
  kevSessionToken?: string;
}

type VerdictStoreHandle = Pick<ResidualVerdictStore, "find" | "findLatest" | "put" | "touch" | "expire" | "close">;

export interface ResidualResolutionOpsDeps {
  /** The codegraph root; the store lives at `<rootDir>/residual-verdicts/<logicalName>.duckdb`. */
  rootDir: string;
  codegraphPool: Pick<GraphDbClientPool, "acquireWrite">;
  config: ResidualResolutionConfig;
  /** Builds the provider an `ask` pass queries. Defaults to the factory over `config`. */
  createProvider?: (model: string) => ResidualModelProvider;
  now?: () => number;
}

/** Wave 1 records verdicts for one model only; a `cacheOnly` re-apply restores its edges. */
const RECORDED_MODEL = RESIDUAL_MODELS[0];

export class ResidualResolutionOps implements ResidualResolvePort {
  private readonly createProvider: (model: string) => ResidualModelProvider;
  private readonly now: () => number;
  readonly thresholds: Readonly<Record<string, number>>;

  constructor(private readonly deps: ResidualResolutionOpsDeps) {
    this.createProvider = deps.createProvider ?? ((model) => ResidualModelProviderFactory.create(model, deps.config));
    this.now = deps.now ?? Date.now;
    this.thresholds = Object.fromEntries(
      RESIDUAL_MODELS.map((model) => [model, ResidualModelProviderFactory.cacheOnly(model, deps.config).threshold]),
    );
  }

  /**
   * The pass an index run ends with: asks `model` when the run named one;
   * otherwise re-applies the stored verdicts (`cacheOnly`) when the project has
   * any, because the run's static re-walk dropped the changed files' model
   * edges. No model and no verdicts → no pass, `undefined`.
   */
  async resolveAfterIndex(request: ResidualAfterIndexRequest): Promise<ResidualPassReport | undefined> {
    if (request.model !== undefined) return this.resolve({ ...request, model: request.model, mode: "ask" });
    if (!existsSync(ResidualVerdictStore.pathFor(this.deps.rootDir, request.logicalName))) return undefined;
    return this.resolve({ ...request, model: RECORDED_MODEL, mode: "cacheOnly" });
  }

  async resolve(request: ResidualResolvePortRequest): Promise<ResidualPassReport> {
    const mode = request.mode ?? "ask";
    let store: VerdictStoreHandle | undefined;
    try {
      const provider =
        mode === "ask"
          ? this.createProvider(request.model)
          : ResidualModelProviderFactory.cacheOnly(request.model, this.deps.config);
      store = await ResidualVerdictStore.open(this.deps.rootDir, request.logicalName);
      const { graphDb } = await this.deps.codegraphPool.acquireWrite(request.physicalCollectionName);
      const readSource = async (relPath: string) => readFile(join(request.projectRoot, relPath), "utf8");
      const pass = new ResidualResolutionPass();
      const input = {
        graphDb,
        store,
        provider,
        mode,
        concurrency: this.deps.config.concurrency,
        ...(this.deps.config.maxQuestionsPerRequest === undefined
          ? {}
          : { maxQuestionsPerRequest: this.deps.config.maxQuestionsPerRequest }),
        ...(this.deps.config.maxCriteriaPerRequest === undefined
          ? {}
          : { maxCriteriaPerRequest: this.deps.config.maxCriteriaPerRequest }),
        menuLimit: this.deps.config.menuLimit,
        minMenu: this.deps.config.minMenu,
        noneThreshold: this.deps.config.noneThreshold,
        ...(this.deps.config.tournamentFloor === undefined
          ? {}
          : { tournamentFloor: this.deps.config.tournamentFloor }),
        ...(this.deps.config.tournamentBudget === undefined
          ? {}
          : { tournamentBudget: this.deps.config.tournamentBudget }),
        ...(this.deps.config.confirmStage === undefined ? {} : { confirmStage: this.deps.config.confirmStage }),
        ...(this.deps.config.fanoutFloor === undefined ? {} : { fanoutFloor: this.deps.config.fanoutFloor }),
        classTies: new GraphClassTieReader(graphDb, readSource),
        ...(this.deps.config.originContext === undefined ? {} : { originContext: this.deps.config.originContext }),
        ...(this.deps.config.namePriorAcceptThreshold === undefined
          ? {}
          : { namePriorAcceptThreshold: this.deps.config.namePriorAcceptThreshold }),
        retentionDays: this.deps.config.retentionDays,
        recomputeDerived: async () => recomputeGraphMetrics(graphDb),
        readMethodSource: async (relPath: string, startLine: number, endLine: number) =>
          sliceLines(await readFile(join(request.projectRoot, relPath), "utf8"), startLine, endLine),
        readSourceFile: readSource,
        now: this.now,
        ...(request.onProgress ? { onProgress: request.onProgress } : {}),
      };
      // A brokered provider leases the GPU inside the pass, which alone knows whether any site misses the cache.
      return await pass.run(input);
    } catch (error) {
      return skippedResidualReport(error instanceof Error ? error.message : String(error), mode);
    } finally {
      await store?.close().catch(() => undefined);
    }
  }
}

/** Lines `startLine..endLine`, 1-based and inclusive. */
function sliceLines(text: string, startLine: number, endLine: number): string {
  return text
    .split("\n")
    .slice(startLine - 1, endLine)
    .join("\n");
}
