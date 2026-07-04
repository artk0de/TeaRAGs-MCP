/**
 * In-process git adapter over the es-git binding (napi-rs / libgit2).
 *
 * Skeleton until w2dlu T9: `open()` fail-louds unconditionally. T9 replaces
 * this with the full independent VcsGitAdapter implementation validated
 * against GitCliAdapter by the equivalence suite.
 */

import { VcsAdapterUnavailableError } from "../../errors.js";
import type { VcsGitAdapter } from "../adapter.js";

export class EsGitAdapter {
  static async open(repoRoot: string): Promise<VcsGitAdapter> {
    void repoRoot;
    throw new VcsAdapterUnavailableError("es-git", "EsGitAdapter is not implemented yet (w2dlu T9)");
  }
}
