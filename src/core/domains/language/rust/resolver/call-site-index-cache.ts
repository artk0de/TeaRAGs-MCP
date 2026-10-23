/**
 * The rustc call-site index of the project a pass resolves (bd s3i8m T6),
 * acquired through the injected `RustCallSiteSource` by the shared
 * {@link RustPassIndexCache}.
 */
import type { SymbolResolutionPassPlan } from "../../../../contracts/types/codegraph.js";
import type {
  RustCallSiteAcquisition,
  RustCallSiteIndex,
  RustCallSiteSource,
} from "../../../../contracts/types/language.js";
import { RustPassIndexCache, type RustTestPathClassifier } from "./pass-index-cache.js";

/** The acquisition's observables for the pass-2 diagnostics block. */
export interface RustCallSiteDiagnostics {
  outcome: RustCallSiteAcquisition["kind"];
  reason?: string;
  cacheHit?: boolean;
  wallMs?: number;
}

export class RustCallSiteIndexCache {
  private readonly indexes: RustPassIndexCache<RustCallSiteIndex, RustCallSiteAcquisition>;

  constructor(rustCallSiteSource: RustCallSiteSource | undefined, isTestPath?: RustTestPathClassifier) {
    this.indexes = new RustPassIndexCache(
      rustCallSiteSource === undefined ? undefined : async (request) => rustCallSiteSource.acquire(request),
      (detail) => ({ kind: "latched", reason: "exit", detail }),
      isTestPath,
    );
  }

  /** Acquire the index for `plan.projectRoot`. Never rejects; a no-op without a source, a root or Rust files. */
  async warm(plan: SymbolResolutionPassPlan): Promise<void> {
    await this.indexes.warm(plan);
  }

  /** The index `warm` acquired for `root`; undefined for any other root or a non-indexed outcome. */
  forRoot(root: string | undefined): RustCallSiteIndex | undefined {
    return this.indexes.forRoot(root);
  }

  /** How the last acquisition settled; undefined before the first one. */
  diagnostics(): RustCallSiteDiagnostics | undefined {
    const acquisition = this.indexes.lastAcquisition();
    if (acquisition === undefined) return undefined;
    switch (acquisition.kind) {
      case "indexed":
        return {
          outcome: "indexed",
          cacheHit: acquisition.cacheHit,
          ...(acquisition.wallMs === undefined ? {} : { wallMs: acquisition.wallMs }),
        };
      case "latched":
      case "skipped":
        return { outcome: acquisition.kind, reason: acquisition.reason };
    }
  }
}
