/**
 * A per-pass compiler index of the project a Rust pass resolves — the
 * rust-analyzer SCIP index (bd s3i8m.6 R2b) or the rustc call-site index
 * (bd s3i8m T6). `warm` — awaited before pass 2 — acquires it through an
 * injected port; `forRoot` hands it out synchronously to the resolve
 * environment. One acquisition per root is in flight at a time, so an earlier
 * kick-off and the pass-start warm share it.
 */
import type { SymbolResolutionPassPlan } from "../../../../contracts/types/codegraph.js";
import { buildTestPathFilter } from "../../../../primitives/paths/index.js";

/** Share of the project's non-test `.rs` files a pass must resolve to count as bulk. */
export const RUST_PASS_INDEX_BULK_SHARE = 0.5;

/** Whether a repo-relative path is a test file, as the codegraph extraction classifies it. */
export type RustTestPathClassifier = (relPath: string) => boolean;

/** Whether an acquisition that misses its cache may spawn the compiler tool. */
export type RustPassIndexAdmission = (projectRustRelPaths: readonly string[]) => "spawn" | "reuseOnly";

/** The settled shapes every compiler-index port answers with; ports may add fields. */
export type RustPassIndexAcquisition<TIndex> =
  | { kind: "indexed"; index: TIndex }
  | { kind: "latched"; reason: string; detail: string }
  | { kind: "skipped"; reason: string };

/** A port's acquire call, never expected to reject. */
export type RustPassIndexAcquire<TAcquisition> = (request: {
  projectRoot: string;
  admission: RustPassIndexAdmission;
}) => Promise<TAcquisition>;

/**
 * Bulk admission: a pass may spawn the compiler tool only when it resolves at
 * least {@link RUST_PASS_INDEX_BULK_SHARE} of the project's NON-TEST `.rs`
 * files. Both sides count non-test files only — the pass's own files are the
 * extraction's, which already excludes tests — so a test-heavy crate's full
 * run still counts as bulk.
 */
export function rustPassIndexAdmission(
  expectedFileCount: number,
  isTestPath: RustTestPathClassifier,
): RustPassIndexAdmission {
  return (projectRustRelPaths) => {
    const nonTest = projectRustRelPaths.filter((relPath) => !isTestPath(relPath)).length;
    return expectedFileCount >= RUST_PASS_INDEX_BULK_SHARE * nonTest ? "spawn" : "reuseOnly";
  };
}

export class RustPassIndexCache<TIndex, TAcquisition extends RustPassIndexAcquisition<TIndex>> {
  private settled: { root: string; acquisition: TAcquisition } | undefined;
  private inFlight: { root: string; done: Promise<void> } | undefined;

  /** `latchedOnThrow` turns a port that broke its never-rejects contract into a settled refusal. */
  constructor(
    private readonly acquire: RustPassIndexAcquire<TAcquisition> | undefined,
    private readonly latchedOnThrow: (detail: string) => TAcquisition,
    private readonly isTestPath: RustTestPathClassifier = defaultTestPathClassifier(),
  ) {}

  /** Acquire the index for `plan.projectRoot`. Never rejects; a no-op without a port, a root or Rust files. */
  async warm(plan: SymbolResolutionPassPlan): Promise<void> {
    const root = plan.projectRoot;
    if (this.acquire === undefined || root === undefined || plan.expectedFileCount <= 0) return;
    if (this.inFlight?.root === root) return this.inFlight.done;
    const done = this.settle(this.acquire, root, plan.expectedFileCount);
    this.inFlight = { root, done };
    try {
      await done;
    } finally {
      if (this.inFlight?.done === done) this.inFlight = undefined;
    }
  }

  /** The index `warm` acquired for `root`; undefined for any other root or a non-indexed outcome. */
  forRoot(root: string | undefined): TIndex | undefined {
    const { settled } = this;
    if (settled === undefined || settled.root !== root || settled.acquisition.kind !== "indexed") return undefined;
    return settled.acquisition.index;
  }

  /** How the last acquisition settled; undefined before the first one. */
  lastAcquisition(): TAcquisition | undefined {
    return this.settled?.acquisition;
  }

  private async settle(
    acquire: RustPassIndexAcquire<TAcquisition>,
    root: string,
    expectedFileCount: number,
  ): Promise<void> {
    let acquisition: TAcquisition;
    try {
      acquisition = await acquire({
        projectRoot: root,
        admission: rustPassIndexAdmission(expectedFileCount, this.isTestPath),
      });
    } catch (error) {
      acquisition = this.latchedOnThrow(error instanceof Error ? error.message : String(error));
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
