/**
 * The Rust resolve environment of the project a pass resolves (bd s3i8m.7).
 * `reload` — the pass-start seam — re-reads the crate map and signature table;
 * `warm` — awaited before it — acquires the rust-analyzer SCIP index
 * (bd s3i8m.6 R2b). `forRoot` hands out one record per loaded state, so the ctx
 * copy is compared by reference.
 */
import type { SymbolResolutionPassPlan } from "../../../../contracts/types/codegraph.js";
import type {
  ManifestFilesReader,
  RustAnalyzerScipSource,
  RustExternalSignatureSources,
} from "../../../../contracts/types/language.js";
import { RustExternalSignatureTableCache } from "../external-signatures/table-cache.js";
import { RustResolveEnvironment } from "./resolve-environment.js";
import { RustAnalyzerScipIndexCache, type RustAnalyzerScipDiagnostics } from "./scip-index-cache.js";
import { RustWorkspaceCrateMapCache } from "./workspace-crates.js";

export class RustResolveEnvironmentCache {
  private readonly crateMaps: RustWorkspaceCrateMapCache;
  private readonly signatureTables: RustExternalSignatureTableCache;
  private readonly scipIndexes: RustAnalyzerScipIndexCache;
  private bound: RustResolveEnvironment | undefined;

  constructor(
    manifestFilesReader?: ManifestFilesReader,
    signatureSources?: RustExternalSignatureSources,
    scipSource?: RustAnalyzerScipSource,
  ) {
    this.crateMaps = new RustWorkspaceCrateMapCache(manifestFilesReader);
    this.signatureTables = new RustExternalSignatureTableCache(signatureSources);
    this.scipIndexes = new RustAnalyzerScipIndexCache(scipSource);
  }

  async warm(plan: SymbolResolutionPassPlan): Promise<void> {
    await this.scipIndexes.warm(plan);
  }

  reload(root: string | undefined): void {
    this.crateMaps.reload(root);
    this.signatureTables.reload(root);
  }

  forRoot(root: string | undefined): RustResolveEnvironment | undefined {
    const crates = this.crateMaps.forRoot(root);
    const signatures = this.signatureTables.forRoot(root);
    const scip = this.scipIndexes.forRoot(root);
    if (crates === undefined && signatures === undefined && scip === undefined) return undefined;
    if (
      this.bound === undefined ||
      this.bound.crates !== crates ||
      this.bound.signatures !== signatures ||
      this.bound.scip !== scip
    ) {
      this.bound = new RustResolveEnvironment(crates, signatures, scip);
    }
    return this.bound;
  }

  scipDiagnostics(): RustAnalyzerScipDiagnostics | undefined {
    return this.scipIndexes.diagnostics();
  }
}
