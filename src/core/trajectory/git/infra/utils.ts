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
