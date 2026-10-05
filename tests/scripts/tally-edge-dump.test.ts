import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseArgs, run } from "../../scripts/codegraph-chain-tally.js";
import { formatTallyEdgeDump } from "../../scripts/lib/tally-edge-dump.js";

describe("formatTallyEdgeDump", () => {
  it("sorts rows and appends the kind-stats block verbatim", () => {
    const out = formatTallyEdgeDump(
      [
        {
          relPath: "b.rb",
          line: 2,
          callText: "x.y",
          receiverKind: "dynamic",
          targetRelPath: null,
          targetSymbolId: null,
          edgeKind: "none",
        },
        {
          relPath: "a.rb",
          line: 9,
          callText: "foo",
          receiverKind: "bareCall",
          targetRelPath: "a.rb",
          targetSymbolId: "A#foo",
          edgeKind: "exact",
        },
      ],
      "bareCall 1.000 1/1",
    );
    expect(out.split("\n")).toEqual([
      "a.rb\t9\tfoo\tbareCall\ta.rb\tA#foo\texact",
      "b.rb\t2\tx.y\tdynamic\t-\t-\tnone",
      "#kind-stats",
      "bareCall 1.000 1/1",
      "",
    ]);
  });

  it("replaces tabs and newlines inside callText so one row stays one line", () => {
    const out = formatTallyEdgeDump(
      [
        {
          relPath: "a.py",
          line: 1,
          callText: "f(\ta,\n b)",
          receiverKind: "bareCall",
          targetRelPath: null,
          targetSymbolId: null,
          edgeKind: "none",
        },
      ],
      "",
    );
    expect(out.split("\n")[0]).toBe("a.py\t1\tf( a,  b)\tbareCall\t-\t-\tnone");
  });

  it("orders rows on the same file and line by callText, then by the full line", () => {
    const row = {
      relPath: "a.rb",
      line: 3,
      receiverKind: "bareCall",
      targetRelPath: null,
      targetSymbolId: null,
      edgeKind: "none",
    };
    const out = formatTallyEdgeDump(
      [
        { ...row, callText: "zed", edgeKind: "none" },
        { ...row, callText: "alpha", edgeKind: "exact" },
        { ...row, callText: "alpha", edgeKind: "candidate" },
      ],
      "k",
    );
    expect(out.split("\n").slice(0, 3)).toEqual([
      "a.rb\t3\talpha\tbareCall\t-\t-\tcandidate",
      "a.rb\t3\talpha\tbareCall\t-\t-\texact",
      "a.rb\t3\tzed\tbareCall\t-\t-\tnone",
    ]);
  });
});

describe("codegraph-chain-tally --dump-edges wiring", () => {
  let corpus: string;

  function write(relPath: string, content: string): void {
    const absolute = join(corpus, relPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }

  beforeEach(() => {
    corpus = mkdtempSync(join(tmpdir(), "chain-tally-dump-"));
    write("app/service.py", "def helper():\n    return 1\n\n\ndef service():\n    return helper()\n");
  });

  afterEach(() => {
    rmSync(corpus, { recursive: true, force: true });
  });

  it("reads the dump path off --dump-edges and leaves it null by default", () => {
    expect(parseArgs(["--dump-edges", "/tmp/x.tsv"]).dumpEdges).toBe("/tmp/x.tsv");
    expect(parseArgs([]).dumpEdges).toBeNull();
  });

  it("collects one answer row per call site from the scored resolver outcome", async () => {
    const result = await run(corpus, "python", null, Number.MAX_SAFE_INTEGER, true, true, { edgeDump: true });
    const answers = (result.edgeDump ?? []).filter((row) => !row.edgeKind.startsWith("runner:"));
    expect(answers).toHaveLength(result.rows.length);
    expect(answers).toContainEqual(
      expect.objectContaining({
        relPath: "app/service.py",
        line: 6,
        callText: "helper()",
        receiverKind: "bareCall",
        targetRelPath: "app/service.py",
        edgeKind: "exact",
      }),
    );
  }, 30_000);

  it("also dumps every method edge production pushes, so a fan or dispatch change is visible", async () => {
    const result = await run(corpus, "python", null, Number.MAX_SAFE_INTEGER, true, true, { edgeDump: true });
    const runnerRows = (result.edgeDump ?? []).filter((row) => row.edgeKind.startsWith("runner:"));
    expect(runnerRows.length).toBeGreaterThan(0);
    expect(runnerRows.length).toEqual(result.rows.reduce((n, row) => n + row.runnerEdges.length, 0));
  }, 30_000);

  it("collects nothing unless asked", async () => {
    const result = await run(corpus, "python", null, Number.MAX_SAFE_INTEGER, true);
    expect(result.edgeDump).toBeUndefined();
  }, 30_000);
});
