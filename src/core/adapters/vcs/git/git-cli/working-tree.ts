/**
 * Git CLI working-tree reads — tracked/untracked listings, working-tree vs
 * HEAD changes and renames, and added-line ranges. Uncommitted state is read
 * on a scratch copy of the index so the user's own index is never touched.
 */

import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGitChildProcessEnv, resolveGitExecutable } from "../../../../infra/git-executable.js";
import { BULK_LOG_STALL_FLOOR_MS, TREE_LISTING_STALL_MS } from "./exec.js";
import { splitNulTerminated } from "./parsers.js";
import { execWithStallGuard } from "./stall-guard-exec.js";

/**
 * Every path `commitOid`'s tree tracks, repo-relative, as git spells it
 * (`ls-tree -z`: no C-quoting). Submodule entries are listed by their path.
 */
export async function listTreePaths(
  repoRoot: string,
  commitOid: string,
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<string[]> {
  const out = await execWithStallGuard(
    resolveGitExecutable(),
    ["ls-tree", "-r", "-z", "--name-only", "--full-tree", commitOid],
    { cwd: repoRoot, stallTimeoutMs: timeoutMs },
  );
  return splitNulTerminated(out);
}

/**
 * HEAD paths the working tree no longer has, repo-relative: deleted on disk,
 * removed from the index, or moved away (`--no-renames`, so the old side of an
 * uncommitted rename reads as a deletion). Edited files are not listed.
 */
export async function listWorktreeDeletions(repoRoot: string, timeoutMs = TREE_LISTING_STALL_MS): Promise<string[]> {
  const out = await execWorktreeDiffOnScratchIndex(
    repoRoot,
    ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "--diff-filter=D", "HEAD", "--"],
    { stallTimeoutMs: timeoutMs },
  );
  return splitNulTerminated(out);
}

/**
 * Paths among `paths` whose working-tree content differs from HEAD — edited,
 * staged or not — repo-relative (bd tea-rags-mcp-xi2r9). Added, deleted and
 * untracked paths are not listed: only a path HEAD holds has HEAD rows to
 * carry a working row onto. `--no-renames`, so a moved file's new side reads
 * as an add and is left out.
 */
export async function listWorktreeModifications(
  repoRoot: string,
  paths: readonly string[],
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<string[]> {
  if (paths.length === 0) return [];
  // Same floored stall window `execFileForPathspec` gave this pathspec diff before
  // it moved onto the scratch index (bd tea-rags-mcp-s5kpv).
  const out = await execWorktreeDiffOnScratchIndex(
    repoRoot,
    ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "--diff-filter=M", "HEAD", "--", ...paths],
    { stallTimeoutMs: Math.max(timeoutMs, BULK_LOG_STALL_FLOOR_MS) },
  );
  return splitNulTerminated(out);
}

/** Lines of a file the working tree ADDED against a base: 1-based, inclusive on both ends. */
export interface AddedLineRange {
  start: number;
  end: number;
}

/**
 * Files the working tree changed against `base`, repo-relative and sorted: every
 * tracked path whose content differs from `base` (staged or not, `--no-renames`
 * so a move lists its new side) plus every untracked, non-ignored file. Paths
 * the working tree deleted are not listed — a naming review has nothing to read
 * in them.
 */
export async function listChangedFiles(
  repoRoot: string,
  base: string,
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    execWorktreeDiffOnScratchIndex(
      repoRoot,
      ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "--diff-filter=d", base, "--"],
      { stallTimeoutMs: timeoutMs },
    ),
    listUntrackedFiles(repoRoot, [], timeoutMs),
  ]);
  return [...new Set([...splitNulTerminated(tracked), ...untracked])].sort();
}

/** The working tree against a commit, repo-relative: what reads differently and what is gone. */
export interface WorkingTreeNameStatus {
  changed: string[];
  deleted: string[];
  /** The untracked, non-ignored files among `changed`. */
  untracked: string[];
}

/**
 * The working tree against `commit` (staged, unstaged and committed-since alike):
 * `git diff --name-status --no-renames <commit>` — a `D` entry is deleted, every
 * other status changed, so a move reads as its source deleted and its target
 * changed — plus every untracked, non-ignored file as changed. Both lists sorted.
 * An unknown commit or a path outside a repository rejects.
 */
