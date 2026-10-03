/**
 * Writes a whole git history into a repository with ONE `git fast-import`
 * (bd tea-rags-mcp-1r3e5).
 *
 * A fixture that builds its history as `add` / `commit` / `rev-parse` chains
 * pays three git spawns per commit. A spawn costs 100–250 ms on this machine
 * and over a second when the coverage run loads it (homebrew git under EDR), so
 * a dozen commits outlived the 30 s hook budget — a different file each run.
 * `importGitHistory` lays the same history down in three spawns per repository
 * (`init`, `fast-import`, `reset --hard`) whatever its length: authors,
 * committers, author/committer dates, messages, file writes, deletions,
 * renames, branches and merges are written exactly as the chain wrote them, and
 * the shas come back from the exported marks.
 *
 * What fast-import does NOT do, the caller keeps live: a commit, merge or
 * checkout that is itself the behaviour under test, and uncommitted
 * working-tree state (dirty or untracked files — plain fs writes after the
 * import).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface GitHistoryIdentity {
  name: string;
  email: string;
}

/** A date git would accept from `GIT_*_DATE`: ISO-8601 (`Z` or `±HH:MM`), a `Date`, or epoch milliseconds. */
export type GitHistoryDate = string | Date | number;

/** One commit of an imported history, applied on top of its parent's tree. */
export interface GitHistoryCommit {
  /** key of this commit's sha in the returned map */
  label?: string;
  /** branch the commit lands on (default: the import's `branch`) */
  branch?: string;
  /**
   * Label of the first parent. Default: the branch's previous commit; for the
   * first commit of a branch other than the import's `branch`, the current tip
   * of the import's `branch` (what `git checkout -b` from it does). `null`
   * makes a root commit.
   */
  from?: string | null;
  /** labels of further parents — a merge commit; its tree is `from`'s plus this commit's own changes */
  merge?: string[];
  /** stored as `git commit -m` stores it: trailing whitespace dropped, one newline appended */
  message: string;
  author: GitHistoryIdentity;
  authorDate: GitHistoryDate;
  /** default: the import's `committer`, else the author */
  committer?: GitHistoryIdentity;
  /** default: `authorDate` */
  committerDate?: GitHistoryDate;
  /** `path → content` written in this commit (mode 100644, or `executable` paths 100755) */
  writes?: Record<string, string | Buffer>;
  /** paths in `writes` committed with mode 100755 */
  executable?: string[];
  /** paths removed in this commit */
  deletes?: string[];
  /** `[from, to]` moves in this commit (applied before `writes`) */
  renames?: [string, string][];
}

export interface GitHistoryImportOptions {
  /** branch `init` creates and the working tree checks out (default `main`) */
  branch?: string;
  /** committer of every commit that names none */
  committer?: GitHistoryIdentity;
  /**
   * Entries appended to `.git/config` before the import, dotted keys
   * (`user.email`, `commit.gpgsign`, `remote.origin.url` → `[remote "origin"]`).
   */
  config?: Record<string, string>;
  /** `false` imports into an existing repository: no `init`, no config (default `true`) */
  init?: boolean;
  /** branch checked out after the import (default `branch`) */
  checkout?: string;
  /** environment of the three git spawns (default `process.env`) — e.g. a hermetic one with no global config */
  env?: NodeJS.ProcessEnv;
}

function gitTime(date: GitHistoryDate): string {
  if (typeof date === "string") {
    const seconds = Math.floor(Date.parse(date) / 1000);
    if (Number.isNaN(seconds)) throw new Error(`importGitHistory: unparseable date "${date}"`);
    const offset = /([+-])(\d{2}):?(\d{2})$/.exec(date);
    return `${seconds} ${offset === null ? "+0000" : `${offset[1]}${offset[2]}${offset[3]}`}`;
  }
  const millis = typeof date === "number" ? date : date.getTime();
  return `${Math.floor(millis / 1000)} +0000`;
}

function configText(config: Record<string, string>): string {
  const sections = new Map<string, string[]>();
  for (const [key, value] of Object.entries(config)) {
    const parts = key.split(".");
    if (parts.length < 2) throw new Error(`importGitHistory: config key "${key}" has no section`);
    const name = parts.at(-1) as string;
    const section = parts[0];
    const subsection = parts.slice(1, -1).join(".");
    const header = subsection.length > 0 ? `[${section} "${subsection}"]` : `[${section}]`;
    const lines = sections.get(header) ?? [];
    lines.push(`\t${name} = ${value}`);
    sections.set(header, lines);
  }
  return [...sections].map(([header, lines]) => `${header}\n${lines.join("\n")}\n`).join("");
}

