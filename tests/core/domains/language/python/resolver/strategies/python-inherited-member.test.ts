/**
 * Inherited-member resolution for Python (E2 seam 4, bd tea-rags-mcp-9fgdi /
 * tea-rags-mcp-84db2).
 *
 * `self.m()` and `Cls.m()` used to stop at the class the resolver could see —
 * `selfMember` walked the single-base `classExtends` chain and `importedName`
 * looked at the bound class only. Both now walk the MRO the walker's
 * `classAncestors` channel describes, and the three-way verdict (resolved /
 * DROP / CONTINUE) is decided by how completely that hierarchy could be READ:
 * a fully-read hierarchy that does not own the member is evidence of absence,
 * a branch that left the project is not.
 *
 * The fixtures are the measured shapes: netbox's
 * `ProviderView(GetRelatedModelsMixin, generic.ObjectView)` (mixin in project,
 * second base external) and polar's `RepositoryBase.from_session` (a
 * `@classmethod`, so the `.` spelling).
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, ImportRef } from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonAncestorLinearizerCache } from "../../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonImportedNameSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-imported-name.js";
import { PythonSelfMemberSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-self-member.js";
import { PythonSuperSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-super.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

type Def = string | { readonly symbolId: string; readonly scope: readonly string[] };

function tableWith(files: Record<string, readonly Def[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      defs.map((def) => {
        const { symbolId, scope } = typeof def === "string" ? { symbolId: def, scope: [] as string[] } : def;
        return {
          symbolId,
          fqName: symbolId,
          shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
          relPath,
          scope: [...scope],
        };
      }),
    );
  }
  return table;
}

interface CtxSpec {
  readonly callerFile: string;
  readonly callerScope?: readonly string[];
  readonly imports?: readonly ImportRef[];
  readonly classAncestors?: Record<string, readonly string[]>;
  readonly classExtends?: Record<string, string>;
  readonly table: InMemoryGlobalSymbolTable;
}

function ctxWith(spec: CtxSpec): CallContext {
  return {
    callerFile: spec.callerFile,
    callerScope: [...(spec.callerScope ?? [])],
    imports: [...(spec.imports ?? [])],
    symbolTable: spec.table,
    ...(spec.classAncestors === undefined ? {} : { classAncestors: spec.classAncestors }),
    ...(spec.classExtends === undefined ? {} : { classExtends: spec.classExtends }),
  };
}

function selfMember(): PythonSelfMemberSymbolResolutionStrategy {
  return new PythonSelfMemberSymbolResolutionStrategy(
    { mode: "strict" },
    new PythonAncestorLinearizerCache(new PythonImportFileMapper(), "strict"),
  );
}

const selfCall = (member: string): CallRef => ({
  callText: `self.${member}()`,
  receiver: "self",
  member,
  startLine: 12,
});

describe("PythonSelfMemberSymbolResolutionStrategy — the MRO, not the first base", () => {
  it("resolves a member declared on a DIRECT project base to the base's symbol", () => {
    const table = tableWith({ "app/base.py": ["Base", "Base#m"], "app/child.py": ["Child"] });
    const ctx = ctxWith({
      callerFile: "app/child.py",
      callerScope: ["Child"],
      table,
      classAncestors: { "app/child.py::Child": ["app.base::Base"] },
    });
    expect(selfMember().attempt(selfCall("m"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.py", targetSymbolId: "Base#m" },
    });
  });

  it("resolves a member two hops up the chain", () => {
    const table = tableWith({
      "app/base.py": ["Base", "Base#m"],
      "app/mid.py": ["Mid"],
      "app/child.py": ["Child"],
    });
    const ctx = ctxWith({
      callerFile: "app/child.py",
      callerScope: ["Child"],
      table,
      classAncestors: {
        "app/child.py::Child": ["app.mid::Mid"],
        "app/mid.py::Mid": ["app.base::Base"],
      },
    });
    expect(selfMember().attempt(selfCall("m"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.py", targetSymbolId: "Base#m" },
    });
  });

  it("finds the mixin even when a LATER base is external (netbox ProviderView)", () => {
    const table = tableWith({
      "netbox/utilities/views.py": ["GetRelatedModelsMixin", "GetRelatedModelsMixin#get_related_models"],
      "netbox/circuits/views.py": ["ProviderView"],
    });
    const ctx = ctxWith({
      callerFile: "netbox/circuits/views.py",
      callerScope: ["ProviderView"],
      table,
      classAncestors: {
        "netbox/circuits/views.py::ProviderView": [
          "netbox.utilities.views::GetRelatedModelsMixin",
          "django.views.generic::ObjectView",
        ],
      },
    });
    expect(selfMember().attempt(selfCall("get_related_models"), ctx)).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "netbox/utilities/views.py",
        targetSymbolId: "GetRelatedModelsMixin#get_related_models",
      },
    });
  });

  it("DROPs — never CONTINUEs — when the only base is EXTERNAL", () => {
    const table = tableWith({ "netbox/dcim/models.py": ["Device"], "other/app.py": ["Helper", "Helper#save"] });
    const ctx = ctxWith({
      callerFile: "netbox/dcim/models.py",
      callerScope: ["Device"],
      table,
      classAncestors: { "netbox/dcim/models.py::Device": ["django.db.models::Model"] },
    });
    // The 540 netbox `agreeExternal` rows: jedi puts `self.save()` in
    // site-packages, and a fabricated project target would be a phantom.
    expect(selfMember().attempt(selfCall("save"), ctx)).toEqual({ kind: "drop" });
  });

  it("CONTINUEs when a base could not be bound at all (unknown boundary)", () => {
    const table = tableWith({ "app/child.py": ["Child"] });
    const ctx = ctxWith({
      callerFile: "app/child.py",
      callerScope: ["Child"],
      table,
      // A star-imported base: the walker recorded a bare spelling and no file
      // in the project declares it. Not evidence the member is absent.
      classAncestors: { "app/child.py::Child": ["Mystery"] },
    });
    expect(selfMember().attempt(selfCall("m"), ctx)).toEqual({ kind: "continue" });
  });

  it("DROPs on a class with NO bases that does not define the member", () => {
    const table = tableWith({ "app/child.py": ["Child", "Child#other"], "elsewhere/x.py": ["Thing", "Thing#m"] });
    const ctx = ctxWith({ callerFile: "app/child.py", callerScope: ["Child"], table, classAncestors: {} });
    expect(selfMember().attempt(selfCall("m"), ctx)).toEqual({ kind: "drop" });
  });

  it("resolves a @classmethod through the `.` spelling (polar RepositoryBase)", () => {
    const table = tableWith({
      "server/polar/kit/repository/base.py": ["RepositoryBase", "RepositoryBase.from_session"],
      "server/polar/account/repository.py": ["AccountRepository"],
    });
    const ctx = ctxWith({
      callerFile: "server/polar/account/repository.py",
      callerScope: ["AccountRepository"],
      table,
      classAncestors: {
        "server/polar/account/repository.py::AccountRepository": ["server.polar.kit.repository.base::RepositoryBase"],
      },
    });
    expect(selfMember().attempt(selfCall("from_session"), ctx)).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "server/polar/kit/repository/base.py",
        targetSymbolId: "RepositoryBase.from_session",
      },
    });
  });

  it("keys a NESTED class by its dotted FQ, which the bare-name walk missed", () => {
    const table = tableWith({
      "app/views.py": [
        "Outer",
        { symbolId: "Outer.Inner", scope: ["Outer"] },
        { symbolId: "Outer.Inner#m", scope: ["Outer", "Inner"] },
      ],
      "app/child.py": ["Child"],
    });
    const ctx = ctxWith({
      callerFile: "app/child.py",
      callerScope: ["Child"],
      table,
      classAncestors: { "app/child.py::Child": ["app.views::Inner"] },
    });
    expect(selfMember().attempt(selfCall("m"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/views.py", targetSymbolId: "Outer.Inner#m" },
    });
  });

  it("resolves the caller's OWN nested class before any ancestor", () => {
    const table = tableWith({
      "app/views.py": [
        "Outer",
        { symbolId: "Outer.Inner", scope: ["Outer"] },
        { symbolId: "Outer.Inner#m", scope: ["Outer", "Inner"] },
      ],
    });
    const ctx = ctxWith({
      callerFile: "app/views.py",
      callerScope: ["Outer", "Inner"],
      table,
      classAncestors: {},
    });
    expect(selfMember().attempt(selfCall("m"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/views.py", targetSymbolId: "Outer.Inner#m" },
    });
  });

  it("keeps the pre-seam single-base walk when the index carries no classAncestors", () => {
    const table = tableWith({ "app/base.py": ["Base", "Base#m"], "app/child.py": ["Child"] });
    const ctx = ctxWith({
      callerFile: "app/child.py",
      callerScope: ["Child"],
      table,
      classExtends: { Child: "Base" },
    });
    expect(selfMember().attempt(selfCall("m"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.py", targetSymbolId: "Base#m" },
    });
  });
});

describe("PythonImportedNameSymbolResolutionStrategy — class receiver on the MRO", () => {
  function importedName(): PythonImportedNameSymbolResolutionStrategy {
    const mapper = new PythonImportFileMapper();
    return new PythonImportedNameSymbolResolutionStrategy(
      { mode: "strict" },
      mapper,
      new PythonAncestorLinearizerCache(mapper, "strict"),
    );
  }

  it("resolves `Cls.m()` to the BASE that declares the classmethod", () => {
    const table = tableWith({
      "server/polar/kit/repository/base.py": ["RepositoryBase", "RepositoryBase.from_session"],
      "server/polar/account/repository.py": ["AccountRepository"],
      "server/polar/account/service.py": ["AccountService"],
    });
    const ctx = ctxWith({
      callerFile: "server/polar/account/service.py",
      table,
      imports: [
        {
          importText: "server.polar.account.repository",
          startLine: 1,
          importedNames: ["AccountRepository"],
          importedBindings: { AccountRepository: "AccountRepository" },
        },
      ],
      classAncestors: {
        "server/polar/account/repository.py::AccountRepository": ["server.polar.kit.repository.base::RepositoryBase"],
      },
    });
    const call: CallRef = {
      callText: "AccountRepository.from_session(session)",
      receiver: "AccountRepository",
      member: "from_session",
      startLine: 20,
    };
    expect(importedName().attempt(call, ctx)).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "server/polar/kit/repository/base.py",
        targetSymbolId: "RepositoryBase.from_session",
      },
    });
  });

  it("CONTINUEs when the bound class's hierarchy could not be read", () => {
    const table = tableWith({ "app/models.py": ["Widget"], "app/views.py": ["View"] });
    const ctx = ctxWith({
      callerFile: "app/views.py",
      table,
      imports: [
        { importText: "app.models", startLine: 1, importedNames: ["Widget"], importedBindings: { Widget: "Widget" } },
      ],
      classAncestors: { "app/models.py::Widget": ["Mystery"] },
    });
    const call: CallRef = { callText: "Widget.build()", receiver: "Widget", member: "build", startLine: 9 };
    expect(importedName().attempt(call, ctx)).toEqual({ kind: "continue" });
  });
});

/**
 * `super()` on the MRO (bd tea-rags-mcp-ntnke / tea-rags-mcp-wz956).
 *
 * `super()` means "dispatch from the position AFTER my class in the MRO", which
 * the old single-parent `classExtends[enclosing]` hop cannot express: under
 * `class C(A, B)` it saw only `A`, so a member declared on `B` was invisible.
 * `startAfter: true` is exactly that semantics.
 *
 * `super` stays the one terminal GUARD pass (bd tea-rags-mcp-pic4 /
 * tea-rags-mcp-4rgg): a miss DROPs and never falls through to the ambiguous
 * short-name path, whatever the closure says. That is where `super` parts
 * company with `selfMember`, which CONTINUEs on an `unknown` boundary.
 */
