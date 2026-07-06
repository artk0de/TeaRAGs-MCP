/**
 * bd tea-rags-mcp — DEFECT 2 (self-receiver abstract-hook dispatch), slice 2c.
 * Spec: docs/superpowers/specs/2026-07-06-ruby-self-receiver-dispatch-design.md.
 *
 * The entry-anchored resolver: at an entry call `Const.member` whose `member`
 * resolves via MRO to a self-dispatch template `M` (in
 * `ctx.selfDispatchTemplates`, hook `H`), the CONCRETE constant receiver narrows
 * the abstract hook to exactly `Const#H` — one edge, no fan-out, no cone. Two
 * different constant entries resolve to their OWN `#H` (the narrow-to-1
 * property). The strategy CONTINUEs for every non-entry shape so the normal
 * passes keep owning them.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  RubySelfDispatchEntrySymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };
const strat = new RubySelfDispatchEntrySymbolResolutionStrategy(cfg);

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const tableWith = (...files: [string, NamedSymbol[]][]): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
};

const ctx = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext => ({
  callerFile: "app/controllers/things_controller.rb",
  callerScope: ["ThingsController"],
  imports: [],
  ...over,
});

// The KindOfService shape: a `KindOfService.call` class-method template
// (`self.new.perform`) mixed into two concrete services that each define
// `#perform`. `KindOfService` itself never defines `perform` (abstract hook).
const KOS_FILE = "app/services/kind_of_service.rb";
const CREATE_FILE = "app/services/create.rb";
const REFRESH_FILE = "app/services/refresh.rb";

const serviceTable = (): InMemoryGlobalSymbolTable =>
  tableWith(
    [
      KOS_FILE,
      [
        sym("KindOfService", "KindOfService", KOS_FILE, []),
        sym("KindOfService.call", "call", KOS_FILE, ["KindOfService"]),
      ],
    ],
    [CREATE_FILE, [sym("Create", "Create", CREATE_FILE, []), sym("Create#perform", "perform", CREATE_FILE, ["Create"])]],
    [
      REFRESH_FILE,
      [sym("Refresh", "Refresh", REFRESH_FILE, []), sym("Refresh#perform", "perform", REFRESH_FILE, ["Refresh"])],
    ],
  );

const serviceCtx = (over: Partial<CallContext> = {}): CallContext =>
  ctx({
    symbolTable: serviceTable(),
    classAncestors: { Create: ["KindOfService"], Refresh: ["KindOfService"] },
    selfDispatchTemplates: { "KindOfService.call": "perform" },
    ...over,
  });

const entryCall = (receiver: string): CallRef => ({
  callText: `${receiver}.call(args)`,
  receiver,
  member: "call",
  startLine: 7,
});

describe("RubySelfDispatchEntrySymbolResolutionStrategy (DEFECT 2)", () => {
  it("narrows `Create.call` to the concrete `Create#perform` (entry-anchored, 1 target)", () => {
    const outcome = strat.attempt(entryCall("Create"), serviceCtx());
    expect(outcome.kind).toBe("resolved");
    expect(outcome.kind === "resolved" && outcome.target).toEqual({
      targetRelPath: CREATE_FILE,
      targetSymbolId: "Create#perform",
    });
  });

  it("narrows a DIFFERENT entry `Refresh.call` to ITS own `Refresh#perform` (narrow-to-1, not a cone)", () => {
    const outcome = strat.attempt(entryCall("Refresh"), serviceCtx());
    expect(outcome.kind === "resolved" && outcome.target.targetSymbolId).toBe("Refresh#perform");
  });

  it("CONTINUES when no self-dispatch template map is present (feature off / non-Ruby)", () => {
    expect(strat.attempt(entryCall("Create"), serviceCtx({ selfDispatchTemplates: undefined })).kind).toBe("continue");
  });

  it("CONTINUES when the entry member does not route to a known template", () => {
    // `Create.build` resolves to no template hook → normal passes own it.
    const call: CallRef = { callText: "Create.build", receiver: "Create", member: "build", startLine: 7 };
    expect(strat.attempt(call, serviceCtx()).kind).toBe("continue");
  });

  it("CONTINUES on a receiverless bare call (no concrete constant entry)", () => {
    const call: CallRef = { callText: "call(args)", receiver: null, member: "call", startLine: 7 };
    expect(strat.attempt(call, serviceCtx()).kind).toBe("continue");
  });

  it("CONTINUES on a lowercase (non-constant) receiver — only a concrete constant is an entry", () => {
    const call: CallRef = { callText: "service.call(args)", receiver: "service", member: "call", startLine: 7 };
    expect(strat.attempt(call, serviceCtx()).kind).toBe("continue");
  });

  it("CONTINUES when the constant does not concretely define the hook (defensive: no method-level Const#H)", () => {
    // Create WITHOUT a `#perform` def — the map claims a template but the concrete
    // hook can't be pinned method-level, so we must not fabricate an edge.
    const table = tableWith(
      [
        KOS_FILE,
        [
          sym("KindOfService", "KindOfService", KOS_FILE, []),
          sym("KindOfService.call", "call", KOS_FILE, ["KindOfService"]),
        ],
      ],
      [CREATE_FILE, [sym("Create", "Create", CREATE_FILE, [])]],
    );
    const outcome = strat.attempt(
      entryCall("Create"),
      ctx({
        symbolTable: table,
        classAncestors: { Create: ["KindOfService"] },
        selfDispatchTemplates: { "KindOfService.call": "perform" },
      }),
    );
    expect(outcome.kind).toBe("continue");
  });
});
