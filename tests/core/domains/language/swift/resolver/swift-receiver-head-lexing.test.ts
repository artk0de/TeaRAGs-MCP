/**
 * Receiver HEADS the Swift fold types by reading their own text — subscripts,
 * parenthesised ranges, parenthesised `??` — and the lexing those readers do to
 * find the one bracket group, the one operator at depth zero, or the string a
 * delimiter sits inside. What this pins is the boundary of each reader: a head
 * that is that shape is typed, and a head that only looks like it (a second
 * subscript, a label, an index the fold cannot type, a group closing early, a
 * delimiter inside a string literal) types nothing rather than something wrong.
 *
 * Driven through `SwiftCallResolver`, the surface production calls; the
 * existing per-shape specs live in `swift-resolver.test.ts`.
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

/** A call whose receiver the walker normalised (`??` dropped) but whose written text keeps it. */
function written(receiver: string, writtenReceiver: string, member: string): CallRef {
  return { ...call(receiver, member), writtenReceiver };
}

const optional = (name: string) => ({
  form: "instance" as const,
  name: "Optional",
  args: [{ form: "instance" as const, name }],
});

const symbols = table({
  "Sources/Request.swift": [
    { symbolId: "Request", scope: [] },
    { symbolId: "Request#cancel", scope: ["Request"] },
    { symbolId: "Request#map", scope: ["Request"] },
  ],
  "Sources/Session.swift": [{ symbolId: "Session", scope: [] }],
  "Sources/String+Ext.swift": [{ symbolId: "String#indentingNewlines", scope: ["String"] }],
  "Sources/Range+Ext.swift": [
    { symbolId: "Range#clamped", scope: ["Range"] },
    { symbolId: "ClosedRange#clamped", scope: ["ClosedRange"] },
  ],
  "Sources/Tile.swift": [
    { symbolId: "Tile", scope: [] },
    { symbolId: "Tile#contains", scope: ["Tile"] },
  ],
});

const typeDeclarations = {
  "Sources/Request.swift": [{ typeId: "Request", symbolKind: "class" as const, line: 1, reopens: false }],
  "Sources/Session.swift": [
    {
      typeId: "Session",
      reopens: false,
      fieldTypeArguments: { apps: ["String", "Set"], frames: ["Request"] },
    },
  ],
  "Sources/String+Ext.swift": [{ typeId: "String", symbolKind: "class" as const, line: 1, reopens: true }],
  "Sources/Range+Ext.swift": [
    { typeId: "Range", symbolKind: "class" as const, line: 1, reopens: true },
    { typeId: "ClosedRange", symbolKind: "class" as const, line: 1, reopens: true },
  ],
  "Sources/Tile.swift": [{ typeId: "Tile", symbolKind: "class" as const, line: 1, reopens: false }],
};

const inSession: CallContext = {
  callerFile: "Sources/Session.swift",
  callerScope: ["Session", "go"],
  imports: [],
  symbolTable: symbols,
  typeDeclarations,
  classFieldTypes: { Session: { apps: "Dictionary", frames: "Array", current: "Request" } },
  localBindings: {
    key: [{ line: 2, type: "String" }],
    label: [{ line: 2, type: "String", typeRef: optional("String") }],
  },
};

describe("SwiftCallResolver — subscript heads", () => {
  const resolver = new SwiftCallResolver();

  it("types exactly one subscript whose index picks the element subscript", () => {
    expect(resolver.resolve(call("frames[0]", "cancel"), inSession)?.targetSymbolId).toBe("Request#cancel");
    expect(resolver.resolve(call("frames[0x1F]", "cancel"), inSession)?.targetSymbolId).toBe("Request#cancel");
  });

  it.each([
    ["a second subscript chained on the first", "frames[0][1]"],
    ["a labelled subscript argument", "frames[at: 0]"],
    ["an empty subscript", "frames[]"],
    ["two subscript arguments", "frames[0, 1]"],
    ["an index the fold cannot type", "frames[ids[0]]"],
    ["a String index into an Array", 'frames["0"]'],
    ["a subscript on a type that is neither Array nor Dictionary", "current[0]"],
  ])("types nothing for %s", (_label, head) => {
    expect(resolver.resolve(call(head, "cancel"), inSession)).toBeNull();
  });

  it("reads a quoted key with an escaped quote and a bracket inside it as ONE String index", () => {
    // `apps` is `[String: Set<String>]`: a String key reads `Optional<Set<String>>`,
    // whose `map` is the standard library's — never the project's `Request#map`.
    expect(resolver.hasInProjectDefinition(call('apps["a\\"]b"]', "map"), inSession)).toBe(false);
    expect(resolver.hasInProjectDefinition(call("apps[key]", "map"), inSession)).toBe(false);
  });

  it("picks no Dictionary subscript for an index of another type than the key", () => {
    // An Int index is no `String` key: the head stays untyped, so the project
    // namesake `Request#map` cannot be ruled out.
    expect(resolver.hasInProjectDefinition(call("apps[0]", "map"), inSession)).toBe(true);
  });
});

describe("SwiftCallResolver — parenthesised range and `??` heads", () => {
  const resolver = new SwiftCallResolver();

  it("finds the range operator outside a string literal that itself holds an escaped quote", () => {
    expect(resolver.resolve(call('("\\"..."..."z")', "clamped"), inSession)?.targetSymbolId).toBe(
      "ClosedRange#clamped",
    );
    expect(resolver.resolve(call("(lo..<(hi + 1))", "clamped"), inSession)?.targetSymbolId).toBe("Range#clamped");
  });

  it("does not read a parenthesised callee applied to a range argument as a range", () => {
    // `(f)(0..<3)`: the first group closes before the end, so this is a call
    // whose result nothing types — the project's `Tile#contains` stays possible.
    expect(resolver.hasInProjectDefinition(call("(f)(0..<3)", "contains"), inSession)).toBe(true);
    expect(resolver.resolve(call("(0..<)", "clamped"), inSession)).toBeNull();
  });

  it("splits `??` outside the string fallback, even when the fallback holds `??` and an escaped quote", () => {
    const head = '(label ?? "n\\"?? a")';
    expect(resolver.resolve(written('(label  "n\\"?? a")', head, "indentingNewlines"), inSession)?.targetSymbolId).toBe(
      "String#indentingNewlines",
    );
  });

  it("types nothing for a parenthesised pair of groups that only looks like a `??` head", () => {
    expect(
      resolver.resolve(written("(label) (fallback)", "(label) ?? (fallback)", "indentingNewlines"), inSession),
    ).toBeNull();
  });
});
