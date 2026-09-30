/**
 * bd tea-rags-mcp-xsxkr — a verdict rests on evidence other than the draft
 * itself, and a demand (MISFIT) on more of it than one row.
 *
 * Field report (taxdome stack review, 2026-09-27): `RefusalsConcern` CONFORMS
 * with its own declaration as the one carrier; a nonexistent `RefusalsHelper`
 * CONFORMS with n = 0; `tax_preparation: TaxPreparation` a MISFIT naming
 * `existing`, held by one method; `result` CONFORMS or NEW_TERM depending on
 * the call it is bound to; `tax_automation_documents_for_payload` a MISFIT
 * naming `tax_automation_documents`.
 */
import { describe, expect, it } from "vitest";

import type { TypeNameRow } from "../../../../../src/core/domains/explore/naming-lexicon/type-roles.js";
import {
  judgeDraftName,
  judgeTypeDraft,
  typeDraftEvidence,
  typeDraftPopulation,
  typeNameEvidence,
} from "../../../../../src/core/domains/explore/naming-lexicon/verdicts.js";

function row(
  shortName: string,
  relPath: string,
  ancestors: string[] = [],
  symbolKind: TypeNameRow["symbolKind"] = "class",
): TypeNameRow {
  return { symbolId: shortName, relPath, shortName, symbolKind, ancestors };
}

/** Distinct single-word types spread over their own directories: population without roles. */
function filler(count: number): TypeNameRow[] {
  return Array.from({ length: count }, (_, i) =>
    row(`Filler${String.fromCharCode(97 + (i % 26))}${i}`, `src/f${i}/x.ts`),
  );
}

function judgeType(rows: readonly TypeNameRow[], draft: { name: string; path: string; extends?: string }) {
  return judgeTypeDraft({
    ...draft,
    casing: "pascal",
    evidence: typeNameEvidence(rows, typeDraftPopulation(draft)),
    conceptNames: [],
  });
}

describe("judgeTypeDraft — the draft's own declaration is never evidence for itself", () => {
  it("a head only the draft's own declaration carries is no known head: NEW_TERM, not CONFORMS", () => {
    const rows = [...filler(6), row("Concern", "app/lib/refusals/concern.rb")];
    expect(judgeType(rows, { name: "Concern", path: "app/lib/refusals/concern.rb" })).toEqual({
      verdict: "NEW_TERM",
      topTerms: [],
    });
  });

  it("the same head carried by another type still conforms", () => {
    const rows = [
      ...filler(6),
      row("Concern", "app/lib/refusals/concern.rb"),
      row("AuditConcern", "app/lib/audit/audit_concern.rb"),
    ];
    expect(judgeType(rows, { name: "Concern", path: "app/lib/refusals/concern.rb" })).toEqual({ verdict: "CONFORMS" });
  });

  it("a directory role the draft's own declaration completes is no role", () => {
    // Two `*Job` in app/jobs: one is the draft itself. Without it one carrier is left — no family.
    const rows = [...filler(6), row("SyncJob", "app/jobs/sync_job.rb"), row("PurgeJob", "app/jobs/purge_job.rb")];
    const own = typeDraftEvidence(typeNameEvidence(rows, "type"), { name: "SyncJob", path: "app/jobs/sync_job.rb" });
    expect(own.rows.map((r) => r.shortName)).not.toContain("SyncJob");
    expect(own.roles.filter((r) => r.evidence === "directory")).toEqual([]);
  });

  it("keeps the own declaration as a fact about the draft: its supertypes still decide membership", () => {
    const rows = [...filler(6), row("SyncJob", "app/jobs/sync_job.rb", ["ApplicationJob"])];
    const own = typeDraftEvidence(typeNameEvidence(rows, "type"), { name: "SyncJob", path: "app/jobs/sync_job.rb" });
    expect(own.own?.map((r) => r.ancestors)).toEqual([["ApplicationJob"]]);
  });

  it("is idempotent: excluding twice excludes the same rows once", () => {
    const rows = [...filler(6), row("Concern", "app/lib/refusals/concern.rb")];
    const draft = { name: "Concern", path: "app/lib/refusals/concern.rb" };
    const once = typeDraftEvidence(typeNameEvidence(rows, "type"), draft);
    expect(typeDraftEvidence(once, draft)).toBe(once);
  });
});

