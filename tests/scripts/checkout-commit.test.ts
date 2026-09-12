import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveCheckoutCommit } from "../../scripts/lib/checkout-commit.js";

// Real `git init` / `git commit`, so refuse loudly if the cwd ever escapes the
// temp tree (the guard the git-trajectory tests carry, for the same reason).
const TMP_BASE = realpathSync(tmpdir());

function gitIn(cwd: string, args: string[]): string {
  if (!resolve(cwd).startsWith(TMP_BASE + sep)) {
    throw new Error(`checkout-commit.test: refusing git "${args[0]}" in non-temp cwd: ${cwd}`);
  }
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function seededCheckout(prefix: string): string {
  const dir = mkdtempSync(join(TMP_BASE, prefix));
  gitIn(dir, ["init", "-q"]);
  writeFileSync(join(dir, "file.txt"), "one\n");
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-q", "-m", "seed"]);
  return dir;
}

/** Collects the diagnostics instead of letting them reach the terminal. */
function collector(): { warn: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { warn: (message) => lines.push(message), lines };
}

describe("resolveCheckoutCommit", () => {
  let checkout: string;
  let dirty: string;
  let notARepo: string;

  beforeAll(() => {
    checkout = seededCheckout("checkout-commit-");
    dirty = seededCheckout("checkout-commit-dirty-");
    notARepo = mkdtempSync(join(TMP_BASE, "checkout-commit-nonrepo-"));
  });

  afterAll(() => {
    for (const dir of [checkout, dirty, notARepo]) rmSync(dir, { recursive: true, force: true });
  });

  it("resolves the checkout's HEAD to a full sha", () => {
    const head = gitIn(checkout, ["rev-parse", "HEAD"]).trim();

    expect(resolveCheckoutCommit(checkout)).toBe(head);
    expect(resolveCheckoutCommit(checkout)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("follows HEAD as it moves rather than caching the first answer", () => {
    const first = resolveCheckoutCommit(checkout);
    writeFileSync(join(checkout, "file.txt"), "two\n");
    gitIn(checkout, ["add", "-A"]);
    gitIn(checkout, ["commit", "-q", "-m", "second"]);

    const second = resolveCheckoutCommit(checkout);
    expect(second).not.toBe(first);
    expect(second).toBe(gitIn(checkout, ["rev-parse", "HEAD"]).trim());
  });

  // The spikes import the BEFORE side from the working tree, so a sha alone would
  // name a commit whose code never ran.
  it("marks a modified working tree as -dirty", () => {
    const head = gitIn(dirty, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(dirty, "file.txt"), "edited but not committed\n");

    expect(resolveCheckoutCommit(dirty)).toBe(`${head}-dirty`);
  });

  it("counts an untracked file as dirty too", () => {
    const clean = seededCheckout("checkout-commit-untracked-");
    const head = gitIn(clean, ["rev-parse", "HEAD"]).trim();
    expect(resolveCheckoutCommit(clean)).toBe(head);

    writeFileSync(join(clean, "stray.txt"), "not committed\n");
    expect(resolveCheckoutCommit(clean)).toBe(`${head}-dirty`);

    rmSync(clean, { recursive: true, force: true });
  });

  // The spikes run without `--before-root` as an identity check, and a corpus
  // path that is not a checkout is a user mistake — neither may take the run
  // down, so both answer null and the summary says "unknown".
  it("answers null when no checkout was named, saying nothing", () => {
    const { warn, lines } = collector();

    expect(resolveCheckoutCommit(undefined, warn)).toBeNull();
    expect(lines).toEqual([]);
  });

  it("answers null for a directory that is not a git checkout, and says why", () => {
    const { warn, lines } = collector();

    expect(resolveCheckoutCommit(notARepo, warn)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(notARepo);
    expect(lines[0]).toMatch(/rev-parse HEAD/);
  });

  it("answers null for a path that does not exist, and says why", () => {
    const absent = join(TMP_BASE, "checkout-commit-absent-dir");
    const { warn, lines } = collector();

    expect(resolveCheckoutCommit(absent, warn)).toBeNull();
    expect(lines[0]).toContain(absent);
  });
});
