/**
 * Pure parsers for git CLI output.
 * No I/O, no state — string → structured data.
 */

import type { BlameLine, CommitChangedPath, CommitFileNumstat, CommitInfo, FileChurnData } from "../../types.js";

/** The literal git puts between the two sides of a rename in `--numstat`. */
const RENAME_SEPARATOR = " => ";

/**
 * `prefix{left => right}suffix`. The prefix capture is GREEDY so it stops at
 * the LAST `{`, which is the rename brace whenever a directory name legitimately
 * contains one; the two side captures are LAZY so a `}` inside the suffix does
 * not get eaten. Either side may be EMPTY (`src/{ => bar}/baz.ts`).
 */
const BRACE_RENAME_RE = /^(.*)\{(.*?) => (.*?)\}(.*)$/;

/** Single-character C escapes `quote_c_style` emits (git `quote.c`). */
const C_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '"': 0x22,
  "\\": 0x5c,
};

/**
 * Reverse git's `quote_c_style`: with `core.quotePath` on (the default) a path
 * holding non-ASCII or control bytes is printed double-quoted with `\NNN` octal
 * byte escapes. Left as-is the quoted form matches nothing keyed on real paths,
 * so the file silently loses its history exactly as a rename does. Bytes are
 * rebuilt first and decoded as UTF-8 once, because one character spans several
 * octal escapes.
 */