export async function readWorkingTreeChanges(
  repoRoot: string,
  commit: string,
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<WorkingTreeNameStatus> {
  const [nameStatus, untracked] = await Promise.all([
    execWorktreeDiffOnScratchIndex(
      repoRoot,
      ["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", commit, "--"],
      { stallTimeoutMs: timeoutMs },
    ),
    listUntrackedFiles(repoRoot, [], timeoutMs),
  ]);
  const changed = new Set(untracked);
  const deleted: string[] = [];
  const fields = splitNulTerminated(nameStatus);
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === "D") deleted.push(fields[i + 1]);
    else changed.add(fields[i + 1]);
  }
  return { changed: [...changed].sort(), deleted: deleted.sort(), untracked: [...untracked].sort() };
}

/** One move git detected between a commit and the working tree, repo-relative. */
export interface WorkingTreeRenamePair {
  from: string;
  to: string;
}

/**
 * The moves of the working tree against `commit`, as git's own rename
 * detection pairs them (`git diff -M --name-status <commit>`): staged, unstaged
 * and committed-since alike, edits within the similarity threshold included.
 *
 * `git diff` sees only paths the index tracks, so an unstaged move — the old
 * path deleted, the new one untracked — would read as an unrelated delete and
 * add. The `untracked` files are therefore marked intent-to-add (`add -N`) in a
 * THROWAWAY copy of the index (`GIT_INDEX_FILE`), which makes them diffable
 * candidates; the repository's own index is never written.
 */
