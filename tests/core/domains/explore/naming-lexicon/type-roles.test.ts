import { describe, expect, it } from "vitest";

import {
  deriveTypeRoles,
  expectedRoleFor,
  primaryPerFile,
  type TypeNameRow,
} from "../../../../../src/core/domains/explore/naming-lexicon/type-roles.js";

function t(shortName: string, relPath: string, ancestors: string[]): TypeNameRow {
  return { symbolId: shortName, relPath, shortName, symbolKind: "class", ancestors };
}

/** Single-word type names with pairwise distinct heads: they dilute a directory without forming a role. */
const FILLER_HEADS = [
  "Alpha",
  "Bravo",
  "Charlie",
  "Delta",
  "Echo",
  "Foxtrot",
  "Golf",
  "Hotel",
  "India",
  "Juliet",
  "Kilo",
  "Lima",
  "Mike",
  "November",
];

function fillers(dir: string, from: number, count: number): TypeNameRow[] {
  return FILLER_HEADS.slice(from, from + count).map((name) => t(name, `${dir}/${name.toLowerCase()}.ts`, []));
}

describe("deriveTypeRoles / expectedRoleFor", () => {
  it("inheritance family beats directory", () => {
    const rows = [
      t("TsStrategy", "src/a/ts.ts", ["SymbolResolutionStrategy"]),
      t("PyStrategy", "src/b/py.ts", ["SymbolResolutionStrategy"]),
      t("RubyStrategy", "src/c/rb.ts", ["SymbolResolutionStrategy"]),
      t("Helper", "src/a/helper.ts", []),
    ];
    const roles = deriveTypeRoles(rows);
    expect(
      expectedRoleFor(roles, {
        path: "src/z/new.ts",
        extends: "SymbolResolutionStrategy",
      }),
    ).toMatchObject({ role: "strategy", evidence: "inheritance" });
  });

  it("a directory role needs share ≥ 0.2", () => {
    // presets/: 3 of 4 types end in Preset → the directory's role is `preset`.
    const presets = [
      t("TechDebtPreset", "src/presets/tech-debt.ts", []),
      t("HotspotsPreset", "src/presets/hotspots.ts", []),
      t("OwnershipPreset", "src/presets/ownership.ts", []),
      t("PresetRegistry", "src/presets/registry.ts", []),
    ];
    expect(expectedRoleFor(deriveTypeRoles(presets), { path: "src/presets/new.ts" })).toEqual({
      role: "preset",
      evidence: "directory",
      examples: ["HotspotsPreset", "OwnershipPreset", "TechDebtPreset"],
    });

    // 2 of 11 end in Preset: share 0.18 < 0.2 → no directory role.
    const diluted = [
      t("TechDebtPreset", "src/presets/tech-debt.ts", []),
      t("HotspotsPreset", "src/presets/hotspots.ts", []),
      ...fillers("src/presets", 0, 9),
    ];
    expect(expectedRoleFor(deriveTypeRoles(diluted), { path: "src/presets/new.ts" })).toBeUndefined();
  });

  it("a project suffix needs ≥ 3 types in ≥ 2 dirs", () => {
    // Store ×3 across src/a (2, diluted below the directory share) and src/b (1).
    const threeStores = [
      t("SymbolStore", "src/a/symbol-store.ts", []),
      t("EdgeStore", "src/a/edge-store.ts", []),
      ...fillers("src/a", 0, 10),
      t("FileStore", "src/b/file-store.ts", []),
      ...fillers("src/b", 10, 4),
    ];
    const roles = deriveTypeRoles(threeStores);
    expect(roles.filter((r) => r.evidence === "directory")).toEqual([]);
    expect(roles.filter((r) => r.evidence === "projectSuffix")).toEqual([
      {
        symbolId: "EdgeStore",
        relPath: "src/a/edge-store.ts",
        role: "store",
        evidence: "projectSuffix",
        support: 3,
        scope: "",
      },
      {
        symbolId: "FileStore",
        relPath: "src/b/file-store.ts",
        role: "store",
        evidence: "projectSuffix",
        support: 3,
        scope: "",
      },
      {
        symbolId: "SymbolStore",
        relPath: "src/a/symbol-store.ts",
        role: "store",
        evidence: "projectSuffix",
        support: 3,
        scope: "",
      },
    ]);
    expect(expectedRoleFor(roles, { path: "src/b/new.ts" })).toEqual({
      role: "store",
      evidence: "projectSuffix",
      examples: ["EdgeStore", "FileStore", "SymbolStore"],
    });

    // Store ×2 → no role anywhere.
    const twoStores = threeStores.filter((row) => row.shortName !== "EdgeStore");
    const noRoles = deriveTypeRoles(twoStores);
    expect(noRoles.filter((r) => r.role === "store")).toEqual([]);
    expect(expectedRoleFor(noRoles, { path: "src/b/new.ts" })).toBeUndefined();
  });

  // Live on the self-index, explore/errors.ts (many `*Error` classes in ONE file) gave
  // all of domains/explore/ the role `error`. Directory evidence counts FILES.
  it("one file of many `*Error` classes is no directory role", () => {
    const errors = Array.from({ length: 10 }, (_, i) => t(`${FILLER_HEADS[i]}Error`, "src/explore/errors.ts", []));
    const rows = [...errors, ...fillers("src/explore", 0, 6)];
    expect(expectedRoleFor(deriveTypeRoles(rows), { path: "src/explore/calculated-doc.ts" })).toBeUndefined();
  });

  it("`*Error` in 3 of 6 files is the directory's role", () => {
    const rows = [
      t("ParseError", "src/explore/parse.ts", []),
      t("OtherParseError", "src/explore/parse.ts", []),
      t("QueryError", "src/explore/query.ts", []),
      t("ScrollError", "src/explore/scroll.ts", []),
      ...fillers("src/explore", 0, 3),
    ];
    expect(expectedRoleFor(deriveTypeRoles(rows), { path: "src/explore/new.ts" })).toMatchObject({
      role: "error",
      evidence: "directory",
    });
  });

  it("a project suffix counts files: three `*Store` types in one file plus one elsewhere is none", () => {
    const rows = [
      t("SymbolStore", "src/a/stores.ts", []),
      t("EdgeStore", "src/a/stores.ts", []),
      t("NodeStore", "src/a/stores.ts", []),
      ...fillers("src/a", 0, 12),
      t("FileStore", "src/b/file-store.ts", []),
      ...fillers("src/b", 12, 2),
    ];
    expect(deriveTypeRoles(rows).filter((r) => r.evidence === "projectSuffix")).toEqual([]);
  });

  // Live on the self-index, explore/ then got `options`: four modules each declare a
  // `<Primary>Options` beside their primary type. Each file contributes ONE type to
  // directory and suffix evidence — the one whose words overlap its file stem most.
  describe("a file contributes only its primary type", () => {
    it("`<Primary>` + `<Primary>Options` in 4 of 7 files → no `options` role", () => {
      const rows = ["Reranker", "RankModule", "SearchConfidence", "PostProcess"].flatMap((primary, i) => [
        t(primary, `src/explore/m${i}.ts`, []),
        t(`${primary}Options`, `src/explore/m${i}.ts`, []),
      ]);
      const all = [...rows, ...fillers("src/explore", 0, 3)];
      expect(expectedRoleFor(deriveTypeRoles(all), { path: "src/explore/calculated-doc.ts" })).toBeUndefined();
    });

    it("`*Options` as the file's own subject in 3 of 5 files → the role holds", () => {
      const rows = [
        t("SearchOptions", "src/options/search-options.ts", []),
        t("IndexOptions", "src/options/index-options.ts", []),
        t("RenderOptions", "src/options/render-options.ts", []),
        ...fillers("src/options", 0, 2),
      ];
      expect(expectedRoleFor(deriveTypeRoles(rows), { path: "src/options/new.ts" })).toMatchObject({
        role: "options",
        evidence: "directory",
      });
    });

    it("a stem-overlap tie goes to the first declared type: `SearchConfidence` over `SearchConfidenceOptions`", () => {
      const rows = [
        t("SearchConfidence", "src/explore/confidence.ts", []),
        t("SearchConfidenceOptions", "src/explore/confidence.ts", []),
        t("PostProcess", "src/explore/post_process.py", []),
        t("PostProcessOptions", "src/explore/post_process.py", []),
        ...fillers("src/explore", 0, 2),
      ];
      expect(expectedRoleFor(deriveTypeRoles(rows), { path: "src/explore/new.ts" })).toBeUndefined();
    });

    it("reranker.ts and rank-module.ts contribute Reranker and RankModule, not their `*Options`", () => {
      const rows = [
        t("Reranker", "src/explore/reranker.ts", []),
        t("RerankOptions", "src/explore/reranker.ts", []),
        t("ResolvedMode", "src/explore/reranker.ts", []),
        t("RankModule", "src/explore/rank-module.ts", []),
        t("RankOptions", "src/explore/rank-module.ts", []),
        ...fillers("src/explore", 0, 2),
      ];
      expect(expectedRoleFor(deriveTypeRoles(rows), { path: "src/explore/new.ts" })).toBeUndefined();
    });

    // T9 live measurement: helper types declared above the main class won the stem tie.
    describe("a stem-overlap tie prefers the tightest name, then the class", () => {
      function k(shortName: string, relPath: string, symbolKind: TypeNameRow["symbolKind"]): TypeNameRow {
        return { symbolId: shortName, relPath, shortName, symbolKind, ancestors: [] };
      }
      const primaryOf = (rows: TypeNameRow[]) => primaryPerFile(rows).map((row) => row.shortName);

      it("completion-runner.ts → CompletionRunner, not the CompletionRunnerDeps declared above it", () => {
        const file = "src/core/domains/ingest/pipeline/enrichment/completion-runner.ts";
        expect(
          primaryOf([
            k("CompletionRunnerDeps", file, "interface"),
            k("CodegraphStorageCompactionRunner", file, "interface"),
            k("CodegraphCompactionStepOutcome", file, "type_alias"),
            k("UnenrichedReader", file, "type_alias"),
            k("OutOfWindowBackfillOutcome", file, "interface"),
            k("DeferredChunkPassOutcome", file, "type_alias"),
            k("CodegraphHealStepOutcome", file, "type_alias"),
            k("CompletionTerminalMarkerProgress", file, "type_alias"),
            k("CompletionRunner", file, "class"),
          ]),
        ).toEqual(["CompletionRunner"]);
      });

      it("the `*OpsDeps` above each `*Ops` never make `deps` the ops directory's role", () => {
        const dir = "src/core/api/internal/ops";
        const rows = [
          k("ExploreOpsDeps", `${dir}/explore-ops.ts`, "interface"),
          k("ResolvedExploreFilter", `${dir}/explore-ops.ts`, "interface"),
          k("ExploreFinalizeOptions", `${dir}/explore-ops.ts`, "interface"),
          k("ExploreOps", `${dir}/explore-ops.ts`, "class"),
          k("FilterPresetLookup", `${dir}/explore-ops.ts`, "interface"),
          k("NamingLexiconExplore", `${dir}/naming-lexicon-ops.ts`, "interface"),
          k("NamingLexiconOpsDeps", `${dir}/naming-lexicon-ops.ts`, "interface"),
          k("NamingLexiconOps", `${dir}/naming-lexicon-ops.ts`, "class"),
          k("WorktreeSeedOpsDeps", `${dir}/worktree-seed-ops.ts`, "interface"),
          k("WorktreeSeedSourceRelease", `${dir}/worktree-seed-ops.ts`, "type_alias"),
          k("WorktreeSeedRequest", `${dir}/worktree-seed-ops.ts`, "interface"),
          k("WorktreeSeedOps", `${dir}/worktree-seed-ops.ts`, "class"),
        ];
        expect(primaryOf(rows)).toEqual(["ExploreOps", "NamingLexiconOps", "WorktreeSeedOps"]);
        expect(expectedRoleFor(deriveTypeRoles(rows), { path: `${dir}/new-ops.ts` })).toMatchObject({
          role: "ops",
          evidence: "directory",
        });
      });

      it("file-outline.ts → the FileOutlineStrategy class over the FileOutlineInput interface", () => {
        const file = "src/core/domains/explore/strategies/file-outline.ts";
        expect(primaryOf([k("FileOutlineInput", file, "interface"), k("FileOutlineStrategy", file, "class")])).toEqual([
          "FileOutlineStrategy",
        ]);
      });

      it("cohere.ts → the CohereEmbeddings class over the CohereError interface", () => {
        const file = "src/core/adapters/embeddings/cohere.ts";
        expect(primaryOf([k("CohereError", file, "interface"), k("CohereEmbeddings", file, "class")])).toEqual([
          "CohereEmbeddings",
        ]);
      });
    });

    it("a plural stem matches a singular head: errors.ts contributes one `*Error`", () => {
      const rows = [
        t("Alpha", "src/explore/errors.ts", []),
        t("ExploreError", "src/explore/errors.ts", []),
        t("QueryError", "src/explore/query.ts", []),
        t("ScrollError", "src/explore/scroll.ts", []),
        ...fillers("src/explore", 1, 3),
      ];
      // errors.ts's primary is ExploreError (stem `errors` ~ `error`), not Alpha, so `error` holds 3 of 6
      // files — a majority; with Alpha as the primary it would hold 2 of 6 and no role.
      expect(expectedRoleFor(deriveTypeRoles(rows), { path: "src/explore/new.ts" })).toMatchObject({
        role: "error",
        evidence: "directory",
      });
    });
  });

  // T9 live: share ≥ 0.2 let a few helper files define a directory (`request` in api/public/dto).
  // A directory role is its MAJORITY family: the plurality head of at least half its primaries.
  describe("a directory role is the majority family", () => {
    const suffixed = (head: string, dir: string, count: number, from = 0): TypeNameRow[] =>
      FILLER_HEADS.slice(from, from + count).map((q) => t(`${q}${head}`, `${dir}/${q.toLowerCase()}.ts`, []));

    it("`*Request` in 3 of 12 primaries (the api/public/dto shape) → no role", () => {
      const rows = [...suffixed("Request", "src/dto", 3), ...fillers("src/dto", 3, 9)];
      expect(deriveTypeRoles(rows).filter((r) => r.evidence === "directory")).toEqual([]);
    });

    it("`*Preset` in 3 of 4 primaries → the role", () => {
      const rows = [...suffixed("Preset", "src/presets", 3), ...fillers("src/presets", 3, 1)];
      expect(expectedRoleFor(deriveTypeRoles(rows), { path: "src/presets/new.ts" })).toMatchObject({
        role: "preset",
        evidence: "directory",
      });
    });

    it("`*Dispatcher` in 2 of 5 primaries → no role", () => {
      const rows = [...suffixed("Dispatcher", "src/executor", 2), ...fillers("src/executor", 2, 3)];
      expect(deriveTypeRoles(rows).filter((r) => r.evidence === "directory")).toEqual([]);
    });

    it("a plurality tie at half each → no role", () => {
      const rows = [...suffixed("Store", "src/mixed", 2), ...suffixed("Cache", "src/mixed", 2, 2)];
      expect(deriveTypeRoles(rows).filter((r) => r.evidence === "directory")).toEqual([]);
    });
  });

  it("a family's role is the tail word its members share; support counts them", () => {
    const rows = [
      t("TechDebtPreset", "src/a/x.ts", ["RerankPreset"]),
      t("HotspotsPreset", "src/b/y.ts", ["RerankPreset"]),
      t("Legacy", "src/c/z.ts", ["RerankPreset"]),
    ];
    const family = deriveTypeRoles(rows).filter((r) => r.evidence === "inheritance");
    expect(family.map((r) => [r.symbolId, r.role, r.support, r.scope])).toEqual([
      ["HotspotsPreset", "preset", 2, "RerankPreset"],
      ["TechDebtPreset", "preset", 2, "RerankPreset"],
    ]);
  });

  it("matches the draft's ancestor by its last namespace segment", () => {
    const rows = [
      t("TsStrategy", "src/a/ts.ts", ["Resolution::SymbolResolutionStrategy"]),
      t("PyStrategy", "src/b/py.ts", ["Resolution::SymbolResolutionStrategy"]),
    ];
    expect(
      expectedRoleFor(deriveTypeRoles(rows), { path: "src/z/new.ts", extends: "SymbolResolutionStrategy" }),
    ).toMatchObject({ role: "strategy", evidence: "inheritance", examples: ["PyStrategy", "TsStrategy"] });
  });

  it("falls back to the directory when the ancestor has no family role", () => {
    const rows = [
      t("TechDebtPreset", "src/presets/tech-debt.ts", []),
      t("HotspotsPreset", "src/presets/hotspots.ts", []),
    ];
    expect(expectedRoleFor(deriveTypeRoles(rows), { path: "src/presets/new.ts", extends: "Unknown" })).toMatchObject({
      role: "preset",
      evidence: "directory",
    });
  });

  it("no rows → no roles", () => {
    expect(deriveTypeRoles([])).toEqual([]);
    expect(expectedRoleFor([], { path: "src/a.ts" })).toBeUndefined();
  });
});
