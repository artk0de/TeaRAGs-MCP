/**
 * The one end-to-end check of the Python side (bd tea-rags-mcp-mmckn). Every
 * other jedi behaviour is asserted through this fixture, because a unit test of
 * `query_site` would be a test of a mock rather than of jedi.
 *
 * `tests/fixtures/py-oracle/expected-oracle.json` is FROZEN ground truth,
 * reviewed by hand against the fixture sources. When a jedi upgrade moves a
 * row, a human confirms jedi is right and updates the fixture in the same
 * commit — the test is never relaxed to make a new answer pass.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE_ROOT = join(REPO_ROOT, "tests", "fixtures", "py-oracle");
const uvAvailable = spawnSync("uv", ["--version"], { encoding: "utf8" }).status === 0;

interface OracleAnswer {
  startLine: number;
  member: string;
  outcome: {
    kind: string;
    origin?: string;
    targets?: { relPath: string; symbolId: string | null }[];
  };
  unlocated?: string;
}

/** Sites the host would emit for the fixture, in the order a walk produces them. */
const SITES: Record<
  string,
  {
    startLine: number;
    callText: string;
    receiver: string | null;
    member: string;
  }[]
> = {
  "pkg/consumer.py": [
    {
      startLine: 7,
      callText: "User(name, ...)",
      receiver: null,
      member: "User",
    },
    {
      startLine: 8,
      callText: "promote(user)",
      receiver: null,
      member: "promote",
    },
  ],
  "pkg/models.py": [
    {
      startLine: 8,
      callText: "super().__init__(name)",
      receiver: "super()",
      member: "__init__",
    },
    {
      startLine: 20,
      callText: "self.touch()",
      receiver: "self",
      member: "touch",
    },
    {
      startLine: 21,
      callText: "self.describe()",
      receiver: "self",
      member: "describe",
    },
  ],
  "pkg/service.py": [
    {
      startLine: 7,
      callText: "user.touch()",
      receiver: "user",
      member: "touch",
    },
    {
      startLine: 8,
      callText: "user.rename('promoted')",
      receiver: "user",
      member: "rename",
    },
    {
      startLine: 12,
      callText: "User.normalise(item)",
      receiver: "User",
      member: "normalise",
    },
  ],
  "pkg/stdlib_use.py": [
    {
      startLine: 10,
      callText: "json.dumps(payload)",
      receiver: "json",
      member: "dumps",
    },
    {
      startLine: 14,
      callText: "os.path.join(...)",
      receiver: "os.path",
      member: "join",
    },
    {
      startLine: 18,
      callText: "jedi.Script(source)",
      receiver: "jedi",
      member: "Script",
    },
  ],
};

function runOracle(workers = 1): Record<string, OracleAnswer[]> {
  const lines = [
    JSON.stringify({
      kind: "config",
      corpusRoot: FIXTURE_ROOT,
      venvPython: null,
      workers,
    }),
  ];
  for (const relPath of Object.keys(SITES).sort()) {
    lines.push(JSON.stringify({ kind: "file", relPath, sites: SITES[relPath] }));
  }
  const child = spawnSync(
    "uv",
    [
      "run",
      "--no-project",
      "--python",
      "3.13",
      "--with",
      "jedi==0.20.0",
      "python",
      join(REPO_ROOT, "scripts", "py-oracle", "jedi_oracle.py"),
    ],
    {
      input: `${lines.join("\n")}\n`,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  expect(child.status, child.stderr).toBe(0);
  const byFile: Record<string, OracleAnswer[]> = {};
  for (const line of child.stdout.trim().split("\n")) {
    const parsed = JSON.parse(line) as {
      relPath: string;
      answers: OracleAnswer[];
      parseFailed: boolean;
      parsoErrors: number;
    };
    expect(parsed.parseFailed).toBe(false);
    expect(parsed.parsoErrors).toBe(0);
    byFile[parsed.relPath] = parsed.answers;
  }
  return byFile;
}

describe.skipIf(!uvAvailable)("jedi_oracle.py over the fixture corpus", () => {
  const answersFor = (relPath: string, member: string): OracleAnswer => {
    const found = runOracle()[relPath]?.find((a) => a.member === member);
    expect(found, `${relPath} has no answer for ${member}`).toBeDefined();
    return found as OracleAnswer;
  };

  it("resolves an inherited method through the first base in the MRO", () => {
    const answer = answersFor("pkg/service.py", "touch");
    expect(answer.outcome.kind).toBe("inProject");
    expect(answer.outcome.origin).toBe("project");
    expect(answer.outcome.targets?.[0]).toMatchObject({
      relPath: "pkg/base.py",
      symbolId: "Auditable#touch",
    });
  });

  it("pins a staticmethod with a DOT separator, not a hash", () => {
    expect(answersFor("pkg/service.py", "normalise").outcome.targets?.[0]).toMatchObject({
      relPath: "pkg/models.py",
      symbolId: "User.normalise",
    });
  });

  it("resolves an inherited method through the MRO, first base winning", () => {
    expect(answersFor("pkg/models.py", "describe").outcome.targets?.[0]).toMatchObject({
      relPath: "pkg/base.py",
      symbolId: "Auditable#describe",
    });
  });

  /**
   * MEASURED, not desired. jedi 0.20.0 searches only the FIRST base behind
   * `super()`: `super().describe()` reaches `Auditable#describe`, but
   * `super().__init__` in `User(Auditable, Named)` — where only the SECOND base
   * defines `__init__` — lands on `object.__init__` in jedi's bundled typeshed
   * instead of on `Named#__init__`. Reordering the bases to `User(Named, ...)`
   * makes jedi find it, which is what pins the cause to base ORDER rather than
   * to the fixture or to this oracle. Downstream tasks must not score a
   * `super()` call into a non-first base as ground truth "external": the row is
   * a jedi blind spot. A jedi release that linearises the full MRO flips this
   * row to `Named#__init__`, and the fixture is updated in that same commit.
   */
  it("stops at the first base for super(), reporting typeshed for the rest", () => {
    const answer = answersFor("pkg/models.py", "__init__");
    expect(answer.outcome.kind).toBe("external");
    expect(answer.outcome.origin).toBe("typeshedStub");
  });

  it("follows the package __init__ re-export back to the defining module", () => {
    expect(answersFor("pkg/consumer.py", "promote").outcome.targets?.[0]).toMatchObject({
      relPath: "pkg/service.py",
      symbolId: "promote",
    });
  });

  it("calls stdlib receivers external with origin stdlib", () => {
    const answer = answersFor("pkg/stdlib_use.py", "dumps");
    expect(answer.outcome.kind).toBe("external");
    expect(answer.outcome.origin).toBe("stdlib");
  });

  it("calls a third-party receiver external with origin sitePackages", () => {
    const answer = answersFor("pkg/stdlib_use.py", "Script");
    expect(answer.outcome.kind).toBe("external");
    expect(answer.outcome.origin).toBe("sitePackages");
  });

  it("matches the frozen expected output exactly", () => {
    const expected = JSON.parse(readFileSync(join(FIXTURE_ROOT, "expected-oracle.json"), "utf8")) as Record<
      string,
      OracleAnswer[]
    >;
    expect(runOracle()).toEqual(expected);
  });

  it("answers a striped multi-worker run exactly as the single-worker one", () => {
    // The pool partitions files by index and pins one group per process, so a
    // parallel run must cover every file exactly once and answer each of them
    // the same way. A baseline that changed with the worker count would not be
    // a baseline.
    expect(runOracle(3)).toEqual(runOracle(1));
  });
});
