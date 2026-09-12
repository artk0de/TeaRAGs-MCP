/**
 * Every Ruby short-name lookup is restricted to Ruby sources (bd
 * tea-rags-mcp-kumq2), mirroring what E4.0.5 did for Python.
 *
 * One symbol table is built per run over every `CODEGRAPH_LANGUAGES` extension
 * — production and both harnesses alike — and `SymbolDefinition` carries no
 * `language` field. On a Rails + React repo (taxdome, mastodon's
 * `app/javascript`) a `.ts`/`.tsx`/`.js` symbol that merely spells the same
 * short name therefore enters every Ruby candidate set. Two shapes go wrong:
 *
 *   - CARDINALITY GATES — `length <= 1` (flat return facts) and `length > 0`
 *     (the naming-convention existence check). A namesake silently SUPPRESSES a
 *     valid Ruby answer, or fabricates one for a class Ruby never declares.
 *   - PICK SITES — the candidate list is pinned to `resolveConstant`'s file,
 *     but `resolveConstant` itself goes through `symbolTable.lookup(fq)`, which
 *     is equally language-blind: a `.ts` class named `User` answers it, and the
 *     short-name filter downstream then agrees on the `.ts` file.
 *
 * A Ruby-only table must come out byte-identical — the filter removes
 * non-Ruby paths and nothing else.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { flatReturnFactMayOverrideKnownReceiver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-return-facts.js";
import { conventionReceiverType } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-unbound-receiver-types.js";
import {
  lookupRubySymbolsByShortName,
  RubyConeTypeLocator,
  RubyConstantSymbolResolutionStrategy,
  RubyExplicitRequireSymbolResolutionStrategy,
  RubySchemaColumnSymbolResolutionStrategy,
  RubyTableDispatchResolver,
  type ResolverConfig,
} from "../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import {
  resolveInstanceMethodInClassChain,
  resolveSelfDispatchHookTarget,
  resolveTypeInstanceMethod,
  resolveViaSuperclassChain,
} from "../../../../../../src/core/domains/language/ruby/resolver/strategies/shared.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

const sym = (
  symbolId: string,
  shortName: string,
  relPath: string,
  scope: string[],
  extra: Partial<NamedSymbol> = {},
): NamedSymbol => ({ symbolId, fqName: symbolId, shortName, relPath, scope, ...extra });

const tableWith = (...files: [string, NamedSymbol[]][]): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
};

const ctx = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext => ({
  callerFile: "app/models/caller.rb",
  callerScope: [],
  imports: [],
  ...over,
});

const TSX = "app/javascript/components/Report.tsx";
const RB = "app/models/report.rb";

describe("lookupRubySymbolsByShortName — same-language candidates only", () => {
  it("drops a `.tsx` namesake and keeps the `.rb` one", () => {
    const symbolTable = tableWith(
      [TSX, [sym("Report#render", "render", TSX, ["Report"])]],
      [RB, [sym("Report#render", "render", RB, ["Report"])]],
    );
    expect(lookupRubySymbolsByShortName(ctx({ symbolTable }), "render").map((d) => d.relPath)).toEqual([RB]);
  });

  it("forwards lookup options and still filters by language under them", () => {
    const schema = "db/schema.rb";
    const symbolTable = tableWith(
      [schema, [sym("Report#name", "name", schema, ["Report"], { isSchemaColumn: true })]],
      [TSX, [sym("Report#name", "name", TSX, ["Report"], { isSchemaColumn: true })]],
    );
    expect(
      lookupRubySymbolsByShortName(ctx({ symbolTable }), "name", { includeSchemaColumns: true }).map((d) => d.relPath),
    ).toEqual([schema]);
  });

  it("is a no-op on a Ruby-only table", () => {
    const other = "app/services/report_service.rb";
    const symbolTable = tableWith(
      [RB, [sym("Report#render", "render", RB, ["Report"])]],
      [other, [sym("ReportService#render", "render", other, ["ReportService"])]],
    );
    expect(lookupRubySymbolsByShortName(ctx({ symbolTable }), "render")).toEqual(
      symbolTable.lookupByShortName("render"),
    );
  });
});

describe("cardinality gates — a namesake must not suppress a valid Ruby answer", () => {
  it("flatReturnFactMayOverrideKnownReceiver: a `.tsx` namesake no longer collides the fact", () => {
    const symbolTable = tableWith(
      [RB, [sym("Report#render", "render", RB, ["Report"])]],
      [TSX, [sym("Report#render", "render", TSX, ["Report"])]],
    );
    expect(flatReturnFactMayOverrideKnownReceiver("render", ctx({ symbolTable }))).toBe(true);
  });

  it("flatReturnFactMayOverrideKnownReceiver: TWO Ruby definitions still collide (unchanged)", () => {
    const other = "app/services/report_service.rb";
    const symbolTable = tableWith(
      [RB, [sym("Report#render", "render", RB, ["Report"])]],
      [other, [sym("ReportService#render", "render", other, ["ReportService"])]],
    );
    expect(flatReturnFactMayOverrideKnownReceiver("render", ctx({ symbolTable }))).toBe(false);
  });

  it("conventionReceiverType: a `.tsx`-only class is not evidence the Ruby class exists", () => {
    const symbolTable = tableWith([TSX, [sym("Report", "Report", TSX, [])]]);
    expect(conventionReceiverType("report", ctx({ symbolTable }))).toBeUndefined();
  });

  it("conventionReceiverType: a real Ruby class still resolves (unchanged)", () => {
    const symbolTable = tableWith([RB, [sym("Report", "Report", RB, [])]]);
    expect(conventionReceiverType("report", ctx({ symbolTable }))?.name).toBe("Report");
  });
});

describe("pick sites — a `.ts`/`.tsx` namesake is never chosen as the target", () => {
  const member = "render";

  /** `resolveConstant` answers with the `.tsx` file: `lookup("Report")` is language-blind too. */
  const crossLanguageTable = (): InMemoryGlobalSymbolTable =>
    tableWith([
      TSX,
      [
        sym("Report", "Report", TSX, []),
        sym("Report.render", member, TSX, ["Report"]),
        sym("Report#render", member, TSX, ["Report"]),
      ],
    ]);

  it("constant strategy (`Report.render`) no longer pins the `.tsx` class method", () => {
    const call: CallRef = { callText: "Report.render(x)", receiver: "Report", member, startLine: 1 };
    const outcome = new RubyConstantSymbolResolutionStrategy(cfg).attempt(
      call,
      ctx({ symbolTable: crossLanguageTable() }),
    );
    // The METHOD-level cross-language pick is what this bead removes. The
    // residual file-only edge it left came from `resolveConstant`
    // (`symbolTable.lookup(fq)` was language-blind too) and is closed by bd
    // tea-rags-mcp-zn4uf — see `ruby-constant-file-language-filter.test.ts`.
    expect(outcome.kind === "resolved" ? outcome.target.targetSymbolId : null).toBeNull();
  });

  it("constant strategy still pins a real Ruby class method (unchanged)", () => {
    const symbolTable = tableWith([
      RB,
      [sym("Report", "Report", RB, []), sym("Report.render", member, RB, ["Report"])],
    ]);
    const call: CallRef = { callText: "Report.render(x)", receiver: "Report", member, startLine: 1 };
    const outcome = new RubyConstantSymbolResolutionStrategy(cfg).attempt(call, ctx({ symbolTable }));
    expect(outcome.kind === "resolved" ? outcome.target : null).toEqual({
      targetRelPath: RB,
      targetSymbolId: "Report.render",
    });
  });

  it("explicit-require strategy still pins a real Ruby require target (unchanged)", () => {
    const lib = "lib/report.rb";
    const symbolTable = tableWith([lib, [sym("Report#render", member, lib, ["Report"])]]);
    const call: CallRef = { callText: "report.render(x)", receiver: "report", member, startLine: 1 };
    const outcome = new RubyExplicitRequireSymbolResolutionStrategy(cfg).attempt(
      call,
      ctx({
        symbolTable,
        imports: [
          { importText: "report", line: 1 },
          { importText: lib, line: 1 },
        ],
      }),
    );
    expect(outcome.kind === "resolved" ? outcome.target.targetRelPath : null).toBe(lib);
  });

  it("cone type locator does not pin the `.tsx` symbol", () => {
    const locator = new RubyConeTypeLocator(cfg);
    expect(locator.findDirectMethod("Report", member, ctx({ symbolTable: crossLanguageTable() }))).toBeNull();
  });

  /** `CONST[k].new.render` — the walker-tagged registry fan-out shape. */
  const dispatchCall = (): CallRef => ({
    callText: "REGISTRY[k].new.render",
    receiver: "REGISTRY[k].new",
    member,
    startLine: 1,
    dispatch: { table: "REGISTRY", key: null, field: member, viaInstance: true },
  });

  const registry = (): CallContext["dispatchTables"] => ({
    REGISTRY: [{ relPath: "app/registry.rb", table: { entries: { a: "Report" } } }],
  });

  it("table dispatch does not fan out to the `.tsx` symbol", () => {
    const outcome = new RubyTableDispatchResolver(cfg).resolveDispatch(
      dispatchCall(),
      ctx({ symbolTable: crossLanguageTable(), dispatchTables: registry() }),
    );
    expect(outcome.kind === "edges" ? outcome.edges : []).toEqual([]);
  });

  it("table dispatch still fans out to a real Ruby target (unchanged)", () => {
    const symbolTable = tableWith([
      RB,
      [sym("Report", "Report", RB, []), sym("Report#render", member, RB, ["Report"])],
    ]);
    const outcome = new RubyTableDispatchResolver(cfg).resolveDispatch(
      dispatchCall(),
      ctx({ symbolTable, dispatchTables: registry() }),
    );
    expect((outcome.kind === "edges" ? outcome.edges : []).map((e) => e.targetSymbolId)).toEqual(["Report#render"]);
  });

  it("schema-column strategy ignores a `.tsx` column namesake", () => {
    const symbolTable = tableWith([TSX, [sym("Report#name", "name", TSX, ["Report"], { isSchemaColumn: true })]]);
    const call: CallRef = { callText: "name", receiver: null, member: "name", startLine: 1 };
    const outcome = new RubySchemaColumnSymbolResolutionStrategy().attempt(
      call,
      ctx({ symbolTable, callerScope: ["Report"] }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("resolveInstanceMethodInClassChain does not pin the `.tsx` symbol", () => {
    const target = resolveInstanceMethodInClassChain(
      "Report",
      member,
      ctx({ symbolTable: crossLanguageTable() }),
      DEFAULT_AMBIGUOUS_RESOLVE_MODE,
      new Set<string>(),
    );
    expect(target?.targetSymbolId ?? null).toBeNull();
  });

  it("resolveViaSuperclassChain does not pin the `.tsx` symbol", () => {
    expect(
      resolveViaSuperclassChain(
        "Report",
        member,
        ctx({ symbolTable: crossLanguageTable() }),
        DEFAULT_AMBIGUOUS_RESOLVE_MODE,
      ),
    ).toBeNull();
  });

  it("resolveTypeInstanceMethod does not pin the `.tsx` symbol", () => {
    const target = resolveTypeInstanceMethod(
      "Report",
      member,
      ctx({ symbolTable: crossLanguageTable() }),
      DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    );
    expect(target?.targetSymbolId ?? null).toBeNull();
  });

  it("resolveSelfDispatchHookTarget does not pin the `.tsx` symbol", () => {
    expect(
      resolveSelfDispatchHookTarget(
        "Report",
        member,
        ctx({ symbolTable: crossLanguageTable() }),
        DEFAULT_AMBIGUOUS_RESOLVE_MODE,
      ),
    ).toBeNull();
  });

  it("a Ruby-only equivalent of the same fixture still pins the method", () => {
    const symbolTable = tableWith([
      RB,
      [sym("Report", "Report", RB, []), sym("Report#render", member, RB, ["Report"])],
    ]);
    const target = resolveTypeInstanceMethod("Report", member, ctx({ symbolTable }), DEFAULT_AMBIGUOUS_RESOLVE_MODE);
    expect(target).toEqual({ targetRelPath: RB, targetSymbolId: "Report#render" });
  });
});
