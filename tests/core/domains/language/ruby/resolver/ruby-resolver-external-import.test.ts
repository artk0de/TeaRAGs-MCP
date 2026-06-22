import { describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * tea-rags-mcp-ykj7 (ykj7-a) — Ruby classifies an UNRESOLVED constant-receiver
 * call as external (gem / stdlib) when `resolveConstant` cannot map it to a
 * project / Zeitwerk file. `Net::HTTP.get` → gem path. A constant that DOES
 * resolve to a project file is in-project (and would not reach this hook
 * unresolved).
 *
 * tea-rags-mcp-5os8y — bare calls (receiver null) consult RUBY_KERNEL_BUILTINS:
 * a Ruby CORE method (`puts`, `raise`, `require`) is classified external; a
 * bare project-method name not in the set stays attempted-unresolved (false).
 */
describe("RubyCallResolver.targetsExternalImport", () => {
  function makeCtx(
    callerFile: string,
    imports: { importText: string; startLine: number }[],
    symbolTable: InMemoryGlobalSymbolTable,
  ): CallContext {
    return { callerFile, callerScope: [], imports, symbolTable };
  }

  const resolver = new RubyCallResolver();

  it("flags a gem constant call that does not resolve to a project file (Net::HTTP.get)", () => {
    const call: CallRef = { callText: "Net::HTTP.get(uri)", receiver: "Net::HTTP", member: "get", startLine: 3 };
    const ctx = makeCtx("app/services/fetcher.rb", [], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  it("does NOT flag a constant that resolves to a project file (User)", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/user.rb", [
      { symbolId: "User", fqName: "User", shortName: "User", relPath: "app/models/user.rb", scope: [] },
    ]);
    const call: CallRef = { callText: "User.find(1)", receiver: "User", member: "find", startLine: 3 };
    const ctx = makeCtx("app/controllers/users_controller.rb", [], table);
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });

  it("does NOT flag a non-constant receiver (lowercase local / self — conservative)", () => {
    const call: CallRef = { callText: "user.save", receiver: "user", member: "save", startLine: 3 };
    const ctx = makeCtx("app/models/account.rb", [], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });

  it("flags a bare Ruby core builtin call (puts → in RUBY_KERNEL_BUILTINS)", () => {
    const call: CallRef = { callText: "puts(x)", receiver: null, member: "puts", startLine: 3 };
    const ctx = makeCtx("app/models/account.rb", [], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  it("flags bare raise / require (Kernel core methods)", () => {
    const ctx = makeCtx("app/models/account.rb", [], new InMemoryGlobalSymbolTable());
    const raise: CallRef = { callText: "raise(e)", receiver: null, member: "raise", startLine: 3 };
    const require: CallRef = { callText: "require('x')", receiver: null, member: "require", startLine: 4 };
    expect(resolver.targetsExternalImport(raise, ctx)).toBe(true);
    expect(resolver.targetsExternalImport(require, ctx)).toBe(true);
  });

  it("does NOT flag a bare project-method name not in the builtin set (my_helper)", () => {
    const call: CallRef = { callText: "my_helper(x)", receiver: null, member: "my_helper", startLine: 3 };
    const ctx = makeCtx("app/models/account.rb", [], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });
});
