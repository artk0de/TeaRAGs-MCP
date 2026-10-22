/**
 * The Rust resolve environment of the project a pass resolves (bd s3i8m.7).
 * `reload` — the pass-start seam — re-reads both halves; `forRoot` hands out
 * one record per loaded state, so the ctx copy is compared by reference.
 */
import type { ManifestFilesReader, RustExternalSignatureSources } from "../../../../contracts/types/language.js";
import { RustExternalSignatureTableCache } from "../external-signatures/table-cache.js";
import { RustResolveEnvironment } from "./resolve-environment.js";
import { RustWorkspaceCrateMapCache } from "./workspace-crates.js";

export class RustResolveEnvironmentCache {
  private readonly crateMaps: RustWorkspaceCrateMapCache;
  private readonly signatureTables: RustExternalSignatureTableCache;
  private bound: RustResolveEnvironment | undefined;

  constructor(manifestFilesReader?: ManifestFilesReader, signatureSources?: RustExternalSignatureSources) {
    this.crateMaps = new RustWorkspaceCrateMapCache(manifestFilesReader);
    this.signatureTables = new RustExternalSignatureTableCache(signatureSources);
  }

  reload(root: string | undefined): void {
    this.crateMaps.reload(root);
    this.signatureTables.reload(root);
  }

  forRoot(root: string | undefined): RustResolveEnvironment | undefined {
    const crates = this.crateMaps.forRoot(root);
    const signatures = this.signatureTables.forRoot(root);
    if (crates === undefined && signatures === undefined) return undefined;
    if (this.bound === undefined || this.bound.crates !== crates || this.bound.signatures !== signatures) {
      this.bound = new RustResolveEnvironment(crates, signatures);
    }
    return this.bound;
  }
}
