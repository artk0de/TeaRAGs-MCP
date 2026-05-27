/**
 * Pure parsers for git CLI output.
 * No I/O, no state — string → structured data.
 */

import type { BlameLine, CommitInfo, FileChurnData } from "./types.js";

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
      const filePath = parts[2];

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
export function parsePathspecOutput(stdout: string): { commit: CommitInfo; changedFiles: string[] }[] {
  const result: { commit: CommitInfo; changedFiles: string[] }[] = [];
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
    const changedFiles: string[] = [];

    // Parse numstat section
    const numstatSection = sections[i] || "";
    i++;

    for (const line of numstatSection.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      // Binary files show "-\t-" — skip them
      if (parts[0] === "-" && parts[1] === "-") continue;
      changedFiles.push(parts[2]);
    }

    if (changedFiles.length > 0) {
      result.push({ commit, changedFiles });
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