describe("judgeTypeDraft — a CONFORMS by a role names the role", () => {
  it("a project suffix that confirms the name is carried on the verdict", () => {
    const rows = [
      ...filler(6),
      row("IndexOptions", "src/a/index-options.ts"),
      row("RenderOptions", "src/b/render-options.ts"),
      row("PostProcessOptions", "src/c/post-process.ts"),
    ];
    expect(judgeType(rows, { name: "SearchOptions", path: "src/z/search-options.ts" })).toMatchObject({
      verdict: "CONFORMS",
      role: { word: "options", evidence: "projectSuffix" },
    });
  });

  it("a name carrying its expected family role names that role", () => {
    const rows = [
      row("TsStrategy", "src/lang/ts/strategy.ts", ["SymbolResolutionStrategy"]),
      row("PyStrategy", "src/lang/py/strategy.ts", ["SymbolResolutionStrategy"]),
      row("RubyStrategy", "src/lang/rb/strategy.ts", ["SymbolResolutionStrategy"]),
    ];
    expect(
      judgeType(rows, { name: "GoStrategy", path: "src/lang/go/strategy.ts", extends: "SymbolResolutionStrategy" }),
    ).toMatchObject({ verdict: "CONFORMS", role: { word: "strategy", evidence: "inheritance" } });
  });
});

describe("judgeDraftName — with nothing to compare, the name's own use elsewhere is the evidence", () => {
  it("an untyped draft no row carries is novel: NEW_TERM with no terms", () => {
    expect(judgeDraftName({ name: "store_entity!", kind: "return", casing: "snake", nameRows: 0 })).toEqual({
      verdict: "NEW_TERM",
      topTerms: [],
    });
  });

  it("an untyped draft other rows carry conforms", () => {
    expect(judgeDraftName({ name: "result", kind: "local", casing: "snake", nameRows: 3348 })).toEqual({
      verdict: "CONFORMS",
    });
  });

  it("a draft bound to a call with no rows agrees whatever the call derives: `result` conforms either way", () => {
    const bound = (member: string) =>
      judgeDraftName({ name: "result", kind: "local", casing: "snake", callee: { member }, nameRows: 3348 });
    // `call` derives no name; `fetch_payload` derives `payload`, which the (absent) prior does not license.
    expect(bound("call")).toEqual({ verdict: "CONFORMS" });
    expect(bound("fetch_payload")).toEqual({ verdict: "CONFORMS" });
  });

  it("a draft bound to a call with no rows, never used elsewhere, stays novel either way", () => {
    const bound = (member: string) =>
      judgeDraftName({ name: "thing", kind: "local", casing: "snake", callee: { member }, nameRows: 0 });
    expect(bound("call")).toEqual({ verdict: "NO_CONVENTION", prefer: { analogous: [] } });
    expect(bound("fetch_payload")).toEqual({ verdict: "NO_CONVENTION", prefer: { analogous: [] } });
  });

  it("a typed draft's name used for OTHER types is no evidence for this one", () => {
    expect(
      judgeDraftName({ name: "envelope", typeName: "VendorEnvelope", casing: "snake", byTypeRows: [], nameRows: 40 }),
    ).toEqual({ verdict: "NO_CONVENTION", prefer: { exact: "vendor_envelope", analogous: [] } });
  });
});

