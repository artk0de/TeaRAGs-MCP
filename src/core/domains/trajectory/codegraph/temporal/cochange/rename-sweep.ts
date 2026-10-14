/**
 * Identifier-rename sweeps (bd tea-rags-mcp-v2525). A sweep renames one
 * concept everywhere it is named and is a fan-out by construction, never
 * evidence of shotgun surgery. Its per-file line counts carry no pattern — a
 * formatter reflows the lines a longer name no longer fits — so the verdict
 * reads the diff text: a commit is a rename sweep when ONE commit-wide
 * substitution σ of identifiers turns everything it removed into everything it
 * added, file by file.
 *
 * σ is one simultaneous substitution and may rename several identifiers: a
 * chained rename (`FooImpl → Foo` while the old `Foo → FooDescriptor`) cannot
 * be written as one old → new pair, yet it is exactly a sweep. What separates
 * a sweep from an edit is that σ is consistent across the whole commit, not
 * how many names it moves: σ is a function (an identifier kept anywhere in a
 * changed line maps to itself, so it cannot also be renamed elsewhere), it is
 * injective (two names merged into one rewire references), and its renames
 * form no cycle (a swap of two names rewires references). Literals,
 * punctuation and structure must match exactly, so a type-only refactor — a
 * cast added, a parameter retyped next to an added annotation — is never one.
 *
 * Formatter tolerance: whitespace and line breaks are not tokens, and a
 * trailing comma (before a closing bracket or at a hunk's end) is dropped,
 * because reflowing a renamed list adds or removes exactly those. A commit
 * with no rename (pure reflow, pure file move), a binary file, or a file whose
 * token streams differ in length is not a sweep.
 */

import type { CochangeFileLineCounts } from "../../../../../contracts/types/codegraph.js";

/**
 * The fewest files a sweep must touch to be assessed: the shotgun width floor
 * (`SHOTGUN_SURGERY_MIN_WIDTH` — a unit spans ≥ 3 components, so ≥ 3 files).
 * A narrower commit is no shotgun unit, so its verdict could change nothing.
 */
export const RENAME_SWEEP_MIN_FILES = 3;

/** Commits per `git log -p` spawn — bounds the diff text held at once. */
const RENAME_SWEEP_DIFF_BATCH = 256;

/** An admitted bundle as the sweep assessment reads it: its commits and its files' line counts. */
export interface RenameSweepBundle {
  shas: readonly string[];
  /** Aligned with the bundle's files; `null` = git reported no count (binary). */
  fileLines: readonly (CochangeFileLineCounts | null)[];
}

/**
 * Each bundle's verdict, aligned with `bundles`. Diff text is read only for
 * the CANDIDATES — the bundles a sweep's numstat could produce: ≥
 * {@link RENAME_SWEEP_MIN_FILES} files, every one line-counted, none adding
 * without deleting or deleting without adding (a renamed line is removed AND
 * added; a pure move is 0/0). Every other bundle is `false` without a read. A
 * bundle of several commits is a sweep only when each of them is.
 */
export async function assessRenameSweepBundles(
  bundles: readonly RenameSweepBundle[],
  readDiffText: (shas: readonly string[]) => Promise<string>,
): Promise<boolean[]> {
  const candidates = bundles.flatMap((bundle, index) => (isRenameSweepCandidate(bundle) ? [index] : []));
  const shas = [...new Set(candidates.flatMap((index) => bundles[index].shas))];
  const sweeps = new Set<string>();
  for (let start = 0; start < shas.length; start += RENAME_SWEEP_DIFF_BATCH) {
    const batch = shas.slice(start, start + RENAME_SWEEP_DIFF_BATCH);
    for (const [sha, files] of parseCommitDiffs(await readDiffText(batch))) {
      if (isIdentifierRenameSweep(files)) sweeps.add(sha);
    }
  }
  const verdicts = bundles.map(() => false);
  for (const index of candidates) verdicts[index] = bundles[index].shas.every((sha) => sweeps.has(sha));
  return verdicts;
}

function isRenameSweepCandidate(bundle: RenameSweepBundle): boolean {
  return (
    bundle.fileLines.length >= RENAME_SWEEP_MIN_FILES &&
    bundle.fileLines.every((lines) => lines !== null && lines.added > 0 === lines.deleted > 0)
  );
}

