/**
 * The Python external vocabulary (bd tea-rags-mcp-mmckn). Every predicate gets
 * a positive AND a negative case, because both directions are load-bearing: a
 * false positive removes a real recall hole from the denominator, and a false
 * negative leaves a stdlib call sitting in it.
 */
import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonExternalVocabulary } from "../../../../../../src/core/domains/language/python/resolver/python-external-vocabulary.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const vocab = new PythonExternalVocabulary();

function ctxWith(
  imports: { importText: string; startLine: number }[],
  files: Record<string, string[]> = {},
  overrides: Partial<CallContext> = {},
): CallContext {
  const symbolTable = new InMemoryGlobalSymbolTable();
  for (const [relPath, names] of Object.entries(files)) {
    symbolTable.upsertFile(
      relPath,
      names.map((name) => ({ symbolId: name, fqName: name, shortName: name, relPath, scope: [] })),
    );
  }
  return { callerFile: "pkg/main.py", callerScope: [], imports, symbolTable, ...overrides };
}

describe("isBareCallExternal", () => {
  it("claims a builtin", () => {
    expect(vocab.isBareCallExternal("len")).toBe(true);
    expect(vocab.isBareCallExternal("isinstance")).toBe(true);
  });

  it("leaves a project free function alone", () => {
    expect(vocab.isBareCallExternal("helper")).toBe(false);
    expect(vocab.isBareCallExternal("promote")).toBe(false);
  });
});

describe("isQualifiedReceiverExternal", () => {
  it("claims a dotted stdlib receiver rooted at a non-relative import", () => {
    expect(vocab.isQualifiedReceiverExternal("os.path", ctxWith([{ importText: "os", startLine: 1 }]), 3)).toBe(true);
  });

  it("claims a dotted third-party receiver whose mapped file is not ours", () => {
    expect(vocab.isQualifiedReceiverExternal("numpy.linalg", ctxWith([{ importText: "numpy", startLine: 1 }]), 3)).toBe(
      true,
    );
  });

  it("does NOT claim a single-segment receiver — importMatch already answered it", () => {
    expect(vocab.isQualifiedReceiverExternal("os", ctxWith([{ importText: "os", startLine: 1 }]), 3)).toBe(false);
  });

  it("does NOT claim a receiver rooted at a relative import", () => {
    expect(vocab.isQualifiedReceiverExternal("sub.mod", ctxWith([{ importText: ".sub", startLine: 1 }]), 3)).toBe(
      false,
    );
  });

  it("does NOT claim a FIRST-PARTY absolute import whose file is in the table", () => {
    // netbox / flask / polar all import their own packages absolutely. The
    // inline classifier called every one of these external.
    const ctx = ctxWith([{ importText: "netbox.dcim.models", startLine: 1 }], {
      "netbox/dcim/models.py": ["Device"],
    });
    expect(vocab.isQualifiedReceiverExternal("netbox.dcim", ctx, 3)).toBe(false);
  });

  it("does NOT claim a first-party PACKAGE directory with no module file of its own", () => {
    // PEP 420 namespace package: no `__init__.py`, so `hasFile` says no and
    // only `hasFilesUnder` can tell that the package is ours.
    const ctx = ctxWith([{ importText: "domains.billing", startLine: 1 }], {
      "domains/billing/invoice.py": ["Invoice"],
    });
    expect(vocab.isQualifiedReceiverExternal("domains.billing", ctx, 3)).toBe(false);
  });

  it("does NOT claim a receiver whose local binding gives it a type at that line", () => {
    const ctx = ctxWith(
      [{ importText: "os", startLine: 1 }],
      {},
      { localBindings: { os: [{ type: "FakeOs", line: 2 }] } },
    );
    expect(vocab.isQualifiedReceiverExternal("os.path", ctx, 3)).toBe(false);
  });
});

describe("isCoreAmbiguousMember", () => {
  it("claims a dict / list / str member", () => {
    expect(vocab.isCoreAmbiguousMember("get")).toBe(true);
    expect(vocab.isCoreAmbiguousMember("append")).toBe(true);
  });

  it("leaves a Django model method to E3's framework vocabulary", () => {
    expect(vocab.isCoreAmbiguousMember("save")).toBe(false);
    expect(vocab.isCoreAmbiguousMember("delete")).toBe(false);
  });

  it("leaves an ordinary project method alone", () => {
    expect(vocab.isCoreAmbiguousMember("rename")).toBe(false);
  });
});

describe("isReceiverTyped", () => {
  it("calls self and cls typed — their type is the enclosing class", () => {
    expect(vocab.isReceiverTyped("self", ctxWith([]), 3)).toBe(true);
    expect(vocab.isReceiverTyped("cls", ctxWith([]), 3)).toBe(true);
  });

  it("calls a locally-bound receiver typed at a line AFTER its binding", () => {
    const ctx = ctxWith([], {}, { localBindings: { user: [{ type: "User", line: 2 }] } });
    expect(vocab.isReceiverTyped("user", ctx, 5)).toBe(true);
  });

  it("does NOT call it typed BEFORE the binding line", () => {
    const ctx = ctxWith([], {}, { localBindings: { user: [{ type: "User", line: 9 }] } });
    expect(vocab.isReceiverTyped("user", ctx, 5)).toBe(false);
  });

  it("calls a declared class field typed", () => {
    const ctx = ctxWith([], {}, { classFieldTypes: { User: { repo: "Repository" } } });
    expect(vocab.isReceiverTyped("self.repo", ctx, 3)).toBe(true);
  });

  it("calls an unbound receiver untyped, which is what admits the coreAmbiguous bucket", () => {
    expect(vocab.isReceiverTyped("row", ctxWith([]), 3)).toBe(false);
  });
});
