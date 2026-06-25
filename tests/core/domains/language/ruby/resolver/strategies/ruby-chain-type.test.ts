import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import type { ResolverConfig } from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import { RubyChainTypeSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/ruby-chain-type.js";
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
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  ...over,
});

describe("RubyChainTypeSymbolResolutionStrategy", () => {
  const strat = new RubyChainTypeSymbolResolutionStrategy(cfg);

  // ── CONTINUE guards ────────────────────────────────────────────────────────

  it("continues when the receiver is null", () => {
    const symbolTable = tableWith();
    const call: CallRef = { callText: "save", receiver: null, member: "save", startLine: 1 };
    expect(strat.attempt(call, ctx({ symbolTable })).kind).toBe("continue");
  });

  it("continues when the receiver has no dot (single-segment — handled by localType/ivar)", () => {
    const symbolTable = tableWith();
    const call: CallRef = { callText: "user.save", receiver: "user", member: "save", startLine: 1 };
    expect(strat.attempt(call, ctx({ symbolTable })).kind).toBe("continue");
  });

  it("continues when the chain type is unknown (no seed data for head)", () => {
    const symbolTable = tableWith([
      "app/models/account.rb",
      [
        sym("Account", "Account", "app/models/account.rb", []),
        sym("Account#name", "name", "app/models/account.rb", ["Account"]),
      ],
    ]);
    // `event.user.account` — no local binding, no structuredReturnTypes, no functionReturnTypes
    const call: CallRef = {
      callText: "event.user.account.name",
      receiver: "event.user.account",
      member: "name",
      startLine: 10,
    };
    expect(strat.attempt(call, ctx({ symbolTable })).kind).toBe("continue");
  });

  // ── RESOLVED — structuredReturnTypes seeded chain ─────────────────────────

  it("resolves event.user.account.name via structuredReturnTypes chain", () => {
    // event → User (from localBinding); User#account → Account (structuredReturnTypes)
    // then resolves Account#name
    const symbolTable = tableWith(
      ["app/models/user.rb", [sym("User", "User", "app/models/user.rb", [])]],
      [
        "app/models/account.rb",
        [
          sym("Account", "Account", "app/models/account.rb", []),
          sym("Account#name", "name", "app/models/account.rb", ["Account"]),
        ],
      ],
    );
    const call: CallRef = {
      callText: "event.user.account.name",
      receiver: "event.user.account",
      member: "name",
      startLine: 10,
    };
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable,
        localBindings: { event: [{ line: 1, type: "Event" }] },
        structuredReturnTypes: {
          "Event#user": { form: "instance", name: "User" },
          "User#account": { form: "instance", name: "Account" },
        },
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/account.rb", targetSymbolId: "Account#name" },
    });
  });

  it("resolves a two-hop chain via associationTypes (Rails belongs_to/has_one)", () => {
    // user → Account via associationTypes (user.account → Account)
    // then resolves Account#email
    const symbolTable = tableWith(
      ["app/models/user.rb", [sym("User", "User", "app/models/user.rb", [])]],
      [
        "app/models/account.rb",
        [
          sym("Account", "Account", "app/models/account.rb", []),
          sym("Account#email", "email", "app/models/account.rb", ["Account"]),
        ],
      ],
    );
    const call: CallRef = {
      callText: "user.account.email",
      receiver: "user.account",
      member: "email",
      startLine: 5,
    };
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable,
        localBindings: { user: [{ line: 1, type: "User" }] },
        associationTypes: { User: { account: "Account" } },
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/account.rb", targetSymbolId: "Account#email" },
    });
  });

  // ── DROP — known type, method absent ─────────────────────────────────────

  it("DROPs when the chain terminal type is known but the method is absent in its file", () => {
    const symbolTable = tableWith([
      "app/models/account.rb",
      [sym("Account", "Account", "app/models/account.rb", [])],
      // Account#missing is NOT in the symbol table
    ]);
    const call: CallRef = {
      callText: "user.account.missing",
      receiver: "user.account",
      member: "missing",
      startLine: 5,
    };
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable,
        localBindings: { user: [{ line: 1, type: "User" }] },
        associationTypes: { User: { account: "Account" } },
      }),
    );
    // Account resolved to a file (account.rb), no method pin — file-only edge
    // resolveTypeInstanceMethod returns a file-only target → resolved (not drop)
    // Drop only happens when the type's file is entirely unknown (no project file)
    expect(outcome.kind).toBe("resolved");
    expect((outcome as { kind: "resolved"; target: { targetSymbolId: null } }).target.targetSymbolId).toBeNull();
  });

  it("DROPs when the chain terminal type resolves to no project file (gem/stdlib)", () => {
    // Account resolves to a gem — no project file
    const symbolTable = tableWith(); // Account NOT in symbol table
    const call: CallRef = {
      callText: "user.account.name",
      receiver: "user.account",
      member: "name",
      startLine: 5,
    };
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable,
        localBindings: { user: [{ line: 1, type: "User" }] },
        associationTypes: { User: { account: "Account" } },
      }),
    );
    expect(outcome.kind).toBe("drop");
  });

  // ── class-valued receiver ─────────────────────────────────────────────────

  it("resolves a class-valued chain terminal via resolveTypeStaticMethod", () => {
    // structuredReturnTypes says "Event#repository" returns form="class", name="Repository"
    // → resolves Repository.create (class method)
    const symbolTable = tableWith(
      ["app/models/event.rb", [sym("Event", "Event", "app/models/event.rb", [])]],
      [
        "app/models/repository.rb",
        [
          sym("Repository", "Repository", "app/models/repository.rb", []),
          sym("Repository.create", "create", "app/models/repository.rb", ["Repository"]),
        ],
      ],
    );
    const call: CallRef = {
      callText: "event.repository.create",
      receiver: "event.repository",
      member: "create",
      startLine: 3,
    };
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable,
        localBindings: { event: [{ line: 1, type: "Event" }] },
        structuredReturnTypes: {
          "Event#repository": { form: "class", name: "Repository" },
        },
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/repository.rb", targetSymbolId: "Repository.create" },
    });
  });
});

