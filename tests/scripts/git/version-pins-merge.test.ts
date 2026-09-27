import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

// The derived pins file must never stop a merge: the `version-pins` merge driver
// keeps ours, and `repin-on-merge.sh` recomputes the pins inside the merge commit.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const REGISTER_SCRIPT = join(REPO_ROOT, "scripts/git/register-merge-drivers.sh");
const REPIN_SCRIPT = join(REPO_ROOT, "scripts/git/repin-on-merge.sh");
const PINS_PATH = "tests/core/domains/language/capability/version-pins.json";

// Real `git init` / `git merge`, so refuse loudly if the cwd ever escapes the temp tree.
const TMP_BASE = realpathSync(tmpdir());

/**
 * A clean env: this suite runs inside the pre-commit hook, where GIT_DIR /
 * GIT_INDEX_FILE point at the REAL repository — inheriting them would aim every
 * command below at it.
 */
function hermeticEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "t@example.com",
    ...extra,
  };
}

function assertTemp(cwd: string): void {
  if (!resolve(cwd).startsWith(TMP_BASE + sep)) {
    throw new Error(`version-pins-merge.test: refusing to run in non-temp cwd: ${cwd}`);
  }
}

function gitIn(cwd: string, args: string[]): string {
  assertTemp(cwd);
  return execFileSync("git", args, { cwd, encoding: "utf8", env: hermeticEnv() });
}

