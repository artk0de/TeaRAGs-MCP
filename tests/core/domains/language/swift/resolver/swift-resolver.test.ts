/**
 * `SwiftCallResolver` — the six-pass chain, one describe per pass plus the
 * guards that keep Swift's precision honest.
 *
 * Two Swift facts drive the chain and are asserted here rather than left to a
 * docblock:
 *   - `self` is IMPLICIT, so `db.write()` inside a method is a stored-property
 *     access, not a free variable — but only when a local of that name has not
 *     shadowed it;
 *   - a type is routinely split across extensions in SEVERAL files, so the
 *     same-file enclosing lookup every other language ends at is not the end
 *     for Swift.
 *
 * The terminal pass answers BARE calls only. A receiver-bearing call no typed
 * pass could claim emits NOTHING — the JavaScript tail's measured verdict
 * (bd tea-rags-mcp-hwwtw), applied to a language with no symbol-level imports
 * to narrow a receiver with.
 */

import { describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { SwiftCallResolver } from "../../../../../../src/core/domains/language/swift/resolver/swift-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function table(rows: Record<string, { symbolId: string; scope: string[] }[]>): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(rows)) {
    t.upsertFile(
      relPath,
      defs.map((d) => ({
        symbolId: d.symbolId,
        fqName: d.symbolId,
        // Production keys the table with `lastSegment`, which strips the `~N`
        // overload suffix — so every declaration of one re-opened type answers
        // the same short name. Mirrored here, or the collision this file pins
        // could not be built at all.
        shortName: (d.symbolId.split(/[#.]/).pop() ?? d.symbolId).replace(/~\d+$/, ""),
        relPath,
        scope: d.scope,
      })),
    );
  }
  return t;
}

function ctx(over: Partial<CallContext> & Pick<CallContext, "callerFile" | "symbolTable">): CallContext {
  return { callerScope: [], imports: [], ...over };
}

function call(receiver: string | null, member: string, startLine = 10): CallRef {
  return { callText: `${receiver ?? ""}.${member}()`, receiver, member, startLine };
}

describe("SwiftCallResolver — localBinding", () => {
  it("resolves a call on a walker-bound receiver to that type's member", () => {
    const t = table({ "Sources/Repository.swift": [{ symbolId: "Repository#persist", scope: ["Repository"] }] });
    const target = new SwiftCallResolver().resolve(
      call("repo", "persist"),
      ctx({
        callerFile: "Sources/Store.swift",
        symbolTable: t,
        localBindings: { repo: [{ line: 5, type: "Repository" }] },
      }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/Repository.swift", targetSymbolId: "Repository#persist" });
  });

  it("resolves a static member on a bound type", () => {
    const t = table({ "Sources/Repository.swift": [{ symbolId: "Repository.make", scope: ["Repository"] }] });
    const target = new SwiftCallResolver().resolve(
      call("repo", "make"),
      ctx({
        callerFile: "Sources/Store.swift",
        symbolTable: t,
        localBindings: { repo: [{ line: 5, type: "Repository" }] },
      }),
    );
    expect(target?.targetSymbolId).toBe("Repository.make");
  });

  it("honours the MOST RECENT binding at or before the call line", () => {
    const t = table({
      "Sources/A.swift": [{ symbolId: "Alpha#go", scope: ["Alpha"] }],
      "Sources/B.swift": [{ symbolId: "Beta#go", scope: ["Beta"] }],
    });
    const target = new SwiftCallResolver().resolve(
      call("v", "go", 20),
      ctx({
        callerFile: "Sources/Store.swift",
        symbolTable: t,
        localBindings: {
          v: [
            { line: 2, type: "Alpha" },
            { line: 15, type: "Beta" },
          ],
        },
      }),
    );
    expect(target?.targetSymbolId).toBe("Beta#go");
  });

  it("DROPS when the bound type is known but declares no such member", () => {
    // The binding is authoritative. Falling through to the terminal pass would
    // pin `s.hasPrefix()` to whichever project symbol happens to be named
    // `hasPrefix` — an edge the type system says cannot exist.
    const t = table({ "Sources/Other.swift": [{ symbolId: "Other#hasPrefix", scope: ["Other"] }] });
    const target = new SwiftCallResolver().resolve(
      call("s", "hasPrefix"),
      ctx({
        callerFile: "Sources/Store.swift",
        symbolTable: t,
        localBindings: { s: [{ line: 5, type: "String" }] },
      }),
    );
    expect(target).toBeNull();
  });
});

describe("SwiftCallResolver — selfMember", () => {
  it("resolves `self.member()` to the enclosing type in the caller's own file", () => {
    const t = table({
      "Sources/Store.swift": [{ symbolId: "Store#helper", scope: ["Store"] }],
      "Sources/Noise.swift": [{ symbolId: "Noise#helper", scope: ["Noise"] }],
    });
    const target = new SwiftCallResolver().resolve(
      call("self", "helper"),
      ctx({ callerFile: "Sources/Store.swift", callerScope: ["Store"], symbolTable: t }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/Store.swift", targetSymbolId: "Store#helper" });
  });

  it("resolves `Self.member()` to the enclosing type's static member", () => {
    const t = table({ "Sources/Store.swift": [{ symbolId: "Store.make", scope: ["Store"] }] });
    const target = new SwiftCallResolver().resolve(
      call("Self", "make"),
      ctx({ callerFile: "Sources/Store.swift", callerScope: ["Store"], symbolTable: t }),
    );
    expect(target?.targetSymbolId).toBe("Store.make");
  });

  it("resolves `self.init(...)` to the enclosing type's initializer", () => {
    const t = table({ "Sources/Invoice.swift": [{ symbolId: "Invoice#init", scope: ["Invoice"] }] });
    const target = new SwiftCallResolver().resolve(
      call("self", "init"),
      ctx({ callerFile: "Sources/Invoice.swift", callerScope: ["Invoice"], symbolTable: t }),
    );
    expect(target?.targetSymbolId).toBe("Invoice#init");
  });
});

describe("SwiftCallResolver — storedPropertyType", () => {
  it("resolves `self.field.member()` through the field's declared type", () => {
    const t = table({ "Sources/Database.swift": [{ symbolId: "Database#write", scope: ["Database"] }] });
    const target = new SwiftCallResolver().resolve(
      call("self.db", "write"),
      ctx({
        callerFile: "Sources/Store.swift",
        callerScope: ["Store"],
        symbolTable: t,
        classFieldTypes: { Store: { db: "Database" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("Database#write");
  });

  it("resolves a BARE property receiver — Swift's implicit self", () => {
    // `db.write()` inside a Store method is `self.db.write()`. Without this
    // arm every implicit-self field call in the corpus is unresolved.
    const t = table({ "Sources/Database.swift": [{ symbolId: "Database#write", scope: ["Database"] }] });
    const target = new SwiftCallResolver().resolve(
      call("db", "write"),
      ctx({
        callerFile: "Sources/Store.swift",
        callerScope: ["Store"],
        symbolTable: t,
        classFieldTypes: { Store: { db: "Database" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("Database#write");
  });

  it("lets a LOCAL of the same name shadow the stored property", () => {
    const t = table({
      "Sources/Database.swift": [{ symbolId: "Database#write", scope: ["Database"] }],
      "Sources/Mock.swift": [{ symbolId: "MockDatabase#write", scope: ["MockDatabase"] }],
    });
    const target = new SwiftCallResolver().resolve(
      call("db", "write"),
      ctx({
        callerFile: "Sources/Store.swift",
        callerScope: ["Store"],
        symbolTable: t,
        classFieldTypes: { Store: { db: "Database" } },
        localBindings: { db: [{ line: 5, type: "MockDatabase" }] },
      }),
    );
    expect(target?.targetSymbolId).toBe("MockDatabase#write");
  });

  it("DROPS a `self.field` receiver whose field type was never recorded", () => {
    // `self.<x>` is definitively an instance member access — never a module,
    // never a free function. With no recorded type there is nothing honest to
    // emit, and the terminal pass must not see it.
    const t = table({ "Sources/Other.swift": [{ symbolId: "Other#write", scope: ["Other"] }] });
    const target = new SwiftCallResolver().resolve(
      call("self.unknown", "write"),
      ctx({ callerFile: "Sources/Store.swift", callerScope: ["Store"], symbolTable: t, classFieldTypes: {} }),
    );
    expect(target).toBeNull();
  });

  it("does not claim a chained `self.a.b.member()` receiver", () => {
    const t = table({ "Sources/Database.swift": [{ symbolId: "Database#write", scope: ["Database"] }] });
    const target = new SwiftCallResolver().resolve(
      call("self.db.inner", "write"),
      ctx({
        callerFile: "Sources/Store.swift",
        callerScope: ["Store"],
        symbolTable: t,
        classFieldTypes: { Store: { db: "Database" } },
      }),
    );
    expect(target).toBeNull();
  });
});

describe("SwiftCallResolver — scopedTypeReceiver", () => {
  it("resolves a nested type named by its SHORT name inside the enclosing type", () => {
    // `Account.opening(…)` inside `Ledger` — the only place that spelling is
    // legal, and the symbol composes as `Ledger.Account.opening`.
    const t = table({
      "Sources/Ledger.swift": [
        { symbolId: "Ledger.Account", scope: ["Ledger"] },
        { symbolId: "Ledger.Account.opening", scope: ["Ledger", "Account"] },
      ],
    });
    const target = new SwiftCallResolver().resolve(
      call("Account", "opening"),
      ctx({ callerFile: "Sources/Ledger.swift", callerScope: ["Ledger"], symbolTable: t }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/Ledger.swift", targetSymbolId: "Ledger.Account.opening" });
  });

  it("lets the INNERMOST scope's namesake type shadow an outer one", () => {
    const t = table({
      "Sources/Outer.swift": [
        { symbolId: "Outer.Inner.Item", scope: ["Outer", "Inner"] },
        { symbolId: "Outer.Inner.Item#use", scope: ["Outer", "Inner", "Item"] },
        { symbolId: "Outer.Item", scope: ["Outer"] },
        { symbolId: "Outer.Item#use", scope: ["Outer", "Item"] },
      ],
    });
    const target = new SwiftCallResolver().resolve(
      call("Item", "use"),
      ctx({ callerFile: "Sources/Outer.swift", callerScope: ["Outer", "Inner"], symbolTable: t }),
    );
    expect(target?.targetSymbolId).toBe("Outer.Inner.Item#use");
  });

  it("DROPS when the innermost namesake type declares no such member", () => {
    // The receiver's type is known once the probe lands. Walking further out to
    // an outer namesake would resolve a name Swift's own lookup already shadowed.
    const t = table({
      "Sources/Outer.swift": [
        { symbolId: "Outer.Inner.Item", scope: ["Outer", "Inner"] },
        { symbolId: "Outer.Item", scope: ["Outer"] },
        { symbolId: "Outer.Item#use", scope: ["Outer", "Item"] },
      ],
    });
    const target = new SwiftCallResolver().resolve(
      call("Item", "use"),
      ctx({ callerFile: "Sources/Outer.swift", callerScope: ["Outer", "Inner"], symbolTable: t }),
    );
    expect(target).toBeNull();
  });

  it("declines a lowerCamelCase receiver — a nested type is UpperCamelCase", () => {
    // `account.opening()` is a value, not a type. Probing it would attribute
    // the call to `Ledger.account`, a member that means something else.
    const t = table({
      "Sources/Ledger.swift": [
        { symbolId: "Ledger.account", scope: ["Ledger"] },
        { symbolId: "Ledger.account.opening", scope: ["Ledger", "account"] },
      ],
    });
    const target = new SwiftCallResolver().resolve(
      call("account", "opening"),
      ctx({ callerFile: "Sources/Ledger.swift", callerScope: ["Ledger"], symbolTable: t }),
    );
    expect(target).toBeNull();
  });

  it("is shadowed by a local binding of the same name", () => {
    // Swift scoping: a local declaration shadows a type name. `localBinding`
    // runs three passes earlier, and that ordering is the assertion here.
    const t = table({
      "Sources/Ledger.swift": [
        { symbolId: "Ledger.Account", scope: ["Ledger"] },
        { symbolId: "Ledger.Account#post", scope: ["Ledger", "Account"] },
      ],
      "Sources/Other.swift": [{ symbolId: "Other#post", scope: ["Other"] }],
    });
    const target = new SwiftCallResolver().resolve(
      call("Account", "post"),
      ctx({
        callerFile: "Sources/Ledger.swift",
        callerScope: ["Ledger"],
        symbolTable: t,
        localBindings: { Account: [{ line: 5, type: "Other" }] },
      }),
    );
    expect(target?.targetSymbolId).toBe("Other#post");
  });

  it("stays silent at file scope, where there is nothing to qualify against", () => {
    const t = table({ "Sources/Ledger.swift": [{ symbolId: "Ledger.Account#post", scope: ["Ledger", "Account"] }] });
    const target = new SwiftCallResolver().resolve(
      call("Account", "post"),
      ctx({ callerFile: "Sources/Ledger.swift", symbolTable: t }),
    );
    expect(target).toBeNull();
  });
});

describe("SwiftCallResolver — a type re-opened by a same-file extension", () => {
  it("counts the extension's second declaration as the SAME type", () => {
    // `extension Invoice` parses as a second `class_declaration` named
    // `Invoice`, so the file composes `Invoice` and `Invoice~2` and both answer
    // the short name. Construction resolves to the base declaration.
    const t = table({
      "Sources/Invoice.swift": [
        { symbolId: "Invoice", scope: [] },
        { symbolId: "Invoice~2", scope: [] },
      ],
    });
    const target = new SwiftCallResolver().resolve(
      call(null, "Invoice"),
      ctx({ callerFile: "Sources/Invoice.swift", symbolTable: t }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/Invoice.swift", targetSymbolId: "Invoice" });
  });

  it("keeps a type declared in TWO files ambiguous", () => {
    // A type and its extension in separate files compose the identical id, and
    // nothing here says which file carries the type's own body. Still no edge.
    const t = table({
      "Sources/Invoice.swift": [{ symbolId: "Invoice", scope: [] }],
      "Sources/Invoice+Codable.swift": [{ symbolId: "Invoice", scope: [] }],
    });
    const target = new SwiftCallResolver().resolve(
      call(null, "Invoice"),
      ctx({ callerFile: "Sources/Store.swift", symbolTable: t }),
    );
    expect(target).toBeNull();
  });

  it("does NOT fold same-file METHOD overloads", () => {
    // `Invoice#init` / `Invoice#init~2` carry distinct bodies. A `#`-form id is
    // a method whatever it is named, so the fold must not reach it.
    const t = table({
      "Sources/Invoice.swift": [
        { symbolId: "Invoice#init", scope: ["Invoice"] },
        { symbolId: "Invoice#init~2", scope: ["Invoice"] },
      ],
    });
    const target = new SwiftCallResolver().resolve(
      call(null, "init"),
      ctx({ callerFile: "Sources/Store.swift", symbolTable: t }),
    );
    expect(target).toBeNull();
  });

  it("does NOT fold same-file FREE FUNCTION overloads", () => {
    // Two top-level `render(_:)` overloads are the shape a naive fold would get
    // wrong: same file, same base id, no separator. lowerCamelCase is what
    // tells them from a re-opened type.
    const t = table({
      "Sources/Render.swift": [
        { symbolId: "render", scope: [] },
        { symbolId: "render~2", scope: [] },
      ],
    });
    const target = new SwiftCallResolver().resolve(
      call(null, "render"),
      ctx({ callerFile: "Sources/Store.swift", symbolTable: t }),
    );
    expect(target).toBeNull();
  });

  it("does NOT fold same-file STATIC member overloads", () => {
    // `.`-joined like a nested type, but the member is lowerCamelCase.
    const t = table({
      "Sources/Invoice.swift": [
        { symbolId: "Invoice.empty", scope: ["Invoice"] },
        { symbolId: "Invoice.empty~2", scope: ["Invoice"] },
      ],
    });
    const target = new SwiftCallResolver().resolve(
      call(null, "empty"),
      ctx({ callerFile: "Sources/Store.swift", symbolTable: t }),
    );
    expect(target).toBeNull();
  });
});

describe("SwiftCallResolver — enclosingBareCall", () => {
  it("prefers the enclosing type's member over a global namesake", () => {
    const t = table({
      "Sources/Store.swift": [{ symbolId: "Store#helper", scope: ["Store"] }],
      "Sources/Free.swift": [{ symbolId: "helper", scope: [] }],
    });
    const target = new SwiftCallResolver().resolve(
      call(null, "helper"),
      ctx({ callerFile: "Sources/Store.swift", callerScope: ["Store"], symbolTable: t }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/Store.swift", targetSymbolId: "Store#helper" });
  });
});

describe("SwiftCallResolver — extensionScopeMember", () => {
  it("resolves `self.member()` to the enclosing type declared in ANOTHER file", () => {
    // A Swift type is routinely split: the stored properties in one file, a
    // conformance extension in the next. The same-file lookup cannot see it.
    const t = table({ "Sources/Invoice.swift": [{ symbolId: "Invoice#format", scope: ["Invoice"] }] });
    const target = new SwiftCallResolver().resolve(
      call("self", "format"),
      ctx({ callerFile: "Sources/Invoice+Codable.swift", callerScope: ["Invoice"], symbolTable: t }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/Invoice.swift", targetSymbolId: "Invoice#format" });
  });

  it("resolves a BARE call to the enclosing type declared in another file", () => {
    const t = table({ "Sources/Invoice.swift": [{ symbolId: "Invoice#format", scope: ["Invoice"] }] });
    const target = new SwiftCallResolver().resolve(
      call(null, "format"),
      ctx({ callerFile: "Sources/Invoice+Codable.swift", callerScope: ["Invoice"], symbolTable: t }),
    );
    expect(target?.targetSymbolId).toBe("Invoice#format");
  });

  it("stays silent when the enclosing type's member is ambiguous across files", () => {
    const t = table({
      "Sources/A.swift": [{ symbolId: "Invoice#format", scope: ["Invoice"] }],
      "Sources/B.swift": [{ symbolId: "Invoice#format", scope: ["Invoice"] }],
    });
    const target = new SwiftCallResolver().resolve(
      call("self", "format"),
      ctx({ callerFile: "Sources/C.swift", callerScope: ["Invoice"], symbolTable: t }),
    );
    expect(target).toBeNull();
  });
});

describe("SwiftCallResolver — globalShortName (terminal, bare calls only)", () => {
  it("resolves a unique bare call by short name", () => {
    const t = table({ "Sources/Format.swift": [{ symbolId: "formatDecimal", scope: [] }] });
    const target = new SwiftCallResolver().resolve(
      call(null, "formatDecimal"),
      ctx({ callerFile: "Sources/Store.swift", symbolTable: t }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/Format.swift", targetSymbolId: "formatDecimal" });
  });

  it("returns null when the bare short name is ambiguous", () => {
    const t = table({
      "Sources/A.swift": [{ symbolId: "render", scope: [] }],
      "Sources/B.swift": [{ symbolId: "render", scope: [] }],
    });
    const target = new SwiftCallResolver().resolve(
      call(null, "render"),
      ctx({ callerFile: "Sources/Store.swift", symbolTable: t }),
    );
    expect(target).toBeNull();
  });

  it("does NOT answer a receiver-bearing call it has no type evidence for", () => {
    // Swift imports name a MODULE, never a symbol, so nothing narrows an
    // unknown receiver. A short-name pin here is a fabricated edge.
    const t = table({ "Sources/Other.swift": [{ symbolId: "Other#doIt", scope: ["Other"] }] });
    const target = new SwiftCallResolver().resolve(
      call("stranger", "doIt"),
      ctx({ callerFile: "Sources/Store.swift", symbolTable: t }),
    );
    expect(target).toBeNull();
  });

  it("leaves `super.member()` unresolved — the supertype is not tracked", () => {
    const t = table({ "Sources/Base.swift": [{ symbolId: "Base#viewDidLoad", scope: ["Base"] }] });
    const target = new SwiftCallResolver().resolve(
      call("super", "viewDidLoad"),
      ctx({ callerFile: "Sources/View.swift", callerScope: ["View"], symbolTable: t }),
    );
    expect(target).toBeNull();
  });

  it("returns null when nothing in the chain matches", () => {
    const target = new SwiftCallResolver().resolve(
      call(null, "ghost"),
      ctx({ callerFile: "Sources/Store.swift", symbolTable: new InMemoryGlobalSymbolTable() }),
    );
    expect(target).toBeNull();
  });
});

describe("SwiftCallResolver — contract", () => {
  it("declares its language", () => {
    expect(new SwiftCallResolver().language).toBe("swift");
  });

  it("answers the miss classifier's denominator over SWIFT declarations only", () => {
    // The chain is Swift-filtered throughout, so the classifier's unfiltered
    // default would charge a miss for a member only a .ts / .rb file declares —
    // a name this resolver could never have resolved.
    const r = new SwiftCallResolver();
    const foreign = table({ "web/store.ts": [{ symbolId: "Store#save", scope: ["Store"] }] });
    expect(r.hasInProjectDefinition(call(null, "save"), ctx({ callerFile: "A.swift", symbolTable: foreign }))).toBe(
      false,
    );
    const native = table({ "Sources/Store.swift": [{ symbolId: "Store#save", scope: ["Store"] }] });
    expect(r.hasInProjectDefinition(call(null, "save"), ctx({ callerFile: "A.swift", symbolTable: native }))).toBe(
      true,
    );
  });

  it("never picks a FOREIGN-language namesake for a Swift call", () => {
    const t = table({ "web/format.ts": [{ symbolId: "formatDecimal", scope: [] }] });
    const target = new SwiftCallResolver().resolve(
      call(null, "formatDecimal"),
      ctx({ callerFile: "Sources/Store.swift", symbolTable: t }),
    );
    expect(target).toBeNull();
  });
});
