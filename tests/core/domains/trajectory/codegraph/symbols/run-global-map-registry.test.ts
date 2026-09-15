/**
 * The run-global map persistence registry (bd tea-rags-mcp-39xca.6).
 *
 * Which `CodegraphRunState` map is persisted in `cg_pass1_aggregates` and
 * absorbed for unwalked files at `seal` used to be decided ad hoc, per merge.
 * bd tea-rags-mcp-4yvms is what that cost: a map added by a parallel merge
 * missed the persisted slice, and an incremental run resolved Python field and
 * re-export lookups against a batch-sized registry while every rate read clean.
 *
 * `RUN_GLOBAL_MAP_PERSISTENCE` is now the one declaration. The compile-time half
 * of the guard lives in the source (`satisfies Record<RunGlobalMapField, …>`
 * over `keyof CodegraphRunState`); this file is the runtime half:
 *
 *  - the declared POLICY of every map is pinned, so flipping a hydrate channel
 *    to batch-only is a visible diff rather than a silent recall regression;
 *  - every hydrate entry survives build → codec → seal, so a hydrate map the
 *    slice does not carry fails here instead of on a live incremental run;
 *  - the persisted key order is pinned, because `applyScopedRowDiff` compares
 *    the JSON column and a reordered registry would rewrite every row once.
 */
import { describe, expect, it } from "vitest";

