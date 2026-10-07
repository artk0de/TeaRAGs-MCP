/**
 * Author identity of the git trajectory (bd tea-rags-mcp-nsxzh) — the ONE
 * place that decides when two commits or blame lines have the same author.
 *
 * Identity = the author's EMAIL, trimmed and lowercased, as git reports it
 * after applying the repo's `.mailmap` (the adapter reads `%aN` / `%aE`, and
 * `git blame --porcelain` maps `author` / `author-mail` itself). A `.mailmap`
 * therefore unifies different addresses; without one, the address alone
 * unifies the name variants one person commits under. Two addresses under
 * one name stay two authors.
 *
 * Payload keeps carrying display NAMES (`recentDominantAuthor`,
 * `blameAuthors`, … — what the `author` / `contributor` filters match). The
 * display name of an identity is its most frequent name among the entries
 * being tallied — the file's window commits for `recent*`, the file's or
 * chunk's blame lines for `blame*` — ties broken by code-point order so the
 * answer never depends on log order. With a `.mailmap` git has already
 * canonicalised the name, so this arbitration only matters for unmapped
 * aliases.
 */

/** The two fields every author-bearing git record carries (`CommitInfo`, `BlameLine`). */
export interface AuthoredGitRecord {
  author: string;
  authorEmail: string;
}

/** One author identity over a set of records. */
export interface AuthorIdentityTally {
  /** `authorIdentityKey` — compare identities by this, never by `name`. */
  key: string;
  /** Display name: the identity's most frequent name, ties by code-point order. */
  name: string;
  /** The identity's email (lowercased); "" when the records carried none. */
  email: string;
  /** Records attributed to the identity. */
  count: number;
}

/** Prefix of a name-derived key, so it never reads as an email key. */
const NAME_KEY_PREFIX = "name:";

/**
 * Identity key of a record: the lowercased, trimmed email; the name only when
 * the record has no email (a synthetic or malformed row).
 */
export function authorIdentityKey(record: AuthoredGitRecord): string {
  const email = record.authorEmail.trim().toLowerCase();
  return email !== "" ? email : `${NAME_KEY_PREFIX}${record.author}`;
}

function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Count records per identity. Sorted by count descending, then by display
 * name and key in code-point order — deterministic for any input order.
 */
export function tallyAuthors(records: Iterable<AuthoredGitRecord>): AuthorIdentityTally[] {
  const byKey = new Map<string, { email: string; count: number; names: Map<string, number> }>();
  for (const record of records) {
    const key = authorIdentityKey(record);
    let entry = byKey.get(key);
    if (!entry) {
      entry = { email: key.startsWith(NAME_KEY_PREFIX) ? "" : key, count: 0, names: new Map() };
      byKey.set(key, entry);
    }
    entry.count++;
    entry.names.set(record.author, (entry.names.get(record.author) ?? 0) + 1);
  }

  const tallies: AuthorIdentityTally[] = [];
  for (const [key, entry] of byKey) {
    let name = "";
    let nameCount = 0;
    for (const [candidate, count] of entry.names) {
      if (count > nameCount || (count === nameCount && compareCodePoints(candidate, name) < 0)) {
        name = candidate;
        nameCount = count;
      }
    }
    tallies.push({ key, name, email: entry.email, count: entry.count });
  }
  return tallies.sort(
    (a, b) => b.count - a.count || compareCodePoints(a.name, b.name) || compareCodePoints(a.key, b.key),
  );
}
