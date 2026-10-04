/**
 * Real git repositories built ONCE per recipe and copied per test (bd
 * tea-rags-mcp-2z4sa).
 *
 * A git spawn costs 100–250 ms on this machine and over a second under parallel
 * load (EDR scans every process), so a `beforeEach` running eight of them hit
 * the 30 s hook budget whenever several vitest processes ran at once. A plain
 * directory copy spawns nothing, so the recipe runs its git commands once per
 * process and every test gets its own copy — isolation holds, because no test
 * ever touches the template itself.
 *
 * A copy is the template byte for byte except for two things git keys to the
 * filesystem, both put back so the copy is the repository a fresh build would
 * have been:
 *  - a linked worktree's `.git` file and its admin dir's `gitdir` name the
 *    checkout by ABSOLUTE path — rewritten from the template root to the copy's;
 *  - each checkout's index caches inode and ctime, which a copy changes — one
 *    `git update-index --refresh` per checkout re-stats it.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitRepoTemplateCopy<Meta> {
  /**
   * The fresh temp dir holding this copy, as `mkdtempSync` names it under
   * `tmpdir()` — NOT resolved through symlinks (macOS `/var` → `/private/var`),
   * exactly as a per-test `mkdtempSync` would have named it.
   */
  root: string;
  /** what the recipe returned when it built the template (shas, names…) */
  meta: Meta;
}

interface BuiltTemplate {
  root: string;
  meta: unknown;
}

const templates = new Map<string, BuiltTemplate>();
let templatesHome: string | undefined;

function home(): string {
  if (templatesHome === undefined) {
    templatesHome = realpathSync(mkdtempSync(join(tmpdir(), "git-repo-templates-")));
    const owned = templatesHome;
    process.once("exit", () => {
      rmSync(owned, { recursive: true, force: true });
    });
  }
  return templatesHome;
}

/** The checkouts directly under `root` (and `root` itself): every dir holding a `.git`. */
function checkoutsUnder(root: string): string[] {
  const candidates = [root, ...readdirSync(root).map((name) => join(root, name))];
  return candidates.filter((dir) => statSync(dir).isDirectory() && existsSync(join(dir, ".git")));
}

/** Every file in which git recorded a checkout's absolute path. */
function absolutePathFiles(checkouts: string[]): string[] {
  const files: string[] = [];
  for (const checkout of checkouts) {
    const dotGit = join(checkout, ".git");
    if (statSync(dotGit).isFile()) {
      files.push(dotGit);
      continue;
    }
    const admin = join(dotGit, "worktrees");
    if (!existsSync(admin)) continue;
    for (const name of readdirSync(admin)) {
      const gitdir = join(admin, name, "gitdir");
      if (existsSync(gitdir)) files.push(gitdir);
    }
  }
  return files;
}

function refreshIndex(checkout: string, env: NodeJS.ProcessEnv): void {
  // `-q` keeps going past entries that really differ (a recipe may leave
  // uncommitted edits); those stay dirty, every other entry is re-stat'ed.
  execFileSync("git", ["update-index", "-q", "--refresh"], { cwd: checkout, env, stdio: "ignore" });
}

export interface GitRepoTemplateOptions {
  /** `mkdtempSync` prefix of each copy's root (default `git-repo-copy-`) */
  prefix?: string;
  /** environment of the index refresh — the GIT_* identity a recipe commits under */
  env?: NodeJS.ProcessEnv;
}

/**
 * A fresh copy of the repository `build` lays out under an empty root. `build`
 * runs once per `key` per process, at a symlink-free root; its return value is
 * handed back as `meta` on every copy, so it must not hold paths under the
 * template root — return shas or names relative to the root instead.
 */
export function copyGitRepoTemplate<Meta>(
  key: string,
  build: (templateRoot: string) => Meta,
  options: GitRepoTemplateOptions = {},
): GitRepoTemplateCopy<Meta> {
  let template = templates.get(key);
  if (template === undefined) {
    const templateRoot = join(home(), String(templates.size));
    mkdirSync(templateRoot);
    template = { root: templateRoot, meta: build(templateRoot) };
    templates.set(key, template);
  }

  const root = mkdtempSync(join(tmpdir(), options.prefix ?? "git-repo-copy-"));
  cpSync(template.root, root, { recursive: true, preserveTimestamps: true });

  // Git recorded the template's symlink-free paths; the copy's take their place.
  const realRoot = realpathSync(root);
  const checkouts = checkoutsUnder(realRoot);
  for (const file of absolutePathFiles(checkouts)) {
    writeFileSync(file, readFileSync(file, "utf8").split(template.root).join(realRoot));
  }
  for (const checkout of checkouts) refreshIndex(checkout, options.env ?? process.env);

  return { root, meta: template.meta as Meta };
}