function writePins(dir: string, content: string): void {
  const file = join(dir, PINS_PATH);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const dirs: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(join(TMP_BASE, "version-pins-merge-"));
  dirs.push(dir);
  gitIn(dir, ["init", "-q", "-b", "main"]);
  gitIn(dir, ["config", "user.name", "Test"]);
  gitIn(dir, ["config", "user.email", "t@example.com"]);
  gitIn(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("version-pins merge driver", () => {
  it("resolves a conflicting pins merge to ours with exit 0 and no markers", () => {
    const dir = tempRepo();
    // The tracked attribute line, verbatim from the repository's .gitattributes.
    const attrLine = readFileSync(join(REPO_ROOT, ".gitattributes"), "utf8")
      .split("\n")
      .find((line) => line.startsWith(`${PINS_PATH} `));
    expect(attrLine).toBe(`${PINS_PATH} merge=version-pins`);
    writeFileSync(join(dir, ".gitattributes"), `${attrLine}\n`);

    // Register the driver the way `npm install` (package.json `prepare`) does.
    assertTemp(dir);
    execFileSync("sh", [REGISTER_SCRIPT], { cwd: dir, env: hermeticEnv() });
    expect(gitIn(dir, ["config", "--get", "merge.version-pins.driver"]).trim()).not.toBe("");

    writePins(dir, '{\n  "ts": "base"\n}\n');
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-q", "-m", "base"]);

    gitIn(dir, ["checkout", "-q", "-b", "theirs"]);
    writePins(dir, '{\n  "ts": "theirs"\n}\n');
    gitIn(dir, ["commit", "-q", "-am", "theirs"]);

    gitIn(dir, ["checkout", "-q", "main"]);
    const ours = '{\n  "ts": "ours"\n}\n';
    writePins(dir, ours);
    gitIn(dir, ["commit", "-q", "-am", "ours"]);

    const merge = spawnSync("git", ["merge", "--no-edit", "theirs"], {
      cwd: dir,
      encoding: "utf8",
      env: hermeticEnv(),
    });
    expect(merge.status, merge.stdout + merge.stderr).toBe(0);
    const merged = readFileSync(join(dir, PINS_PATH), "utf8");
    expect(merged).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
    expect(merged).toBe(ours);
    expect(gitIn(dir, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ")).toHaveLength(3);
  });
});

describe("repin-on-merge.sh", () => {
  function runRepin(dir: string, repinCmd: string): ReturnType<typeof spawnSync> {
    assertTemp(dir);
    return spawnSync("sh", [REPIN_SCRIPT], {
      cwd: dir,
      encoding: "utf8",
      env: hermeticEnv({ REPIN_CMD: repinCmd }),
    });
  }

  function seeded(): string {
    const dir = tempRepo();
    writePins(dir, "{}\n");
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-q", "-m", "seed"]);
    return dir;
  }

  // The stub stands in for `npm run pin:lang-versions`: it rewrites the pins
  // file, so staging can be observed, and leaves a marker proving it ran.
  const STUB = `echo ran > repin.marker && printf '{"repinned":true}\\n' > ${PINS_PATH}`;

  it("does nothing outside a merge or cherry-pick", () => {
    const dir = seeded();
    const run = runRepin(dir, STUB);
    expect(run.status, String(run.stderr)).toBe(0);
    expect(existsSync(join(dir, "repin.marker"))).toBe(false);
    expect(gitIn(dir, ["diff", "--cached", "--name-only"]).trim()).toBe("");
  });

  it.each(["MERGE_HEAD", "CHERRY_PICK_HEAD"])("re-pins and stages the pins when %s exists", (head) => {
    const dir = seeded();
    const sha = gitIn(dir, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(dir, ".git", head), `${sha}\n`);

    const run = runRepin(dir, STUB);
    expect(run.status, String(run.stderr)).toBe(0);
    expect(readFileSync(join(dir, "repin.marker"), "utf8").trim()).toBe("ran");
    expect(gitIn(dir, ["diff", "--cached", "--name-only"]).trim()).toBe(PINS_PATH);
  });

  it("fails loudly when the pin run fails", () => {
    const dir = seeded();
    const sha = gitIn(dir, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(dir, ".git", "MERGE_HEAD"), `${sha}\n`);

    const run = runRepin(dir, "exit 3");
    expect(run.status).not.toBe(0);
    expect(gitIn(dir, ["diff", "--cached", "--name-only"]).trim()).toBe("");
  });
});

describe("merge hooks end to end", () => {
  const STUB = `echo ran > repin.marker && printf '{"repinned":true}\\n' > ${PINS_PATH}`;

  /** Installs the TRACKED husky hook bodies, run the way husky runs them (`sh -e`). */
  function installHooks(dir: string, names: string[]): void {
    const hooks = join(dir, ".git", "test-hooks");
    mkdirSync(hooks, { recursive: true });
    for (const name of names) {
      const body = readFileSync(join(REPO_ROOT, ".husky", name), "utf8").replaceAll(
        "scripts/git/repin-on-merge.sh",
        REPIN_SCRIPT,
      );
      writeFileSync(join(hooks, name), `#!/bin/sh\nset -e\n${body}`, { mode: 0o755 });
    }
    gitIn(dir, ["config", "core.hooksPath", hooks]);
  }

  function commitFile(dir: string, file: string, content: string, message: string): void {
    writeFileSync(join(dir, file), content);
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-q", "-m", message]);
  }

  function gitWithStub(dir: string, args: string[]): ReturnType<typeof spawnSync> {
    assertTemp(dir);
    return spawnSync("git", args, { cwd: dir, encoding: "utf8", env: hermeticEnv({ REPIN_CMD: STUB }) });
  }

  function seeded(): string {
    const dir = tempRepo();
    writePins(dir, "{}\n");
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-q", "-m", "seed"]);
    return dir;
  }

  it("a clean `git merge` commits the re-pinned file in the merge commit itself", () => {
    const dir = seeded();
    // Hooks go in after the setup commits, so only the merge runs them.
    gitIn(dir, ["checkout", "-q", "-b", "side"]);
    commitFile(dir, "side.txt", "side\n", "side");
    gitIn(dir, ["checkout", "-q", "main"]);
    commitFile(dir, "main.txt", "main\n", "main");
    const mainTip = gitIn(dir, ["rev-parse", "HEAD"]).trim();
    const sideTip = gitIn(dir, ["rev-parse", "side"]).trim();
    installHooks(dir, ["pre-merge-commit", "post-merge"]);

    const merge = gitWithStub(dir, ["merge", "--no-edit", "side"]);
    expect(merge.status, String(merge.stdout) + String(merge.stderr)).toBe(0);
    expect(existsSync(join(dir, "repin.marker"))).toBe(true);
    expect(gitIn(dir, ["show", `HEAD:${PINS_PATH}`])).toBe('{"repinned":true}\n');
    expect(gitIn(dir, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ")).toEqual([
      expect.any(String),
      mainTip,
      sideTip,
    ]);
    expect(gitIn(dir, ["status", "--porcelain", "--untracked-files=no"]).trim()).toBe("");
  });

  it("a fast-forward `git merge` rewrites nothing", () => {
    const dir = seeded();
    gitIn(dir, ["checkout", "-q", "-b", "side"]);
    commitFile(dir, "side.txt", "side\n", "side");
    const sideTip = gitIn(dir, ["rev-parse", "HEAD"]).trim();
    gitIn(dir, ["checkout", "-q", "main"]);
    installHooks(dir, ["pre-merge-commit", "post-merge"]);

    const merge = gitWithStub(dir, ["merge", "--no-edit", "side"]);
    expect(merge.status, String(merge.stdout) + String(merge.stderr)).toBe(0);
    expect(existsSync(join(dir, "repin.marker"))).toBe(false);
    expect(gitIn(dir, ["rev-parse", "HEAD"]).trim()).toBe(sideTip);
  });

  it("a conflicted merge concluded by `git commit` carries the re-pinned file", () => {
    const dir = seeded();
    commitFile(dir, "shared.txt", "base\n", "base");
    gitIn(dir, ["checkout", "-q", "-b", "side"]);
    commitFile(dir, "shared.txt", "side\n", "side");
    gitIn(dir, ["checkout", "-q", "main"]);
    commitFile(dir, "shared.txt", "main\n", "main");
    // The tracked pre-commit runs lint-staged / tsc; install only its re-pin line.
    const preCommit = readFileSync(join(REPO_ROOT, ".husky/pre-commit"), "utf8")
      .split("\n")
      .find((line) => line.includes("scripts/git/repin-on-merge.sh") && !line.startsWith("#"));
    expect(preCommit).toBeDefined();
    const hooks = join(dir, ".git", "test-hooks");
    mkdirSync(hooks);
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nset -e\n${String(preCommit).replace("scripts/git/repin-on-merge.sh", REPIN_SCRIPT)}\n`,
      { mode: 0o755 },
    );
    gitIn(dir, ["config", "core.hooksPath", hooks]);

    expect(gitWithStub(dir, ["merge", "--no-edit", "side"]).status).not.toBe(0);
    writeFileSync(join(dir, "shared.txt"), "resolved\n");
    gitIn(dir, ["add", "shared.txt"]);
    const commit = gitWithStub(dir, ["commit", "--no-edit"]);
    expect(commit.status, String(commit.stdout) + String(commit.stderr)).toBe(0);
    expect(gitIn(dir, ["show", `HEAD:${PINS_PATH}`])).toBe('{"repinned":true}\n');
    expect(gitIn(dir, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ")).toHaveLength(3);
  });
});
