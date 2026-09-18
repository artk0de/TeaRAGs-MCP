import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { lintStagedCommandsFor, pinnableSourceFiles } from "../../scripts/lib/lint-staged-format.js";

/**
 * bd tea-rags-mcp-e6xx — the version pin digests source bytes, and the
 * pre-commit hook's lint-staged step rewrites those bytes AFTER `npm run
 * pin:lang-versions` ran (eslint --fix dropped an assertion, prettier merged
 * two imports), so a commit that pinned correctly still failed its own pin
 * test. The pin script now applies lint-staged's own commands first; these are
 * the pure halves of that step.
 */
const LINT_STAGED = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")) as {
    "lint-staged": Record<string, string | string[]>;
  }
)["lint-staged"];

describe("lintStagedCommandsFor", () => {
  it("answers the repository's own command list for a TypeScript source, in order", () => {
    expect(lintStagedCommandsFor("src/core/domains/language/go/walker/walker.ts", LINT_STAGED)).toEqual([
      "eslint --no-warn-ignored --max-warnings 0 --fix",
      "prettier --write",
    ]);
  });

  it("matches a pattern without a slash against the basename, as lint-staged does", () => {
    expect(lintStagedCommandsFor("docs/README.md", LINT_STAGED)).toEqual(["prettier --write"]);
  });

  it("answers nothing for a file no pattern covers", () => {
    expect(lintStagedCommandsFor("gin/gin.go", LINT_STAGED)).toEqual([]);
  });

  it("accepts a single command written as a string", () => {
    expect(lintStagedCommandsFor("a.ts", { "*.ts": "prettier --write" })).toEqual(["prettier --write"]);
  });
});

describe("pinnableSourceFiles", () => {
  it("keeps the non-test TypeScript sources under src/ — the only files a pin digests", () => {
    expect(
      pinnableSourceFiles([
        "src/core/domains/language/go/walker/walker.ts",
        "src/core/infra/symbolid/classify.ts",
        "tests/core/domains/language/go/walker/go-walker.test.ts",
        "src/core/domains/language/go/walker/walker.test.ts",
        "scripts/codegraph-chain-tally.ts",
        "src/core/domains/language/CLAUDE.md",
        "tests/core/domains/language/capability/version-pins.json",
      ]),
    ).toEqual(["src/core/domains/language/go/walker/walker.ts", "src/core/infra/symbolid/classify.ts"]);
  });
});