function unquoteCStylePath(field: string): string {
  if (field.length < 2 || !field.startsWith('"') || !field.endsWith('"')) return field;

  const body = field.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      bytes.push(...Buffer.from(body[i], "utf8"));
      continue;
    }
    const escape = body[++i];
    if (escape === undefined) break;
    const simple = C_ESCAPES[escape];
    if (simple !== undefined) {
      bytes.push(simple);
    } else if (escape >= "0" && escape <= "7") {
      bytes.push(parseInt(body.slice(i, i + 3), 8) & 0xff);
      i += 2;
    } else {
      bytes.push(...Buffer.from(escape, "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Index of the closing `"` of a leading C-quoted token, or -1. */
function closingQuoteIndex(field: string): number {
  for (let i = 1; i < field.length; i++) {
    if (field[i] === "\\") {
      i++;
      continue;
    }
    if (field[i] === '"') return i;
  }
  return -1;
}

/**
 * Split the brace-free rename form into its two sides, or null when the field
 * is a plain path. Git quotes each side independently and suppresses the braces
 * whenever EITHER side needs quoting, so a leading quote pins the boundary
 * exactly; otherwise the FIRST separator wins — git emits exactly one, and a
 * path that literally contains ` => ` is rendered ambiguously by git itself
 * (`a => b.ts` renamed to `c => d.ts` prints `a => b.ts => c => d.ts`), so no
 * reader of the textual form can recover it. Such a row simply fails to match
 * the chunk map, which is the pre-fix behaviour — never a wrong attribution.
 */
function splitRenameSides(field: string): [string, string] | null {
  if (field.startsWith('"')) {
    const end = closingQuoteIndex(field);
    if (end === -1 || !field.slice(end + 1).startsWith(RENAME_SEPARATOR)) return null;
    return [field.slice(0, end + 1), field.slice(end + 1 + RENAME_SEPARATOR.length)];
  }
  const at = field.indexOf(RENAME_SEPARATOR);
  return at === -1 ? null : [field.slice(0, at), field.slice(at + RENAME_SEPARATOR.length)];
}

/**
 * Rejoin one side of a brace rename. An EMPTY side (`src/{ => bar}/baz.ts`)
 * leaves the prefix's trailing slash adjacent to the suffix's leading one, and
 * that is the only way git's own output can produce a doubled slash — so the
 * collapse is scoped to it rather than applied to the whole path.
 */
function joinRenameSide(prefix: string, middle: string, suffix: string): string {
  const joined = `${prefix}${middle}${suffix}`;
  return middle === "" ? joined.replace("//", "/") : joined;
}

/**
 * Turn one numstat path column into the file it names plus, for a rename, the
 * path it had at the first parent (bd tea-rags-mcp-0dwsn).
 *
 * This is the ONLY place the mangled column is interpreted. The persisted
 * discovery snapshots hold v1 rows written straight from `git log`, so their
 * upgrade path calls this same function — two implementations would drift and
 * upgraded rows would stop matching freshly parsed ones.
 *
 * Why not `git log -z`, which emits the two sides as separate NUL-terminated
 * fields and skips C-quoting entirely: measured against this repo, `-z` makes
 * NUL the row AND path separator, while `NUMSTAT_LOG_FORMAT` already uses
 * `%x00` as its field separator. A rename then prints `39\t14\t\0old\0new\0`,
 * so the numstat block stops being one addressable section between two header
 * blocks and the framing every parser here relies on collapses. The v1
 * snapshots would still need brace parsing regardless, so `-z` would buy a
 * second code path rather than replace this one.
 */
export function parseNumstatChangedPath(field: string): CommitChangedPath {
  const brace = BRACE_RENAME_RE.exec(field);
  if (brace) {
    const [, prefix, left, right, suffix] = brace;
    return {
      path: joinRenameSide(prefix, right, suffix),
      previousPath: joinRenameSide(prefix, left, suffix),
    };
  }

  const sides = splitRenameSides(field);
  if (sides) return { path: unquoteCStylePath(sides[1]), previousPath: unquoteCStylePath(sides[0]) };

  return { path: unquoteCStylePath(field) };
}

/**
 * Parse `git log --numstat --format=%x00%H%x00%P%x00%an%x00%ae%x00%at%x00%B` output
 * into a per-file FileChurnData map.
 */
export function parseNumstatOutput(stdout: string): Map<string, FileChurnData> {
  const fileMap = new Map<string, FileChurnData>();

  const sections = stdout.split("\0");
  let i = 0;

  while (i < sections.length) {
    if (!sections[i]?.trim()) {
      i++;
      continue;
    }

    const sha = sections[i]?.trim();
    if (sha?.length !== 40 || !/^[a-f0-9]+$/.test(sha)) {
      i++;
      continue;
    }

    const parentsRaw = sections[i + 1] || "";
    const parents = parentsRaw.trim() ? parentsRaw.trim().split(" ") : [];
    const author = sections[i + 2] || "";
    const email = sections[i + 3] || "";
    const timestamp = parseInt(sections[i + 4] || "0", 10);
    const body = sections[i + 5] || "";
    i += 6;

    const commitInfo: CommitInfo = { sha, author, authorEmail: email, timestamp, body, parents };

    const numstatSection = sections[i] || "";
    i++;

    for (const line of numstatSection.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;

      const added = parseInt(parts[0], 10);
      const deleted = parseInt(parts[1], 10);
      // Churn is keyed on the CURRENT path: a rename row belongs to the file as
      // the commit left it, never to the `{old => new}` column git printed.
      const { path: filePath } = parseNumstatChangedPath(parts[2]);

      if (isNaN(added) || isNaN(deleted)) continue;

      let entry = fileMap.get(filePath);
      if (!entry) {
        entry = { commits: [], linesAdded: 0, linesDeleted: 0 };
        fileMap.set(filePath, entry);
      }
      entry.commits.push(commitInfo);
      entry.linesAdded += added;
      entry.linesDeleted += deleted;
    }
  }

  return fileMap;
}

/**
 * Parse `git log --numstat --format=%x00...` output with pathspec filtering.
 * Returns commit + changed files pairs.
 */
export function parsePathspecOutput(stdout: string): { commit: CommitInfo; changedFiles: CommitChangedPath[] }[] {
  const result: { commit: CommitInfo; changedFiles: CommitChangedPath[] }[] = [];
  const sections = stdout.split("\0");
  let i = 0;

  while (i < sections.length) {
    if (!sections[i]?.trim()) {
      i++;
      continue;
    }

    const sha = sections[i]?.trim();
    if (sha?.length !== 40 || !/^[a-f0-9]+$/.test(sha)) {
      i++;
      continue;
    }

    const parentsRaw = sections[i + 1] || "";
    const parents = parentsRaw.trim() ? parentsRaw.trim().split(" ") : [];
    const author = sections[i + 2] || "";
    const email = sections[i + 3] || "";
    const timestamp = parseInt(sections[i + 4] || "0", 10);
    const body = sections[i + 5] || "";
    i += 6;

    const commit: CommitInfo = { sha, author, authorEmail: email, timestamp, body, parents };
    const changedFiles: CommitChangedPath[] = [];

    // Parse numstat section
    const numstatSection = sections[i] || "";
    i++;

    for (const line of numstatSection.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      // Binary files show "-\t-" — skip them
      if (parts[0] === "-" && parts[1] === "-") continue;
      changedFiles.push(parseNumstatChangedPath(parts[2]));
    }

    if (changedFiles.length > 0) {
      result.push({ commit, changedFiles });
    }
  }

  return result;
}

/**
 * Parse `git log --numstat --format=%x00%H…%at%x00%ct%x00%B…` output (the
 * committer-augmented format `NUMSTAT_LOG_FORMAT_WITH_COMMITTER`), keeping the
 * PER-FILE +/- counts (`parsePathspecOutput`'s numstat loop keeps only the
 * path, discarding them). Unlike the shared parsers this one also extracts the
 * COMMITTER epoch (`%ct`, section i+5) alongside the author epoch (`%at`,
 * section i+4): the file-churn discovery windows/evicts/sorts by committer
 * date. Binary rows (`-\t-\t<path>`) are SKIPPED, exactly as
 * `parseNumstatOutput` does (parseInt("-") is NaN → skip): a file touched
 * ONLY by binary commits must not appear here with a phantom commit, so the
 * incremental discovery aggregate equals the legacy full-recompute per file.
 */
export function parseCommitFileNumstat(stdout: string): CommitFileNumstat[] {
  const result: CommitFileNumstat[] = [];
  const sections = stdout.split("\0");
  let i = 0;

  while (i < sections.length) {
    if (!sections[i]?.trim()) {
      i++;
      continue;
    }

    const sha = sections[i]?.trim();
    if (sha?.length !== 40 || !/^[a-f0-9]+$/.test(sha)) {
      i++;
      continue;
    }

    const parentsRaw = sections[i + 1] || "";
    const parents = parentsRaw.trim() ? parentsRaw.trim().split(" ") : [];
    const author = sections[i + 2] || "";
    const email = sections[i + 3] || "";
    const timestamp = parseInt(sections[i + 4] || "0", 10);
    const committerTimestamp = parseInt(sections[i + 5] || "0", 10);
    const body = sections[i + 6] || "";
    i += 7;

    const commit: CommitInfo = { sha, author, authorEmail: email, timestamp, body, parents };
    const files: CommitFileNumstat["files"] = [];

    // Parse numstat section
    const numstatSection = sections[i] || "";
    i++;

    for (const line of numstatSection.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;

      // Binary files show "-\t-" — parseInt("-") is NaN. Skip the row entirely
      // to match parseNumstatOutput (the legacy full-recompute path), so a file
      // touched ONLY by binary commits gets the SAME commitCount on both paths.
      const added = parseInt(parts[0], 10);
      const deleted = parseInt(parts[1], 10);
      if (Number.isNaN(added) || Number.isNaN(deleted)) continue;

      files.push({ ...parseNumstatChangedPath(parts[2]), added, deleted });
    }

    if (files.length > 0) {
      result.push({ commit, committerTimestamp, files });
    }
  }

  return result;
}

const BLAME_HEADER_RE = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

/**
 * Parse `git blame --porcelain HEAD -- <file>` output into per-line attributions.
 * Porcelain emits author/email/time headers only at first occurrence of each commit;
 * subsequent occurrences carry only the SHA + line numbers, so we cache metadata
 * by SHA and look it up on every content line.
 */
export function parseBlameOutput(stdout: string): BlameLine[] {
  const result: BlameLine[] = [];
  // Force standalone owned copies of the strings we keep (sha/author/email). V8
  // keeps `String.slice()` / regex-capture results as SlicedStrings that pin the
  // ENTIRE parent — here the multi-hundred-KB `git blame --porcelain` stdout —
  // alive for as long as any returned BlameLine references them. A live heap
  // snapshot confirmed BlameLine.author/sha/authorEmail slices retaining whole
  // per-file porcelain blocks (held across all files via blameByRelPath). A
  // Buffer round-trip (cheap: once per unique sha, not per line) materialises an
  // owned copy so the stdout is GC'd right after parsing.
  const own = (s: string): string => Buffer.from(s, "utf8").toString("utf8");
  const meta = new Map<string, { sha: string; author: string; authorEmail: string; timestamp: number }>();

  let pendingSha = "";
  let pendingLine = 0;
  let pendingAuthor = "";
  let pendingEmail = "";
  let pendingTime = 0;
  let inEntry = false;

  for (const line of stdout.split("\n")) {
    const headerMatch = BLAME_HEADER_RE.exec(line);
    if (headerMatch) {
      pendingSha = headerMatch[1];
      pendingLine = parseInt(headerMatch[2], 10);
      pendingAuthor = "";
      pendingEmail = "";
      pendingTime = 0;
      inEntry = true;
      continue;
    }
    if (!inEntry) continue;

    if (line.startsWith("author ")) {
      pendingAuthor = line.slice(7);
    } else if (line.startsWith("author-mail ")) {
      pendingEmail = line.slice(12).replace(/^<|>$/g, "");
    } else if (line.startsWith("author-time ")) {
      pendingTime = parseInt(line.slice(12), 10) || 0;
    } else if (line.startsWith("\t")) {
      // Look up by the slice (string Map keys compare by value, so the lookup
      // slice is not retained). Create the entry once per sha with OWNED copies;
      // later lines of the same sha reuse them. result references only `cached`.
      let cached = meta.get(pendingSha);
      if (!cached && pendingAuthor) {
        cached = {
          sha: own(pendingSha),
          author: own(pendingAuthor),
          authorEmail: own(pendingEmail),
          timestamp: pendingTime,
        };
        meta.set(cached.sha, cached);
      }
      if (cached) {
        result.push({
          lineNumber: pendingLine,
          sha: cached.sha,
          author: cached.author,
          authorEmail: cached.authorEmail,
          timestamp: cached.timestamp,
        });
      }
      inEntry = false;
    }
  }

  return result;
}
