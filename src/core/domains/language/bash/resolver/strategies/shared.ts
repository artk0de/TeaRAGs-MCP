/**
 * Shared inputs and helpers for the Bash symbol-resolution strategies.
 *
 * `ResolverConfig` is the per-resolver config every strategy receives by
 * constructor injection (the old `BashCallResolver(mode)` single argument).
 * `mapBashSourceToFile` is the one helper the import-narrowing strategy uses to
 * map a Bash `source ./other.sh` import path to a project-relative file — kept
 * here so it lives once and the orchestrator can re-export it.
 */

import { posix } from "node:path";

import type { AmbiguousResolveMode } from "../../../../../contracts/types/codegraph.js";

export interface ResolverConfig {
  mode: AmbiguousResolveMode;
}

export function mapBashSourceToFile(importText: string, callerFile: string): string {
  // Bash source paths are either absolute or relative to the caller.
  // Codegraph treats absolute paths as project-relative (caller never
  // passes shell-evaluated absolute paths like $HOME/.bashrc).
  const callerDir = posix.dirname(callerFile);
  return posix.normalize(posix.join(callerDir, importText));
}
