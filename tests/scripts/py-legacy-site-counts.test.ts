/**
 * The legacy population of a merged run (bd tea-rags-mcp-w205u, E4.0.2b).
 *
 * A `--oracle merged` run has to print the three published tables and the
 * recall block byte-identically to a `--oracle jedi` run at the same workers.
 * That needs the rows of a REPLACED file to keep the row jedi itself produced —
 * verdict, degraded flag and all — so the legacy side counts them in `sites`
 * and withholds them from every rate, exactly as a jedi-only run does.
 */
import { describe, expect, it } from "vitest";

import {
  legacyViewOf,
  mergeOracleReplies,
  tallyPyRecall,
  tallyPyRows,
  type MergedOracleFileReply,
  type PyOracleFileReply,
  type PyOracleRow,
} from "../../scripts/lib/py-oracle-core.js";
import { buildRows } from "../../scripts/py-codegraph-jedi-oracle.js";

const reply = (relPath: string, overrides: Partial<PyOracleFileReply> = {}): PyOracleFileReply => ({
  relPath,
  parseFailed: false,
  parsoErrors: 0,
  answers: [],
  ...overrides,
});

const site = (receiverKind = "bareCall") =>
  ({
    relPath: "pkg/a.py",
    call: { callText: "f()", receiver: null, member: "f", startLine: 1 },
    ctx: { callerFile: "pkg/a.py", callerScope: [] },
    receiverKind,
    chain: null,
    answeredBy: "none",
    missBucket: "miss",
  }) as never;

const EXTERNAL = { startLine: 1, member: "f", outcome: { kind: "external" as const, origin: "sitePackages" as const } };
const IN_PROJECT = {
  startLine: 1,
  member: "f",
  outcome: {
    kind: "inProject" as const,
    targets: [{ relPath: "pkg/b.py", symbolId: "g", pinUncertain: false }],
  },
};

/** jedi answered from a parso-damaged tree; the second engine repaired the file. */
const damagedThenRepaired = (): Map<string, MergedOracleFileReply> =>
  mergeOracleReplies(
    new Map([["pkg/a.py", reply("pkg/a.py", { parsoErrors: 3, answers: [EXTERNAL] })]]),
    new Map([["pkg/a.py", reply("pkg/a.py", { answers: [IN_PROJECT] })]]),
  );

const only = (rows: readonly PyOracleRow[]): PyOracleRow => {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row");
  return row;
};

describe("mergeOracleReplies keeps the replaced file's jedi reply", () => {
  it("carries jedi's own reply beside the repair, so the legacy side loses no site", () => {
    expect(damagedThenRepaired().get("pkg/a.py")?.legacy).toEqual(
      reply("pkg/a.py", { parsoErrors: 3, answers: [EXTERNAL] }),
    );
  });

  it("gives a file only the second engine saw a SILENT jedi reply, not a missing one", () => {
    const merged = mergeOracleReplies(new Map(), new Map([["pkg/a.py", reply("pkg/a.py", { answers: [IN_PROJECT] })]]));
    expect(merged.get("pkg/a.py")?.legacy).toEqual(reply("pkg/a.py"));
  });
});

describe("buildRows attaches the row a jedi-only run would have produced", () => {
  it("keeps jedi's verdict on the legacy view while the merged row reads the repair", () => {
    const row = only(buildRows([site()], damagedThenRepaired()));
    expect(row.verdict).toBe("missed");
    expect(legacyViewOf(row)?.verdict).toBe("agreeExternal");
  });

  it("keeps jedi's degraded flag, so the legacy side withholds the row from every rate", () => {
    const row = only(buildRows([site()], damagedThenRepaired()));
    expect(legacyViewOf(row)?.oracleDegraded).toBe(true);
    expect(row.oracleDegraded).toBe(false);
  });

  it("is the row itself when jedi answered the file — jedi mode is the identity", () => {
    const row = only(buildRows([site()], new Map([["pkg/a.py", reply("pkg/a.py", { answers: [EXTERNAL] })]])));
    expect(legacyViewOf(row)).toBe(row);
  });

  it("has no legacy view under --oracle lsp, where jedi was never asked", () => {
    const lspOnly = new Map([["pkg/a.py", { reply: reply("pkg/a.py", { answers: [IN_PROJECT] }), engine: "lsp" }]]);
    expect(legacyViewOf(only(buildRows([site()], lspOnly as never)))).toBeUndefined();
  });
});

describe("the legacy tables count a replaced file's rows", () => {
  const legacyRows = (): PyOracleRow[] =>
    buildRows([site()], damagedThenRepaired()).flatMap((row) => {
      const view = legacyViewOf(row);
      return view === undefined ? [] : [view];
    });

  it("counts the replaced row in sites and withholds it from every rate", () => {
    expect(tallyPyRows(legacyRows(), (row) => [row.receiverKind])[0]).toMatchObject({
      label: "bareCall",
      sites: 1,
      oracle: 0,
      external: 0,
    });
  });

  it("leaves the legacy recall denominator empty while the merged one scores the repair", () => {
    const rows = buildRows([site()], damagedThenRepaired());
    expect(tallyPyRecall(rows, (row) => [row.receiverKind])[0]).toMatchObject({
      label: "bareCall",
      nLegacy: 0,
      nMerged: 1,
    });
  });
});

describe("the recall block orders by label", () => {
  it("sorts by label rather than by nMerged, so both modes print the same rows in order", () => {
    const sites = [site("bbb"), site("bbb"), site("aaa")];
    const rows = buildRows(
      sites,
      new Map([["pkg/a.py", reply("pkg/a.py", { answers: [IN_PROJECT, IN_PROJECT, IN_PROJECT] })]]),
    );
    expect(tallyPyRecall(rows, (row) => [row.receiverKind]).map((split) => split.label)).toEqual(["aaa", "bbb"]);
  });
});