/** One `-U0` hunk: the lines it removed and the lines it added, in order. */
export interface RenameSweepDiffHunk {
  removed: readonly string[];
  added: readonly string[];
}

/** One file of a commit's diff, at its post-commit path. */
export interface RenameSweepDiffFile {
  path: string;
  binary: boolean;
  hunks: readonly RenameSweepDiffHunk[];
}

const TOKEN = /[A-Za-z_$][\w$]*|\d[\w.]*|\S/g;
const IDENTIFIER = /^[A-Za-z_$]/;
const CLOSERS = new Set([")", "]", "}"]);

/** Whether one commit-wide identifier substitution explains every file of the commit. See the module docblock. */
export function isIdentifierRenameSweep(files: readonly RenameSweepDiffFile[]): boolean {
  const forward = new Map<string, string>();
  const backward = new Map<string, string>();
  for (const file of files) {
    if (file.binary) return false;
    const removed = file.hunks.flatMap((hunk) => hunkTokens(hunk.removed));
    const added = file.hunks.flatMap((hunk) => hunkTokens(hunk.added));
    if (removed.length !== added.length) return false;
    for (let i = 0; i < removed.length; i++) {
      const from = removed[i];
      const to = added[i];
      if (from === to && !IDENTIFIER.test(from)) continue;
      if (!IDENTIFIER.test(from) || !IDENTIFIER.test(to)) return false;
      if ((forward.get(from) ?? to) !== to || (backward.get(to) ?? from) !== from) return false;
      forward.set(from, to);
      backward.set(to, from);
    }
  }
  const renames = [...forward].filter(([from, to]) => from !== to);
  return renames.length > 0 && !hasRenameCycle(new Map(renames));
}

/** A hunk side's tokens, with the trailing commas a reflow adds or drops removed. */
function hunkTokens(lines: readonly string[]): string[] {
  const tokens = lines.join("\n").match(TOKEN) ?? [];
  return tokens.filter((token, i) => token !== "," || (i + 1 < tokens.length && !CLOSERS.has(tokens[i + 1])));
}

function hasRenameCycle(renames: ReadonlyMap<string, string>): boolean {
  for (const start of renames.keys()) {
    let current = renames.get(start);
    for (let steps = 0; current !== undefined && steps < renames.size; steps++) {
      if (current === start) return true;
      current = renames.get(current);
    }
  }
  return false;
}

/** The commit header `readCommitDiffs` prints: a NUL, then the full SHA. */
export const COMMIT_DIFF_HEADER = "\u0000";

/**
 * Parse `git log --no-walk -p -U0 --format=%x00%H` output into each commit's
 * files. A file is keyed by its post-commit path; a pure rename has no hunks;
 * `Binary files … differ` marks it binary. Lines before the first `@@` of a
 * file (`---` / `+++` headers, mode and similarity lines) are not content.
 */
export function parseCommitDiffs(text: string): Map<string, RenameSweepDiffFile[]> {
  const commits = new Map<string, RenameSweepDiffFile[]>();
  let files: RenameSweepDiffFile[] | undefined;
  let file: { path: string; binary: boolean; hunks: { removed: string[]; added: string[] }[] } | undefined;
  let hunk: { removed: string[]; added: string[] } | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith(COMMIT_DIFF_HEADER)) {
      files = [];
      commits.set(line.slice(COMMIT_DIFF_HEADER.length).trim(), files);
      file = undefined;
      hunk = undefined;
    } else if (!files) {
      continue;
    } else if (line.startsWith("diff --git ")) {
      file = { path: postCommitPath(line), binary: false, hunks: [] };
      files.push(file);
      hunk = undefined;
    } else if (!file) {
      continue;
    } else if (line.startsWith("@@")) {
      hunk = { removed: [], added: [] };
      file.hunks.push(hunk);
    } else if (hunk && line.startsWith("-")) {
      hunk.removed.push(line.slice(1));
    } else if (hunk && line.startsWith("+")) {
      hunk.added.push(line.slice(1));
    } else if (!hunk && line.startsWith("Binary files ")) {
      file.binary = true;
    }
  }
  return commits;
}

function postCommitPath(header: string): string {
  const at = header.lastIndexOf(" b/");
  return at < 0 ? header : header.slice(at + 3);
}
