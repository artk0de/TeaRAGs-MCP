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
 * Hash-suffixed ids (`<prefix>-<5-char suffix>`, e.g. a tracker that mints
 * `acme-k3p9q`) count only under a prefix the window LEARNED (bd
 * tea-rags-mcp-0ik6q): named by at least {@link TASK_ID_HASH_PREFIX_MIN_COMMITS}
 * commits with at least {@link TASK_ID_HASH_PREFIX_MIN_DISTINCT_SUFFIXES}
 * distinct suffixes that look minted, not counted or spelled — see
 * {@link isHashSuffixPopulation} and {@link learnHashIdPrefixes}. A suffix must
 * hold a digit: on tea-rags that alone dropped 20 of 21 plain-word matches. A
 * dotted child id (`<prefix>-k3p9q.35.21`) is kept whole — it is its own task,
 * and folding it into the epic would make every commit of a program share one
 * ticket. With exactly one learned prefix a subject ending in ` (k3p9q)`
 * names `<prefix>-k3p9q`; with two the short form is ambiguous and dropped.
 *
 * The vocabulary is learned ONCE per run window and passed to every
 * extraction — never relearned per commit or per batch.
 */

/** Anchored commits a key needs before it counts as a ticket key. */
export const TASK_ID_KEY_MIN_ANCHORED_COMMITS = 10;
/** Distinct ticket numbers a key needs — one repeated number is a name (`UTF-8`), not a tracker. */
export const TASK_ID_KEY_MIN_DISTINCT_NUMBERS = 2;
/** Commits that must name a hash-id prefix before its ids count. */
export const TASK_ID_HASH_PREFIX_MIN_COMMITS = 10;
/** Distinct suffixes a hash-id prefix needs — one repeated suffix is a name (`rc-0927b`), not a tracker. */
export const TASK_ID_HASH_PREFIX_MIN_DISTINCT_SUFFIXES = 2;