import { fromCgPass1Row, toCgPass1Row } from "../../../../../../src/core/adapters/duckdb/cg-pass1-aggregates-row.js";
import { NoopGlobalSymbolTable } from "../../../../../../src/core/adapters/duckdb/daemon/noop-symbol-table.js";
import type {
  FileExtraction,
  GlobalSymbolTable,
  SelfDispatchMethodDecl,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { buildPass1Aggregates } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/pass1-aggregates.js";
import {
  NON_AGGREGATE_RUN_STATE_FIELDS,
  PASS1_AGGREGATE_SLICE_FIELDS,
  RUN_GLOBAL_MAP_PERSISTENCE,
  type RunGlobalMapField,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-global-map-registry.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

/**
 * Every run-global map and the policy it is expected to carry. Keyed by
 * `RunGlobalMapField`, so a new map fails the type check here as well as in the
 * registry; the assertion below then fails until the two agree.
 */
const EXPECTED_POLICY = {
  ancestors: "hydrate",
  prependedAncestors: "hydrate",
  classExtends: "hydrate",
  compactClasses: "hydrate",
  inheritanceRows: "hydrate",
  selfDispatchMethods: "hydrate",
  structuredReturnTypes: "hydrate",
  returnTypes: "hydrate",
  classFieldTypesByClassKey: "hydrate",
  moduleReexports: "hydrate",
  extractedFilesByLanguage: "batchOnly",
  extractedRelPathsByLanguage: "batchOnly",
  includedBy: "batchOnly",
  hierarchyView: "batchOnly",
  selfDispatchTemplates: "batchOnly",
  selfInstantiatingClassMethods: "batchOnly",
  schemaTables: "batchOnly",
  instantiatedTypes: "batchOnly",
  ivarTypes: "batchOnly",
  classFieldCallResults: "batchOnly",
  dispatchTables: "batchOnly",
  callbackParams: "batchOnly",
  knownTargetCallArgs: "batchOnly",
  paramNames: "batchOnly",
  classFieldParamLinks: "batchOnly",
  typedClassFields: "batchOnly",
  paramTypes: "batchOnly",
  derivedClassFieldTypes: "batchOnly",
} as const satisfies Record<RunGlobalMapField, "hydrate" | "batchOnly">;

/**
 * The `aggregates_json` key order every row written before the registry
 * existed carries. Reordering it is not a format change a reader notices, but
 * the row diff compares the column bytes and would rewrite every row once.
 */
const PERSISTED_KEY_ORDER = [
  "classAncestors",
  "classPrependedAncestors",
  "classExtends",
  "compactDeclaredClasses",
  "inheritanceEdges",
  "selfDispatchMethods",
  "structuredReturnTypes",
  "functionReturnTypes",
  "classFieldTypesByClassKey",
  "moduleReexports",
];

const RELPATH = "app/models/account.rb";

/** An extraction carrying a fact for every hydrate channel AND for several batch-only ones. */
function everyChannelExtraction(): FileExtraction {
  return {
    relPath: RELPATH,
    language: "ruby",
    imports: [],
    fileScope: [],
    chunks: [],
    classAncestors: { Account: ["ApplicationRecord"] },
    classPrependedAncestors: { Account: ["Auditable"] },
    classExtends: { Account: "ApplicationRecord" },
    compactDeclaredClasses: ["Billing::Account"],
    inheritanceEdges: [{ source: "Account", ancestor: "ApplicationRecord", kind: "super", ordinal: 0 }],
    structuredReturnTypes: { "Account#firm": { form: "instance", name: "Firm" } },
    functionReturnTypes: { build_account: "Account" },
    classFieldTypesByClassKey: { [`${RELPATH}::Account`]: { firm: "Firm" } },
    moduleReexports: [{ exportedName: "Account", sourceModule: ".", sourceName: "Account" }],
    // Batch-only facts: present on the extraction, absent from the slice.
    ivarTypes: { Account: { "@firm": "Firm" } },
    instantiatedTypes: ["Account"],
    callbackParams: { "Account#each": [0] },
  } as unknown as FileExtraction;
}

const SELF_DISPATCH: readonly SelfDispatchMethodDecl[] = [
  { symbolId: "Account#call", enclosingType: "Account", selfHookCandidates: ["perform"] },
];

const noopTable = async (): Promise<GlobalSymbolTable> => new NoopGlobalSymbolTable();

function isPopulated(value: unknown): boolean {
  if (value instanceof Set || value instanceof Map) return value.size > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

describe("RUN_GLOBAL_MAP_PERSISTENCE declares one persistence policy per run-global map", () => {
  it("pins the policy of every map, so a flip is a reviewed diff", () => {
    const declared = Object.fromEntries(
      Object.entries(RUN_GLOBAL_MAP_PERSISTENCE).map(([field, entry]) => [field, entry.policy]),
    );
    expect(declared).toEqual(EXPECTED_POLICY);
  });

  it("gives every batch-only map a stated reason", () => {
    for (const [field, entry] of Object.entries(RUN_GLOBAL_MAP_PERSISTENCE)) {
      if (entry.policy !== "batchOnly") continue;
      expect(entry.reason.trim().length, `${field} has no reason`).toBeGreaterThan(0);
    }
  });

  it("names only fields a run state actually has, in both lists", () => {
    const state = new CodegraphRunState();
    for (const field of [...Object.keys(RUN_GLOBAL_MAP_PERSISTENCE), ...Object.keys(NON_AGGREGATE_RUN_STATE_FIELDS)]) {
      expect(field in state, `${field} is not a CodegraphRunState field`).toBe(true);
    }
  });

  it("never lists a field as both a run-global map and a non-aggregate field", () => {
    const maps = new Set(Object.keys(RUN_GLOBAL_MAP_PERSISTENCE));
    expect(Object.keys(NON_AGGREGATE_RUN_STATE_FIELDS).filter((field) => maps.has(field))).toEqual([]);
  });
});

describe("the pass-1 aggregate slice is derived from the registry's hydrate entries", () => {
  it("lists exactly the hydrate entries' slice fields, in persisted order", () => {
    expect([...PASS1_AGGREGATE_SLICE_FIELDS]).toEqual(PERSISTED_KEY_ORDER);
  });

  it("writes the persisted JSON in the pre-registry key order, batch-only facts excluded", () => {
    const slice = buildPass1Aggregates(everyChannelExtraction(), SELF_DISPATCH);
    if (slice === undefined) throw new Error("fixture declares facts, expected a slice");

    const [relPath, language, json] = toCgPass1Row(slice) as [string, string, string];
    expect(relPath).toBe(RELPATH);
    expect(language).toBe("ruby");
    expect(Object.keys(JSON.parse(json) as object)).toEqual(PERSISTED_KEY_ORDER);
  });

  it("hydrates every hydrate map after a round trip through the persisted row", async () => {
    const slice = buildPass1Aggregates(everyChannelExtraction(), SELF_DISPATCH);
    if (slice === undefined) throw new Error("fixture declares facts, expected a slice");
    const [relPath, language, json] = toCgPass1Row(slice) as [string, string, string];
    const persisted = fromCgPass1Row({ rel_path: relPath, language, aggregates_json: json });

    // A run that walked nothing: every fact below can only have come from the row.
    const state = new CodegraphRunState();
    await state.seal(noopTable, async () => [persisted]);

    for (const [field, entry] of Object.entries(RUN_GLOBAL_MAP_PERSISTENCE)) {
      if (entry.policy !== "hydrate") continue;
      expect(isPopulated(state[field as keyof CodegraphRunState]), `${field} was not hydrated`).toBe(true);
    }
  });
});
