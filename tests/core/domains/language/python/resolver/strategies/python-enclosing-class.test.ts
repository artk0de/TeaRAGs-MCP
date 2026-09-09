/**
 * The enclosing-class key the Python resolver derives from `callerScope` (bd
 * tea-rags-mcp-graiw).
 *
 * `callerScope` is NOT a list of class containers. `collectSymbols` pushes every
 * `nameOf`-named node onto it and `pyNameOf` names a `function_definition`, so
 * a call inside a nested `def` carries the enclosing method on the scope, and a
 * class declared inside a `def` carries that `def`. Joining the whole array
 * therefore names a class only when every container happens to be one.
 *
 * Two measured shapes, both from the E0 chain tally:
 *   - polar `server/polar/auth/dependencies.py:207` — `super().__call__()` in
 *     `class _AuthenticatorSignature(_Authenticator)`, declared inside
 *     `def Authenticator()`. The class FQ is
 *     `Authenticator._AuthenticatorSignature`.
 *   - flask, 10 sites — a call inside `App#template_filter#decorator`, whose
 *     scope is `["App", "template_filter"]`. The enclosing class is `App`.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonAncestorLinearizerCache } from "../../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import {
  pythonEnclosingClass,
  PythonSelfFieldSymbolResolutionStrategy,
  PythonSelfMemberSymbolResolutionStrategy,
  PythonSuperSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/python/resolver/strategies/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

/** A symbol table def whose `scope` + `shortName` spell `symbolId`, as the walk does. */
const sym = (symbolId: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath: "",
  scope,
});

const tableWith = (files: Record<string, NamedSymbol[]>): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      defs.map((def) => ({ ...def, relPath })),
    );
  }
  return table;
};

const ctx = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext => ({
  callerFile: "app.py",
  callerScope: [],
  imports: [],
  ...over,
});

const linearizers = (): PythonAncestorLinearizerCache =>
  new PythonAncestorLinearizerCache(new PythonImportFileMapper(), DEFAULT_AMBIGUOUS_RESOLVE_MODE);

describe("pythonEnclosingClass — the longest scope prefix that names a class", () => {
  it("keeps a function container in the FQ when the class is declared inside a def (polar)", () => {
    const symbolTable = tableWith({
      "deps.py": [
        sym("Authenticator", []),
        sym("Authenticator._AuthenticatorSignature", ["Authenticator"]),
        sym("Authenticator._AuthenticatorSignature#__call__", ["Authenticator", "_AuthenticatorSignature"]),
      ],
    });
    expect(
      pythonEnclosingClass(
        ctx({ symbolTable, callerFile: "deps.py", callerScope: ["Authenticator", "_AuthenticatorSignature"] }),
      ),
    ).toEqual({
      key: "deps.py::Authenticator._AuthenticatorSignature",
      classFq: "Authenticator._AuthenticatorSignature",
      name: "_AuthenticatorSignature",
    });
  });

  it("drops a trailing method container when the call sits in a NESTED def (flask)", () => {
    const symbolTable = tableWith({
      "app.py": [sym("App", []), sym("App#template_filter", ["App"])],
    });
    expect(pythonEnclosingClass(ctx({ symbolTable, callerScope: ["App", "template_filter"] }))).toEqual({
      key: "app.py::App",
      classFq: "App",
      name: "App",
    });
  });

  it("stops at the INNER class of a nested pair even when it declares no base", () => {
    const symbolTable = tableWith({
      "app.py": [sym("Outer", []), sym("Outer.Inner", ["Outer"])],
    });
    expect(
      pythonEnclosingClass(
        ctx({ symbolTable, callerScope: ["Outer", "Inner"], classAncestors: { "app.py::Outer": ["Base"] } }),
      )?.classFq,
    ).toBe("Outer.Inner");
  });

  it("answers from `classAncestors` when the symbol table has no entry for the class", () => {
    const symbolTable = tableWith({ "app.py": [] });
    expect(
      pythonEnclosingClass(
        ctx({
          symbolTable,
          callerScope: ["Authenticator", "_AuthenticatorSignature"],
          classAncestors: { "app.py::Authenticator._AuthenticatorSignature": ["_Authenticator"] },
        }),
      )?.key,
    ).toBe("app.py::Authenticator._AuthenticatorSignature");
  });

  it("is null with an empty scope, and falls back to the whole scope when no prefix is confirmed", () => {
    const symbolTable = tableWith({ "app.py": [] });
    expect(pythonEnclosingClass(ctx({ symbolTable }))).toBeNull();
    expect(pythonEnclosingClass(ctx({ symbolTable, callerScope: ["Handler"] }))?.classFq).toBe("Handler");
  });
});