export async function readWorkingTreeRenames(
  repoRoot: string,
  commit: string,
  untracked: readonly string[],
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<WorkingTreeRenamePair[]> {
  const git = resolveGitExecutable();
  const markUntrackedIntentToAdd = async (env: NodeJS.ProcessEnv): Promise<void> => {
    for (let i = 0; i < untracked.length; i += UNTRACKED_INTENT_BATCH) {
      await execWithStallGuard(
        git,
        ["--literal-pathspecs", "add", "-N", "--", ...untracked.slice(i, i + UNTRACKED_INTENT_BATCH)],
        { cwd: repoRoot, stallTimeoutMs: timeoutMs, env },
      );
    }
  };
  return parseRenamePairs(
    await execWorktreeDiffOnScratchIndex(
      repoRoot,
      ["diff", "--no-ext-diff", "-M", "--name-status", "-z", commit, "--"],
      {
        stallTimeoutMs: timeoutMs,
        prepareScratchIndex: untracked.length > 0 ? markUntrackedIntentToAdd : undefined,
      },
    ),
  );
}

/** How {@link execWorktreeDiffOnScratchIndex} runs its diff. */
interface WorktreeDiffOnScratchIndexOptions {
  /** Output-inactivity window of every git child the helper spawns (ms). */
  stallTimeoutMs: number;
  /** Runs against the scratch index before the diff (e.g. `add -N`); `env` points git at it. */
  prepareScratchIndex?: (env: NodeJS.ProcessEnv) => Promise<void>;
}

/**
 * Runs a `git diff` that compares a commit with the WORKING TREE against a
 * throwaway copy of the index (`GIT_INDEX_FILE`), never the user's own (bd
 * tea-rags-mcp-s5kpv).
 *
 * Porcelain `git diff` refreshes stat info while comparing and writes it back
 * to the index under `index.lock` — and, unlike `git status`, it does so even
 * under `GIT_OPTIONAL_LOCKS=0` (measured on git 2.50.1). A diff reaped by the
 * stall guard then leaves a stale lock in the user's repository, and a live one
 * races the user's own `git commit`. On the copy the refresh is harmless: it
 * lands in a temp dir that is removed afterwards — on success, failure and a
 * stall kill alike, since all three settle the awaited diff before `finally`.
 * Plumbing `git diff-index` would avoid the write, but it does not refresh, so
 * a file whose stat moved with its content unchanged would read as changed.
 *
 * A repository with no index yet (nothing ever staged) has no file to copy: the
 * scratch index then starts absent, which git reads exactly as it reads the
 * missing original. Cost: one index copy per call (taxdome: 8.4 MB).
 */
async function execWorktreeDiffOnScratchIndex(
  repoRoot: string,
  diffArgs: string[],
  options: WorktreeDiffOnScratchIndexOptions,
): Promise<string> {
  const { stallTimeoutMs, prepareScratchIndex } = options;
  const git = resolveGitExecutable();
  const indexPath = (
    await execWithStallGuard(git, ["rev-parse", "--path-format=absolute", "--git-path", "index"], {
      cwd: repoRoot,
      stallTimeoutMs,
    })
  ).trim();
  const scratch = await mkdtemp(join(tmpdir(), "tea-rags-scratch-index-"));
  const scratchIndex = join(scratch, "index");
  try {
    await copyIndexKeepingMtime(indexPath, scratchIndex);
    const env = { ...buildGitChildProcessEnv(), GIT_INDEX_FILE: scratchIndex };
    if (prepareScratchIndex) await prepareScratchIndex(env);
    return await execWithStallGuard(git, diffArgs, { cwd: repoRoot, stallTimeoutMs, env });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Copies the index to `scratchIndex` with the ORIGINAL's mtime. Git's racy-git
 * rule content-checks every entry whose file is not older than the index file;
 * a copy stamped "now" would turn those entries into trusted ones, and a
 * same-size edit made within the index's own timestamp would vanish from the
 * diff. The mtime is read BEFORE the copy: an index replaced in between yields
 * newer content under an older mtime, which only widens the racy set (more
 * content checks, never fewer). A missing index (nothing ever staged) leaves
 * no copy — git reads the absent file exactly as it reads the absent original.
 */
async function copyIndexKeepingMtime(indexPath: string, scratchIndex: string): Promise<void> {
  let original: Awaited<ReturnType<typeof stat>>;
  try {
    original = await stat(indexPath);
    await copyFile(indexPath, scratchIndex);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await utimes(scratchIndex, original.atime, original.mtime);
}

/** Paths per `add -N` — keeps the argv within OS ARG_MAX limits. */
const UNTRACKED_INTENT_BATCH = 500;

/** The `R<score> old new` entries of a `--name-status -z` diff; every other status names one path. */
function parseRenamePairs(nameStatus: string): WorkingTreeRenamePair[] {
  const fields = splitNulTerminated(nameStatus);
  const pairs: WorkingTreeRenamePair[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i];
    if (status.startsWith("R") || status.startsWith("C")) {
      if (status.startsWith("R") && i + 2 < fields.length) pairs.push({ from: fields[i + 1], to: fields[i + 2] });
      i += 3;
    } else {
      i += 2;
    }
  }
  return pairs;
}

/**
 * `git status --porcelain=v2 -z --branch --untracked-files=all`, verbatim: one
 * spawn that carries HEAD (the `# branch.oid <sha>` header, `(initial)` before
 * the first commit) and every staged, unstaged and untracked path. The text does
 * not move when an already-modified file is edited again.
 */
export async function readStatusPorcelain(repoRoot: string, timeoutMs = TREE_LISTING_STALL_MS): Promise<string> {
  return execWithStallGuard(
    resolveGitExecutable(),
    ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"],
    { cwd: repoRoot, stallTimeoutMs: timeoutMs },
  );
}

/**
 * The line ranges `relPath` gained against `base`, read from the hunk headers of
 * `git diff -U0` (`@@ -a,b +c,d @@` → `c..c+d-1`; `d` omitted means 1, `d = 0`
 * is a pure deletion and adds nothing). An untracked file was added whole, so it
 * reads as one range over every line it has.
 */
export async function readAddedLineRanges(
  repoRoot: string,
  base: string,
  relPath: string,
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<AddedLineRange[]> {
  if ((await listUntrackedFiles(repoRoot, [relPath], timeoutMs)).length > 0) {
    const lineCount = countLines(readFileSync(join(repoRoot, relPath), "utf8"));
    return lineCount > 0 ? [{ start: 1, end: lineCount }] : [];
  }
  const diff = await execWorktreeDiffOnScratchIndex(
    repoRoot,
    ["diff", "--no-ext-diff", "--no-color", "--no-renames", "-U0", base, "--", relPath],
    { stallTimeoutMs: timeoutMs },
  );
  return parseAddedHunkRanges(diff);
}

/**
 * {@link readAddedLineRanges} for many files in two subprocesses: one untracked
 * listing and one `git diff -U0` over every tracked path, split per file by its
 * `+++` header. Every asked path gets an entry — `[]` when nothing was added.
 * Paths are literal (`--literal-pathspecs`): `[id].ts` names a file, not a
 * character class.
 */
export async function readAddedLineRangesOfFiles(
  repoRoot: string,
  base: string,
  relPaths: readonly string[],
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<Map<string, AddedLineRange[]>> {
  const ranges = new Map<string, AddedLineRange[]>(relPaths.map((relPath) => [relPath, []]));
  if (relPaths.length === 0) return ranges;
  const untracked = new Set(
    splitNulTerminated(
      await execWithStallGuard(
        resolveGitExecutable(),
        ["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", ...relPaths],
        { cwd: repoRoot, stallTimeoutMs: timeoutMs },
      ),
    ),
  );
  for (const relPath of untracked) {
    const lineCount = countLines(readFileSync(join(repoRoot, relPath), "utf8"));
    ranges.set(relPath, lineCount > 0 ? [{ start: 1, end: lineCount }] : []);
  }
  const tracked = relPaths.filter((relPath) => !untracked.has(relPath));
  if (tracked.length === 0) return ranges;
  const diff = await execWorktreeDiffOnScratchIndex(
    repoRoot,
    [
      "-c",
      "core.quotePath=false",
      "--literal-pathspecs",
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--no-renames",
      "-U0",
      base,
      "--",
      ...tracked,
    ],
    { stallTimeoutMs: timeoutMs },
  );
  for (const [relPath, added] of parseAddedHunkRangesPerFile(diff)) {
    if (ranges.has(relPath)) ranges.set(relPath, added);
  }
  return ranges;
}

/**
 * A multi-file `-U0` diff split per file. The file is the `+++ b/<path>` side;
 * a deletion (`+++ /dev/null`) keeps its `--- a/<path>` side and adds nothing.
 */
function parseAddedHunkRangesPerFile(diff: string): Map<string, AddedLineRange[]> {
  const perFile = new Map<string, AddedLineRange[]>();
  let oldPath: string | undefined;
  let current: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      oldPath = undefined;
      current = undefined;
    } else if (line.startsWith("--- ")) {
      oldPath = diffHeaderPath(line.slice(4), "a/");
    } else if (line.startsWith("+++ ")) {
      current = diffHeaderPath(line.slice(4), "b/") ?? oldPath;
      if (current !== undefined && !perFile.has(current)) perFile.set(current, []);
    } else if (current !== undefined && line.startsWith("@@ ")) {
      perFile.get(current)?.push(...parseAddedHunkRanges(line));
    }
  }
  return perFile;
}

/**
 * The path of a `---` / `+++` header side: `/dev/null` → undefined; a trailing
 * TAB (git's marker after a name holding a space) dropped; a C-quoted name
 * (`"b/a\"b.ts"`, what `core.quotePath=false` still quotes) unquoted.
 */
function diffHeaderPath(raw: string, prefix: "a/" | "b/"): string | undefined {
  const name = raw.endsWith("\t") ? raw.slice(0, -1) : raw;
  if (name === "/dev/null") return undefined;
  const unquoted = name.startsWith('"') && name.endsWith('"') ? unquoteGitPath(name.slice(1, -1)) : name;
  return unquoted.startsWith(prefix) ? unquoted.slice(prefix.length) : unquoted;
}

const GIT_PATH_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/** Git's C-style path quoting reversed: named escapes and `\ooo` octal bytes, decoded as UTF-8. */
function unquoteGitPath(body: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = body[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(GIT_PATH_ESCAPES[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

async function listUntrackedFiles(repoRoot: string, pathspec: string[], timeoutMs: number): Promise<string[]> {
  const out = await execWithStallGuard(
    resolveGitExecutable(),
    ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspec],
    { cwd: repoRoot, stallTimeoutMs: timeoutMs },
  );
  return splitNulTerminated(out);
}

const ADDED_HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;

function parseAddedHunkRanges(diff: string): AddedLineRange[] {
  const ranges: AddedLineRange[] = [];
  for (const match of diff.matchAll(ADDED_HUNK_HEADER)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}
