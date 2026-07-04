/**
 * Selects the git adapter implementation for `GIT_ADAPTER` (closed enum).
 *
 * Fail-loud contract: `es-git` is an explicit opt-in — when its binding
 * cannot load, creation throws `VcsAdapterUnavailableError` with an
 * agent-executable install hint. There is no silent runtime fallback; the
 * escape hatch is setting `GIT_ADAPTER=git`.
 */

import { ConfigValueInvalidError } from "../../infra/errors.js";
import { VcsAdapterUnavailableError } from "./errors.js";
import type { VcsGitAdapter } from "./git/adapter.js";
import { GitCliAdapter } from "./git/git-cli/adapter.js";
import type { GitAdapterKind } from "./types.js";

export class VcsAdapterFactory {
  static async create(adapter: GitAdapterKind, repoRoot: string): Promise<VcsGitAdapter> {
    switch (adapter) {
      case "git":
        return new GitCliAdapter(repoRoot);
      case "es-git": {
        try {
          const { EsGitAdapter } = await import("./git/es-git/adapter.js");
          return await EsGitAdapter.open(repoRoot);
        } catch (err) {
          if (err instanceof VcsAdapterUnavailableError) throw err;
          throw new VcsAdapterUnavailableError("es-git", err instanceof Error ? err.message : String(err));
        }
      }
      default:
        return Promise.reject(
          new ConfigValueInvalidError("vcs.adapter", String(adapter satisfies never), "GIT_ADAPTER=git | es-git"),
        );
    }
  }
}
