/**
 * Repo identity for the git cache namespaces — memoized.
 *
 * The identity is the shared git dir (`git rev-parse --git-common-dir`), so
 * every working tree over one object database lands in one cache namespace.
 * Resolving it costs a couple of filesystem reads, and the stores ask for it on
 * every load and save, so the answer is cached per working tree.
 *
 * A working tree's shared git dir cannot change while the process runs — moving
 * or re-linking a checkout means a new path, hence a new key — so an unbounded
 * process-lifetime memo is safe and stays small (one entry per indexed repo).
 */
import { resolveGitCommonDir } from "../../../../adapters/vcs/git/common-dir.js";

const identityByWorkingTree = new Map<string, string>();

/** Shared-git-dir identity for `repoRoot`; the path itself when not a repo. */
export function resolveRepoIdentity(repoRoot: string): string {
  const cached = identityByWorkingTree.get(repoRoot);
  if (cached !== undefined) return cached;

  const identity = resolveGitCommonDir(repoRoot);
  identityByWorkingTree.set(repoRoot, identity);
  return identity;
}

/** Drop the memo — tests that build throwaway repos under one path reuse it. */
export function clearRepoIdentityMemo(): void {
  identityByWorkingTree.clear();
}
