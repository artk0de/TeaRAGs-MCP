/**
 * The shared import→file-edge engine (E2 seam 1, bd tea-rags-mcp-9fgdi). The
 * engine is deliberately dumb: a mapper answers project/external/unknown and
 * this turns the project answers into edges. Every judgement call — which root,
 * `.py` or `__init__.py`, is numpy external — belongs to the mapper and is
 * tested there.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, FileExtraction } from "../../../../src/core/contracts/types/codegraph.js";
import type { ImportFileMapper, ImportFileTarget } from "../../../../src/core/contracts/types/language.js";
import { resolveImportFileEdges } from "../../../../src/core/domains/language/import-file-edges.js";

function extractionWith(relPath: string, importTexts: string[]): FileExtraction {
  return {
    relPath,
    language: "python",
    imports: importTexts.map((importText, i) => ({
      importText,
      startLine: i + 1,
    })),
    chunks: [],
    fileScope: [],
  };
}

function mapperFrom(answers: Record<string, ImportFileTarget>): ImportFileMapper {
  return {
    mapImportToFile: (importText) => answers[importText] ?? { kind: "unknown" },
  };
}

const ctx = {
  callerFile: "pkg/a.py",
  callerScope: [],
  imports: [],
} as unknown as CallContext;

describe("resolveImportFileEdges", () => {
  it("emits one edge per project mapping, carrying the import text verbatim", () => {
    const edges = resolveImportFileEdges(
      extractionWith("pkg/a.py", ["pkg.b", "pkg.sub"]),
      mapperFrom({
        "pkg.b": { kind: "project", relPath: "pkg/b.py" },
        "pkg.sub": { kind: "project", relPath: "pkg/sub/__init__.py" },
      }),
      ctx,
    );
    expect(edges).toEqual([
      { targetRelPath: "pkg/b.py", importText: "pkg.b" },
      { targetRelPath: "pkg/sub/__init__.py", importText: "pkg.sub" },
    ]);
  });

  it("emits nothing for an external mapping", () => {
    const edges = resolveImportFileEdges(
      extractionWith("pkg/a.py", ["numpy"]),
      mapperFrom({ numpy: { kind: "external" } }),
      ctx,
    );
    expect(edges).toEqual([]);
  });

  it("emits nothing for an unknown mapping", () => {
    const edges = resolveImportFileEdges(
      extractionWith("pkg/a.py", ["domains.orders"]),
      mapperFrom({ "domains.orders": { kind: "unknown" } }),
      ctx,
    );
    expect(edges).toEqual([]);
  });

  it("drops a self-loop: `from . import x` inside the package __init__", () => {
    const edges = resolveImportFileEdges(
      extractionWith("pkg/__init__.py", ["."]),
      mapperFrom({ ".": { kind: "project", relPath: "pkg/__init__.py" } }),
      ctx,
    );
    expect(edges).toEqual([]);
  });

  it("does NOT dedupe — the runner owns that (dedupeFileEdgesByTarget)", () => {
    const edges = resolveImportFileEdges(
      extractionWith("pkg/a.py", ["pkg.b", "pkg.b"]),
      mapperFrom({ "pkg.b": { kind: "project", relPath: "pkg/b.py" } }),
      ctx,
    );
    expect(edges).toHaveLength(2);
  });

  it("passes the OWNING file, not ctx.callerFile, as fromFile", () => {
    const seen: string[] = [];
    const mapper: ImportFileMapper = {
      mapImportToFile: (_importText, fromFile) => {
        seen.push(fromFile);
        return { kind: "unknown" };
      },
    };
    resolveImportFileEdges(extractionWith("pkg/deep/c.py", ["x"]), mapper, ctx);
    expect(seen).toEqual(["pkg/deep/c.py"]);
  });

  it("returns an empty array for a file with no imports", () => {
    expect(resolveImportFileEdges(extractionWith("pkg/a.py", []), mapperFrom({}), ctx)).toEqual([]);
  });
});
