/**
 * Leaking-abstraction detector, file level (bd tea-rags-mcp-jetrd, A4).
 *
 * A module is a directory holding a language entry file (its facade). The
 * boundary is judged only where the importers themselves adopted the facade:
 * adoption = facade importers / (facade importers + deep importers) over the
 * distinct external importing files, a file doing both counting as deep.
 * Active iff at least 3 external importers, adoption > 0.5 and adoption at or
 * above the adaptive (Otsu) threshold over all such modules. A violation is
 * an edge from outside an active module into one of its non-entry files,
 * attributed to the innermost such module; `bypass` when the facade itself
 * imports the target (re-exports it), `internal-reach` otherwise.
 */
import { describe, expect, it } from "vitest";

import type {
  FileDependencyEdge,
  FileDependencyGraph,
  FileDependencyGraphFile,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  detectLeakingAbstractions,
  FACADE_ADOPTION_MAJORITY,
  FACADE_MIN_EXTERNAL_IMPORTERS,
  FACADE_MODULE_EXCLUSION_REASONS,
  MODULE_ENTRY_FILE_NAMES,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

function walked(relPath: string, language = "typescript"): FileDependencyGraphFile {
  return { relPath, language, symbolCount: 1 };
}

function edge(sourceRelPath: string, targetRelPath: string, callWeight = 0): FileDependencyEdge {
  return { sourceRelPath, targetRelPath, callWeight };
}

/**
 * - `lib/sync/` — facade `index.ts` re-exports `a.ts` and the nested module
 *   `snap/`. Facade-only importers u1..u3, u7; deep importers u4 (facade AND
 *   `a.ts` → deep), u5 (`b.ts`), u6 (`snap/index.ts`, not sync's entry);
 *   u7 facade-only: adoption 4 / 7 → ACTIVE (population of 3 → majority rule).
 * - `lib/sync/snap/` — importers `lib/sync/index.ts` and u6 through the facade,
 *   `lib/sync/a.ts` deep into `s.ts`: 2 / 3 → ACTIVE.
 * - `lib/contracts/` — three importers, all deep: 0 / 3 → facade-not-adopted.
 * - `lib/tiny/` — one importer → too-few-importers.
 * - `pkg/store/` — Go package → language-enforced.
 */
function fixture(): FileDependencyGraph {
  const files = [
    walked("lib/sync/index.ts"),
    walked("lib/sync/a.ts"),
    walked("lib/sync/b.ts"),
    walked("lib/sync/snap/index.ts"),
    walked("lib/sync/snap/s.ts"),
    walked("lib/contracts/index.ts"),
    walked("lib/contracts/t.ts"),
    walked("lib/tiny/index.ts"),
    walked("lib/tiny/x.ts"),
    walked("pkg/store/store.go", "go"),
    walked("cmd/main.go", "go"),
    ...["u1", "u2", "u3", "u4", "u5", "u6", "u7"].map((u) => walked(`app/${u}.ts`)),
  ];
  const edges = [
    edge("lib/sync/index.ts", "lib/sync/a.ts"),
    edge("lib/sync/index.ts", "lib/sync/snap/index.ts"),
    edge("lib/sync/a.ts", "lib/sync/snap/s.ts", 3),
    edge("app/u1.ts", "lib/sync/index.ts"),
    edge("app/u2.ts", "lib/sync/index.ts"),
    edge("app/u3.ts", "lib/sync/index.ts"),
    edge("app/u4.ts", "lib/sync/index.ts"),
    edge("app/u4.ts", "lib/sync/a.ts", 2),
    edge("app/u5.ts", "lib/sync/b.ts", 1.5),
    edge("app/u6.ts", "lib/sync/snap/index.ts"),
    edge("app/u7.ts", "lib/sync/index.ts"),
    edge("app/u1.ts", "lib/contracts/t.ts"),
    edge("app/u2.ts", "lib/contracts/t.ts"),
    edge("app/u3.ts", "lib/contracts/t.ts"),
    edge("app/u1.ts", "lib/tiny/x.ts"),
    edge("cmd/main.go", "pkg/store/store.go"),
  ];
  return { files, edges };
}

describe("detectLeakingAbstractions (bd tea-rags-mcp-jetrd)", () => {
  it("names its thresholds as the owner-approved constants", () => {
    expect(FACADE_ADOPTION_MAJORITY).toBe(0.5);
    expect(FACADE_MIN_EXTERNAL_IMPORTERS).toBe(3);
  });

  it("assesses every module: adoption over distinct external importers, a file doing both counting as deep", () => {
    const report = detectLeakingAbstractions(fixture());

    expect(report.modules).toEqual([
      {
        moduleDir: "cmd",
        facadeRelPath: null,
        externalImporterCount: 0,
        facadeImporterCount: 0,
        deepImporterCount: 0,
        adoption: 0,
        status: "language-enforced",
      },
      {
        moduleDir: "lib/contracts",
        facadeRelPath: "lib/contracts/index.ts",
        externalImporterCount: 3,
        facadeImporterCount: 0,
        deepImporterCount: 3,
        adoption: 0,
        status: "facade-not-adopted",
      },
      {
        moduleDir: "lib/sync",
        facadeRelPath: "lib/sync/index.ts",
        externalImporterCount: 7,
        facadeImporterCount: 4,
        deepImporterCount: 3,
        adoption: 4 / 7,
        status: "active",
      },
      {
        moduleDir: "lib/sync/snap",
        facadeRelPath: "lib/sync/snap/index.ts",
        externalImporterCount: 3,
        facadeImporterCount: 2,
        deepImporterCount: 1,
        adoption: 2 / 3,
        status: "active",
      },
      {
        moduleDir: "lib/tiny",
        facadeRelPath: "lib/tiny/index.ts",
        externalImporterCount: 1,
        facadeImporterCount: 0,
        deepImporterCount: 1,
        adoption: 0,
        status: "too-few-importers",
      },
      {
        moduleDir: "pkg/store",
        facadeRelPath: null,
        externalImporterCount: 1,
        facadeImporterCount: 0,
        deepImporterCount: 0,
        adoption: 0,
        status: "language-enforced",
      },
    ]);
  });

  it("flags edges into an active module's non-entry files, attributed to the innermost module, with the kind", () => {
    const report = detectLeakingAbstractions(fixture());

    expect(report.violations).toEqual([
      {
        kind: "internal-reach",
        kindBasis: "file-rule",
        sourceRelPath: "lib/sync/a.ts",
        targetRelPath: "lib/sync/snap/s.ts",
        moduleDir: "lib/sync/snap",
        facadeRelPath: "lib/sync/snap/index.ts",
        adoption: 2 / 3,
        facadeImporterCount: 2,
        deepImporterCount: 1,
        callWeight: 3,
      },
      {
        kind: "internal-reach",
        kindBasis: "file-rule",
        sourceRelPath: "app/u5.ts",
        targetRelPath: "lib/sync/b.ts",
        moduleDir: "lib/sync",
        facadeRelPath: "lib/sync/index.ts",
        adoption: 4 / 7,
        facadeImporterCount: 4,
        deepImporterCount: 3,
        callWeight: 1.5,
      },
      {
        kind: "bypass",
        kindBasis: "file-rule",
        sourceRelPath: "app/u4.ts",
        targetRelPath: "lib/sync/a.ts",
        moduleDir: "lib/sync",
        facadeRelPath: "lib/sync/index.ts",
        adoption: 4 / 7,
        facadeImporterCount: 4,
        deepImporterCount: 3,
        callWeight: 2,
      },
      {
        kind: "bypass",
        kindBasis: "file-rule",
        sourceRelPath: "app/u6.ts",
        targetRelPath: "lib/sync/snap/index.ts",
        moduleDir: "lib/sync",
        facadeRelPath: "lib/sync/index.ts",
        adoption: 4 / 7,
        facadeImporterCount: 4,
        deepImporterCount: 3,
        callWeight: 0,
      },
    ]);
  });

  it("groups violations per module as root causes, most violations first", () => {
    const report = detectLeakingAbstractions(fixture());

    expect(report.rootCauses).toEqual([
      {
        moduleDir: "lib/sync",
        facadeRelPath: "lib/sync/index.ts",
        adoption: 4 / 7,
        facadeImporterCount: 4,
        deepImporterCount: 3,
        violationCount: 3,
        bypassCount: 2,
        internalReachCount: 1,
        sources: ["app/u4.ts", "app/u5.ts", "app/u6.ts"],
      },
      {
        moduleDir: "lib/sync/snap",
        facadeRelPath: "lib/sync/snap/index.ts",
        adoption: 2 / 3,
        facadeImporterCount: 2,
        deepImporterCount: 1,
        violationCount: 1,
        bypassCount: 0,
        internalReachCount: 1,
        sources: ["lib/sync/a.ts"],
      },
    ]);
  });

  it("names every module exclusion reason", () => {
    expect(Object.keys(FACADE_MODULE_EXCLUSION_REASONS).sort()).toEqual([
      "facade-not-adopted",
      "language-enforced",
      "too-few-importers",
    ]);
  });

  it("summarises modules by status and violations by kind", () => {
    const g = fixture();
    const report = detectLeakingAbstractions(g);

    expect(report.summary).toEqual({
      adoptionThreshold: 0.5,
      adoptionThresholdMethod: "majority",
      minExternalImporters: 3,
      edgeCount: g.edges.length,
      judgedEdgeCount: 10,
      violationCount: 4,
      violationsByKind: { bypass: 2, internalReach: 2 },
      moduleCount: 6,
      activeModuleCount: 2,
      excludedModules: { facadeNotAdopted: 1, tooFewImporters: 1, languageEnforced: 2 },
    });
  });

  it("scopes judged edges by SOURCE while adoption stays whole-graph", () => {
    const g = fixture();
    const report = detectLeakingAbstractions(g, { sourcePathPattern: "app/**" });

    expect(report.violations.map((v) => v.sourceRelPath)).toEqual(["app/u5.ts", "app/u4.ts", "app/u6.ts"]);
    expect(report.modules.find((m) => m.moduleDir === "lib/sync/snap")?.adoption).toBe(2 / 3);
    expect(report.summary.scope).toEqual({
      sourcePathPattern: "app/**",
      outOfScopeEdgeCount: g.edges.filter((e) => !e.sourceRelPath.startsWith("app/")).length,
    });
    expect(report.summary.judgedEdgeCount).toBe(8);
  });

  it("recognises the declared entry-file vocabulary per language, and nothing for Go", () => {
    expect(MODULE_ENTRY_FILE_NAMES).toEqual({
      typescript: ["index.ts", "index.tsx"],
      javascript: ["index.js"],
      python: ["__init__.py"],
      rust: ["mod.rs", "lib.rs"],
    });
    const files = [
      walked("a/index.tsx"),
      walked("b/index.js", "javascript"),
      walked("c/__init__.py", "python"),
      walked("d/mod.rs", "rust"),
      walked("e/lib.rs", "rust"),
      walked("f/main.ts"),
    ];
    const report = detectLeakingAbstractions({ files, edges: [] });

    expect(report.modules.map((m) => [m.moduleDir, m.facadeRelPath])).toEqual([
      ["a", "a/index.tsx"],
      ["b", "b/index.js"],
      ["c", "c/__init__.py"],
      ["d", "d/mod.rs"],
      ["e", "e/lib.rs"],
    ]);
  });

  it("never activates a module whose facade serves exactly half its importers", () => {
    const files = [walked("m/index.ts"), walked("m/x.ts")];
    const edges: FileDependencyEdge[] = [];
    for (const [i, target] of ["m/index.ts", "m/index.ts", "m/x.ts", "m/x.ts"].entries()) {
      files.push(walked(`a/s${i}.ts`));
      edges.push(edge(`a/s${i}.ts`, target));
    }
    const report = detectLeakingAbstractions({ files, edges });

    expect(report.modules[0]).toMatchObject({ adoption: 0.5, status: "facade-not-adopted" });
  });

  it("draws the adoption threshold by Otsu's split once the population is large enough", () => {
    // Ten modules with adoption 0.1 0.2 0.3 0.55 0.9 0.95 1 1 1 1 → Otsu cut 0.725.
    const shapes: [facade: number, deep: number][] = [
      [1, 9],
      [1, 4],
      [3, 7],
      [11, 9],
      [9, 1],
      [19, 1],
      [3, 0],
      [3, 0],
      [3, 0],
      [3, 0],
    ];
    const files: FileDependencyGraphFile[] = [];
    const edges: FileDependencyEdge[] = [];
    shapes.forEach(([facade, deep], m) => {
      files.push(walked(`mods/m${m}/index.ts`), walked(`mods/m${m}/inner.ts`));
      for (let i = 0; i < facade + deep; i++) {
        const source = `users/m${m}/u${i}.ts`;
        files.push(walked(source));
        edges.push(edge(source, i < facade ? `mods/m${m}/index.ts` : `mods/m${m}/inner.ts`));
      }
    });
    const report = detectLeakingAbstractions({ files, edges });

    expect(report.summary.adoptionThresholdMethod).toBe("otsu");
    expect(report.summary.adoptionThreshold).toBeCloseTo(0.725, 12);
    expect(report.summary.adoptionSeparability).toBeGreaterThan(0.9);
    const status = (dir: string) => report.modules.find((m) => m.moduleDir === dir)?.status;
    expect(status("mods/m3")).toBe("facade-not-adopted");
    expect(status("mods/m4")).toBe("active");
    expect(report.summary.activeModuleCount).toBe(6);
  });

  it("treats a root-level entry file as the repository's module and never counts self-edges", () => {
    const g: FileDependencyGraph = {
      files: [walked("index.ts"), walked("x.ts"), walked("y.ts")],
      edges: [edge("x.ts", "x.ts"), edge("index.ts", "x.ts")],
    };
    const report = detectLeakingAbstractions(g);

    expect(report.modules).toEqual([
      {
        moduleDir: "",
        facadeRelPath: "index.ts",
        externalImporterCount: 0,
        facadeImporterCount: 0,
        deepImporterCount: 0,
        adoption: 0,
        status: "too-few-importers",
      },
    ]);
    expect(report.violations).toEqual([]);
  });
});

/**
 * bd tea-rags-mcp-r8hme.2 — with export names on the edges, the kind is decided
 * by WHAT the deep import takes: `bypass` when the facade re-exports every name
 * (or re-exports the whole target), `internal-reach` when at least one name is
 * not re-exported, listing those names. An edge whose names were never
 * recorded keeps the file-level rule.
 */
describe("detectLeakingAbstractions — export names (bd tea-rags-mcp-r8hme.2)", () => {
  function named(
    sourceRelPath: string,
    targetRelPath: string,
    names: { imported?: string[]; reexported?: string[] },
  ): FileDependencyEdge {
    return {
      sourceRelPath,
      targetRelPath,
      callWeight: 0,
      ...(names.imported ? { importedExportNames: names.imported } : {}),
      ...(names.reexported ? { reexportedExportNames: names.reexported } : {}),
    };
  }

  /**
   * `lib/m/` (TypeScript): the facade re-exports `x` from `a.ts`, all of
   * `b.ts`, and only IMPORTS `helper` from `c.ts`. Ten facade importers and six
   * deep ones → adoption 10 / 16, active under the majority rule.
   * `pkg/p/` (Python): `__init__.py` imports `A` from `a.py`, which is what the
   * package exposes. Four facade importers, two deep → 4 / 6, active.
   */
  function namesFixture(): FileDependencyGraph {
    const facadeUsers = Array.from({ length: 10 }, (_, i) => `app/f${i}.ts`);
    const pyUsers = ["svc/q0.py", "svc/q1.py", "svc/q2.py", "svc/q3.py"];
    return {
      files: [
        ...["index.ts", "a.ts", "b.ts", "c.ts", "e.ts"].map((f) => walked(`lib/m/${f}`)),
        walked("pkg/p/__init__.py", "python"),
        walked("pkg/p/a.py", "python"),
        ...facadeUsers.map((f) => walked(f)),
        ...["d1", "d2", "d3", "d4", "d5", "d6"].map((d) => walked(`app/${d}.ts`)),
        ...pyUsers.map((f) => walked(f, "python")),
        walked("svc/deep1.py", "python"),
        walked("svc/deep2.py", "python"),
      ],
      edges: [
        named("lib/m/index.ts", "lib/m/a.ts", { reexported: ["x"] }),
        named("lib/m/index.ts", "lib/m/b.ts", { reexported: ["*"] }),
        named("lib/m/index.ts", "lib/m/c.ts", { imported: ["helper"] }),
        ...facadeUsers.map((f) => named(f, "lib/m/index.ts", { imported: ["x"] })),
        named("app/d1.ts", "lib/m/a.ts", { imported: ["x"] }),
        named("app/d2.ts", "lib/m/a.ts", { imported: ["x", "y"] }),
        named("app/d3.ts", "lib/m/b.ts", { imported: ["anything"] }),
        named("app/d4.ts", "lib/m/c.ts", { imported: ["helper"] }),
        named("app/d5.ts", "lib/m/a.ts", {}),
        named("app/d6.ts", "lib/m/e.ts", { imported: ["z"] }),
        named("pkg/p/__init__.py", "pkg/p/a.py", { imported: ["A"] }),
        ...pyUsers.map((f) => named(f, "pkg/p/__init__.py", { imported: ["A"] })),
        named("svc/deep1.py", "pkg/p/a.py", { imported: ["A"] }),
        named("svc/deep2.py", "pkg/p/a.py", { imported: ["A", "_B"] }),
      ],
    };
  }

  function kindOf(report: ReturnType<typeof detectLeakingAbstractions>, source: string) {
    const v = report.violations.find((x) => x.sourceRelPath === source);
    return v && { kind: v.kind, importedNames: v.importedNames, nonExportedNames: v.nonExportedNames };
  }

  it("calls a deep import of only re-exported names a bypass", () => {
    const report = detectLeakingAbstractions(namesFixture());
    expect(kindOf(report, "app/d1.ts")).toEqual({ kind: "bypass", importedNames: ["x"], nonExportedNames: undefined });
    expect(kindOf(report, "app/d3.ts")).toEqual({
      kind: "bypass",
      importedNames: ["anything"],
      nonExportedNames: undefined,
    });
  });

  it("calls a deep import of any name the facade does not re-export an internal reach, naming it", () => {
    const report = detectLeakingAbstractions(namesFixture());
    expect(kindOf(report, "app/d2.ts")).toEqual({
      kind: "internal-reach",
      importedNames: ["x", "y"],
      nonExportedNames: ["y"],
    });
    // The facade imports `helper` but does not re-export it: the file-level rule
    // would have said bypass.
    expect(kindOf(report, "app/d4.ts")).toEqual({
      kind: "internal-reach",
      importedNames: ["helper"],
      nonExportedNames: ["helper"],
    });
    expect(kindOf(report, "app/d6.ts")).toEqual({
      kind: "internal-reach",
      importedNames: ["z"],
      nonExportedNames: ["z"],
    });
  });

  it("keeps the file-level rule for an edge whose names were never recorded", () => {
    const report = detectLeakingAbstractions(namesFixture());
    expect(kindOf(report, "app/d5.ts")).toEqual({
      kind: "bypass",
      importedNames: undefined,
      nonExportedNames: undefined,
    });
  });

  it("reads a Python package's imported names as what its __init__.py exposes", () => {
    const report = detectLeakingAbstractions(namesFixture());
    expect(kindOf(report, "svc/deep1.py")).toEqual({
      kind: "bypass",
      importedNames: ["A"],
      nonExportedNames: undefined,
    });
    expect(kindOf(report, "svc/deep2.py")).toEqual({
      kind: "internal-reach",
      importedNames: ["A", "_B"],
      nonExportedNames: ["_B"],
    });
  });

  it("falls back to the file-level rule when the facade edge carries no names", () => {
    const g = namesFixture();
    g.edges = g.edges.map((e) =>
      e.sourceRelPath === "lib/m/index.ts" && e.targetRelPath === "lib/m/c.ts"
        ? edge(e.sourceRelPath, e.targetRelPath)
        : e,
    );
    expect(kindOf(detectLeakingAbstractions(g), "app/d4.ts")?.kind).toBe("bypass");
  });
});

/**
 * bd tea-rags-mcp-r8hme.43 — every verdict names HOW its kind was decided:
 * `names` when both edges carried export names and the comparison decided,
 * `file-rule` when names were absent and the file-level rule (bypass iff the
 * facade has an edge to the target) decided. A nameless bypass read as
 * names-certified once sent a fix spec to re-export names the facade already
 * exposed — the export half was a no-op.
 */
describe("detectLeakingAbstractions — kindBasis (bd tea-rags-mcp-r8hme.43)", () => {
  function named(
    sourceRelPath: string,
    targetRelPath: string,
    names: { imported?: string[]; reexported?: string[] },
  ): FileDependencyEdge {
    return {
      sourceRelPath,
      targetRelPath,
      callWeight: 0,
      ...(names.imported ? { importedExportNames: names.imported } : {}),
      ...(names.reexported ? { reexportedExportNames: names.reexported } : {}),
    };
  }

  function basisFixture(): FileDependencyGraph {
    const facadeUsers = ["app/f0.ts", "app/f1.ts", "app/f2.ts"];
    return {
      files: [
        ...["index.ts", "a.ts"].map((f) => walked(`lib/m/${f}`)),
        ...facadeUsers.map((f) => walked(f)),
        walked("app/d1.ts"),
        walked("app/d5.ts"),
      ],
      edges: [
        named("lib/m/index.ts", "lib/m/a.ts", { reexported: ["x"] }),
        ...facadeUsers.map((f) => named(f, "lib/m/index.ts", { imported: ["x"] })),
        named("app/d1.ts", "lib/m/a.ts", { imported: ["x"] }),
        named("app/d5.ts", "lib/m/a.ts", {}),
      ],
    };
  }

  function basisOf(report: ReturnType<typeof detectLeakingAbstractions>, source: string) {
    const v = report.violations.find((x) => x.sourceRelPath === source);
    return v && { kind: v.kind, kindBasis: v.kindBasis };
  }

  it("marks a bypass whose names the facade re-exports with kindBasis names", () => {
    const report = detectLeakingAbstractions(basisFixture());
    expect(basisOf(report, "app/d1.ts")).toEqual({ kind: "bypass", kindBasis: "names" });
  });

  it("marks a nameless bypass with kindBasis file-rule — the file-level rule decided", () => {
    const report = detectLeakingAbstractions(basisFixture());
    expect(basisOf(report, "app/d5.ts")).toEqual({ kind: "bypass", kindBasis: "file-rule" });
  });
});
