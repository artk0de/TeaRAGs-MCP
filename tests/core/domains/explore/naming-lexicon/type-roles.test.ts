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

/**
 * Who is a MEMBER of a non-inheritance role family (bd tea-rags-mcp-49fsr, hand-checked
 * misses on taxdome). A directory or project-suffix family carries its role only to the
 * types that belong to it:
 *   - kind homogeneity (project suffix): a `module` and a type declaration (class,
 *     interface, type alias, enum) are two forms, and a family names only its
 *     dominant one. Live: the `module ClientPushBaseData` mixin took `data` from 164
 *     TS `*Data` type aliases;
 *   - supertype cohesion (directory and project suffix): when the family's carriers
 *     that CAN declare a supertype share a dominant one (≥ 2 of them and ≥ half), such
 *     a carrier whose supertypes miss it is no member; a type alias declares none, so
 *     it neither counts nor is excluded. Live: `SendFailedPaymentNotification`
 *     (`include KindOfService`) took `notification` from 140 `*Notification` types —
 *     68 of the 103 classes extend `Notification`, the 37 others are TS type aliases.
 */
describe("deriveTypeRoles — non-inheritance family membership", () => {
  function k(
    shortName: string,
    relPath: string,
    symbolKind: TypeNameRow["symbolKind"],
    ancestors: string[] = [],
  ): TypeNameRow {
    return { symbolId: shortName, relPath, shortName, symbolKind, ancestors };
  }
  const carriersOf = (rows: TypeNameRow[], role: string, evidence: string) =>
    deriveTypeRoles(rows)
      .filter((r) => r.role === role && r.evidence === evidence)
      .map((r) => r.symbolId)
      .sort();

  describe("a project suffix names only its family's dominant declaration form", () => {
    const DATA_ALIASES = ["Invoice", "Client", "Firm"].map((q, i) =>
      k(`${q}Data`, `app/javascript/m${i}/${q}Data.ts`, "type_alias"),
    );

    it("a mixin module takes no `data` role from a family of type aliases", () => {
      const rows = [
        ...DATA_ALIASES,
        k("ClientPushBaseData", "app/helpers/communication/client_push_base_data.rb", "module"),
      ];
      expect(carriersOf(rows, "data", "projectSuffix")).toEqual(["ClientData", "FirmData", "InvoiceData"]);
    });

    it("an interface and a type alias are one form: `interface CardProps` keeps `props`", () => {
      const rows = [
        ...["Accordion", "Button", "Dialog"].map((q, i) => k(`${q}Props`, `src/c${i}/${q}.tsx`, "type_alias")),
        k("CardProps", "src/c9/Card.tsx", "interface"),
      ];
      expect(carriersOf(rows, "props", "projectSuffix")).toContain("CardProps");
    });

    // Live on the self-index: `interface CacheStore` / `interface CodeChunker` are the contracts
    // their `*Store` / `*Chunker` classes implement — one family, not two.
    it("a class and an interface are one form: `interface CacheStore` keeps `store`", () => {
      const rows = [
        ...["Edge", "File", "Symbol"].map((q, i) => k(`${q}Store`, `src/s${i}/${q.toLowerCase()}-store.ts`, "class")),
        k("CacheStore", "src/cli/cache-store.ts", "interface"),
      ];
      expect(carriersOf(rows, "store", "projectSuffix")).toContain("CacheStore");
    });

    it("forms tied at half: no dominant form, every carrier keeps the role", () => {
      const rows = [
        ...["Invoice", "Client"].map((q, i) => k(`${q}Report`, `app/javascript/m${i}/${q}Report.ts`, "type_alias")),
        ...["Firm", "Job"].map((q, i) => k(`${q}Report`, `app/reports/r${i}/${q.toLowerCase()}_report.rb`, "module")),
      ];
      expect(carriersOf(rows, "report", "projectSuffix")).toHaveLength(4);
    });
  });

  describe("a cohesive family's carrier that misses its supertype is no member", () => {
    const NOTIFICATIONS = ["InvoicePaid", "ProposalSigned", "TaskAssigned"].map((q, i) =>
      k(`${q}Notification`, `app/models/n${i}/inbox/${q.toLowerCase()}_notification.rb`, "class", ["Notification"]),
    );
    const SERVICE = k(
      "SendFailedPaymentNotification",
      "app/services/billing/invoices/send_failed_payment_notification.rb",
      "class",
      ["KindOfService"],
    );

    it("a verb-first service takes no `notification` suffix from a family extending `Notification`", () => {
      expect(carriersOf([...NOTIFICATIONS, SERVICE], "notification", "projectSuffix")).toEqual([
        "InvoicePaidNotification",
        "ProposalSignedNotification",
        "TaskAssignedNotification",
      ]);
    });

    it("a type alias declares no supertype: it neither dilutes the family's nor loses the role", () => {
      const aliases = ["Inbox", "Toast", "Banner", "Popup"].map((q, i) =>
        k(`${q}Notification`, `app/javascript/t${i}/${q}Notification.ts`, "type_alias"),
      );
      const extra = k("DigestNotification", "app/models/n9/inbox/digest_notification.rb", "class", ["Notification"]);
      const rows = [...NOTIFICATIONS, extra, SERVICE, ...aliases];
      expect(carriersOf(rows, "notification", "projectSuffix")).toEqual([
        "BannerNotification",
        "DigestNotification",
        "InboxNotification",
        "InvoicePaidNotification",
        "PopupNotification",
        "ProposalSignedNotification",
        "TaskAssignedNotification",
        "ToastNotification",
      ]);
    });

    it("a family sharing no supertype keeps every carrier", () => {
      const rows = ["Call", "Doctor", "Prime"].map((q, i) =>
        k(`${q}Args`, `src/cmd${i}/${q.toLowerCase()}.ts`, "class"),
      );
      expect(carriersOf(rows, "args", "projectSuffix")).toEqual(["CallArgs", "DoctorArgs", "PrimeArgs"]);
    });

    // Live on taxdome, the first cut dropped `ApplicationForm` from the family extending it, and
    // `ReplaceForm < ActivateForm` from the `ApplicationForm` family.
    it("the family's supertype itself, and a type extending it through a project type, are members", () => {
      const rows = [
        ...NOTIFICATIONS,
        k("Notification", "app/models/inbox/notification.rb", "class", ["ApplicationRecord"]),
        k("DocumentNotification", "app/models/n7/document_notification.rb", "class", ["Notification"]),
        k("SignedDocumentNotification", "app/models/n8/signed_document_notification.rb", "class", [
          "Inbox::DocumentNotification",
        ]),
        SERVICE,
      ];
      expect(carriersOf(rows, "notification", "projectSuffix")).toEqual([
        "DocumentNotification",
        "InvoicePaidNotification",
        "Notification",
        "ProposalSignedNotification",
        "SignedDocumentNotification",
        "TaskAssignedNotification",
      ]);
    });

    // Declaring nothing is no evidence of non-membership: TS types match structurally without
    // `implements`, Ruby duck-types. Live on the self-index, `BatchAccumulator` and
    // `PointsAccumulator` lost `accumulator` beside the `implements StatsAccumulator` family.
    describe("only a DECLARED supertype can miss the family's", () => {
      const ACCUMULATORS = ["Author", "Language", "Chunk"].map((q, i) =>
        k(`${q}CountsAccumulator`, `src/stats/s${i}/${q.toLowerCase()}-counts.ts`, "class", ["StatsAccumulator"]),
      );

      it("a TS class with no `implements` in a cohesive `*Accumulator` family keeps its role", () => {
        const rows = [...ACCUMULATORS, k("BatchAccumulator", "src/pipeline/batch-accumulator.ts", "class")];
        expect(carriersOf(rows, "accumulator", "projectSuffix")).toContain("BatchAccumulator");
      });

      it("a class declaring an unrelated supertype still loses it", () => {
        const rows = [
          ...ACCUMULATORS,
          k("RetryAccumulator", "src/pipeline/retry-accumulator.ts", "class", ["EventEmitter"]),
        ];
        expect(carriersOf(rows, "accumulator", "projectSuffix")).not.toContain("RetryAccumulator");
      });
    });

    it("a directory family: a carrier extending another supertype is no member", () => {
      const rows = [
        k("RubyBareCallStrategy", "src/strategies/bare-call.ts", "class", ["SymbolResolutionStrategy"]),
        k("RubyConstantStrategy", "src/strategies/constant.ts", "class", ["SymbolResolutionStrategy"]),
        k("RubySuperStrategy", "src/strategies/super.ts", "class", ["SymbolResolutionStrategy"]),
        k("RubyFallbackStrategy", "src/strategies/fallback.ts", "class", ["DispatchResolverComponent"]),
      ];
      expect(carriersOf(rows, "strategy", "directory")).toEqual([
        "RubyBareCallStrategy",
        "RubyConstantStrategy",
        "RubySuperStrategy",
      ]);
    });
  });
});

