/**
 * A local bound to the RESULT of a call (E2 seam 5 / R1b, bd tea-rags-mcp-z68v9).
 *
 * `repository = SubscriptionRepository.from_session(session)` types `repository`
 * as whatever `from_session` returns — polar 470 `localVar` rows, netbox 130,
 * httpx 15. The walker cannot type it (the callee is cross-file and the return
 * lives on an ANCESTOR), so it records the callee SPELLING and `localBinding`
 * folds it here, where the whole symbol table is in scope.
 *
 * The fixtures are the measured shape: `RepositoryBase.from_session` annotated
 * `-> Self` on the base, called through a subclass in another file.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  CallResultBinding,
  ImportRef,
  LocalBinding,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../../../src/core/contracts/types/language.js";
import { PythonAncestorLinearizerCache } from "../../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonLocalBindingSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-local-binding.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function tableWith(files: Record<string, readonly string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      defs.map((symbolId) => {
        // `Cls#m` / `Cls.m` is declared INSIDE `Cls`, and the own-class lookup
        // filters candidates by their declaring scope.
        const cut = symbolId.search(/[#.]/);
        return {
          symbolId,
          fqName: symbolId,
          shortName: cut < 0 ? symbolId : symbolId.slice(cut + 1),
          relPath,
          scope: cut < 0 ? [] : [symbolId.slice(0, cut)],
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
  readonly localBindings?: Record<string, LocalBinding[]>;
  readonly callResultBindings?: Record<string, CallResultBinding[]>;
  readonly structuredReturnTypes?: Record<string, TypeRef>;
  readonly classFieldTypes?: Record<string, Record<string, string>>;
  readonly table: InMemoryGlobalSymbolTable;
}

function ctxWith(spec: CtxSpec): CallContext {
  return {
    callerFile: spec.callerFile,
    callerScope: [...(spec.callerScope ?? [])],
    imports: [...(spec.imports ?? [])],
    symbolTable: spec.table,
    ...(spec.classAncestors === undefined ? {} : { classAncestors: spec.classAncestors }),
    ...(spec.localBindings === undefined ? {} : { localBindings: spec.localBindings }),
    ...(spec.callResultBindings === undefined ? {} : { callResultBindings: spec.callResultBindings }),
    ...(spec.structuredReturnTypes === undefined ? {} : { structuredReturnTypes: spec.structuredReturnTypes }),
    ...(spec.classFieldTypes === undefined ? {} : { classFieldTypes: spec.classFieldTypes }),
  };
}

function localBinding(): PythonLocalBindingSymbolResolutionStrategy {
  const mapper = new PythonImportFileMapper();
  return new PythonLocalBindingSymbolResolutionStrategy(
    { mode: "strict" },
    mapper,
    new PythonAncestorLinearizerCache(mapper, "strict"),
  );
}

const callOn = (receiver: string, member: string, startLine: number): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine,
});

/** polar's shape: `from_session` is a `@classmethod` on the base, `-> Self`. */
const POLAR_TABLE = tableWith({
  "repo/base.py": ["RepositoryBase", "RepositoryBase.from_session", "RepositoryBase#update"],
  "repo/sub.py": ["SubscriptionRepository"],
  "svc/use.py": ["run"],
});
const POLAR_ANCESTORS = { "repo/sub.py::SubscriptionRepository": ["repo.base::RepositoryBase"] };
const POLAR_RETURNS: Record<string, TypeRef> = {
  "RepositoryBase.from_session": { form: "instance", name: "RepositoryBase" },
};

