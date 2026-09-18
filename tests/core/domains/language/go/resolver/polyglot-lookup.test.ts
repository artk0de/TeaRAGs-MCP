import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, NamedSymbol } from "../../../../../../src/core/contracts/types/codegraph.js";
import { GoCallResolver } from "../../../../../../src/core/domains/language/go/resolver/go-resolver.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * The symbol table is ONE polyglot index with no `language` field, so every
 * Go lookup must see Go declarations only (`.claude/rules/resolver-architecture.md`
 * §2). A Go repository with a TypeScript front end is the ordinary shape:
 * `Client` in `api/client.go`, `Client` in `web/client.ts`. The typed-receiver
 * passes composed `Client#fetch` and asked the table directly, so a Go call on
 * a Go `Client` landed on the TypeScript method — and a Go method sharing its
 * id with a TypeScript one was dropped as ambiguous.
 */

const sym = (symbolId: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope: [],
});

function polyglotTable(extra: [string, NamedSymbol[]][] = []): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile("api/client.go", [sym("Client", "api/client.go"), sym("Transport", "api/client.go")]);
  t.upsertFile("web/client.ts", [sym("Client", "web/client.ts"), sym("Client#fetch", "web/client.ts")]);
  t.upsertFile("web/transport.ts", [sym("Transport#send", "web/transport.ts")]);
  t.upsertFile("web/widget.ts", [sym("Widget", "web/widget.ts"), sym("Widget#render", "web/widget.ts")]);
  for (const [relPath, defs] of extra) t.upsertFile(relPath, defs);
  return t;
}

function goCtx(over: Partial<CallContext> = {}): CallContext {
  return {
    callerFile: "api/handler.go",
    callerScope: [],
    imports: [],
    symbolTable: polyglotTable(),
    localBindings: { c: [{ line: 1, type: "Client" }] },
    classFieldTypesByClassKey: { "api/client.go::Client": { http: "Transport" } },
    ...over,
  };
}

const call = (receiver: string, member: string): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine: 3,
});

const resolver = new GoCallResolver(new DefaultSymbolIdComposer());

describe("GoCallResolver — Go lookups see Go declarations only", () => {
  it("NEGATIVE: a Go `c.fetch()` on a Go `Client` never lands on the TypeScript `Client#fetch`", () => {
    expect(resolver.resolve(call("c", "fetch"), goCtx())).toBeNull();
  });

  it("NEGATIVE: the receiver chain never lands on a TypeScript method (`c.http.send()`)", () => {
    expect(resolver.resolve(call("c.http", "send"), goCtx())).toBeNull();
  });

  it("resolves the Go method when a TypeScript method shares its symbolId", () => {
    const ctx = goCtx({ symbolTable: polyglotTable([["api/fetch.go", [sym("Client#fetch", "api/fetch.go")]]]) });
    expect(resolver.resolve(call("c", "fetch"), ctx)).toEqual({
      targetRelPath: "api/fetch.go",
      targetSymbolId: "Client#fetch",
    });
  });

  it("NEGATIVE: a declared return type naming only a TypeScript type binds nothing", () => {
    const ctx = goCtx({
      localBindings: undefined,
      localCallBindings: { w: "Build" },
      functionReturnTypes: { Build: "Widget" },
    });
    expect(resolver.resolve(call("w", "render"), ctx)).toBeNull();
  });
});
