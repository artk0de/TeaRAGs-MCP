/**
 * bd tea-rags-mcp-bjfa0 — a taxdome diff review (get_naming_lexicon diff mode,
 * verdicts the user accepted) that the lexicon got wrong:
 *
 * 1. `build_api_client` (a return) judged as a whole against the noun `client`;
 * 2. `tax_preparations` (a relation) demanded a rename to `scope`, a name one
 *    method held — rows counted, not holders;
 * 3. `target = UploadTargetBuffer.read(…)` — untyped — a NEW_TERM offering nothing,
 *    and `entity_id` offered four one-off names another block bound;
 * 5. `same_firm?`, an override of `AbstractPolicy#same_firm?`, judged novel;
 * 6. `write_vendor_document!` told to become `for_delivery`, a complement.
 */
import { describe, expect, it } from "vitest";

import {
  judgeDraftName,
  type NamingByTypeRow,
} from "../../../../../src/core/domains/explore/naming-lexicon/verdicts.js";

describe("judgeDraftName — a return's leading verb belongs to the method; its noun is judged", () => {
  const CLIENT_RETURNS: NamingByTypeRow[] = [
    { kind: "return", name: "client", n: 115, exampleOwner: "ClientNoteSerializer#client" },
    { kind: "return", name: "clients", n: 27, exampleOwner: "Firm#clients" },
  ];
  const judge = (name: string) =>
    judgeDraftName({ name, kind: "return", typeName: "Client", casing: "snake", byTypeRows: CLIENT_RETURNS });

  it("a closed-class verb before the project's noun conforms", () => {
    expect(judge("build_client")).toEqual({ verdict: "CONFORMS" });
    expect(judge("read_client")).toEqual({ verdict: "CONFORMS" });
  });

  it("a verb before a qualified noun conforms: the qualifier says WHICH client the method returns", () => {
    expect(judge("build_api_client")).toEqual({ verdict: "CONFORMS" });
    expect(judge("api_client")).toEqual({ verdict: "CONFORMS" });
  });

  it("a noun that does not spell the type is still measured against the project's noun", () => {
    expect(judge("fetch_widget")).toEqual({
      verdict: "MISFIT",
      suggestion: "client",
      holder: "ClientNoteSerializer#client",
    });
  });
});

// Item 6: live on taxdome `write_vendor_document!` (return, `Instead::Document`) was a MISFIT
// naming `for_delivery` — three rows of n = 1, the first won the tie, and it was a complement.
describe("judgeDraftName — a suggestion is a name, never a complement that starts with a connector", () => {
  const rows = (...names: string[]): NamingByTypeRow[] =>
    names.map((name) => ({ kind: "return" as const, name, n: 1, exampleOwner: `Vendor#${name}` }));

  it("a connector-led row is never the suggestion", () => {
    const verdict = judgeDraftName({
      name: "write_vendor_document!",
      kind: "return",
      typeName: "TaxPreparation::TaxAutomations::Instead::Document",
      casing: "snake",
      byTypeRows: rows("for_delivery", "documents", "secondary_default_sorting"),
    });
    expect(verdict).not.toMatchObject({ suggestion: "for_delivery" });
    // What is left holds one method each: no convention to demand, and none to offer.
    expect(verdict).toEqual({ verdict: "NEW_TERM", topTerms: [] });
  });

  it("the type `Doc` of the report: never `for_delivery`", () => {
    const verdict = judgeDraftName({
      name: "write_vendor_document!",
      kind: "return",
      typeName: "Doc",
      casing: "snake",
      byTypeRows: rows("for_delivery", "documents"),
    });
    expect(verdict).not.toMatchObject({ suggestion: "for_delivery" });
  });

  // Live the `one` rows were `for_delivery` and `secondary_default_sorting` alone (`documents` reads many):
  // with the complement gone, one method's name was the demand.
  it("a return MISFIT needs a convention too: one other method's name is no demand and no term", () => {
    expect(
      judgeDraftName({
        name: "write_vendor_document!",
        kind: "return",
        typeName: "TaxPreparation::TaxAutomations::Instead::Document",
        casing: "snake",
        byTypeRows: rows("for_delivery", "secondary_default_sorting"),
      }),
    ).toEqual({ verdict: "NEW_TERM", topTerms: [] });
  });

  it("with only connector-led rows there is nothing to suggest: NEW_TERM with no terms", () => {
    expect(
      judgeDraftName({
        name: "fetch_widget",
        kind: "return",
        typeName: "TaxPreparation::TaxAutomations::Instead::Document",
        casing: "snake",
        // Both spell the type after a connector: the draft's FREE shape holds no share of them.
        byTypeRows: rows("for_documents", "by_document"),
      }),
    ).toEqual({ verdict: "NEW_TERM", topTerms: [] });
  });
});

