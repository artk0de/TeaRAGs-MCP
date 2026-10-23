/**
 * The rust-analyzer SCIP index of the project a pass resolves (bd s3i8m.6 R2b),
 * acquired through the injected `RustAnalyzerScipSource` by the shared
 * {@link RustPassIndexCache}.
 */
import type { SymbolResolutionPassPlan } from "../../../../contracts/types/codegraph.js";
import type {
  RustAnalyzerScipAcquisition,
  RustAnalyzerScipIndex,
  RustAnalyzerScipSource,
} from "../../../../contracts/types/language.js";
import {
  RUST_PASS_INDEX_BULK_SHARE,
  rustPassIndexAdmission,
  RustPassIndexCache,
  type RustTestPathClassifier,
} from "./pass-index-cache.js";

export type { RustTestPathClassifier } from "./pass-index-cache.js";

/** Share of the project's non-test `.rs` files a pass must resolve to count as bulk. */
export const RUST_ANALYZER_SCIP_BULK_SHARE = RUST_PASS_INDEX_BULK_SHARE;

/** Bulk admission for a rust-analyzer spawn — {@link rustPassIndexAdmission}. */
export const rustAnalyzerScipAdmission = rustPassIndexAdmission;

/** The acquisition's observables for the pass-2 diagnostics block. */
export interface RustAnalyzerScipDiagnostics {
  outcome: RustAnalyzerScipAcquisition["kind"];
  reason?: string;
  cacheHit?: boolean;
  toolchainSkew?: boolean;
  wallMs?: number;
  peakRssMb?: number;
}

export class RustAnalyzerScipIndexCache {
  private readonly indexes: RustPassIndexCache<RustAnalyzerScipIndex, RustAnalyzerScipAcquisition>;

  constructor(rustAnalyzerScipSource: RustAnalyzerScipSource | undefined, isTestPath?: RustTestPathClassifier) {
    this.indexes = new RustPassIndexCache(
      rustAnalyzerScipSource === undefined ? undefined : async (request) => rustAnalyzerScipSource.acquire(request),
      (detail) => ({ kind: "latched", reason: "exit", detail }),
      isTestPath,
    );
  }

  /** Acquire the index for `plan.projectRoot`. Never rejects; a no-op without a source, a root or Rust files. */
  async warm(plan: SymbolResolutionPassPlan): Promise<void> {
    await this.indexes.warm(plan);
  }

  /** The index `warm` acquired for `root`; undefined for any other root or a non-indexed outcome. */
  forRoot(root: string | undefined): RustAnalyzerScipIndex | undefined {
    return this.indexes.forRoot(root);
  }

  /** How the last acquisition settled; undefined before the first one. */
  diagnostics(): RustAnalyzerScipDiagnostics | undefined {
    const acquisition = this.indexes.lastAcquisition();
    if (acquisition === undefined) return undefined;
    switch (acquisition.kind) {
      case "indexed":
        return {
          outcome: "indexed",
          cacheHit: acquisition.cacheHit,
          toolchainSkew: acquisition.toolchainSkew,
          ...(acquisition.wallMs === undefined ? {} : { wallMs: acquisition.wallMs }),
          ...(acquisition.peakRssMb === undefined ? {} : { peakRssMb: acquisition.peakRssMb }),
        };
      case "latched":
      case "skipped":
        return { outcome: acquisition.kind, reason: acquisition.reason };
    }
  }
}