// Live on taxdome (bd tea-rags-mcp-49fsr): `KindOfService` holds 2,554 commands whose heads are
// their verbs' objects (`SendFirmAttributes`, `RenderShortcodeTexts`); no head holds the family,
// and the word naming what they ARE sits in the supertype and the directory, not in the names.
describe("deriveTypeRoles — a dispersed family's kind, named by its supertype and its directory", () => {
  function k(
    shortName: string,
    relPath: string,
    ancestors: string[] = [],
    symbolKind: TypeNameRow["symbolKind"] = "class",
  ): TypeNameRow {
    return { symbolId: shortName, relPath, shortName, symbolKind, ancestors };
  }
  const rolesOf = (rows: TypeNameRow[], name: string) =>
    deriveTypeRoles(rows)
      .filter((r) => r.symbolId === name)
      .map(({ role, evidence, scope, carriedInName }) => ({
        role,
        evidence,
        scope,
        ...(carriedInName !== undefined ? { carriedInName } : {}),
      }));

  const SERVICES = [
    k("KindOfService", "app/lib/kind_of_service.rb", [], "module"),
    k("SendFirmAttributes", "app/services/marketing/send_firm_attributes.rb", ["KindOfService"]),
    k("RenderShortcodeTexts", "app/services/crm/render_shortcode_texts.rb", ["KindOfService"]),
    k("CreateInvoice", "app/services/billing/create_invoice.rb", ["KindOfService"]),
    k("ArchivePipeline", "app/services/workflow/archive_pipeline.rb", ["KindOfService"]),
    k("IssueRefund", "app/services/billing/issue_refund.rb", ["KindOfService"]),
  ];
  const ATTRIBUTES = [
    k("ContactAttributes", "app/models/twilio/contact_attributes.rb"),
    k("BusinessAttributes", "app/models/twilio/business_attributes.rb"),
    k("CountryAttributes", "app/models/phone/country_attributes.rb"),
  ];

  it("a member in a directory named for the supertype's head takes that role, not carried in names", () => {
    expect(rolesOf([...SERVICES, ...ATTRIBUTES], "SendFirmAttributes")).toEqual([
      { role: "service", evidence: "inheritance", scope: "KindOfService", carriedInName: false },
    ]);
  });

  it("the member's head is the family's varying slot: no suffix role from it", () => {
    const rows = [...SERVICES, ...ATTRIBUTES];
    expect(rolesOf(rows, "ContactAttributes")).toContainEqual({
      role: "attributes",
      evidence: "projectSuffix",
      scope: "",
    });
    expect(rolesOf(rows, "SendFirmAttributes").some((r) => r.evidence === "projectSuffix")).toBe(false);
  });

  it("a member outside such a directory gains nothing and keeps its roles", () => {
    const rows = [
      ...SERVICES,
      ...ATTRIBUTES,
      k("SyncFirmAttributes", "app/lib/marketing/sync_firm_attributes.rb", ["KindOfService"]),
    ];
    expect(rolesOf(rows, "SyncFirmAttributes")).toEqual([{ role: "attributes", evidence: "projectSuffix", scope: "" }]);
  });

  // `ApplicationRecord` → `record`, but models live in `app/models/`: no agreement, no role, and
  // `GuestBlob` keeps `blob`.
  it("a supertype head the directory does not name changes nothing", () => {
    const rows = [
      k("ApplicationRecord", "app/models/application_record.rb"),
      k("GuestBlob", "app/models/guest_blob.rb", ["ApplicationRecord"]),
      k("Client", "app/models/client.rb", ["ApplicationRecord"]),
      k("Invoice", "app/models/invoice.rb", ["ApplicationRecord"]),
      k("PresignedBlob", "app/lib/tech/presigned_blob.rb"),
      k("ActiveBlob", "app/lib/storage/active_blob.rb"),
    ];
    expect(rolesOf(rows, "GuestBlob")).toEqual([{ role: "blob", evidence: "projectSuffix", scope: "" }]);
  });

  // Live: `ActiveModel::Model` / `StoreModel::Model` under `app/models/` — a capability mixin the
  // project does not declare; its head says nothing about what `NotificationSettings` is.
  it("a supertype the project does not declare names no kind", () => {
    const rows = [
      k("NotificationSettings", "app/models/firm_member/notification_settings.rb", ["ActiveModel::Model"]),
      k("CertificateData", "app/models/custom_domain/certificate_data.rb", ["ActiveModel::Model"]),
      k("ImportMapping", "app/models/contact_import/import_mapping.rb", ["ActiveModel::Model"]),
      k("TwilioSettings", "app/lib/twilio/twilio_settings.rb"),
      k("QuickbookSettings", "app/lib/quickbook/quickbook_settings.rb"),
    ];
    expect(rolesOf(rows, "NotificationSettings")).toEqual([{ role: "settings", evidence: "projectSuffix", scope: "" }]);
  });

  // Live: `NylasApiV3` includes `LoggerHelper` beside `MailHelper` in `mailbox_helper/` — half the
  // family ends in `Helper`, so the word IS carried in names and a non-carrier is no kind member.
  it("a family whose names carry the word names no unnamed kind", () => {
    const rows = [
      k("LoggerHelper", "app/lib/logger_helper.rb", [], "module"),
      k("MailHelper", "app/lib/communication/mailbox_helper/mail_helper.rb", ["LoggerHelper"], "module"),
      k("NylasApiV3", "app/lib/communication/mailbox_helper/nylas_api_v3.rb", ["LoggerHelper"]),
    ];
    expect(rolesOf(rows, "NylasApiV3")).toEqual([]);
  });

  it("of two agreeing families the larger names the kind", () => {
    const rows = [
      ...SERVICES,
      k("KindOfServiceTask", "app/lib/kind_of_service_task.rb", [], "module"),
      k("FindConnection", "app/services/admin/tasks/find_connection.rb", ["KindOfService", "KindOfServiceTask"]),
      k("RestartSync", "app/services/admin/tasks/restart_sync.rb", ["KindOfService", "KindOfServiceTask"]),
    ];
    expect(rolesOf(rows, "FindConnection")).toEqual([
      { role: "service", evidence: "inheritance", scope: "KindOfService", carriedInName: false },
    ]);
  });

  it("an expected role for a draft extending the supertype is the kind, flagged not carried in names", () => {
    const roles = deriveTypeRoles([...SERVICES, ...ATTRIBUTES]);
    expect(
      expectedRoleFor(roles, {
        path: "app/services/billing/send_failed_payment_notification.rb",
        extends: "KindOfService",
      }),
    ).toMatchObject({ role: "service", evidence: "inheritance", carriedInName: false });
  });
});

