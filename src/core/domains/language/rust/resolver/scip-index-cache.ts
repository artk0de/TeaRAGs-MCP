/**
 * The rust-analyzer SCIP index of the project a pass resolves (bd s3i8m.6 R2b).
 * `warm` — awaited before pass 2 — acquires it through the injected
 * `RustAnalyzerScipSource`; `forRoot` hands it out synchronously to the resolve
 * environment. One acquisition per root is in flight at a time, so an earlier
 * kick-off and the pass-start warm share it.
 */
import type { SymbolResolutionPassPlan } from "../../../../contracts/types/codegraph.js";
import type {
  RustAnalyzerScipAcquisition,
  RustAnalyzerScipIndex,
  RustAnalyzerScipSource,
} from "../../../../contracts/types/language.js";
import { buildTestPathFilter } from "../../../../primitives/paths/index.js";

/** Share of the project's non-test `.rs` files a pass must resolve to count as bulk. */
export const RUST_ANALYZER_SCIP_BULK_SHARE = 0.5;

/** Whether a repo-relative path is a test file, as the codegraph extraction classifies it. */
export type RustTestPathClassifier = (relPath: string) => boolean;

/** The acquisition's observables for the pass-2 diagnostics block. */
export interface RustAnalyzerScipDiagnostics {
  outcome: RustAnalyzerScipAcquisition["kind"];
  reason?: string;
  cacheHit?: boolean;
  toolchainSkew?: boolean;
  wallMs?: number;
  peakRssMb?: number;
}

/**
 * Bulk admission: a pass may spawn rust-analyzer only when it resolves at least
 * {@link RUST_ANALYZER_SCIP_BULK_SHARE} of the project's NON-TEST `.rs` files.
 * Both sides count non-test files only — the pass's own files are the
 * extraction's, which already excludes tests — so a test-heavy crate's full run
 * still counts as bulk.
 */
export function rustAnalyzerScipAdmission(
  expectedFileCount: number,
  isTestPath: RustTestPathClassifier,
): (projectRustRelPaths: readonly string[]) => "spawn" | "reuseOnly" {
  return (projectRustRelPaths) => {
    const nonTest = projectRustRelPaths.filter((relPath) => !isTestPath(relPath)).length;
    return expectedFileCount >= RUST_ANALYZER_SCIP_BULK_SHARE * nonTest ? "spawn" : "reuseOnly";
  };
}

export class RustAnalyzerScipIndexCache {
  private settled: { root: string; acquisition: RustAnalyzerScipAcquisition } | undefined;
  private inFlight: { root: string; done: Promise<void> } | undefined;

  constructor(
    private readonly rustAnalyzerScipSource: RustAnalyzerScipSource | undefined,
    private readonly isTestPath: RustTestPathClassifier = defaultTestPathClassifier(),
  ) {}

  /** Acquire the index for `plan.projectRoot`. Never rejects; a no-op without a source, a root or Rust files. */
  async warm(plan: SymbolResolutionPassPlan): Promise<void> {
    const root = plan.projectRoot;
    if (this.rustAnalyzerScipSource === undefined || root === undefined || plan.expectedFileCount <= 0) return;
    if (this.inFlight?.root === root) return this.inFlight.done;
    const done = this.acquire(this.rustAnalyzerScipSource, root, plan.expectedFileCount);
    this.inFlight = { root, done };
    try {
      await done;
    } finally {
      if (this.inFlight?.done === done) this.inFlight = undefined;
    }
  }

  /** The index `warm` acquired for `root`; undefined for any other root or a non-indexed outcome. */
  forRoot(root: string | undefined): RustAnalyzerScipIndex | undefined {
    const { settled } = this;
    if (settled === undefined || settled.root !== root || settled.acquisition.kind !== "indexed") return undefined;
    return settled.acquisition.index;
  }

  /** How the last acquisition settled; undefined before the first one. */
  diagnostics(): RustAnalyzerScipDiagnostics | undefined {
    const acquisition = this.settled?.acquisition;
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

  private async acquire(
    rustAnalyzerScipSource: RustAnalyzerScipSource,
    root: string,
    expectedFileCount: number,
  ): Promise<void> {
    let acquisition: RustAnalyzerScipAcquisition;
    try {
      acquisition = await rustAnalyzerScipSource.acquire({
        projectRoot: root,
        admission: rustAnalyzerScipAdmission(expectedFileCount, this.isTestPath),
      });
    } catch (error) {
      acquisition = { kind: "latched", reason: "exit", detail: error instanceof Error ? error.message : String(error) };
    }
    this.settled = { root, acquisition };
  }
}

/** The installed test-file conventions, built on first use: the isolate installs them before any pass runs. */
function defaultTestPathClassifier(): RustTestPathClassifier {
  let filter: ReturnType<typeof buildTestPathFilter> | undefined;
  return (relPath) => {
    filter ??= buildTestPathFilter();
    return filter.ignores(relPath);
  };
}
