/**
 * Three precision guards on the Python short-name fallback (bd
 * tea-rags-mcp-w205u, E4.0.5). Every case here is an oracle row the E4.0.4
 * attribution filed under `chain-wrong`, reproduced at unit scale.
 *
 * The symbol table is built over EVERY `CODEGRAPH_LANGUAGES` extension — one
 * table per run, production and both harnesses alike — and carries no
 * `language` field, so a bare `lookupByShortName` answers with whatever file in
 * the repo happens to spell the member:
 *
 *   - cross-language — polar's `range(...)` resolved to
 *     `clients/packages/ui/src/components/atoms/Paginator.tsx#range`, and
 *     `GitHub()` to `Icons.tsx#GitHub`. 46 of polar's 155 phantoms.
 *   - not bare-callable — a bare `open(path, mode)` resolved to the INSTANCE
 *     method `src/flask/testing.py#FlaskClient#open`, 9 of flask's 11. A bare
 *     call in Python names a module-level `def`/`class`, an enclosing-function
 *     def, an imported name, or a builtin. Never `Cls#m`.
 *   - a builtin — `open` / `type` / `range` are bound before any module runs,
 *     so a cross-file pick for one is a fabricated edge by construction.
 *     `PYTHON_BUILTINS` was consulted only by the external classifier AFTER the
 *     chain had already answered.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  lookupPythonSymbolsByShortName,
  PythonGlobalShortNameSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/python/resolver/strategies/index.js";
import { isPythonSourcePath } from "../../../../../../../src/core/domains/language/python/vocabulary/source-extensions.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

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
  callerFile: "server/polar/caller.py",
  callerScope: [],
  imports: [],
  ...over,
});

const strat = new PythonGlobalShortNameSymbolResolutionStrategy(cfg);

describe("isPythonSourcePath", () => {
  it("admits `.py` and rejects every other CODEGRAPH_LANGUAGES extension", () => {
    expect(isPythonSourcePath("server/polar/models/organization.py")).toBe(true);
    expect(isPythonSourcePath("clients/packages/ui/src/components/atoms/Paginator.tsx")).toBe(false);
    expect(isPythonSourcePath("clients/lib.ts")).toBe(false);
    expect(isPythonSourcePath("vendor/thing.rb")).toBe(false);
    expect(isPythonSourcePath("static/app.js")).toBe(false);
  });
});

describe("lookupPythonSymbolsByShortName — same-language candidates only", () => {
  it("drops a `.tsx` namesake and keeps the `.py` one (polar `range` → Paginator.tsx)", () => {
    const tsx = "clients/packages/ui/src/components/atoms/Paginator.tsx";
    const py = "server/polar/kit/pagination.py";
    const symbolTable = tableWith([tsx, [sym("range", "range", tsx, [])]], [py, [sym("paginate", "paginate", py, [])]]);
    expect(lookupPythonSymbolsByShortName(ctx({ symbolTable }), "range")).toEqual([]);
    expect(lookupPythonSymbolsByShortName(ctx({ symbolTable }), "paginate").map((d) => d.relPath)).toEqual([
      "server/polar/kit/pagination.py",
    ]);
  });
});

describe("PythonGlobalShortNameSymbolResolutionStrategy — cross-language candidates (w205u)", () => {
  const call: CallRef = { callText: "render_row(x)", receiver: null, member: "render_row", startLine: 1 };

  it("ignores a `.tsx` definition that is the only candidate — CONTINUE, not a phantom", () => {
    const symbolTable = tableWith([
      "clients/packages/ui/src/components/atoms/Paginator.tsx",
      [sym("render_row", "render_row", "clients/packages/ui/src/components/atoms/Paginator.tsx", [])],
    ]);
    expect(strat.attempt(call, ctx({ symbolTable })).kind).toBe("continue");
  });

  it("still resolves when the `.tsx` namesake is the only thing making the name ambiguous", () => {
    const symbolTable = tableWith(
      ["clients/ui/Paginator.tsx", [sym("render_row", "render_row", "clients/ui/Paginator.tsx", [])]],
      ["server/polar/render.py", [sym("render_row", "render_row", "server/polar/render.py", [])]],
    );
    expect(strat.attempt(call, ctx({ symbolTable }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "server/polar/render.py", targetSymbolId: "render_row" },
    });
  });
});

describe("PythonGlobalShortNameSymbolResolutionStrategy — bare calls reach module scope only (w205u)", () => {
  it("never attributes a bare call to an INSTANCE method in another file (netbox `field_class`)", () => {
    const call: CallRef = { callText: "field_class()", receiver: null, member: "field_class", startLine: 1 };
    const symbolTable = tableWith([
      "netbox/utilities/jsonschema.py",
      [sym("JSONSchemaProperty#field_class", "field_class", "netbox/utilities/jsonschema.py", ["JSONSchemaProperty"])],
    ]);
    expect(strat.attempt(call, ctx({ symbolTable, callerFile: "netbox/forms/base.py" })).kind).toBe("continue");
  });

  it("never attributes a bare call to a NESTED function in another file (flask `view`)", () => {
    const call: CallRef = { callText: "view(**kwargs)", receiver: null, member: "view", startLine: 1 };
    const symbolTable = tableWith([
      "src/flask/views.py",
      [sym("View.as_view#view", "view", "src/flask/views.py", ["View", "as_view"])],
    ]);
    expect(strat.attempt(call, ctx({ symbolTable, callerFile: "src/flask/app.py" })).kind).toBe("continue");
  });

  it("rejects the pick rather than narrowing it — an unreachable candidate still counts as ambiguity", () => {
    // Precision-only guarantee. Filtering the set BEFORE `pickSingleCandidate`
    // would let `Cls#helper` stop counting and promote `api/schemas.py#helper`
    // to a NEW cross-file edge; the strategy declines instead, exactly as it
    // did before the guard (`strategies.test.ts`, same-file module scope).
    const call: CallRef = { callText: "helper()", receiver: null, member: "helper", startLine: 1 };
    const symbolTable = tableWith(
      ["kit/email.py", [sym("Cls#helper", "helper", "kit/email.py", ["Cls"])]],
      ["api/schemas.py", [sym("helper", "helper", "api/schemas.py", [])]],
    );
    expect(strat.attempt(call, ctx({ symbolTable, callerFile: "kit/email.py" })).kind).toBe("continue");
  });

  it("still resolves a bare call to a module-level def in another file", () => {
    const call: CallRef = { callText: "do_thing()", receiver: null, member: "do_thing", startLine: 1 };
    const symbolTable = tableWith(["helper.py", [sym("do_thing", "do_thing", "helper.py", [])]]);
    expect(strat.attempt(call, ctx({ symbolTable }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "helper.py", targetSymbolId: "do_thing" },
    });
  });

  it("reaches a same-file NESTED def through the enclosing scope (netbox `make_plugin_dict`)", () => {
    // LEGB's `E`. `callerScope` omits the innermost function, so a call in
    // `get_catalog_plugins`' own body carries exactly the nested def's scope.
    const call: CallRef = { callText: "make_plugin_dict(p)", receiver: null, member: "make_plugin_dict", startLine: 9 };
    const file = "netbox/utilities/catalog.py";
    const symbolTable = tableWith([
      file,
      [sym("get_catalog_plugins#make_plugin_dict", "make_plugin_dict", file, ["get_catalog_plugins"])],
    ]);
    expect(strat.attempt(call, ctx({ symbolTable, callerFile: file, callerScope: [] }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: file, targetSymbolId: "get_catalog_plugins#make_plugin_dict" },
    });
  });

  it("reaches a class declared inside a def (polar `Authenticator._AuthenticatorSignature`)", () => {
    const call: CallRef = { callText: "_AuthenticatorSignature()", receiver: null, member: "_AuthenticatorSignature", startLine: 9 }; // prettier-ignore
    const file = "server/polar/auth/dependencies.py";
    const symbolTable = tableWith([
      file,
      [sym("Authenticator._AuthenticatorSignature", "_AuthenticatorSignature", file, ["Authenticator"])],
    ]);
    expect(strat.attempt(call, ctx({ symbolTable, callerFile: file, callerScope: [] }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: file, targetSymbolId: "Authenticator._AuthenticatorSignature" },
    });
  });

  it("stops at ONE segment of slack — a def two containers deeper is not reachable", () => {
    const call: CallRef = { callText: "deep()", receiver: null, member: "deep", startLine: 9 };
    const file = "app.py";
    const symbolTable = tableWith([file, [sym("outer#middle#deep", "deep", file, ["outer", "middle"])]]);
    expect(strat.attempt(call, ctx({ symbolTable, callerFile: file, callerScope: [] })).kind).toBe("continue");
  });

  it("does NOT reach a nested def in a SIBLING container — the scope is not enclosing", () => {
    const call: CallRef = { callText: "helper()", receiver: null, member: "helper", startLine: 9 };
    const file = "app.py";
    const symbolTable = tableWith([file, [sym("other#helper", "helper", file, ["other"])]]);
    expect(strat.attempt(call, ctx({ symbolTable, callerFile: file, callerScope: ["unrelated"] })).kind).toBe(
      "continue",
    );
  });

  it("does NOT reach a same-named nested def in ANOTHER file, however the scopes line up", () => {
    const call: CallRef = { callText: "helper()", receiver: null, member: "helper", startLine: 9 };
    const symbolTable = tableWith(["other.py", [sym("outer#helper", "helper", "other.py", ["outer"])]]);
    expect(strat.attempt(call, ctx({ symbolTable, callerFile: "app.py", callerScope: ["outer"] })).kind).toBe(
      "continue",
    );
  });

  it("leaves the `self` arm's method candidates alone — `self.open()` still resolves", () => {
    const call: CallRef = { callText: "self.open(path)", receiver: "self", member: "open", startLine: 1 };
    const symbolTable = tableWith([
      "src/flask/testing.py",
      [sym("FlaskClient#open", "open", "src/flask/testing.py", ["FlaskClient"])],
    ]);
    expect(strat.attempt(call, ctx({ symbolTable, callerFile: "src/flask/testing.py" }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/flask/testing.py", targetSymbolId: "FlaskClient#open" },
    });
  });
});

describe("PythonGlobalShortNameSymbolResolutionStrategy — builtins guard (w205u)", () => {
  const call: CallRef = { callText: "open(path, mode)", receiver: null, member: "open", startLine: 1 };

  it("DROPS a bare builtin with no same-file module-level def (flask `open` → FlaskClient#open)", () => {
    const symbolTable = tableWith([
      "src/flask/testing.py",
      [sym("FlaskClient#open", "open", "src/flask/testing.py", ["FlaskClient"])],
    ]);
    expect(strat.attempt(call, ctx({ symbolTable, callerFile: "src/flask/cli.py" })).kind).toBe("drop");
  });

  it("DROPS a bare builtin even when a module-level def in ANOTHER file spells it", () => {
    const symbolTable = tableWith(["src/flask/helpers.py", [sym("open", "open", "src/flask/helpers.py", [])]]);
    expect(strat.attempt(call, ctx({ symbolTable, callerFile: "src/flask/cli.py" })).kind).toBe("drop");
  });

  it("resolves a builtin SHADOWED by a module-level def in the caller's own file (RF.8 wins)", () => {
    const symbolTable = tableWith(["src/flask/cli.py", [sym("open", "open", "src/flask/cli.py", [])]]);
    expect(strat.attempt(call, ctx({ symbolTable, callerFile: "src/flask/cli.py" }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/flask/cli.py", targetSymbolId: "open" },
    });
  });

  it("leaves `self.<builtin>()` to the `self` arm — the guard is bare-arm only", () => {
    const selfCall: CallRef = { callText: "self.type()", receiver: "self", member: "type", startLine: 1 };
    const symbolTable = tableWith([
      "server/polar/models/customer.py",
      [sym("Customer#type", "type", "server/polar/models/customer.py", ["Customer"])],
    ]);
    expect(strat.attempt(selfCall, ctx({ symbolTable, callerFile: "server/polar/models/customer.py" }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "server/polar/models/customer.py", targetSymbolId: "Customer#type" },
    });
  });
});