// ── Composition test: chain resolves terminally instead of dynamic-fanning ─

describe("RubyCallResolver composition — chainType before receiverSetDrop", () => {
  it("resolves a two-hop chain terminally (not via dynamic fan-out) when type is known", () => {
    const symbolTable = tableWith(
      ["app/models/user.rb", [sym("User", "User", "app/models/user.rb", [])]],
      [
        "app/models/account.rb",
        [
          sym("Account", "Account", "app/models/account.rb", []),
          sym("Account#email", "email", "app/models/account.rb", ["Account"]),
        ],
      ],
    );
    const resolver = new RubyCallResolver();
    const call: CallRef = {
      callText: "user.account.email",
      receiver: "user.account",
      member: "email",
      startLine: 5,
    };
    const target = resolver.resolve(
      call,
      ctx({
        symbolTable,
        localBindings: { user: [{ line: 1, type: "User" }] },
        associationTypes: { User: { account: "Account" } },
      }),
    );
    expect(target).toEqual({ targetRelPath: "app/models/account.rb", targetSymbolId: "Account#email" });
  });

  it("still falls through to receiverSetDrop for unknown chain (no regression)", () => {
    // An unknown chain (no type data) must still DROP via receiverSetDrop,
    // NOT accidentally resolve through bareCall short-name lookup.
    const symbolTable = tableWith([
      "app/models/account.rb",
      [sym("Account#email", "email", "app/models/account.rb", ["Account"])],
    ]);
    const resolver = new RubyCallResolver();
    const call: CallRef = {
      callText: "event.user.account.email",
      receiver: "event.user.account",
      member: "email",
      startLine: 5,
    };
    // No localBindings, no structuredReturnTypes → chain type unknown → CONTINUE from chainType
    // → receiverSetDrop fires (receiver is non-null) → resolve returns null
    const target = resolver.resolve(call, ctx({ symbolTable }));
    expect(target).toBeNull();
  });
});