const data = (content: string | Buffer): Buffer => {
  const body = typeof content === "string" ? Buffer.from(content) : content;
  return Buffer.concat([Buffer.from(`data ${body.length}\n`), body, Buffer.from("\n")]);
};

/** fast-import quotes a path only when it must; tests never use such paths. */
function path(p: string): string {
  if (/[\s"\\]/.test(p) || p.length === 0) throw new Error(`importGitHistory: unsupported path "${p}"`);
  return p;
}

/**
 * Imports `commits` (in order) into `repo` and checks the working tree out at
 * the `checkout` branch. Returns every labelled commit's sha.
 */
export function importGitHistory(
  repo: string,
  commits: readonly GitHistoryCommit[],
  options: GitHistoryImportOptions = {},
): Record<string, string> {
  const branch = options.branch ?? "main";
  const env = options.env ?? process.env;
  if (options.init ?? true) {
    execFileSync("git", ["init", "-q", "-b", branch], { cwd: repo, env, stdio: "ignore" });
    if (options.config !== undefined) appendFileSync(join(repo, ".git/config"), configText(options.config));
  }

  const markOf = new Map<string, number>();
  const tips = new Map<string, number>();
  const chunks: Buffer[] = [];
  commits.forEach((commit, i) => {
    const mark = i + 1;
    if (commit.label !== undefined) {
      if (markOf.has(commit.label)) throw new Error(`importGitHistory: duplicate label "${commit.label}"`);
      markOf.set(commit.label, mark);
    }
    const ref = commit.branch ?? branch;
    const committer = commit.committer ?? options.committer ?? commit.author;
    const message = `${commit.message.replace(/\s+$/, "")}\n`;
    const markRef = (label: string): string => {
      const target = markOf.get(label);
      if (target === undefined) throw new Error(`importGitHistory: unknown label "${label}"`);
      return `:${target}`;
    };
    const lines: string[] = [
      `commit refs/heads/${ref}\n`,
      `mark :${mark}\n`,
      `author ${commit.author.name} <${commit.author.email}> ${gitTime(commit.authorDate)}\n`,
      `committer ${committer.name} <${committer.email}> ${gitTime(commit.committerDate ?? commit.authorDate)}\n`,
    ];
    chunks.push(Buffer.from(lines.join("")), data(message));
    const parent =
      commit.from === null
        ? undefined
        : commit.from !== undefined
          ? markRef(commit.from)
          : !tips.has(ref) && tips.has(branch)
            ? `:${tips.get(branch)}`
            : undefined;
    if (parent !== undefined) chunks.push(Buffer.from(`from ${parent}\n`));
    for (const merged of commit.merge ?? []) chunks.push(Buffer.from(`merge ${markRef(merged)}\n`));
    for (const [source, target] of commit.renames ?? []) {
      chunks.push(Buffer.from(`R ${path(source)} ${path(target)}\n`));
    }
    for (const removed of commit.deletes ?? []) chunks.push(Buffer.from(`D ${path(removed)}\n`));
    const executable = new Set(commit.executable ?? []);
    for (const [file, content] of Object.entries(commit.writes ?? {})) {
      const mode = executable.has(file) ? "100755" : "100644";
      chunks.push(Buffer.from(`M ${mode} inline ${path(file)}\n`), data(content));
    }
    chunks.push(Buffer.from("\n"));
    tips.set(ref, mark);
  });

  const marks = join(repo, ".git/fast-import-marks");
  execFileSync("git", ["fast-import", "--quiet", `--export-marks=${marks}`], {
    cwd: repo,
    env,
    input: Buffer.concat(chunks),
    stdio: ["pipe", "ignore", "pipe"],
  });
  const checkout = options.checkout ?? branch;
  execFileSync("git", checkout === branch ? ["reset", "-q", "--hard"] : ["checkout", "-q", "-f", checkout], {
    cwd: repo,
    env,
    stdio: "ignore",
  });

  const byMark = new Map(
    readFileSync(marks, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.split(" ") as [string, string]),
  );
  rmSync(marks);
  return Object.fromEntries([...markOf].map(([label, mark]) => [label, byMark.get(`:${mark}`) as string]));
}
