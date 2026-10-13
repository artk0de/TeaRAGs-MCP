/**
 * The diff's added / removed edge classification (bd tea-rags-mcp-xb669.3):
 * the SAME `heldBeforeChange` evidence order `DiffDetectorRun` subtracts with
 * — the diff base whenever it answers for the source, else the indexed graph —
 * exposed for a section that judges what a change adds without running the
 * detector families.
 */
import { describe, expect, it } from "vitest";

import { diffAddedEdges, diffRemovedEdgeCount } from "../../../../../src/core/api/internal/ops/diff-detector-run.js";
import { ReviewEdgeOverlay } from "../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";
import { baseEdgesOf, graphOf, overlayOf } from "./__helpers__/diff-run-fixtures.js";

describe("diffAddedEdges", () => {
  it("lists only the overlay pairs no evidence held before the change", () => {
    const overlay = overlayOf(
      [
        ["src/a.ts", "src/held-at-base.ts"],
        ["src/a.ts", "src/new.ts"],
        ["src/b.ts", "src/held-in-index.ts"],
        ["src/b.ts", "src/new.ts"],
      ],
      ["src/a.ts", "src/b.ts"],
    );
    const added = diffAddedEdges(["src/a.ts", "src/b.ts"], overlay, {
      baseEdges: baseEdgesOf({ "src/a.ts": ["src/held-at-base.ts"] }),
      graph: graphOf([["src/b.ts", "src/held-in-index.ts"]]),
    });
    expect(added).toEqual([
      { source: "src/a.ts", target: "src/new.ts" },
      { source: "src/b.ts", target: "src/new.ts" },
    ]);
  });

  it("lets the base decide over the index when it answers for the source", () => {
    const overlay = overlayOf([["src/a.ts", "src/x.ts"]], ["src/a.ts"]);
    const added = diffAddedEdges(["src/a.ts"], overlay, {
      baseEdges: baseEdgesOf({ "src/a.ts": [] }),
      graph: graphOf([["src/a.ts", "src/x.ts"]]),
    });
    expect(added).toEqual([{ source: "src/a.ts", target: "src/x.ts" }]);
  });

  it("judges every overlay pair when no port is wired — a missing fact is never already held", () => {
    const overlay = overlayOf([["src/a.ts", "src/x.ts"]], ["src/a.ts"]);
    expect(diffAddedEdges(["src/a.ts"], overlay, {})).toEqual([{ source: "src/a.ts", target: "src/x.ts" }]);
  });
});

describe("diffRemovedEdgeCount", () => {
  it("counts the targets a read source held before the change and no longer holds", () => {
    const overlay = overlayOf([["src/a.ts", "src/x.ts"]], ["src/a.ts"]);
    const removed = diffRemovedEdgeCount(["src/a.ts"], overlay, {
      baseEdges: baseEdgesOf({ "src/a.ts": ["src/x.ts", "src/y.ts", "src/z.ts"] }),
    });
    expect(removed).toBe(2);
  });

  it("counts a deleted file's out-edges as removed", () => {
    const overlay = overlayOf([], []);
    const removed = diffRemovedEdgeCount([], overlay, {
      graph: graphOf([
        ["src/gone.ts", "src/x.ts"],
        ["src/gone.ts", "src/y.ts"],
        ["src/other.ts", "src/x.ts"],
      ]),
      deletedFiles: ["src/gone.ts"],
    });
    expect(removed).toBe(2);
  });

  it("counts nothing for a source whose read was skipped — its current edges are unknown", () => {
    const overlay = new ReviewEdgeOverlay([
      { relPath: "src/a.rs", edges: [], skip: { reason: "unsupportedLanguage" } },
    ]);
    const removed = diffRemovedEdgeCount(["src/a.rs"], overlay, { graph: graphOf([["src/a.rs", "src/b.rs"]]) });
    expect(removed).toBe(0);
  });
});
