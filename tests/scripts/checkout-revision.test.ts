import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveCheckoutCommit } from "../../scripts/lib/checkout-revision.js";

// Real `git init` / `git commit`, so refuse loudly if the cwd ever escapes the
// temp tree (the guard the git-trajectory tests carry, for the same reason).
const TMP_BASE = realpathSync(tmpdir());

function gitIn(cwd: string, args: string[]): string {
  if (!resolve(cwd).startsWith(TMP_BASE + sep)) {
    throw new Error(`checkout-revision.test: refusing git "${args[0]}" in non-temp cwd: ${cwd}`);
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

describe("resolveCheckoutCommit", () => {
  let checkout: string;
  let bare: string;

  beforeAll(() => {
    checkout = mkdtempSync(join(TMP_BASE, "checkout-revision-"));
    gitIn(checkout, ["init", "-q"]);
    writeFileSync(join(checkout, "file.txt"), "one\n");
    gitIn(checkout, ["add", "-A"]);
    gitIn(checkout, ["commit", "-q", "-m", "seed"]);
    bare = mkdtempSync(join(TMP_BASE, "checkout-revision-nonrepo-"));
  });

  afterAll(() => {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
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

  // The spikes run without `--before-root` as an identity check, and a corpus
  // path that is not a checkout is a user mistake — neither may take the run
  // down, so both answer null and the summary says "unknown".
  it("answers null when no checkout was named", () => {
    expect(resolveCheckoutCommit(undefined)).toBeNull();
  });

  it("answers null for a directory that is not a git checkout", () => {
    expect(resolveCheckoutCommit(bare)).toBeNull();
  });

  it("answers null for a path that does not exist", () => {
    expect(resolveCheckoutCommit(join(TMP_BASE, "checkout-revision-absent-dir"))).toBeNull();
  });
});
