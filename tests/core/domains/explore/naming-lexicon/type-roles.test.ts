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

/**
 * A directory role's family is COHESIVE when its members share a supertype
 * (bd tea-rags-mcp-tun7x): the dominant supertype of the directory's role
 * carriers is carried by ≥ 2 of them and by at least half — the majority the
 * directory role itself is defined by. Live: `ruby/resolver/strategies/` holds
 * 14 `*SymbolResolutionStrategy` (all `extends SymbolResolutionStrategy`) beside
 * four `*DispatchResolver` components; `cli/commands/` `*Args` declare no
 * supertype at all.
 */
describe("expectedRoleFor — a directory role's family supertypes", () => {
  const STRATEGIES = [
    t("RubyBareCallStrategy", "src/strategies/bare-call.ts", ["SymbolResolutionStrategy"]),
    t("RubyConstantStrategy", "src/strategies/constant.ts", ["Resolution::SymbolResolutionStrategy"]),
    t("RubySuperStrategy", "src/strategies/super.ts", ["SymbolResolutionStrategy"]),
    t("RubyConeDispatchResolver", "src/strategies/cone-dispatch.ts", ["DispatchResolverComponent"]),
  ];

  it("a cohesive family carries its dominant supertype (by last namespace segment)", () => {
    expect(expectedRoleFor(deriveTypeRoles(STRATEGIES), { path: "src/strategies/new.ts" })).toMatchObject({
      role: "strategy",
      evidence: "directory",
      familySupertypes: ["SymbolResolutionStrategy"],
    });
  });

  it("carriers with no supertype → no family supertypes", () => {
    const args = [
      t("CallArgs", "src/commands/call.ts", []),
      t("DoctorArgs", "src/commands/doctor.ts", []),
      t("PrimeArgs", "src/commands/prime.ts", []),
    ];
    expect(expectedRoleFor(deriveTypeRoles(args), { path: "src/commands/new.ts" })).not.toHaveProperty(
      "familySupertypes",
    );
  });

  it("a supertype one carrier declares is not shared → no family supertypes", () => {
    const rows = [
      t("TechDebtPreset", "src/presets/tech-debt.ts", ["RerankPreset"]),
      t("HotspotsPreset", "src/presets/hotspots.ts", ["CompositePreset"]),
      t("OwnershipPreset", "src/presets/ownership.ts", []),
    ];
    expect(expectedRoleFor(deriveTypeRoles(rows), { path: "src/presets/new.ts" })).not.toHaveProperty(
      "familySupertypes",
    );
  });

  it("a shared supertype under half of the carriers → no family supertypes", () => {
    const rows = [
      t("APreset", "src/presets/a.ts", ["RerankPreset"]),
      t("BPreset", "src/presets/b.ts", ["RerankPreset"]),
      t("CPreset", "src/presets/c.ts", []),
      t("DPreset", "src/presets/d.ts", []),
      t("EPreset", "src/presets/e.ts", []),
    ];
    expect(expectedRoleFor(deriveTypeRoles(rows), { path: "src/presets/new.ts" })).not.toHaveProperty(
      "familySupertypes",
    );
  });

  it("two supertypes tied at the majority are both the family's", () => {
    const rows = [
      t("APreset", "src/presets/a.ts", ["RerankPreset", "Named"]),
      t("BPreset", "src/presets/b.ts", ["RerankPreset", "Named"]),
      t("CPreset", "src/presets/c.ts", []),
    ];
    expect(expectedRoleFor(deriveTypeRoles(rows), { path: "src/presets/new.ts" })).toMatchObject({
      familySupertypes: ["Named", "RerankPreset"],
    });
  });
});

/**
 * Wrong roles live on taxdome (bd tea-rags-mcp-49fsr): `Finish`, `BatchCreateAsync`,
 * `ActivateOnLogin`, `KbaAttemptCreate` (services — `include KindOfService`),
 * `ClientPortalSettingsUpdated` (an event), the namespace `module Communication`,
 * a TS `OverviewBlockType` and `ProposalPackage`.
 */
