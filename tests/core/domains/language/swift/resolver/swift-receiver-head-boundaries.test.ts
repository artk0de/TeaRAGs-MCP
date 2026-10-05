/**
 * The edge of each Swift receiver-head reader: a head that has the right
 * outline but is missing the thing that makes it typeable — `self` outside any
 * type, `super`, a call group that never closes or is followed by something
 * other than a trailing closure, a call whose name a local already owns, a
 * stored property that is not a closure. Each such head types nothing, so the
 * project's namesake stays a candidate instead of being misattributed.
 *
 * Driven through `SwiftCallResolver`, the surface production calls.
 */

import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, SymbolDefinition } from "../../../../../../src/core/contracts/types/codegraph.js";
import { SwiftCallResolver } from "../../../../../../src/core/domains/language/swift/resolver/swift-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function table(
  rows: Record<string, ({ symbolId: string; scope: string[] } & Partial<SymbolDefinition>)[]>,
): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(rows)) {
    t.upsertFile(
      relPath,
      defs.map((d) => ({
        ...d,
        fqName: d.symbolId,
        shortName: (d.symbolId.split(/[#.]/).pop() ?? d.symbolId).replace(/~\d+$/, ""),
        relPath,
      })),
    );
  }
  return t;
}

function call(receiver: string | null, member: string, startLine = 6): CallRef {
  return { callText: `${receiver ?? ""}.${member}()`, receiver, member, startLine };
}

const symbols = table({
  "Sources/Request.swift": [
    { symbolId: "Request", scope: [] },
    { symbolId: "Request#cancel", scope: ["Request"] },
  ],
  "Sources/Session.swift": [{ symbolId: "Session", scope: [] }],
});

const typeDeclarations = {
  "Sources/Request.swift": [{ typeId: "Request", symbolKind: "class" as const, line: 1, reopens: false }],
  "Sources/Session.swift": [{ typeId: "Session", symbolKind: "class" as const, line: 1, reopens: false }],
};

const inSession: CallContext = {
  callerFile: "Sources/Session.swift",
  callerScope: ["Session", "go"],
  imports: [],
  symbolTable: symbols,
  typeDeclarations,
  classFieldTypes: { Session: { current: "Request" } },
  localBindings: {
    handler: [{ line: 2, type: "Request" }],
    stride: [{ line: 2, type: "Int" }],
    broken: [{ line: 2, type: "[Request" }],
  },
};

const outsideAnyType: CallContext = { ...inSession, callerScope: ["go"] };

describe("SwiftCallResolver — receiver heads that only look typeable", () => {
  const resolver = new SwiftCallResolver();

  it("types `self` and `Self` to nothing outside a type, and `super` to nothing anywhere", () => {
    expect(resolver.resolve(call("self", "cancel"), outsideAnyType)).toBeNull();
    expect(resolver.resolve(call("Self", "cancel"), outsideAnyType)).toBeNull();
    expect(resolver.resolve(call("super", "cancel"), inSession)).toBeNull();
  });

  it.each([
    ["a subscript on a qualified base", "session.frames[0]"],
    ["a subscript on a parenthesised base", "(frames)[0]"],
    ["a call group that never closes", "validate(statusCode"],
    ["a call group followed by another call group", "validate(a)(b)"],
    ["a call group followed by a bare word", "validate(a) b"],
    ["three call groups in a row", "validate(a)(b)(c)"],
    ["a call whose name a local value already owns", "handler(a)"],
    ["a call of a stored property that is no closure", "current(a)"],
    ["a range operator that is neither half-open nor closed", "(lo..hi)"],
    ["a local whose declared collection type never closes", "broken"],
    ["a standard-library function name a local shadows", "stride(from: 0, to: 5, by: 1)"],
  ])("types nothing for %s", (_label, head) => {
    expect(resolver.resolve(call(head, "cancel"), inSession)).toBeNull();
  });

  it.each([
    ["a callee with no receiver before the dot", ".forEach"],
    ["a callee whose receiver the fold cannot type", "unknown.forEach"],
    ["a callee that is a method of a type with no closure signature for it", "current.cancel"],
    ["a bare callee that is a dollar-prefixed anonymous parameter", "$handler"],
    ["a bare callee a local value already owns", "handler"],
    ["a bare callee that is a lowercase name the enclosing type does not declare", "unrelated"],
  ])("types a closure parameter to nothing for %s", (_label, callee) => {
    const withClosure: CallContext = {
      ...inSession,
      callResultBindings: { $0: [{ line: 7, callee, closureParameter: 0 }] },
    };

    expect(resolver.resolve(call("$0", "cancel", 7), withClosure)).toBeNull();
  });

  it("ignores a closure-parameter binding whose scope ended before the call, and one declared after it", () => {
    const callee = "current.forEach";
    const ended: CallContext = {
      ...inSession,
      callResultBindings: { $0: [{ line: 3, callee, closureParameter: 0, scopeEndLine: 4 }] },
    };
    const later: CallContext = {
      ...inSession,
      callResultBindings: { $0: [{ line: 9, callee, closureParameter: 0 }] },
    };

    expect(resolver.resolve(call("$0", "cancel", 7), ended)).toBeNull();
    expect(resolver.resolve(call("$0", "cancel", 7), later)).toBeNull();
  });
});
