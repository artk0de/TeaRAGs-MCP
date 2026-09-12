/**
 * `cls.<member>()` — the class-object twin of `selfMember` (bd
 * tea-rags-mcp-w205u, E4.4a).
 *
 * 34 measured rows across netbox (17), polar (16) and ugnest (1) call a member
 * of the enclosing class through `cls` inside a `@classmethod`, and every one
 * of them read `receiverKind: dynamic`, `answeredBy: none`, `verdict: missed`
 * before this pass existed. `CallContext` carries no decorator channel, so the
 * precision gate is the three facts that ARE on it: an enclosing class exists,
 * `cls` is not a name the walker BOUND at this site, and the MRO owns the
 * member.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  CallResultBinding,
  LocalBinding,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonAncestorLinearizerCache } from "../../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonClsMemberSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-cls-member.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function tableWith(files: Record<string, readonly string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      defs.map((symbolId) => ({
        symbolId,
        fqName: symbolId,
        shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
        relPath,
        scope: [],
      })),
    );
  }
  return table;
}

interface CtxSpec {
  readonly callerScope?: readonly string[];
  readonly files?: Record<string, readonly string[]>;
  readonly classAncestors?: Record<string, readonly string[]> | null;
  readonly classExtends?: Record<string, string>;
  readonly localBindings?: Record<string, LocalBinding[]>;
  readonly callResultBindings?: Record<string, CallResultBinding[]>;
}

/** `Widget` in `app/widget.py` inherits `make` from `Base` in `app/base.py`. */
function ctxWith(spec: CtxSpec = {}): CallContext {
  const ancestors =
    spec.classAncestors === null ? undefined : (spec.classAncestors ?? { "app/widget.py::Widget": ["app.base::Base"] });
  return {
    callerFile: "app/widget.py",
    callerScope: [...(spec.callerScope ?? ["Widget"])],
    imports: [],
    symbolTable: tableWith(spec.files ?? { "app/base.py": ["Base", "Base.make"], "app/widget.py": ["Widget"] }),
    ...(ancestors === undefined ? {} : { classAncestors: ancestors }),
    ...(spec.classExtends === undefined ? {} : { classExtends: spec.classExtends }),
    ...(spec.localBindings === undefined ? {} : { localBindings: spec.localBindings }),
    ...(spec.callResultBindings === undefined ? {} : { callResultBindings: spec.callResultBindings }),
  };
}

function clsMember(withLinearizers = true): PythonClsMemberSymbolResolutionStrategy {
  return new PythonClsMemberSymbolResolutionStrategy(
    { mode: "strict" },
    withLinearizers ? new PythonAncestorLinearizerCache(new PythonImportFileMapper(), "strict") : undefined,
  );
}

const clsCall = (member: string): CallRef => ({
  callText: `cls.${member}()`,
  receiver: "cls",
  member,
  startLine: 12,
});

describe("PythonClsMemberSymbolResolutionStrategy — cls is the enclosing class", () => {
  it("resolves a member the enclosing class INHERITS to the ancestor that owns it", () => {
    expect(clsMember().attempt(clsCall("make"), ctxWith())).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.py", targetSymbolId: "Base.make" },
    });
  });

  it("stops at the first owner in the order — the enclosing class wins over its ancestor", () => {
    const ctx = ctxWith({
      files: { "app/base.py": ["Base", "Base.make"], "app/widget.py": ["Widget", "Widget.make"] },
    });
    expect(clsMember().attempt(clsCall("make"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/widget.py", targetSymbolId: "Widget.make" },
    });
  });

  it("ACCEPTS the instance spelling — classFirst reorders the scan, it does not decline", () => {
    const ctx = ctxWith({ files: { "app/base.py": ["Base", "Base#make"], "app/widget.py": ["Widget"] } });
    expect(clsMember().attempt(clsCall("make"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.py", targetSymbolId: "Base#make" },
    });
  });

  it("prefers the CLASS spelling when the owner declares both", () => {
    const ctx = ctxWith({
      files: { "app/base.py": ["Base"], "app/widget.py": ["Widget", "Widget#make", "Widget.make"] },
    });
    expect(clsMember().attempt(clsCall("make"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/widget.py", targetSymbolId: "Widget.make" },
    });
  });

  it("CONTINUEs when the walker bound a value to `cls` here — `for cls in classes:` is not the class", () => {
    const ctx = ctxWith({ localBindings: { cls: [{ line: 10, type: "Base" }] } });
    expect(clsMember().attempt(clsCall("make"), ctx)).toEqual({ kind: "continue" });
  });

  it("CONTINUEs when `cls` holds a call result — the same shadow, the other channel", () => {
    const ctx = ctxWith({ callResultBindings: { cls: [{ line: 10, callee: "pick_class" }] } });
    expect(clsMember().attempt(clsCall("make"), ctx)).toEqual({ kind: "continue" });
  });

  it("CONTINUEs at module level — no enclosing class, so `cls` names nothing here", () => {
    expect(clsMember().attempt(clsCall("make"), ctxWith({ callerScope: [] }))).toEqual({ kind: "continue" });
  });

  it("CONTINUEs — never DROPs — when nothing on the MRO owns the member", () => {
    expect(clsMember().attempt(clsCall("absent"), ctxWith())).toEqual({ kind: "continue" });
  });

  it("leaves a `self` receiver untouched so selfMember still owns it", () => {
    const selfCall: CallRef = { callText: "self.make()", receiver: "self", member: "make", startLine: 12 };
    expect(clsMember().attempt(selfCall, ctxWith())).toEqual({ kind: "continue" });
  });

  it("answers from the single-base classExtends walk on a walker-v2 index, and CONTINUEs on its miss", () => {
    const files = { "app/base.py": ["Base", "Base#make"], "app/widget.py": ["Widget"] };
    const ctx = ctxWith({ files, classAncestors: null, classExtends: { Widget: "Base" } });
    expect(clsMember(false).attempt(clsCall("make"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.py", targetSymbolId: "Base#make" },
    });
    expect(clsMember(false).attempt(clsCall("absent"), ctx)).toEqual({ kind: "continue" });
  });
});
