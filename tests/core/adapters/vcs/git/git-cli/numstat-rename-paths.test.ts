/**
 * bd tea-rags-mcp-0dwsn — rename blindness in the numstat parsers.
 *
 * `git log --numstat` has rename detection ON by default, so a renamed file
 * arrives as ONE mangled path column instead of a path. Every shape below was
 * captured from real `git log --numstat` output (the first four out of this
 * repo's own history, the quoted one out of a scratch repo with a non-ASCII
 * rename target), so they are observations, not guesses:
 *
 *   src/core/{infra => domains/maintenance}/migration/x.ts   prefix, no suffix
 *   scripts/spikes/{a.mjs => a.js}                           prefix, no suffix
 *   src/core/domains/maintenance/{ => drift}/x.ts            EMPTY left side
 *   src/core/{domains/ingest => }/infra/x.ts                 EMPTY right side
 *   verify-providers.js => scripts/verify-providers.js       no common affix
 *   cyr.ts => "\320\277\321\200.ts"                          C-quoted side
 *
 * The invariant under test is the same for all three parsers: the column names
 * the file AS OF THIS COMMIT, and — when the commit renamed it — where it came
 * from. Nothing downstream may ever see the `{a => b}` string.
 */

import { describe, expect, it } from "vitest";

import {
  parseCommitFileNumstat,
  parseNumstatChangedPath,
  parseNumstatOutput,
  parsePathspecOutput,
} from "../../../../../../src/core/adapters/vcs/git/git-cli/parsers.js";

const SHA = "a".repeat(40);
const PARENT = "b".repeat(40);

/** Build one `NUMSTAT_LOG_FORMAT` commit section with the given numstat rows. */
function logOutput(rows: string[]): string {
  return ["", SHA, PARENT, "Alice", "alice@ex.com", "1700000000", "feat: move things", rows.join("\n")].join("\0");
}

/** Same, for `NUMSTAT_LOG_FORMAT_WITH_COMMITTER` (extra `%ct` section). */
function logOutputWithCommitter(rows: string[]): string {
  return ["", SHA, PARENT, "Alice", "alice@ex.com", "1700000000", "1700000001", "feat: move", rows.join("\n")].join(
    "\0",
  );
}

describe("parseNumstatChangedPath — every shape git can put in the numstat path column", () => {
  it("leaves a plain path alone and reports no previous path", () => {
    expect(parseNumstatChangedPath("src/core/api/public/app.ts")).toEqual({ path: "src/core/api/public/app.ts" });
  });

  it("splits a common-prefix rename into current + previous path", () => {
    expect(parseNumstatChangedPath("src/core/{infra => domains/maintenance}/migration/x.ts")).toEqual({
      path: "src/core/domains/maintenance/migration/x.ts",
      previousPath: "src/core/infra/migration/x.ts",
    });
  });

  it("splits a prefix+suffix rename where only the basename moved", () => {
    expect(parseNumstatChangedPath("scripts/spikes/{read-run-stats.mjs => read-run-stats.js}")).toEqual({
      path: "scripts/spikes/read-run-stats.js",
      previousPath: "scripts/spikes/read-run-stats.mjs",
    });
  });

  it("collapses the seam slash when the LEFT side of the braces is empty", () => {
    expect(parseNumstatChangedPath("src/core/domains/maintenance/{ => drift}/schema-drift-monitor.ts")).toEqual({
      path: "src/core/domains/maintenance/drift/schema-drift-monitor.ts",
      previousPath: "src/core/domains/maintenance/schema-drift-monitor.ts",
    });
  });

  it("collapses the seam slash when the RIGHT side of the braces is empty", () => {
    expect(parseNumstatChangedPath("src/core/{domains/ingest => }/infra/score-background.ts")).toEqual({
      path: "src/core/infra/score-background.ts",
      previousPath: "src/core/domains/ingest/infra/score-background.ts",
    });
  });

  it("handles the brace-free form git emits when the two paths share no affix", () => {
    expect(parseNumstatChangedPath("verify-providers.js => scripts/verify-providers.js")).toEqual({
      path: "scripts/verify-providers.js",
      previousPath: "verify-providers.js",
    });
  });

  it("C-unquotes a quoted rename target (git quotes per side, braces suppressed)", () => {
    // Real output for `git mv cyr.ts "приве т.ts"` with core.quotePath on.
    expect(
      parseNumstatChangedPath('cyr.ts => "\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265 \\321\\202.ts"'),
    ).toEqual({
      path: "приве т.ts",
      previousPath: "cyr.ts",
    });
  });

  it("C-unquotes a quoted plain path that no rename is involved in", () => {
    expect(parseNumstatChangedPath('"src/\\320\\277.ts"')).toEqual({ path: "src/п.ts" });
  });

  it("keeps an unquoted path containing spaces intact on both sides", () => {
    expect(parseNumstatChangedPath("plainold.ts => wei rd.md")).toEqual({
      path: "wei rd.md",
      previousPath: "plainold.ts",
    });
  });
});

describe("parseNumstatOutput — file churn is keyed on the CURRENT path", () => {
  it("keys a rename row under the post-rename path, never under the mangled column", () => {
    const churn = parseNumstatOutput(
      logOutput(["39\t14\tsrc/bootstrap/config/{tuning-snapshot.ts => env-snapshot.ts}"]),
    );

    expect([...churn.keys()]).toEqual(["src/bootstrap/config/env-snapshot.ts"]);
    expect(churn.get("src/bootstrap/config/env-snapshot.ts")?.commits.map((c) => c.sha)).toEqual([SHA]);
  });

  it("still skips binary rows and keeps plain paths untouched", () => {
    const churn = parseNumstatOutput(logOutput(["-\t-\tassets/logo.bin", "3\t3\tsrc/bootstrap/factory.ts"]));

    expect([...churn.keys()]).toEqual(["src/bootstrap/factory.ts"]);
  });
});

describe("parsePathspecOutput — changed files carry the rename pair", () => {
  it("reports the current path plus where the commit moved the file from", () => {
    const [entry] = parsePathspecOutput(
      logOutput([
        "39\t14\tsrc/bootstrap/config/{tuning-snapshot.ts => env-snapshot.ts}",
        "3\t3\tsrc/bootstrap/factory.ts",
      ]),
    );

    expect(entry.changedFiles).toEqual([
      { path: "src/bootstrap/config/env-snapshot.ts", previousPath: "src/bootstrap/config/tuning-snapshot.ts" },
      { path: "src/bootstrap/factory.ts" },
    ]);
  });
});

describe("parseCommitFileNumstat — per-file counts keep the rename pair", () => {
  it("reports the current path, the previous path and the +/- counts together", () => {
    const [entry] = parseCommitFileNumstat(
      logOutputWithCommitter(["82\t33\ttests/bootstrap/{tuning-snapshot.test.ts => env-snapshot.test.ts}"]),
    );

    expect(entry.files).toEqual([
      {
        path: "tests/bootstrap/env-snapshot.test.ts",
        previousPath: "tests/bootstrap/tuning-snapshot.test.ts",
        added: 82,
        deleted: 33,
      },
    ]);
  });
});