/** What a run accepts as a task id. Structured-cloneable: it rides the chunk-walk worker job. */
export interface TaskIdVocabulary {
  /** Ticket keys (`TD`) learned from anchored positions. */
  readonly projectKeys: ReadonlySet<string>;
  /** The repository has a GitHub/GitLab remote: `#N` counts in PR/issue contexts. */
  readonly forgeIssueRefs: boolean;
  /** Prefixes of hash-suffixed ids (`acme` of `acme-k3p9q`) learned from the window; absent = none. */
  readonly hashIdPrefixes?: ReadonlySet<string>;
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

const HASH_ID = /(?<![\w-])([a-z][a-z0-9]*(?:-[a-z0-9]+)*)-([a-z0-9]{5})((?:\.\d+)*)(?![\w-])/g;
const SUBJECT_TRAILING_HASH_SUFFIX = /\s\(([a-z0-9]{5})\)\s*$/;
const HASH_SUFFIX_LENGTH = 5;
const DIGIT = /\d/;
const LETTER = /[a-z]/;

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

/** What the window says about one candidate hash-id prefix. */
interface HashIdPrefixEvidence {
  commits: number;
  readonly suffixes: Set<string>;
}

/** What the window says about hash-suffixed ids. */
interface HashIdWindowEvidence {
  readonly prefixes: Map<string, HashIdPrefixEvidence>;
  /** Suffixes named in the short form, ` (k3p9q)` closing a subject. */
  readonly subjectSuffixes: Set<string>;
}

/** Record the hash-shaped ids a message names, one commit per prefix. */
function collectHashIdEvidence(message: string, { prefixes: evidence, subjectSuffixes }: HashIdWindowEvidence): void {
  const subjectSuffix = SUBJECT_TRAILING_HASH_SUFFIX.exec(message.split("\n", 1)[0])?.[1];
  if (subjectSuffix && DIGIT.test(subjectSuffix)) subjectSuffixes.add(subjectSuffix);
  const prefixesInCommit = new Set<string>();
  for (const m of message.matchAll(HASH_ID)) {
    const [, prefix, suffix] = m;
    if (!DIGIT.test(suffix)) continue;
    let prefixEvidence = evidence.get(prefix);
    if (!prefixEvidence) {
      prefixEvidence = { commits: 0, suffixes: new Set() };
      evidence.set(prefix, prefixEvidence);
    }
    prefixEvidence.suffixes.add(suffix);
    if (!prefixesInCommit.has(prefix)) {
      prefixesInCommit.add(prefix);
      prefixEvidence.commits += 1;
    }
  }
}

/**
 * True when the suffixes look MINTED: most carry a letter (a run of plain
 * numbers — `crowdin-new-locales-99571`, `revert-pr-21236` — is a counter),
 * and no character position is shared by all of them (`weekly-js-ts-part9`
 * is a stem plus a counter).
 */
function isHashSuffixPopulation(suffixes: ReadonlySet<string>): boolean {
  let withLetter = 0;
  for (const suffix of suffixes) if (LETTER.test(suffix)) withLetter += 1;
  if (withLetter * 2 <= suffixes.size) return false;
  for (let position = 0; position < HASH_SUFFIX_LENGTH; position++) {
    const chars = new Set<string>();
    for (const suffix of suffixes) chars.add(suffix[position]);
    if (chars.size < 2) return false;
  }
  return true;
}

/**
 * The prefixes whose ids count. A candidate most of whose suffixes a
 * better-supported accepted prefix already names is dropped: `worktree-k3p9q`
 * is a branch named after the tracker's id, not a second tracker. The
 * best-supported prefix also owns the short-form suffixes — the same rule
 * {@link extractTaskIds} resolves them by — because a merged branch is often
 * named after an id its commits only ever cite as ` (k3p9q)`.
 */
function learnHashIdPrefixes({ prefixes: evidence, subjectSuffixes }: HashIdWindowEvidence): Set<string> {
  const candidates = [...evidence]
    .filter(
      ([, { commits, suffixes }]) =>
        commits >= TASK_ID_HASH_PREFIX_MIN_COMMITS &&
        suffixes.size >= TASK_ID_HASH_PREFIX_MIN_DISTINCT_SUFFIXES &&
        isHashSuffixPopulation(suffixes),
    )
    .sort(([, a], [, b]) => b.commits - a.commits);
  const accepted: [string, HashIdPrefixEvidence][] = [];
  for (const candidate of candidates) {
    const [, { commits, suffixes }] = candidate;
    const shadowed = accepted.some(([, stronger], rank) => {
      if (stronger.commits <= commits) return false;
      let shared = 0;
      for (const suffix of suffixes) {
        if (stronger.suffixes.has(suffix) || (rank === 0 && subjectSuffixes.has(suffix))) shared += 1;
      }
      return shared * 2 > suffixes.size;
    });
    if (!shadowed) accepted.push(candidate);
  }
  return new Set(accepted.map(([prefix]) => prefix));
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
  const hashIdEvidence: HashIdWindowEvidence = { prefixes: new Map(), subjectSuffixes: new Set() };
  for (const message of messages) {
    if (!message) continue;
    collectHashIdEvidence(message, hashIdEvidence);
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
  return {
    projectKeys,
    forgeIssueRefs: remoteUrls.some(isForgeRemoteUrl),
    hashIdPrefixes: learnHashIdPrefixes(hashIdEvidence),
  };
}

/** Hash-suffixed ids under the learned prefixes: the full form anywhere, the short form trailing the subject. */
function hashTaskIds(text: string, hashIdPrefixes: ReadonlySet<string>, taskIds: Set<string>): void {
  for (const m of text.matchAll(HASH_ID)) {
    if (hashIdPrefixes.has(m[1]) && DIGIT.test(m[2])) taskIds.add(m[0]);
  }
  if (hashIdPrefixes.size !== 1) return;
  const suffix = SUBJECT_TRAILING_HASH_SUFFIX.exec(text.split("\n", 1)[0])?.[1];
  if (suffix && DIGIT.test(suffix)) taskIds.add(`${[...hashIdPrefixes][0]}-${suffix}`);
}

/** Task ids a commit message names, under the run's learned vocabulary. */
export function extractTaskIds(text: string, vocabulary: TaskIdVocabulary): string[] {
  if (!text) return [];
  const taskIds = new Set<string>();
  for (const m of text.matchAll(TICKET_ID)) {
    if (vocabulary.projectKeys.has(m[1])) taskIds.add(m[0]);
  }
  if (vocabulary.hashIdPrefixes?.size) hashTaskIds(text, vocabulary.hashIdPrefixes, taskIds);
  if (vocabulary.forgeIssueRefs) {
    for (const pattern of [ISSUE_CONTEXT, TRAILING_ISSUE, ISSUE_LINK]) {
      for (const m of text.matchAll(pattern)) taskIds.add(`#${m[1]}`);
    }
  }
  for (const m of text.matchAll(AZURE_ID)) taskIds.add(`AB#${m[1]}`);
  return Array.from(taskIds);
}
