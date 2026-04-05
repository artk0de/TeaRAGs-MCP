/**
 * Resolve bug-fix child commits from merge commit branch prefixes.
 *
 * Builds a Set<sha> of commits that belong to fix/, hotfix/, or bugfix/
 * branches by traversing the parent graph from merge commits' second parent.
 * Pure function — no I/O, no git CLI calls.
 */

import type { CommitInfo } from "../../../../adapters/git/types.js";

/**
 * Patterns that identify a merge commit as merging a bug-fix branch.
 * Matches GitLab ("Merge branch 'fix/...'") and GitHub ("Merge pull request #N from user/fix-...")
 */
const FIX_BRANCH_PATTERNS = [
  /Merge branch '(?:fix|hotfix|bugfix)\//i,
  /Merge pull request #\d+ from [^/]+\/(?:fix|hotfix|bugfix)[/-]/i,
];

function isBugFixMerge(subject: string): boolean {
  return FIX_BRANCH_PATTERNS.some((p) => p.test(subject));
}

/**
 * Build a Set of commit SHAs that belong to bug-fix branches.
 *
 * Algorithm:
 * 1. Index all commits by SHA for O(1) lookup
 * 2. Find merge commits (2+ parents) with fix/hotfix/bugfix branch prefix
 * 3. For each such merge: BFS from parent[1] (branch tip) through parent chain,
 *    stop when reaching parent[0] (mainline) or a commit not in our set
 * 4. All visited SHAs = bug-fix commits
 */
export function buildBugFixShaSet(commits: CommitInfo[]): Set<string> {
  const commitMap = new Map<string, CommitInfo>();
  for (const c of commits) {
    commitMap.set(c.sha, c);
  }

  const bugFixShas = new Set<string>();

  for (const c of commits) {
    if (!c.parents || c.parents.length < 2) continue;

    const subject = c.body.split("\n")[0];
    if (!isBugFixMerge(subject)) continue;

    const mainlineParent = c.parents[0];
    const branchTip = c.parents[1];

    // BFS from branch tip, stop at mainline
    const queue = [branchTip];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const sha = queue.shift()!;
      if (sha === mainlineParent || visited.has(sha)) continue;
      visited.add(sha);

      const node = commitMap.get(sha);
      if (!node) continue;

      bugFixShas.add(sha);

      for (const parent of node.parents) {
        if (!visited.has(parent) && parent !== mainlineParent) {
          queue.push(parent);
        }
      }
    }
  }

  return bugFixShas;
}