describe("judgeDraftName — a convention is held by several owners, not by several rows of one", () => {
  const TYPE = "TaxPreparation::TaxAutomations::TaxPreparation";
  const local = (name: string, n: number, holders: number): NamingByTypeRow => ({
    kind: "local",
    name,
    n,
    holders,
    exampleOwner: "TaxPreparation::Juno::TaxPreparations::FindOrCreate#create_or_merge_on_race!",
  });

  it("three rows in ONE method are no convention: the type-named local conforms", () => {
    expect(
      judgeDraftName({
        name: "tax_preparation",
        kind: "local",
        typeName: TYPE,
        casing: "snake",
        byTypeRows: [local("existing", 3, 1)],
      }),
    ).toEqual({ verdict: "CONFORMS" });
  });

  it("the same rows across two owners are a convention", () => {
    expect(
      judgeDraftName({
        name: "tax_preparation",
        kind: "local",
        typeName: TYPE,
        casing: "snake",
        byTypeRows: [local("existing", 3, 2)],
      }),
    ).toMatchObject({ verdict: "MISFIT", suggestion: "existing" });
  });

  // Live the `existing` locals sit in THREE methods of two FindOrCreate services — a convention by owners — but
  // the project's methods return the type as `tax_preparation`: the name the §5a rule 4 exception keeps.
  it("a convention does not beat the type's name when the project's methods return the type under it", () => {
    expect(
      judgeDraftName({
        name: "tax_preparation",
        kind: "local",
        typeName: TYPE,
        casing: "snake",
        byTypeRows: [
          local("existing", 3, 3),
          { kind: "return", name: "tax_preparation", n: 2, exampleOwner: "TaxAutomationDocument#tax_preparation" },
          { kind: "return", name: "juno_tax_preparations", n: 3, exampleOwner: "JunoClient#juno_tax_preparations" },
        ],
      }),
    ).toEqual({ verdict: "CONFORMS" });
  });

  it("another kind spelling the type counts on its own rows, not diluted by the draft's kind", () => {
    const ret = (name: string, n: number) => ({ kind: "return" as const, name, n, exampleOwner: `M#${name}` });
    expect(
      judgeDraftName({
        name: "tax_preparation",
        kind: "local",
        typeName: TYPE,
        casing: "snake",
        byTypeRows: [
          local("existing", 3, 3),
          ...["ein_prior", "prior", "scope", "survivor"].map((name) => local(name, 1, 1)),
          ret("tax_preparation", 3),
          ret("juno_tax_preparations", 3),
          ...["created", "found", "merged", "reopened", "latest", "prior", "picked", "kept"].map((name) =>
            ret(name, 1),
          ),
        ],
      }),
    ).toEqual({ verdict: "CONFORMS" });
  });

  it("a relation named by its model's plural is never beaten by a role noun for the container", () => {
    expect(
      judgeDraftName({
        name: "tax_preparations",
        kind: "local",
        typeName: TYPE,
        typeMultiplicity: "many",
        casing: "snake",
        byTypeRows: [local("scope", 6, 6), local("records", 4, 4)],
      }),
    ).toEqual({ verdict: "CONFORMS" });
  });

  it("the singular for a collection is not the plural: the convention still speaks", () => {
    expect(
      judgeDraftName({
        name: "tax_preparation",
        kind: "local",
        typeName: TYPE,
        typeMultiplicity: "many",
        casing: "snake",
        byTypeRows: [local("scope", 6, 6)],
      }),
    ).toMatchObject({ verdict: "MISFIT", suggestion: "scope" });
  });
});