describe("judgeDraftName — a value MISFIT needs a convention, not one row", () => {
  const TYPE = "TaxPreparation::TaxAutomations::TaxPreparation";
  const local = (name: string, n: number, exampleOwner = `Holder#${name}`) => ({
    kind: "local" as const,
    name,
    n,
    exampleOwner,
  });

  it("a type-named local against one row naming the type otherwise conforms: one row is no convention", () => {
    expect(
      judgeDraftName({
        name: "tax_preparations",
        kind: "local",
        typeName: TYPE,
        typeMultiplicity: "many",
        casing: "snake",
        byTypeRows: [local("scope", 1)],
      }),
    ).toEqual({ verdict: "CONFORMS" });
  });

  // bd tea-rags-mcp-bjfa0: still no rename, but one owner's name is context, not a term to offer — topTerms [].
  it("any other draft against one row is not demanded a rename: NO_CONVENTION with the row as context", () => {
    expect(
      judgeDraftName({
        name: "tax_automation_document",
        kind: "local",
        casing: "snake",
        callee: { member: "find_tax_automation_document!" },
        byCalleeRows: [
          { member: "find_tax_automation_document!", kind: "local", name: "row", n: 1, exampleOwner: "A#m" },
        ],
      }),
    ).toEqual({ verdict: "NO_CONVENTION", prefer: { analogous: ["row"] } });
  });

  it("one return row is too thin to name the type's noun", () => {
    expect(
      judgeDraftName({
        name: "meta",
        typeName: "GitFileSignals",
        casing: "camel",
        byTypeRows: [
          { kind: "return", name: "computeFileSignals", n: 1, exampleOwner: "GitProvider#computeFileSignals" },
        ],
      }),
    ).toEqual({ verdict: "NEW_TERM", topTerms: ["fileSignals"] });
  });

  it("a local named after its type conforms when another kind of the type's values spells it", () => {
    expect(
      judgeDraftName({
        name: "tax_preparation",
        kind: "local",
        typeName: TYPE,
        casing: "snake",
        byTypeRows: [
          local("existing", 3, "TaxPreparation::Juno::TaxPreparations::FindOrCreate#create_or_merge_on_race!"),
          local("prior", 1),
          local("scope", 1),
          { kind: "param", name: "tax_preparation", n: 18, exampleOwner: "Worker#perform" },
        ],
      }),
    ).toEqual({ verdict: "CONFORMS" });
  });

  it("a type-named local no kind spells, against a convention of ≥ 2 rows, is still a MISFIT", () => {
    expect(
      judgeDraftName({
        name: "tax_preparation",
        kind: "local",
        typeName: TYPE,
        casing: "snake",
        byTypeRows: [local("existing", 3, "FindOrCreate#create_or_merge_on_race!")],
      }),
    ).toEqual({ verdict: "MISFIT", suggestion: "existing", holder: "FindOrCreate#create_or_merge_on_race!" });
  });
});

describe("judgeDraftName — a MISFIT suggestion keeps what the draft says about WHICH value", () => {
  const DOC = "TaxPreparation::TaxAutomations::Document";
  const returns = [{ kind: "return" as const, name: "tax_automation_documents", n: 6, exampleOwner: "Export#docs" }];
  const judge = (name: string) =>
    judgeDraftName({
      name,
      kind: "return",
      typeName: DOC,
      typeMultiplicity: "many",
      casing: "snake",
      byTypeRows: returns,
    });

  it("a draft that is the project's name plus a complement conforms", () => {
    expect(judge("tax_automation_documents_for_payload")).toEqual({ verdict: "CONFORMS" });
  });

  it("a draft with a complement keeps it on the suggestion: only the part before the connector is replaced", () => {
    expect(judge("filed_under_another_entity")).toEqual({
      verdict: "MISFIT",
      suggestion: "tax_automation_documents_under_another_entity",
      holder: "Export#docs",
    });
  });

  it("a suggestion that would only drop the draft's qualifier is no rename: NEW_TERM naming the project's word", () => {
    expect(
      judgeDraftName({
        name: "other_node",
        kind: "local",
        typeName: "Node",
        casing: "snake",
        byTypeRows: [{ kind: "local", name: "node", n: 10, exampleOwner: "Graph#walk" }],
      }),
    ).toEqual({ verdict: "NEW_TERM", topTerms: ["node"] });
  });
});