describe("PythonSuperSymbolResolutionStrategy — the MRO after the enclosing class", () => {
  function superStrategy(): PythonSuperSymbolResolutionStrategy {
    const mapper = new PythonImportFileMapper();
    return new PythonSuperSymbolResolutionStrategy(
      { mode: "strict" },
      new PythonAncestorLinearizerCache(mapper, "strict"),
    );
  }

  const superCall = (member: string, receiver = "super"): CallRef => ({
    callText: `${receiver}.${member}()`,
    receiver,
    member,
    startLine: 7,
  });

  it("resolves through the SECOND base when only it defines the member", () => {
    // `class C(A, B)` with `m` on `B` only — the case the classExtends hop could
    // not see, and the one jedi 0.20.0 itself gets wrong (its answer is
    // withdrawn by `applySuperMroBlindSpot`, so the row scores `unknown`).
    const table = tableWith({
      "app/a.py": ["A"],
      "app/b.py": ["B", "B#m"],
      "app/c.py": ["C", "C#caller"],
    });
    const ctx = ctxWith({
      callerFile: "app/c.py",
      callerScope: ["C"],
      table,
      classAncestors: { "app/c.py::C": ["app.a::A", "app.b::B"] },
    });
    expect(superStrategy().attempt(superCall("m"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/b.py", targetSymbolId: "B#m" },
    });
  });

  it("skips the caller's OWN class even when it also defines the member", () => {
    const table = tableWith({ "app/base.py": ["Base", "Base#m"], "app/c.py": ["C", "C#m"] });
    const ctx = ctxWith({
      callerFile: "app/c.py",
      callerScope: ["C"],
      table,
      classAncestors: { "app/c.py::C": ["app.base::Base"] },
    });
    expect(superStrategy().attempt(superCall("m"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.py", targetSymbolId: "Base#m" },
    });
  });

  it("still accepts the pre-normalization `super()` receiver text", () => {
    // An index written before bd ntnke carries the verbatim spelling.
    const table = tableWith({ "app/base.py": ["Base", "Base#m"], "app/c.py": ["C"] });
    const ctx = ctxWith({
      callerFile: "app/c.py",
      callerScope: ["C"],
      table,
      classAncestors: { "app/c.py::C": ["app.base::Base"] },
    });
    expect(superStrategy().attempt(superCall("m", "super()"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.py", targetSymbolId: "Base#m" },
    });
  });

  it("resolves a @classmethod ancestor through the `.` spelling", () => {
    const table = tableWith({ "app/base.py": ["Base", "Base.build"], "app/c.py": ["C"] });
    const ctx = ctxWith({
      callerFile: "app/c.py",
      callerScope: ["C"],
      table,
      classAncestors: { "app/c.py::C": ["app.base::Base"] },
    });
    expect(superStrategy().attempt(superCall("build"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.py", targetSymbolId: "Base.build" },
    });
  });

  it("DROPs when no project ancestor defines the member — closed hierarchy", () => {
    const table = tableWith({ "app/base.py": ["Base"], "app/c.py": ["C"], "other/x.py": ["Thing", "Thing#m"] });
    const ctx = ctxWith({
      callerFile: "app/c.py",
      callerScope: ["C"],
      table,
      classAncestors: { "app/c.py::C": ["app.base::Base"] },
    });
    expect(superStrategy().attempt(superCall("m"), ctx)).toEqual({ kind: "drop" });
  });

  it("DROPs — never CONTINUEs — on an EXTERNAL boundary", () => {
    const table = tableWith({ "app/models.py": ["Device"], "other/x.py": ["Helper", "Helper#save"] });
    const ctx = ctxWith({
      callerFile: "app/models.py",
      callerScope: ["Device"],
      table,
      classAncestors: { "app/models.py::Device": ["django.db.models::Model"] },
    });
    expect(superStrategy().attempt(superCall("save"), ctx)).toEqual({ kind: "drop" });
  });

  it("DROPs — never CONTINUEs — on an UNKNOWN boundary, unlike selfMember", () => {
    const table = tableWith({ "app/c.py": ["C"], "other/x.py": ["Thing", "Thing#m"] });
    const ctx = ctxWith({
      callerFile: "app/c.py",
      callerScope: ["C"],
      table,
      classAncestors: { "app/c.py::C": ["Mystery"] },
    });
    expect(superStrategy().attempt(superCall("m"), ctx)).toEqual({ kind: "drop" });
  });

  it("DROPs when the enclosing class declares no ancestors at all", () => {
    const table = tableWith({ "app/c.py": ["C"], "other/x.py": ["Thing", "Thing#m"] });
    const ctx = ctxWith({ callerFile: "app/c.py", callerScope: ["C"], table, classAncestors: {} });
    expect(superStrategy().attempt(superCall("m"), ctx)).toEqual({ kind: "drop" });
  });

  it("keys a NESTED caller by its dotted FQ", () => {
    const table = tableWith({
      "app/base.py": ["Base", "Base#m"],
      "app/c.py": ["Outer", { symbolId: "Outer.Inner", scope: ["Outer"] }],
    });
    const ctx = ctxWith({
      callerFile: "app/c.py",
      callerScope: ["Outer", "Inner"],
      table,
      classAncestors: { "app/c.py::Outer.Inner": ["app.base::Base"] },
    });
    expect(superStrategy().attempt(superCall("m"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.py", targetSymbolId: "Base#m" },
    });
  });

  it("CONTINUEs when the receiver is not a super form at all", () => {
    const table = tableWith({ "app/c.py": ["C"] });
    const ctx = ctxWith({ callerFile: "app/c.py", callerScope: ["C"], table, classAncestors: {} });
    expect(superStrategy().attempt(superCall("m", "self"), ctx)).toEqual({ kind: "continue" });
  });

  it("keeps the pre-seam classExtends walk when the index carries no classAncestors", () => {
    const table = tableWith({ "app/base.py": ["Base", "Base#m"], "app/c.py": ["C"] });
    const ctx = ctxWith({ callerFile: "app/c.py", callerScope: ["C"], table, classExtends: { C: "Base" } });
    expect(superStrategy().attempt(superCall("m"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.py", targetSymbolId: "Base#m" },
    });
  });
});

/**
 * The explicit two-argument `super(Cls, self)`. The walker leaves its receiver
 * text verbatim, because `Cls` names the class the walk starts AFTER and that
 * is not always the enclosing class. Where it IS the enclosing class the call
 * is semantically identical to `super()` and resolves the same way; where it
 * names anything else this pass declines and the chain carries on.
 */
describe("PythonSuperSymbolResolutionStrategy — the two-argument form", () => {
  function superStrategy(): PythonSuperSymbolResolutionStrategy {
    const mapper = new PythonImportFileMapper();
    return new PythonSuperSymbolResolutionStrategy(
      { mode: "strict" },
      new PythonAncestorLinearizerCache(mapper, "strict"),
    );
  }

  const twoArg = (cls: string, member: string): CallRef => ({
    callText: `super(${cls}, self).${member}()`,
    receiver: `super(${cls}, self)`,
    member,
    startLine: 7,
  });

  const table = () => tableWith({ "app/base.py": ["Base", "Base#m"], "app/c.py": ["C", "C#m"] });

  const ctxFor = (t: InMemoryGlobalSymbolTable): CallContext =>
    ctxWith({
      callerFile: "app/c.py",
      callerScope: ["C"],
      table: t,
      classAncestors: { "app/c.py::C": ["app.base::Base"] },
    });

  it("resolves like `super()` when the named class IS the enclosing class", () => {
    expect(superStrategy().attempt(twoArg("C", "m"), ctxFor(table()))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.py", targetSymbolId: "Base#m" },
    });
  });

  it("CONTINUEs when the named class is NOT the enclosing class", () => {
    // `super(Base, self)` starts after `Base`, not after `C`. This pass has no
    // answer for it, so it declines rather than guessing the enclosing class's.
    expect(superStrategy().attempt(twoArg("Base", "m"), ctxFor(table()))).toEqual({ kind: "continue" });
  });

  it("accepts the dotted FQ of a nested enclosing class", () => {
    const t = tableWith({
      "app/base.py": ["Base", "Base#m"],
      "app/c.py": ["Outer", { symbolId: "Outer.Inner", scope: ["Outer"] }],
    });
    const ctx = ctxWith({
      callerFile: "app/c.py",
      callerScope: ["Outer", "Inner"],
      table: t,
      classAncestors: { "app/c.py::Outer.Inner": ["app.base::Base"] },
    });
    expect(superStrategy().attempt(twoArg("Outer.Inner", "m"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.py", targetSymbolId: "Base#m" },
    });
  });

  it("CONTINUEs on the two-argument form when the index carries no classAncestors", () => {
    const t = tableWith({ "app/base.py": ["Base", "Base#m"], "app/c.py": ["C"] });
    const ctx = ctxWith({ callerFile: "app/c.py", callerScope: ["C"], table: t, classExtends: { C: "Base" } });
    // The pre-seam walk starts at the single parent, which is the right answer
    // only for `super()`. Declining keeps walker-v2 behaviour byte-identical.
    expect(superStrategy().attempt(twoArg("C", "m"), ctx)).toEqual({ kind: "continue" });
  });
});