describe("judgeDraftName — an untyped value read off a constant receiver takes its terms from the receiver", () => {
  const READ = { member: "read", receiver: "TaxPreparation::TaxAutomations::UploadTargetBuffer" };
  const judge = (name: string, extra: { nameRows?: number; nameIsGeneric?: boolean } = {}) =>
    judgeDraftName({ name, kind: "local", casing: "snake", callee: READ, ...extra });

  it("a name nothing compares is offered the receiver's concept, not an empty NEW_TERM", () => {
    expect(judge("target")).toEqual({ verdict: "NEW_TERM", topTerms: ["upload_target", "upload_target_buffer"] });
  });

  it("a name spelling the receiver's concept conforms", () => {
    expect(judge("upload_target")).toEqual({ verdict: "CONFORMS" });
    expect(judge("upload_target_buffer")).toEqual({ verdict: "CONFORMS" });
  });

  it("a generic name's use elsewhere is no evidence for this value: the receiver's concept is offered", () => {
    expect(judge("target", { nameRows: 289, nameIsGeneric: true })).toEqual({
      verdict: "NEW_TERM",
      topTerms: ["upload_target", "upload_target_buffer"],
    });
  });

  it("a name the project uses, not generic, keeps conforming on that use", () => {
    expect(judge("target", { nameRows: 289 })).toEqual({ verdict: "CONFORMS" });
  });

  it("a member that names its value, or a receiver that is no constant, derives nothing from the receiver", () => {
    expect(
      judgeDraftName({
        name: "cause",
        kind: "local",
        casing: "snake",
        callee: { member: "reason_for", receiver: "TaxPreparation::TaxAutomations::RefusalsHelper" },
      }),
    ).toEqual({ verdict: "NO_CONVENTION", prefer: { analogous: [] } });
    expect(
      judgeDraftName({ name: "thing", kind: "local", casing: "snake", callee: { member: "read", receiver: "buffer" } }),
    ).toEqual({ verdict: "NO_CONVENTION", prefer: { analogous: [] } });
  });
});

// Live on taxdome `entity_id = RedisConnection.with_tax_preparation_pool { |redis| redis.get(key) }` was a NEW_TERM
// offering ai_query_ids / claimed / payload / result_ai_query_id: each the one local some other block bound.
describe("judgeDraftName — a name no second owner shares is no term to offer", () => {
  const POOL = { member: "with_tax_preparation_pool", receiver: "RedisConnection" };
  const row = (name: string, n: number, holders?: number) => ({
    ...POOL,
    kind: "local" as const,
    name,
    n,
    ...(holders !== undefined ? { holders } : {}),
    exampleOwner: `Owner#${name}`,
  });
  const judge = (rows: ReturnType<typeof row>[]) =>
    judgeDraftName({ name: "entity_id", kind: "local", casing: "snake", callee: POOL, byCalleeRows: rows });

  it("a callee whose bound names never repeat offers nothing: NO_CONVENTION", () => {
    expect(
      judge([row("ai_query_ids", 1, 1), row("claimed", 1, 1), row("payload", 1, 1), row("result_ai_query_id", 1, 1)]),
    ).toEqual({ verdict: "NO_CONVENTION", prefer: { analogous: ["ai_query_ids", "claimed", "payload", "result_ai_query_id"] } });
  });

  it("only the names several owners hold are offered", () => {
    expect(judge([row("payload", 3, 3), row("claimed", 1, 1), row("result", 2, 1)])).toEqual({
      verdict: "NEW_TERM",
      topTerms: ["payload"],
    });
  });
});

describe("judgeDraftName — an override's name is fixed by its supertype", () => {
  it("a method an ancestor declares conforms, naming the declaration", () => {
    expect(
      judgeDraftName({ name: "same_firm?", kind: "return", casing: "snake", overrides: "AbstractPolicy#same_firm?" }),
    ).toEqual({ verdict: "CONFORMS", override: { declaredBy: "AbstractPolicy#same_firm?" } });
  });

  it("the supertype's name wins over any row evidence", () => {
    expect(
      judgeDraftName({
        name: "build",
        kind: "return",
        typeName: "Client",
        casing: "snake",
        byTypeRows: [{ kind: "return", name: "client", n: 40, exampleOwner: "A#client" }],
        overrides: "BaseFactory#build",
      }),
    ).toEqual({ verdict: "CONFORMS", override: { declaredBy: "BaseFactory#build" } });
  });

  it("only a method overrides: a local named like an ancestor's method is judged as before", () => {
    expect(
      judgeDraftName({ name: "same_firm?", kind: "local", casing: "snake", overrides: "AbstractPolicy#same_firm?" }),
    ).toEqual({ verdict: "NO_CONVENTION", prefer: { analogous: [] } });
  });
});
