/**
 * Task ids named by commit messages — the reader behind `git.*.taskIds`,
 * change-reasons and co-change bundle ids (bd tea-rags-mcp-8rcox).
 *
 * A `KEY-N` token is a ticket only when the PROJECT uses KEY as a ticket key:
 * the key must appear in an ANCHORED position (subject lead, conventional
 * scope, merge-branch name, after a closing/reference verb) in at least
 * {@link TASK_ID_KEY_MIN_ANCHORED_COMMITS} commits of the run window with at
 * least {@link TASK_ID_KEY_MIN_DISTINCT_NUMBERS} distinct numbers. An accepted
 * key then counts anywhere in a message. Without that statistical gate the
 * pattern read `UTF-8`, `SHA-256` and `LEVEL-2` as tickets. `#N` counts only
 * in a PR/issue context and only when the repository has a GitHub/GitLab
 * remote; `!N` (merge-request footers) never counts.
 *
 * The vocabulary is learned ONCE per run window and passed to every
 * extraction — never relearned per commit or per batch.
 */

/** Anchored commits a key needs before it counts as a ticket key. */
export const TASK_ID_KEY_MIN_ANCHORED_COMMITS = 10;
/** Distinct ticket numbers a key needs — one repeated number is a name (`UTF-8`), not a tracker. */
export const TASK_ID_KEY_MIN_DISTINCT_NUMBERS = 2;

/** What a run accepts as a task id. Structured-cloneable: it rides the chunk-walk worker job. */
export interface TaskIdVocabulary {
  /** Ticket keys (`TD`) learned from anchored positions. */
  readonly projectKeys: ReadonlySet<string>;
  /** The repository has a GitHub/GitLab remote: `#N` counts in PR/issue contexts. */
  readonly forgeIssueRefs: boolean;
}

/** Accepts nothing but explicit Azure DevOps ids — for a caller with no history to learn from. */
export const EMPTY_TASK_ID_VOCABULARY: TaskIdVocabulary = { projectKeys: new Set(), forgeIssueRefs: false };

const TICKET_ID = /\b([A-Z]{2,10})-(\d{1,6})\b/g;
const TICKET_ID_EXACT = /^([A-Z]{2,10})-(\d{1,6})$/;
const SUBJECT_BRACKET_LEAD = /^((?:\s*\[[A-Z]{2,10}-\d{1,6}\])+)/;
const SUBJECT_KEY_LEAD = /^([A-Z]{2,10}-\d{1,6}):/;
const CONVENTIONAL_SCOPE = /\b\w+\([^)]*?\b([A-Z]{2,10}-\d{1,6})\b[^)]*\)!?:/g;
const MERGE_BRANCH = /(?:branch|into)\s+'[^']*?\b([A-Z]{2,10}-\d{1,6})\b[^']*'/g;
const REFERENCE_VERB = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|see|part of)\s+([A-Za-z]{2,10}-\d{1,6})\b/gi;

const ISSUE_CONTEXT = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|PR|pull request|issue|pull)\s+#(\d{1,7})\b/gi;
const TRAILING_ISSUE = /\(#(\d{1,7})\)\s*$/gm;
const ISSUE_LINK = /\[#(\d{1,7})\]\(https?:\/\/[^)\s]*\/(?:issues|pull)\/\d+\)/g;
const AZURE_ID = /\bAB#(\d{1,7})\b/g;

/** Forge hosts whose `#N` names an issue or pull request. */
const FORGE_HOST_LABELS = new Set(["github", "gitlab"]);

/** The ticket ids a message names in an ANCHORED position — the evidence a key is a tracker key. */
function anchoredTicketIds(text: string): Set<string> {
  const subject = text.split("\n", 1)[0];
  const ids = new Set<string>();
  const lead = SUBJECT_BRACKET_LEAD.exec(subject) ?? SUBJECT_KEY_LEAD.exec(subject);
  if (lead) for (const m of lead[1].matchAll(TICKET_ID)) ids.add(m[0]);
  for (const m of subject.matchAll(CONVENTIONAL_SCOPE)) ids.add(m[1]);
  for (const m of text.matchAll(MERGE_BRANCH)) ids.add(m[1]);
  for (const m of text.matchAll(REFERENCE_VERB)) if (TICKET_ID_EXACT.test(m[1])) ids.add(m[1]);
  return ids;
}

/** True when the remote URL's host is a GitHub or GitLab instance (`gitlab.corp.dev` included). */
export function isForgeRemoteUrl(url: string): boolean {
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(url)?.[1] ?? /^(?:[^@/]+@)?([^/:]+):/.exec(url)?.[1];
  if (!host) return false;
  return host
    .toLowerCase()
    .split(".")
    .some((label) => FORGE_HOST_LABELS.has(label));
}

/**
 * Learn the run's vocabulary from its window's commit messages and the
 * repository's remote URLs.
 */
export function learnTaskIdVocabulary(messages: Iterable<string>, remoteUrls: readonly string[]): TaskIdVocabulary {
  const evidence = new Map<string, { commits: number; numbers: Set<string> }>();
  for (const message of messages) {
    if (!message) continue;
    const keysInCommit = new Set<string>();
    for (const id of anchoredTicketIds(message)) {
      const [, key, num] = TICKET_ID_EXACT.exec(id) ?? [];
      if (!key) continue;
      let keyEvidence = evidence.get(key);
      if (!keyEvidence) {
        keyEvidence = { commits: 0, numbers: new Set() };
        evidence.set(key, keyEvidence);
      }
      keyEvidence.numbers.add(num);
      if (!keysInCommit.has(key)) {
        keysInCommit.add(key);
        keyEvidence.commits += 1;
      }
    }
  }
  const projectKeys = new Set<string>();
  for (const [key, { commits, numbers }] of evidence) {
    if (commits >= TASK_ID_KEY_MIN_ANCHORED_COMMITS && numbers.size >= TASK_ID_KEY_MIN_DISTINCT_NUMBERS) {
      projectKeys.add(key);
    }
  }
  return { projectKeys, forgeIssueRefs: remoteUrls.some(isForgeRemoteUrl) };
}

/** Task ids a commit message names, under the run's learned vocabulary. */
export function extractTaskIds(text: string, vocabulary: TaskIdVocabulary): string[] {
  if (!text) return [];
  const taskIds = new Set<string>();
  for (const m of text.matchAll(TICKET_ID)) {
    if (vocabulary.projectKeys.has(m[1])) taskIds.add(m[0]);
  }
  if (vocabulary.forgeIssueRefs) {
    for (const pattern of [ISSUE_CONTEXT, TRAILING_ISSUE, ISSUE_LINK]) {
      for (const m of text.matchAll(pattern)) taskIds.add(`#${m[1]}`);
    }
  }
  for (const m of text.matchAll(AZURE_ID)) taskIds.add(`AB#${m[1]}`);
  return Array.from(taskIds);
}
