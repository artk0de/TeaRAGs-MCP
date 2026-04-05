/**
 * Pure parsers for git CLI output.
 * No I/O, no state — string → structured data.
 */

import type { CommitInfo, FileChurnData } from "./types.js";

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
