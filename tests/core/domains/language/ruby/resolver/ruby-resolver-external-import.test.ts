import { describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { SUPER_RECEIVER_SENTINEL } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
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

  // cai0 — no-receiver class-body DSL macro keyword is a framework macro
  // invocation (catalogue-derived, zero project defs) → external.
  it("flags bare DSL macro keywords as external (has_many / validates / scope / before_save / delegate)", () => {
    const ctx = makeCtx("app/models/user.rb", [], new InMemoryGlobalSymbolTable());
    for (const m of ["has_many", "validates", "scope", "before_save", "delegate"]) {
      const call: CallRef = { callText: m, receiver: null, member: m, startLine: 3 };
      expect(resolver.targetsExternalImport(call, ctx), m).toBe(true);
    }
  });

  // cai0 — no-receiver Rails controller/ActiveSupport runtime helper → external.
  it("flags bare Rails runtime helpers as external (params / render / redirect_to / t)", () => {
    const ctx = makeCtx("app/controllers/users_controller.rb", [], new InMemoryGlobalSymbolTable());
    for (const m of ["params", "render", "redirect_to", "t"]) {
      const call: CallRef = { callText: m, receiver: null, member: m, startLine: 3 };
      expect(resolver.targetsExternalImport(call, ctx), m).toBe(true);
    }
  });

  // cai0 — a receiver-qualified call to a DSL-macro name is NOT a class-body
  // macro invocation; the new bare-call branches must not touch it.
  it("does NOT flag a receiver-qualified call sharing a DSL macro name (x.has_many)", () => {
    const call: CallRef = { callText: "x.has_many", receiver: "x", member: "has_many", startLine: 3 };
    const ctx = makeCtx("app/models/user.rb", [], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });

  // cai0 super-quick-win — a `super` whose enclosing class's ancestor chain
  // resolves to ZERO in-project files (e.g. `class Agent < ActiveRecord::Base`)
  // targets a gem method (`ActiveRecord::Base#destroy`). It is EXTERNAL, not an
  // internal resolver miss: the super pass correctly DROPs it (no in-project
  // file), and it must be excluded from the denominator like any gem call.
  it("flags a super call whose ancestor chain is entirely external (Agent < ActiveRecord::Base)", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/agent.rb", [
      { symbolId: "Agent", fqName: "Agent", shortName: "Agent", relPath: "app/models/agent.rb", scope: [] },
    ]);
    const call: CallRef = { callText: "super", receiver: SUPER_RECEIVER_SENTINEL, member: "destroy", startLine: 155 };
    const ctx: CallContext = {
      callerFile: "app/models/agent.rb",
      callerScope: ["Agent"],
      imports: [],
      symbolTable: table,
      classAncestors: { Agent: ["ActiveRecord::Base"] },
    };
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  // cai0 — a `super` with an IN-PROJECT ancestor (nested `Agents::WebsiteAgent <
  // Agent`) is NOT external: the super pass resolves it (file-only edge to
  // agent.rb), so it never reaches this hook unresolved; the classifier must not
  // claim it.
  it("does NOT flag a super call with an in-project ancestor (Agents::WebsiteAgent < Agent)", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/agent.rb", [
      { symbolId: "Agent", fqName: "Agent", shortName: "Agent", relPath: "app/models/agent.rb", scope: [] },
    ]);
    const call: CallRef = {
      callText: "super",
      receiver: SUPER_RECEIVER_SENTINEL,
      member: "default_encoding",
      startLine: 436,
    };
    const ctx: CallContext = {
      callerFile: "app/models/agents/website_agent.rb",
      callerScope: ["Agents", "WebsiteAgent"],
      imports: [],
      symbolTable: table,
      classAncestors: { "Agents::WebsiteAgent": ["Agent"], Agent: ["ActiveRecord::Base"] },
    };
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });

  // cai0 — a `super` with no declared ancestors (no classAncestors entry) is NOT
  // provably external — stay conservative (attempted-unresolved), never over-shrink.
  it("does NOT flag a super call with no declared ancestor chain", () => {
    const call: CallRef = { callText: "super", receiver: SUPER_RECEIVER_SENTINEL, member: "foo", startLine: 3 };
    const ctx: CallContext = {
      callerFile: "app/models/plain.rb",
      callerScope: ["Plain"],
      imports: [],
      symbolTable: new InMemoryGlobalSymbolTable(),
    };
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });

  // cai0 imass — an @ivar whose inferred type (classFieldTypes) is a gem (no
  // project file) is honestly external: the ivar strategy DROPs it, and it must
  // leave the denominator like any gem call, NOT remain an internal-miss.
  it("flags an @ivar call whose recorded type is a gem (Net::HTTP)", () => {
    const call: CallRef = { callText: "@http.get(uri)", receiver: "@http", member: "get", startLine: 3 };
    const ctx: CallContext = {
      callerFile: "app/services/fetcher.rb",
      callerScope: ["Fetcher"],
      imports: [],
      symbolTable: new InMemoryGlobalSymbolTable(),
      classFieldTypes: { Fetcher: { "@http": "Net::HTTP" } },
    };
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  // cai0 imass — an @ivar typed to an IN-PROJECT class is NOT external (the ivar
  // strategy resolves it); the classifier must not claim it.
  it("does NOT flag an @ivar call whose recorded type resolves to a project file", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/user.rb", [
      { symbolId: "User", fqName: "User", shortName: "User", relPath: "app/models/user.rb", scope: [] },
    ]);
    const call: CallRef = { callText: "@user.save", receiver: "@user", member: "save", startLine: 3 };
    const ctx: CallContext = {
      callerFile: "app/services/fetcher.rb",
      callerScope: ["Fetcher"],
      imports: [],
      symbolTable: table,
      classFieldTypes: { Fetcher: { "@user": "User" } },
    };
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });

  // cai0 imass — an @ivar with NO recorded type is genuinely attempted-unresolved
  // (we don't know it's a gem) — stay conservative, never over-shrink.
  it("does NOT flag an @ivar call with no recorded type", () => {
    const call: CallRef = { callText: "@x.save", receiver: "@x", member: "save", startLine: 3 };
    const ctx: CallContext = {
      callerFile: "app/services/fetcher.rb",
      callerScope: ["Fetcher"],
      imports: [],
      symbolTable: new InMemoryGlobalSymbolTable(),
      classFieldTypes: { Fetcher: {} },
    };
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });

  // mktkk increment A — an index-access receiver (`opts[k]`) yields an element
  // whose type is statically untrackable (Hash/Array element → core/external).
  // The dynamic-dispatch pass suppresses fan-out; this classifier must mark it
  // as external so the suppressed call leaves the inProjectEdgeRecall denominator
  // as callsExternalSkipped instead of becoming a recall hole.
  it("classifies an index-access receiver call as external (mktkk)", () => {
    const call: CallRef = { callText: "opts[k].fetch", receiver: "opts[k]", member: "fetch", startLine: 1 };
    const ctx = makeCtx("app/services/fetcher.rb", [], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  it("does NOT classify a bare-identifier receiver as external on index grounds (increment B)", () => {
    const call: CallRef = { callText: "obj.fetch", receiver: "obj", member: "fetch", startLine: 1 };
    const ctx = makeCtx("app/services/fetcher.rb", [], new InMemoryGlobalSymbolTable());
    // `obj` is lowercase, non-index → not external by THIS rule.
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });

  // increment B / B-suppress — a chain receiver whose tail is a provably-external
  // core/runtime method (`req.headers`, `e.backtrace`, `type.constantize`) is
  // classified external. The dynamic-dispatch pass suppresses fan-out; the
  // classifier ensures the suppressed call leaves the denominator as
  // callsExternalSkipped rather than becoming a recall hole.
  it("classifies a chain-tail-external receiver call as external (req.headers.to_h)", () => {
    const call: CallRef = { callText: "req.headers.to_h", receiver: "req.headers", member: "to_h", startLine: 1 };
    const ctx = makeCtx("app/controllers/api_controller.rb", [], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  it("does NOT classify an in-project chain receiver as external on chain-tail grounds (event.user)", () => {
    const call: CallRef = { callText: "event.user.save", receiver: "event.user", member: "save", startLine: 1 };
    const ctx = makeCtx("app/models/event.rb", [], new InMemoryGlobalSymbolTable());
    // `.user` is NOT in EXTERNAL_CHAIN_TAILS → NOT external by this rule.
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });
});
