/**
 * P6 undecidable — K11 (bd tea-rags-mcp-m99j1.1.24, Task 22).
 *
 * A call on a TYPED receiver whose member is absent from a fully in-project
 * (closed) MRO, where some class on that MRO answers attribute lookup itself
 * (`__getattr__` / `__getattribute__`), has no static target: the attribute is
 * computed at run time. `targetsUndecidable` says so, and the miss classifier
 * moves the site to `unresolvable`. Precision runs in reverse here — a wrong
 * `true` hides a real miss — so every other shape must answer `false`.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const PROXY = "pkg/proxy.py";
const OTHER = "pkg/other.py";

function tableWith(files: Record<string, readonly string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, ids] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      ids.map((symbolId) => {
        const parts = symbolId.split(/[#.]/);
        return { symbolId, fqName: symbolId, shortName: parts[parts.length - 1], relPath, scope: parts.slice(0, -1) };
      }),
    );
  }
  return table;
}

/**
 * `Proxy` answers attribute lookup through `__getattr__`; `Strict` through
 * `__getattribute__`; `Child(Proxy)` inherits the hook; `Plain` has none;
 * `Remote(requests.Session)` has the hook but an MRO that leaves the project.
 * `Other#missing` keeps the member declared in-project, which is the residual
 * bucket the classification carves.
 */
function ctx(callerScope: readonly string[], extra: Partial<CallContext> = {}): CallContext {
  return {
    callerFile: PROXY,
    callerScope: [...callerScope],
    imports: [{ importText: "import requests", startLine: 1 }],
    symbolTable: tableWith({
      [PROXY]: [
        "Proxy",
        "Proxy#__getattr__",
        "Proxy#present",
        "Proxy#run",
        "Strict",
        "Strict#__getattribute__",
        "Strict#run",
        "Child",
        "Child#run",
        "Plain",
        "Plain#run",
        "Remote",
        "Remote#__getattr__",
        "Remote#run",
      ],
      [OTHER]: ["Other", "Other#missing", "Other#present"],
    }),
    classAncestors: {
      [`${PROXY}::Child`]: ["Proxy"],
      [`${PROXY}::Remote`]: ["requests.Session"],
    },
    classExtends: { Child: "Proxy", Remote: "requests.Session" },
    ...extra,
  };
}

function call(receiver: string | null, member: string, line = 10): CallRef {
  return { callText: `${receiver ?? ""}.${member}()`, receiver, member, startLine: line };
}

describe("PythonCallResolver#targetsUndecidable (P6, K11)", () => {
  const resolver = new PythonCallResolver();

  it("answers true for a member absent on the MRO of a class defining __getattr__", () => {
    expect(resolver.targetsUndecidable(call("self", "missing"), ctx(["Proxy", "run"]))).toBe(true);
  });

  it("answers true for a class defining __getattribute__", () => {
    expect(resolver.targetsUndecidable(call("self", "missing"), ctx(["Strict", "run"]))).toBe(true);
  });

  it("answers true when the hook is inherited from an in-project base", () => {
    expect(resolver.targetsUndecidable(call("self", "missing"), ctx(["Child", "run"]))).toBe(true);
  });

  it("answers true for a typed local bound to such a class", () => {
    const local = ctx(["Plain", "run"], {
      localBindings: { p: [{ type: "Proxy", line: 5, valueKind: "instance" }] },
    });
    expect(resolver.targetsUndecidable(call("p", "missing"), local)).toBe(true);
  });

  it("leaves a member FOUND on the MRO resolved, and never claims it", () => {
    const site = call("self", "present");
    const callCtx = ctx(["Child", "run"]);
    expect(resolver.resolve(site, callCtx)).toEqual({ targetRelPath: PROXY, targetSymbolId: "Proxy#present" });
    expect(resolver.targetsUndecidable(site, callCtx)).toBe(false);
  });

  it("answers false for a class with no attribute-lookup hook on its MRO", () => {
    expect(resolver.targetsUndecidable(call("self", "missing"), ctx(["Plain", "run"]))).toBe(false);
  });

  it("answers false when the MRO leaves the project — the member may live on the external base", () => {
    expect(resolver.targetsUndecidable(call("self", "missing"), ctx(["Remote", "run"]))).toBe(false);
  });

  it("answers false for an untyped receiver", () => {
    expect(resolver.targetsUndecidable(call("thing", "missing"), ctx(["Proxy", "run"]))).toBe(false);
  });

  it("answers false for a bare call", () => {
    expect(resolver.targetsUndecidable(call(null, "missing"), ctx(["Proxy", "run"]))).toBe(false);
  });

  it("answers false for a CLASS-form receiver: an instance __getattr__ never sees class attribute access", () => {
    expect(resolver.targetsUndecidable(call("Proxy", "missing"), ctx(["Plain", "run"]))).toBe(false);
  });
});