describe("deriveTypeRoles — what is not a role", () => {
  function k(
    shortName: string,
    relPath: string,
    symbolKind: TypeNameRow["symbolKind"],
    ancestors: string[] = [],
  ): TypeNameRow {
    return { symbolId: shortName, relPath, shortName, symbolKind, ancestors };
  }
  const rolesOf = (rows: TypeNameRow[], role: string) => deriveTypeRoles(rows).filter((r) => r.role === role);

  describe("a module is a file's primary only when it names the file", () => {
    it("a file declaring only `module Communication` has no primary", () => {
      expect(primaryPerFile([k("Communication", "app/services/communication/request.rb", "module")])).toEqual([]);
    });

    // Live on the self-index: a TS `export const rubyCommentCaptureHook = { … }` object is a
    // `module` row, and the chunking directories' `hook` role rests on them.
    it("a module named for its file is the primary: comment-capture.ts → rubyCommentCaptureHook", () => {
      const file = "src/core/domains/language/ruby/chunking/comment-capture.ts";
      expect(primaryPerFile([k("rubyCommentCaptureHook", file, "module")]).map((row) => row.shortName)).toEqual([
        "rubyCommentCaptureHook",
      ]);
    });

    it("the namespace wrapping a file's class is not its primary: cursor.rb → Cursor", () => {
      const file = "app/lib/communication/cursor_paginated/cursor.rb";
      const rows = [
        k("Communication", file, "module"),
        k("CursorPaginated", file, "module"),
        k("Cursor", file, "class"),
      ];
      expect(primaryPerFile(rows).map((row) => row.shortName)).toEqual(["Cursor"]);
    });

    it("the namespace module wrapping each contract file is no `communication` suffix", () => {
      const rows = [
        ...["a", "b", "c", "d"].map((d) => k("Communication", `app/services/communication/${d}/request.rb`, "module")),
        k("CommonCommunication", "app/javascript/crm/useCommunications.ts", "type_alias"),
      ];
      expect(rolesOf(rows, "communication")).toEqual([]);
    });
  });

  describe("a head restating the declaration kind is no role", () => {
    it("`*Type` type aliases carry no `type` role", () => {
      const rows = ["Overview", "Action", "Account"].map((q, i) =>
        k(`${q}Type`, `src/m${i}/${q.toLowerCase()}-type.ts`, "type_alias"),
      );
      expect(rolesOf(rows, "type")).toEqual([]);
    });

    it("`*Type` classes (a GraphQL object type) keep the `type` role", () => {
      const rows = ["User", "Invoice", "Account"].map((q, i) =>
        k(`${q}Type`, `app/graphql/m${i}/${q.toLowerCase()}_type.rb`, "class"),
      );
      expect(rolesOf(rows, "type").map((r) => r.evidence)).toEqual(["projectSuffix", "projectSuffix", "projectSuffix"]);
    });
  });

  describe("an inheritance family's role is its majority head", () => {
    it("`create` on 2 of 5 KindOfService members is no family role", () => {
      const rows = ["KbaAttemptCreate", "TagCreate", "TagDestroy", "BillUpdate", "ClientList"].map((name, i) =>
        k(name, `app/services/s${i}/${name.toLowerCase()}.rb`, "class", ["KindOfService"]),
      );
      expect(deriveTypeRoles(rows).filter((r) => r.evidence === "inheritance")).toEqual([]);
    });

    it("a family split half and half has no role", () => {
      const rows = [
        k("AStore", "src/a/a.ts", "class", ["Base"]),
        k("BStore", "src/b/b.ts", "class", ["Base"]),
        k("ACache", "src/c/c.ts", "class", ["Base"]),
        k("BCache", "src/d/d.ts", "class", ["Base"]),
      ];
      expect(deriveTypeRoles(rows).filter((r) => r.evidence === "inheritance")).toEqual([]);
    });
  });

  describe("a head that varies within an inheritance family is that family's slot, not a role", () => {
    const SERVICES = ["TagCreate", "TagDestroy", "BillUpdate", "ClientList", "JobClone"].map((name, i) =>
      k(name, `app/services/x${i}/${name.toLowerCase()}.rb`, "class", ["KindOfService"]),
    );

    it("`*Async` services in three directories are no `async` project suffix", () => {
      const asyncs = ["BatchCreateAsync", "UpdateAsync", "StartAsync"].map((name, i) =>
        k(name, `app/services/a${i}/${name.toLowerCase()}.rb`, "class", ["KindOfService"]),
      );
      expect(rolesOf([...SERVICES, ...asyncs], "async")).toEqual([]);
    });

    it("`*Updated` events filling a directory are no `updated` directory role", () => {
      const dir = "app/lib/activity/events/firm_settings";
      const events = [
        ...["Branding", "ClientPortalSettings", "AboutUs"].map((q) =>
          k(`${q}Updated`, `${dir}/${q.toLowerCase()}_updated.rb`, "class", ["Events::BaseEvent"]),
        ),
        ...["InvoiceCreated", "PaymentDeleted", "OrganizerSent", "ProposalViewed"].map((name, i) =>
          k(name, `app/lib/activity/events/e${i}/${name.toLowerCase()}.rb`, "class", ["Events::BaseEvent"]),
        ),
      ];
      expect(rolesOf(events, "updated")).toEqual([]);
    });

    it("a head that IS its family's role keeps its directory and suffix evidence", () => {
      const strategies = ["Ts", "Py", "Ruby"].map((q, i) =>
        k(`${q}Strategy`, `src/s${i}/${q.toLowerCase()}-strategy.ts`, "class", ["SymbolResolutionStrategy"]),
      );
      expect(new Set(rolesOf(strategies, "strategy").map((r) => r.evidence))).toEqual(
        new Set(["inheritance", "projectSuffix"]),
      );
    });

    it("a mixin family with no role does not veto a head another majority family names", () => {
      const forms = ["Create", "Update", "Index"].map((q, i) =>
        k(`${q}Form`, `app/forms/f${i}/${q.toLowerCase()}_form.rb`, "class", ["BaseForm", "Model"]),
      );
      const models = ["UserParams", "TagArgs", "JobArgs", "BillParams"].map((name, i) =>
        k(name, `app/lib/m${i}/${name.toLowerCase()}.rb`, "class", ["Model"]),
      );
      expect(rolesOf([...forms, ...models], "form").some((r) => r.evidence === "projectSuffix")).toBe(true);
    });
  });

  describe("a project suffix counts distinct names that qualify the head", () => {
    it("bare `Finish` ×4 plus one `ContactImportFinish` is no `finish` suffix", () => {
      const rows = [
        ...["a", "b", "c", "d"].map((d) => k("Finish", `app/services/${d}/finish.rb`, "class")),
        k("ContactImportFinish", "app/services/crm/contact_import_finish.rb", "class"),
      ];
      expect(rolesOf(rows, "finish")).toEqual([]);
    });

    it("`Package`, `ProposalPackage` declared in two files and `SelectedPackage` are no `package` suffix", () => {
      const rows = [
        k("Package", "app/models/proposal/package.rb", "class"),
        k("ProposalPackage", "app/javascript/types/ProposalPackage.ts", "type_alias"),
        k("ProposalPackage", "app/javascript/pages/Packages/Packages.tsx", "type_alias"),
        k("SelectedPackage", "app/javascript/hooks/useCalculateProposalPayment.ts", "type_alias"),
      ];
      expect(rolesOf(rows, "package")).toEqual([]);
    });

    it("once three distinct names qualify the head, a bare carrier shares the role", () => {
      const rows = [
        ...["Accordion", "Button", "Card"].map((q, i) => k(`${q}Props`, `src/c${i}/${q}.tsx`, "type_alias")),
        k("Props", "src/c3/Thread.tsx", "type_alias"),
      ];
      expect(rolesOf(rows, "props").map((r) => r.symbolId)).toContain("Props");
    });
  });
});