describe("PythonLocalBindingSymbolResolutionStrategy — a local bound to a call's result", () => {
  it("binds a local to a classmethod's return type through the MRO", () => {
    const ctx = ctxWith({
      callerFile: "svc/use.py",
      table: POLAR_TABLE,
      classAncestors: POLAR_ANCESTORS,
      structuredReturnTypes: POLAR_RETURNS,
      callResultBindings: { repository: [{ line: 10, callee: "SubscriptionRepository.from_session" }] },
    });
    expect(localBinding().attempt(callOn("repository", "update", 12), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "repo/base.py", targetSymbolId: "RepositoryBase#update" },
    });
  });

  it("prefers a real localBindings entry over a call binding", () => {
    const table = tableWith({
      "repo/base.py": ["RepositoryBase", "RepositoryBase.from_session", "RepositoryBase#update"],
      "repo/sub.py": ["SubscriptionRepository", "SubscriptionRepository#update"],
      "svc/use.py": ["run"],
    });
    const ctx = ctxWith({
      callerFile: "svc/use.py",
      table,
      classAncestors: POLAR_ANCESTORS,
      structuredReturnTypes: POLAR_RETURNS,
      localBindings: { repository: [{ line: 10, type: "SubscriptionRepository" }] },
      callResultBindings: { repository: [{ line: 10, callee: "SubscriptionRepository.from_session" }] },
    });
    expect(localBinding().attempt(callOn("repository", "update", 12), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "repo/sub.py", targetSymbolId: "SubscriptionRepository#update" },
    });
  });

  it("ignores a call binding declared BELOW the call site", () => {
    const ctx = ctxWith({
      callerFile: "svc/use.py",
      table: POLAR_TABLE,
      classAncestors: POLAR_ANCESTORS,
      structuredReturnTypes: POLAR_RETURNS,
      callResultBindings: { repository: [{ line: 30, callee: "SubscriptionRepository.from_session" }] },
    });
    expect(localBinding().attempt(callOn("repository", "update", 12), ctx)).toEqual({ kind: "continue" });
  });

  it("takes the NEAREST call binding above the call site", () => {
    const table = tableWith({
      "repo/base.py": ["RepositoryBase", "RepositoryBase.from_session", "RepositoryBase#update"],
      "repo/sub.py": ["SubscriptionRepository"],
      "repo/other.py": ["OtherRepository", "OtherRepository.build", "OtherRepository#update"],
      "svc/use.py": ["run"],
    });
    const ctx = ctxWith({
      callerFile: "svc/use.py",
      table,
      classAncestors: POLAR_ANCESTORS,
      structuredReturnTypes: {
        ...POLAR_RETURNS,
        "OtherRepository.build": { form: "instance", name: "OtherRepository" },
      },
      callResultBindings: {
        repository: [
          { line: 5, callee: "SubscriptionRepository.from_session" },
          { line: 20, callee: "OtherRepository.build" },
        ],
      },
    });
    expect(localBinding().attempt(callOn("repository", "update", 25), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "repo/other.py", targetSymbolId: "OtherRepository#update" },
    });
  });

  it("CONTINUEs when the callee folds to nothing", () => {
    const ctx = ctxWith({
      callerFile: "svc/use.py",
      table: POLAR_TABLE,
      classAncestors: POLAR_ANCESTORS,
      structuredReturnTypes: POLAR_RETURNS,
      callResultBindings: { repository: [{ line: 10, callee: "opaque.thing" }] },
    });
    expect(localBinding().attempt(callOn("repository", "update", 12), ctx)).toEqual({ kind: "continue" });
  });

  it("DROPs when the folded type is external", () => {
    const table = tableWith({
      "app/net.py": ["Factory", "Factory.build"],
      "svc/use.py": ["run"],
    });
    const ctx = ctxWith({
      callerFile: "svc/use.py",
      table,
      imports: [{ importText: "httpx", startLine: 1 }],
      structuredReturnTypes: { "Factory.build": { form: "instance", name: "Client" } },
      callResultBindings: { client: [{ line: 10, callee: "Factory.build" }] },
    });
    expect(localBinding().attempt(callOn("client", "send", 12), ctx)).toEqual({ kind: "drop" });
  });

  it("does not fold a callee more than one hop", () => {
    const table = tableWith({
      "app/a.py": ["Alpha", "Alpha.make"],
      "app/b.py": ["Beta", "Beta.next", "Beta#run"],
      "app/c.py": ["Gamma", "Gamma#run"],
      "svc/use.py": ["run"],
    });
    const ctx = ctxWith({
      callerFile: "svc/use.py",
      table,
      structuredReturnTypes: {
        // `Alpha.make` yields a Beta; a SECOND hop would then read `Beta.next`
        // and reach Gamma. One hop only, so the receiver stays a Beta.
        "Alpha.make": { form: "instance", name: "Beta" },
        "Beta.next": { form: "instance", name: "Gamma" },
      },
      callResultBindings: { thing: [{ line: 10, callee: "Alpha.make" }] },
    });
    expect(localBinding().attempt(callOn("thing", "run", 12), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/b.py", targetSymbolId: "Beta#run" },
    });
  });

  it("binds a bare callee whose top-level def declares a return type", () => {
    const table = tableWith({
      "app/make.py": ["build_client"],
      "app/client.py": ["Client", "Client#send"],
      "svc/use.py": ["run"],
    });
    const ctx = ctxWith({
      callerFile: "svc/use.py",
      table,
      // Keyed by the declaring FILE since E5.1c (bd tea-rags-mcp-1v12o.1.7);
      // this pinned the bare `build_client` before.
      structuredReturnTypes: { "app/make.py::build_client": { form: "instance", name: "Client" } },
      callResultBindings: { client: [{ line: 10, callee: "build_client" }] },
    });
    expect(localBinding().attempt(callOn("client", "send", 12), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/client.py", targetSymbolId: "Client#send" },
    });
  });

  it("CONTINUEs on a bare callee the symbol table does not pin to one def", () => {
    const table = tableWith({
      "app/one.py": ["build_client"],
      "app/two.py": ["build_client"],
      "app/client.py": ["Client", "Client#send"],
      "svc/use.py": ["run"],
    });
    const ctx = ctxWith({
      callerFile: "svc/use.py",
      table,
      structuredReturnTypes: { "app/one.py::build_client": { form: "instance", name: "Client" } },
      callResultBindings: { client: [{ line: 10, callee: "build_client" }] },
    });
    expect(localBinding().attempt(callOn("client", "send", 12), ctx)).toEqual({ kind: "continue" });
  });

  it("CONTINUEs when a receiver has no call binding at all", () => {
    const ctx = ctxWith({ callerFile: "svc/use.py", table: POLAR_TABLE, callResultBindings: {} });
    expect(localBinding().attempt(callOn("repository", "update", 12), ctx)).toEqual({ kind: "continue" });
  });

  // ugnest's selector shape (bd tea-rags-mcp-1v12o.4): `-> Comment | None` is
  // the ordinary Python spelling for "may be absent", and a call on the value
  // dispatches exactly where a non-nilable one does.
  it("folds a NILABLE return fact to its one reachable arm", () => {
    const table = tableWith({
      "sel/comment.py": ["CommentSelector", "CommentSelector.get_by_id"],
      "models/comment.py": ["Comment", "Comment#save"],
      "svc/approve.py": ["run"],
    });
    const ctx = ctxWith({
      callerFile: "svc/approve.py",
      table,
      structuredReturnTypes: {
        "CommentSelector.get_by_id": {
          form: "union",
          members: [{ form: "instance", name: "Comment" }, { form: "nil" }],
        },
      },
      callResultBindings: { comment: [{ line: 10, callee: "CommentSelector.get_by_id" }] },
    });
    expect(localBinding().attempt(callOn("comment", "save", 12), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "models/comment.py", targetSymbolId: "Comment#save" },
    });
  });

  it("folds a nilable MODULE-LEVEL return fact the same way", () => {
    const table = tableWith({
      "sel/lookup.py": ["find_comment"],
      "models/comment.py": ["Comment", "Comment#save"],
      "svc/approve.py": ["run"],
    });
    const ctx = ctxWith({
      callerFile: "svc/approve.py",
      table,
      structuredReturnTypes: {
        "sel/lookup.py::find_comment": {
          form: "union",
          members: [{ form: "nil" }, { form: "instance", name: "Comment" }],
        },
      },
      callResultBindings: { comment: [{ line: 10, callee: "find_comment" }] },
    });
    expect(localBinding().attempt(callOn("comment", "save", 12), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "models/comment.py", targetSymbolId: "Comment#save" },
    });
  });

  // Two real arms are two real targets; collapsing one of them away would pick a
  // winner the annotation never named.
  it("leaves a TWO-armed union unfolded", () => {
    const table = tableWith({
      "sel/comment.py": ["CommentSelector", "CommentSelector.get_by_id"],
      "models/comment.py": ["Comment", "Comment#save"],
      "models/draft.py": ["Draft", "Draft#save"],
      "svc/approve.py": ["run"],
    });
    const ctx = ctxWith({
      callerFile: "svc/approve.py",
      table,
      structuredReturnTypes: {
        "CommentSelector.get_by_id": {
          form: "union",
          members: [
            { form: "instance", name: "Comment" },
            { form: "instance", name: "Draft" },
          ],
        },
      },
      callResultBindings: { comment: [{ line: 10, callee: "CommentSelector.get_by_id" }] },
    });
    expect(localBinding().attempt(callOn("comment", "save", 12), ctx)).toEqual({ kind: "continue" });
  });
});
