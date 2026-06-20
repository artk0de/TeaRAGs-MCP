import { describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * tea-rags-mcp-ykj7 (ykj7-a) — Python classifies an UNRESOLVED dotted-receiver
 * call (`os.path.join`) as external when its root segment matches a non-relative
 * import (stdlib / third-party). Conservative: bare calls and single-segment
 * receivers are left as attempted-unresolved (the import-match strategy already
 * emits a file-only edge for those, so they never reach this hook unresolved).
 */
describe("PythonCallResolver.targetsExternalImport", () => {
  function makeCtx(
    callerFile: string,
    imports: { importText: string; startLine: number }[],
    symbolTable: InMemoryGlobalSymbolTable,
  ): CallContext {
    return { callerFile, callerScope: [], imports, symbolTable };
  }

  const resolver = new PythonCallResolver();

  it("flags a qualified stdlib access rooted at a non-relative import (os.path.join)", () => {
    const call: CallRef = { callText: "os.path.join(a, b)", receiver: "os.path", member: "join", startLine: 3 };
    const ctx = makeCtx("pkg/main.py", [{ importText: "os", startLine: 1 }], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  it("flags a qualified third-party access (numpy.linalg.norm)", () => {
    const call: CallRef = { callText: "numpy.linalg.norm(v)", receiver: "numpy.linalg", member: "norm", startLine: 3 };
    const ctx = makeCtx("pkg/main.py", [{ importText: "numpy", startLine: 1 }], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  it("does NOT flag a dotted receiver rooted at a relative import (internal)", () => {
    const call: CallRef = { callText: "sub.mod.fn()", receiver: "sub.mod", member: "fn", startLine: 3 };
    const ctx = makeCtx("pkg/main.py", [{ importText: ".sub", startLine: 1 }], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });

  it("does NOT flag a single-segment receiver (handled by import-match as a file edge)", () => {
    const call: CallRef = { callText: "os.getcwd()", receiver: "os", member: "getcwd", startLine: 3 };
    const ctx = makeCtx("pkg/main.py", [{ importText: "os", startLine: 1 }], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });

  it("does NOT flag a bare call (cannot distinguish builtin from project — conservative)", () => {
    const call: CallRef = { callText: "helper()", receiver: null, member: "helper", startLine: 3 };
    const ctx = makeCtx("pkg/main.py", [], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });
});
