/**
 * `ReviewEdgeOverlay` — the pure per-review view over file-edge reads (bd
 * tea-rags-mcp-89k7k.1.2, F1): every read file masked out of the indexed
 * graph, plus that read's edges. Moved with the value into the codegraph
 * domain (bd tea-rags-mcp-89k7k.35.19); the working-tree producer's tests stay
 * in `tests/core/api/internal/ops/review-edge-overlay.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  ReviewEdgeOverlay,
  type ReviewFileEdgeRead,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";

describe("ReviewEdgeOverlay", () => {
  function read(
    relPath: string,
    edges: readonly [string, string][],
    skip?: ReviewFileEdgeRead["skip"],
  ): ReviewFileEdgeRead {
    return {
      relPath,
      edges: edges.map(([sourceRelPath, targetRelPath]) => ({ sourceRelPath, targetRelPath })),
      ...(skip !== undefined ? { skip } : {}),
    };
  }

  it("masks every read relPath, whatever the read found", () => {
    const overlay = new ReviewEdgeOverlay([
      read("src/a.ts", [["src/a.ts", "src/b.ts"]]),
      read("src/empty.ts", []),
      read("docs/notes.md", [], { reason: "noCodegraphLanguage" }),
      read("src/gone.ts", [], { reason: "unreadable", detail: "ENOENT" }),
    ]);

    expect([...overlay.masked].sort()).toEqual(["docs/notes.md", "src/a.ts", "src/empty.ts", "src/gone.ts"]);
  });

  it("answers edgesFrom for a file with edges, without edges, and outside the read", () => {
    const overlay = new ReviewEdgeOverlay([
      read("src/a.ts", [
        ["src/a.ts", "src/b.ts"],
        ["src/a.ts", "src/c.ts"],
      ]),
      read("src/empty.ts", []),
    ]);

    expect(overlay.edgesFrom("src/a.ts")).toEqual([
      { sourceRelPath: "src/a.ts", targetRelPath: "src/b.ts" },
      { sourceRelPath: "src/a.ts", targetRelPath: "src/c.ts" },
    ]);
    expect(overlay.edgesFrom("src/empty.ts")).toEqual([]);
    expect(overlay.edgesFrom("src/unchanged.ts")).toEqual([]);
  });

  it("lists the skipped reads with their reasons and details", () => {
    const overlay = new ReviewEdgeOverlay([
      read("src/a.ts", [["src/a.ts", "src/b.ts"]]),
      read("docs/notes.md", [], { reason: "noCodegraphLanguage" }),
      read("src/gone.ts", [], { reason: "unreadable", detail: "ENOENT: no such file" }),
      read("app/user.rb", [], { reason: "unsupportedLanguage", detail: "index-backed mapper" }),
      read("src/broken.py", [], { reason: "parseFailed", detail: "grammar missing" }),
    ]);

    expect(overlay.unsupported()).toEqual([
      { relPath: "docs/notes.md", reason: "noCodegraphLanguage" },
      { relPath: "src/gone.ts", reason: "unreadable", detail: "ENOENT: no such file" },
      { relPath: "app/user.rb", reason: "unsupportedLanguage", detail: "index-backed mapper" },
      { relPath: "src/broken.py", reason: "parseFailed", detail: "grammar missing" },
    ]);
  });

  it("hands out frozen edge views — the overlay is pure after construction", () => {
    const overlay = new ReviewEdgeOverlay([read("src/a.ts", [["src/a.ts", "src/b.ts"]])]);

    expect(Object.isFrozen(overlay.edgesFrom("src/a.ts"))).toBe(true);
    expect(Object.isFrozen(overlay.edgesFrom("src/empty.ts"))).toBe(true);
  });
});