describe("selfMember / super / selfField through the enclosing-class key", () => {
  const selfCall = (member: string): CallRef => ({
    callText: `self.${member}()`,
    receiver: "self",
    member,
    startLine: 12,
  });

  it("resolves a self-call made from a NESTED def against the enclosing class's MRO (flask)", () => {
    const symbolTable = tableWith({
      "app.py": [sym("App", []), sym("App#template_filter", ["App"])],
      "scaffold.py": [sym("Scaffold", []), sym("Scaffold#add_url_rule", ["Scaffold"])],
    });
    const outcome = new PythonSelfMemberSymbolResolutionStrategy(cfg, linearizers()).attempt(
      selfCall("add_url_rule"),
      ctx({
        symbolTable,
        callerScope: ["App", "template_filter"],
        classAncestors: { "app.py::App": ["scaffold::Scaffold"] },
        imports: [{ importText: "scaffold", importedNames: ["Scaffold"], importedBindings: { Scaffold: "Scaffold" } }],
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "scaffold.py", targetSymbolId: "Scaffold#add_url_rule" },
    });
  });

  it("resolves `super().__call__()` from a class declared inside a def (polar)", () => {
    const symbolTable = tableWith({
      "deps.py": [
        sym("Authenticator", []),
        sym("Authenticator._AuthenticatorSignature", ["Authenticator"]),
        sym("Authenticator._AuthenticatorSignature#__call__", ["Authenticator", "_AuthenticatorSignature"]),
      ],
      "base.py": [sym("_Authenticator", []), sym("_Authenticator#__call__", ["_Authenticator"])],
    });
    const outcome = new PythonSuperSymbolResolutionStrategy(cfg, linearizers()).attempt(
      { callText: "super().__call__(auth_subject)", receiver: "super()", member: "__call__", startLine: 207 },
      ctx({
        symbolTable,
        callerFile: "deps.py",
        callerScope: ["Authenticator", "_AuthenticatorSignature"],
        classAncestors: { "deps.py::Authenticator._AuthenticatorSignature": ["base::_Authenticator"] },
        imports: [
          { importText: "base", importedNames: ["_Authenticator"], importedBindings: { _Authenticator: "base" } },
        ],
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "base.py", targetSymbolId: "_Authenticator#__call__" },
    });
  });

  it("reads `self.<field>` from a nested def against the enclosing class's field types", () => {
    const symbolTable = tableWith({
      "app.py": [sym("App", []), sym("App#template_filter", ["App"])],
      "service.py": [sym("SomeService#process", ["SomeService"])],
    });
    const outcome = new PythonSelfFieldSymbolResolutionStrategy(cfg).attempt(
      { callText: "self.service.process()", receiver: "self.service", member: "process", startLine: 3 },
      ctx({
        symbolTable,
        callerScope: ["App", "template_filter"],
        classFieldTypes: { App: { service: "SomeService" } },
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "service.py", targetSymbolId: "SomeService#process" },
    });
  });

  it("CONTINUEs rather than DROPs when the enclosing key names no class the run declares", () => {
    // The closure must read `unknown`, not `closed`: an absent `classAncestors`
    // entry for a key nothing declares is an absence of evidence, and `closed`
    // would let `selfMember` claim the member is not on the hierarchy.
    const symbolTable = tableWith({ "app.py": [], "other.py": [sym("Other#run", ["Other"])] });
    const outcome = new PythonSelfMemberSymbolResolutionStrategy(cfg, linearizers()).attempt(
      selfCall("run"),
      ctx({ symbolTable, callerScope: ["Ghost"], classAncestors: { "other.py::Other": ["Base"] } }),
    );
    expect(outcome.kind).toBe("continue");
  });
});