// bd tea-rags-mcp-5ulz2, live on taxdome: families keyed by the supertype's LAST segment merged
// `Sidekiq::Throttled::Worker` (73), `Platform::Async::Batch::Worker` (10), `Sidekiq::Worker` and
// `Platform::Async::Workflow::Worker` (2) into one `Worker` family. Its `worker` role made the
// draft `ExportAsyncWorkflow < Platform::Async::Workflow::Worker` MISFIT → `…Worker`, while that
// supertype's own subclasses are `ImportAsyncWorkflow` and `UpdateAsyncWorkflow`.
describe("deriveTypeRoles — the nearest family decides", () => {
  const WORKERS = ["AccountsCleanup", "AccountsInvalidate", "Mailer"].map((q, i) =>
    t(`${q}Worker`, `app/workers/w${i}/${q.toLowerCase()}_worker.rb`, ["Sidekiq::Throttled::Worker"]),
  );
  const WORKFLOWS = ["Import", "Update"].map((q, i) =>
    t(`${q}AsyncWorkflow`, `app/workers/f${i}/${q.toLowerCase()}_async_workflow.rb`, [
      "Platform::Async::Workflow::Worker",
    ]),
  );
  const DRAFT = { path: "app/workers/x/export_async_workflow.rb", extends: "Platform::Async::Workflow::Worker" };

  it("a draft takes the role of its supertype as written, before the last-segment family", () => {
    expect(expectedRoleFor(deriveTypeRoles([...WORKERS, ...WORKFLOWS]), DRAFT)).toMatchObject({
      role: "workflow",
      evidence: "inheritance",
      examples: ["ImportAsyncWorkflow", "UpdateAsyncWorkflow"],
    });
  });

  it("the written supertype's members carry its role, scoped by the written name", () => {
    const roles = deriveTypeRoles([...WORKERS, ...WORKFLOWS]).filter((r) => r.role === "workflow");
    expect(roles.map((r) => [r.symbolId, r.evidence, r.support, r.scope])).toEqual([
      ["ImportAsyncWorkflow", "inheritance", 2, "Platform::Async::Workflow::Worker"],
      ["UpdateAsyncWorkflow", "inheritance", 2, "Platform::Async::Workflow::Worker"],
    ]);
  });

  it("a written supertype with too few subclasses for a convention falls back to the last-segment family", () => {
    expect(expectedRoleFor(deriveTypeRoles([...WORKERS, WORKFLOWS[0]]), DRAFT)).toMatchObject({
      role: "worker",
      evidence: "inheritance",
    });
  });

  // bd tea-rags-mcp-1ffi9, the user's decision: taxdome's team names the direct subclasses of
  // `Platform::Async::Workflow::Worker` `*AsyncWorkflow`. A written family's role is the TAIL its
  // role majority shares — the longest word suffix carried by ≥ 2 members and ≥ half of them.
  describe("a written family's role is the tail its majority shares (1ffi9)", () => {
    const flow = (name: string, i: number, supertype = "Platform::Async::Workflow::Worker") =>
      t(name, `app/workers/g${i}/${name.toLowerCase()}.rb`, [supertype]);

    it("members sharing `AsyncWorkflow` give the tail [async, workflow], headed by `workflow`", () => {
      expect(expectedRoleFor(deriveTypeRoles([...WORKERS, ...WORKFLOWS]), DRAFT)).toMatchObject({
        role: "workflow",
        tail: ["async", "workflow"],
      });
    });

    it("members sharing only the head give a one-word role, no tail", () => {
      const rows = [...WORKERS, flow("ImportAsyncWorkflow", 0), flow("UpdateSyncWorkflow", 1)];
      const role = expectedRoleFor(deriveTypeRoles(rows), DRAFT);
      expect(role).toMatchObject({ role: "workflow" });
      expect(role?.tail).toBeUndefined();
    });

    // Measured on taxdome: a majority qualifier flipped 12 correct names in 4 families and caught
    // none; the qualifier words must be UNANIMOUS among the head's names. The head keeps its majority.
    it("a tail qualifier needs every name carrying the head: 2 of 4 is no tail, 2 of 2 is", () => {
      const half = ["ImportAsyncWorkflow", "UpdateAsyncWorkflow", "SyncWorkflow", "PullWorkflow"].map((n, i) =>
        flow(n, i),
      );
      expect(expectedRoleFor(deriveTypeRoles(half), DRAFT)?.tail).toBeUndefined();
      const all = ["ImportAsyncWorkflow", "UpdateAsyncWorkflow"].map((n, i) => flow(n, i));
      expect(expectedRoleFor(deriveTypeRoles(all), DRAFT)?.tail).toEqual(["async", "workflow"]);
    });

    it("6 of 11 names carrying `DocumentNotification` leave the one-word role `notification`", () => {
      const supertype = "TaxPreparation::Inbox::DocumentNotification";
      const names = [
        "ApprovedDocumentNotification",
        "RejectedDocumentNotification",
        "ClientUploadedDocumentsNotification",
        "ClientUploadedRequestedDocumentsNotification",
        "SharedDocumentNotification",
        "DeletedDocumentNotification",
        "DatevUploadNotification",
        "IrsTranscriptsDownloadedNotification",
        "SignatureRequestNotification",
        "SignedDocumentBySignerNotification",
        "VoidedSignatureRequestNotification",
      ];
      const role = expectedRoleFor(deriveTypeRoles(names.map((n, i) => flow(n, i, supertype))), {
        path: "app/models/tax_preparation/inbox/x.rb",
        extends: supertype,
      });
      expect(role).toMatchObject({ role: "notification", evidence: "inheritance" });
      expect(role?.tail).toBeUndefined();
    });

    it("one member's own qualifier never extends the tail", () => {
      const rows = ["BulkImportAsyncWorkflow", "UpdateAsyncWorkflow"].map((n, i) => flow(n, i));
      expect(expectedRoleFor(deriveTypeRoles(rows), DRAFT)?.tail).toEqual(["async", "workflow"]);
    });

    // Measured on taxdome: counted per declaration, 9 re-declared `ApplicationController`s made
    // `events` the tail of `Tech::Webhooks::ApplicationController` and flipped `QuotesController`.
    it("a name re-declared in many namespaces is one name for the tail's majority", () => {
      const supertype = "Tech::Webhooks::EventsBase";
      const rows = [
        ...[0, 1, 2].map((i) => flow("ApplicationEventsController", i, supertype)),
        flow("QuotesController", 3, supertype),
        flow("PredictsController", 4, supertype),
      ];
      expect(
        expectedRoleFor(deriveTypeRoles(rows), { path: "app/controllers/x/y.rb", extends: supertype })?.tail,
      ).toBeUndefined();
    });

    it("the supertype's own name re-declared by its subclasses is no member of the tail", () => {
      const supertype = "Tech::Base::UserSerializer";
      const rows = [
        ...[0, 1, 2].map((i) => flow("UserSerializer", i, supertype)),
        flow("CurrentUserSerializer", 3, supertype),
        flow("MailboxHolderSerializer", 4, supertype),
      ];
      expect(
        expectedRoleFor(deriveTypeRoles(rows), { path: "app/serializers/x/y.rb", extends: supertype })?.tail,
      ).toBeUndefined();
    });

    it("a tail qualifier is a word the supertype names outside its root namespace", () => {
      const index = ["ChatV1Index", "ContactsV1Index", "ClientsV2Index", "ClientsV3Index"].map((n, i) =>
        flow(n, i, "Chewy::Index"),
      );
      expect(
        expectedRoleFor(deriveTypeRoles(index), { path: "app/chewy/x.rb", extends: "Chewy::Index" })?.tail,
      ).toBeUndefined();
      const bills = ["OverdueBillsNotification", "PaidBillsNotification", "PartiallyPaidBillsNotification"].map(
        (n, i) => flow(n, i, "GettingPaid::Inbox::BillNotification"),
      );
      expect(
        expectedRoleFor(deriveTypeRoles(bills), {
          path: "app/models/x.rb",
          extends: "GettingPaid::Inbox::BillNotification",
        })?.tail,
      ).toEqual(["bills", "notification"]);
    });

    it("a last-segment family keeps a one-word role", () => {
      const rows = ["ImportAsyncWorker", "UpdateAsyncWorker"].map((n, i) => flow(n, i, "Worker"));
      const role = expectedRoleFor(deriveTypeRoles(rows), { path: "app/workers/x/y.rb", extends: "Worker" });
      expect(role).toMatchObject({ role: "worker" });
      expect(role?.tail).toBeUndefined();
    });

    it("a written family with the last-segment family's head but a longer tail carries its tail", () => {
      const rows = [
        ...["AccountsCleanup", "Mailer"].map((q, i) => flow(`${q}Worker`, i, "Sidekiq::Worker")),
        ...["ImportAsync", "UpdateAsync"].map((q, i) => flow(`${q}Worker`, i + 2, "Platform::Async::Worker")),
      ];
      expect(
        expectedRoleFor(deriveTypeRoles(rows), { path: "app/workers/x/y.rb", extends: "Platform::Async::Worker" }),
      ).toMatchObject({ role: "worker", tail: ["async", "worker"] });
    });
  });

  it("a written family naming the same role as its last-segment family adds no second assignment", () => {
    const rows = [
      t("TsStrategy", "src/a/ts.ts", ["Resolution::SymbolResolutionStrategy"]),
      t("PyStrategy", "src/b/py.ts", ["Resolution::SymbolResolutionStrategy"]),
    ];
    expect(deriveTypeRoles(rows).map((r) => [r.symbolId, r.scope])).toEqual([
      ["PyStrategy", "SymbolResolutionStrategy"],
      ["TsStrategy", "SymbolResolutionStrategy"],
    ]);
  });
});
