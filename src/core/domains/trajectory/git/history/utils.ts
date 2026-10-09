/**
 * Extract task IDs from commit message text.
 * Supports JIRA (TD-1234), GitHub (#123), Azure DevOps (AB#123), GitLab (!123).
 *
 * Provider-agnostic — works with any VCS commit message format.
 */
export function extractTaskIds(text: string): string[] {
  if (!text) return [];

  const taskIds = new Set<string>();

  // JIRA/Linear style: ABC-123
  const jiraPattern = /\b([A-Z]{2,10}-\d{1,6})\b/g;
  let match;
  while ((match = jiraPattern.exec(text)) !== null) {
    taskIds.add(match[1]);
  }

  // GitHub style: #123 (not preceded by &)
  const githubPattern = /(?:^|[^&])#(\d{1,7})\b/g;
  while ((match = githubPattern.exec(text)) !== null) {
    taskIds.add(`#${match[1]}`);
  }

  // Azure DevOps: AB#123
  const azurePattern = /\bAB#(\d{1,7})\b/g;
  while ((match = azurePattern.exec(text)) !== null) {
    taskIds.add(`AB#${match[1]}`);
  }

  // GitLab MR: !123
  const gitlabPattern = /!(\d{1,7})\b/g;
  while ((match = gitlabPattern.exec(text)) !== null) {
    taskIds.add(`!${match[1]}`);
  }

  return Array.from(taskIds);
}

/**
 * Cosmetic/infrastructure patterns to EXCLUDE — not real bug fixes.
 * Checked against the full commit body (case-insensitive).
 */
const COSMETIC_PATTERN =
  /\bfix(?:e[sd])?\s+(?:typo|lint|linter|format|formatting|style|whitespace|indentation|imports?|tests?|specs?|flaky|rubocop|eslint|prettier|ci|pipeline|migration|review|code\s*review|conflicts?)\b/i;

const TEXT_FIX_PATTERN = /\btext\s+fix(?:es)?\b/i;

/**
 * Strong positive signals — conventional commits and explicit tags.
 * Checked against the SUBJECT line only.
 */
const CONVENTIONAL_FIX = /^(?:hot)?fix(?:\([^)]+\))?!?:/i;
const TAG_FIX = /^\[(?:Fix|Bug|Hotfix|Bugfix)\]/i;

/**
 * Ticket + Fix verb: "[TD-123] Fix ..." or "TD-123 Fix ..." or "[PROJ-456] fixed ..."
 * Checked against the SUBJECT line only.
 */
const TICKET_FIX = /^\[?[A-Z]+-\d+\]?\s+(?:fix|fixed|fixes)\b/i;

/**
 * GitHub/GitLab closing keywords in body: "fixes #123", "resolves #456", "closes #789"
 * Checked against the FULL body.
 */
const CLOSES_ISSUE = /\b(?:fix|fixe[sd]|resolve[sd]?|close[sd]?)\s+#\d+/i;

export const MERGE_SUBJECT = /^Merge\b/i;

/**
 * Combined bug-fix check: merge branch prefix OR commit message.
 * Used by file-reader and chunk-reader for final classification.
 */
export function isBugFixCommitOrBranch(body: string, sha: string, bugFixShas: Set<string>): boolean {
  if (bugFixShas.has(sha)) return true;
  return isBugFixCommit(body);
}

/**
 * Check if a commit is a bug fix based on its message.
 *
 * Classification rules (in order):
 * 1. Skip merge commits — branch prefix is handled by merge-branch-resolver
 * 2. Exclude cosmetic patterns (fix typo, fix lint, fix tests, etc.)
 * 3. Match conventional prefix: fix:, hotfix:, fix(scope):
 * 4. Match explicit tag: [Fix], [Bug], [HOTFIX], [Bugfix]
 * 5. Match ticket + Fix verb: [TD-123] Fix ..., TD-456 fixed ...
 * 6. Match GitHub closing keywords: fixes #123, resolves #456
 */
export function isBugFixCommit(body: string): boolean {
  const subject = body.split("\n")[0];

  // 1. Skip merge commits
  if (MERGE_SUBJECT.test(subject)) return false;

  // 2. Exclude cosmetic/infrastructure fixes
  if (COSMETIC_PATTERN.test(body)) return false;
  if (TEXT_FIX_PATTERN.test(body)) return false;

  // 3. Conventional commit prefix
  if (CONVENTIONAL_FIX.test(subject)) return true;

  // 4. Explicit tag
  if (TAG_FIX.test(subject)) return true;

  // 5. Ticket + Fix verb
  if (TICKET_FIX.test(subject)) return true;

  // 6. GitHub/GitLab closing keywords (anywhere in body)
  if (CLOSES_ISSUE.test(body)) return true;

  return false;
}
