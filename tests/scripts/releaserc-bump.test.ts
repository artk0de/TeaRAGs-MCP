import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { analyzeCommits } from "@semantic-release/commit-analyzer";
import { describe, expect, it } from "vitest";

// Runs the commit-analyzer config semantic-release actually uses, so the bump
// a commit earns is asserted against .releaserc.json itself. The analyzer takes
// the HIGHEST release among every matching rule, so a `release: false` rule for
// a scope cannot veto a generic `{ type: "feat", release: "minor" }` rule — the
// generic rule has to exclude the scope itself. v1.46.0 shipped empty because a
// lone feat(scripts) commit matched both.
const releaserc = JSON.parse(readFileSync(resolve(__dirname, "../../.releaserc.json"), "utf8")) as {
  plugins: [string, Record<string, unknown>][];
};
const analyzerConfig = releaserc.plugins.find(([name]) => name === "@semantic-release/commit-analyzer")![1];

async function bumpFor(message: string): Promise<string | null> {
  return analyzeCommits(analyzerConfig, {
    cwd: process.cwd(),
    commits: [{ hash: "abcdef1", message }],
    logger: { log: () => {} },
  });
}

describe(".releaserc.json version bumps", () => {
  it.each([
    "feat(scripts): release notes separate the plugin",
    "fix(scripts): spike imports from src",
    "improve(ci): faster matrix",
    "refactor(test): shared helper",
    "perf(website): smaller bundle",
    "feat(deps): bump a dependency",
    "ci(ci): skip the matrix",
    "chore(release): 1.46.0",
  ])("non-release scopes and types never bump: %s", async (message) => {
    expect(await bumpFor(message)).toBeNull();
  });

  it.each(["feat(embedding): quantization", "feat(qdrant): recover", "feat(config): new knob"])(
    "infrastructure feats bump patch: %s",
    async (message) => {
      expect(await bumpFor(message)).toBe("patch");
    },
  );

  it.each(["feat(api): new tool", "feat(explore): projection", "feat: scopeless feature"])(
    "public feats bump minor: %s",
    async (message) => {
      expect(await bumpFor(message)).toBe("minor");
    },
  );

  it.each([
    "fix(api): a bug",
    "fix: scopeless fix",
    "improve(cli): colours",
    "perf(git): faster walk",
    "docs(plugin): skill guidance",
    "docs: scopeless docs",
    "refactor(ingest): split module",
  ])("patch-level changes bump patch: %s", async (message) => {
    expect(await bumpFor(message)).toBe("patch");
  });

  it("a breaking change bumps minor, never major", async () => {
    expect(await bumpFor("feat(api)!: reshape the report")).toBe("minor");
    expect(await bumpFor("fix(config): pins\n\nBREAKING CHANGE: defaults move")).toBe("minor");
  });
});
