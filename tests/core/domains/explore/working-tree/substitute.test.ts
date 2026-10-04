/**
 * The substitution rule (bd tea-rags-mcp-xi2r9.3), pure: rows of touched files
 * leave, the tree's rows that pass `keep` arrive; rows of untouched files are
 * never consulted against `keep`.
 */

import { describe, expect, it } from "vitest";

import { codeRow, fakeWorkingTreeView } from "../__fixtures__/working-tree-view.js";
import {
  substituteWorkingTreeRows,
  workingTreeStateOf,
} from "../../../../../src/core/domains/explore/working-tree/substitute.js";

describe("substituteWorkingTreeRows", () => {
  const base = [codeRow("a", { relativePath: "src/a.ts" }), codeRow("b", { relativePath: "src/b.ts" })];

  it("drops rows of touched files and adds the delta rows that pass keep", () => {
    const view = fakeWorkingTreeView({ changed: ["src/a.ts"], deleted: ["src/b.ts"] });
    const delta = [
      codeRow("a2", { relativePath: "src/a.ts", symbolId: "kept" }),
      codeRow("a3", { relativePath: "src/a.ts", symbolId: "dropped" }),
    ];

    const rows = substituteWorkingTreeRows(base, view, delta, (r) => r.payload.symbolId === "kept");

    expect(rows.map((r) => r.id)).toEqual(["a2"]);
  });

  it("keeps rows of untouched files without asking keep", () => {
    const view = fakeWorkingTreeView({ changed: ["src/a.ts"] });

    const rows = substituteWorkingTreeRows(base, view, [], () => false);

    expect(rows.map((r) => r.id)).toEqual(["b"]);
  });

  it("returns the scrolled rows unchanged when nothing is touched", () => {
    const rows = substituteWorkingTreeRows(base, fakeWorkingTreeView({}), [codeRow("x", {})], () => true);

    expect(rows).toEqual(base);
  });
});

describe("workingTreeStateOf", () => {
  const view = fakeWorkingTreeView({ changed: ["src/m.ts"], deleted: ["src/d.ts"] });

  it("names a deleted file deleted, any other delta file modified, the rest nothing", () => {
    expect(workingTreeStateOf(view, "src/d.ts")).toBe("deleted");
    expect(workingTreeStateOf(view, "src/m.ts")).toBe("modified");
    expect(workingTreeStateOf(view, "src/u.ts")).toBeUndefined();
    expect(workingTreeStateOf(view, undefined)).toBeUndefined();
  });
});
