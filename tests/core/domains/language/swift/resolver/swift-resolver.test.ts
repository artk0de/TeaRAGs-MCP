/**
 * `SwiftCallResolver` — the nine-pass chain, one describe per pass plus the
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

  it("types an implicit-self property an EXTENSION declares in another file", () => {
    // Swift re-opens a type routinely, and `classFieldTypes` reaches a resolver
    // PER FILE — so a property declared in `Store+DSL.swift` is invisible to a
    // caller in `Store.swift` unless the run-global union is read as well.
    const t = table({ "Sources/Database.swift": [{ symbolId: "Database#write", scope: ["Database"] }] });
    const target = new SwiftCallResolver().resolve(
      call("db", "write"),
      ctx({
        callerFile: "Sources/Store.swift",
        callerScope: ["Store"],
        symbolTable: t,
        classFieldTypesByClassKey: { "Sources/Store+DSL.swift::Store": { db: "Database" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("Database#write");
  });

  it("types an implicit-self property declared on a SUPERCLASS", () => {
    const t = table({ "Sources/EventMonitor.swift": [{ symbolId: "EventMonitor#request", scope: ["EventMonitor"] }] });
    const target = new SwiftCallResolver().resolve(
      call("eventMonitor", "request"),
      ctx({
        callerFile: "Sources/DataRequest.swift",
        callerScope: ["DataRequest"],
        symbolTable: t,
        classExtends: { DataRequest: "Request" },
        classFieldTypesByClassKey: { "Sources/Request.swift::Request": { eventMonitor: "EventMonitor" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("EventMonitor#request");
  });

  it("lets the caller's OWN file outrank the run-global union", () => {
    const t = table({
      "Sources/Local.swift": [{ symbolId: "LocalDatabase#write", scope: ["LocalDatabase"] }],
      "Sources/Global.swift": [{ symbolId: "GlobalDatabase#write", scope: ["GlobalDatabase"] }],
    });
    const target = new SwiftCallResolver().resolve(
      call("db", "write"),
      ctx({
        callerFile: "Sources/Store.swift",
        callerScope: ["Store"],
        symbolTable: t,
        classFieldTypes: { Store: { db: "LocalDatabase" } },
        classFieldTypesByClassKey: { "Sources/Store+DSL.swift::Store": { db: "GlobalDatabase" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("LocalDatabase#write");
  });

  it("refuses a namesake type from ANOTHER LANGUAGE's entry in the shared channel", () => {
    // Go composes the identical `<relPath>::<Type>` key, so a Go `Store` must
    // never type a Swift receiver — the guard `lookupSwiftSymbols` applies to
    // the symbol table, applied to the field channel.
    const t = table({ "Sources/Database.swift": [{ symbolId: "Database#write", scope: ["Database"] }] });
    const target = new SwiftCallResolver().resolve(
      call("db", "write"),
      ctx({
        callerFile: "Sources/Store.swift",
        callerScope: ["Store"],
        symbolTable: t,
        classFieldTypesByClassKey: { "internal/db/store.go::Store": { db: "Database" } },
      }),
    );
    expect(target).toBeNull();
  });
});

describe("SwiftCallResolver — chainedReceiverType", () => {
  it("threads a field-of-a-field receiver hop by hop", () => {
    // `self.session.adapter.adapt()` — two links, each one a stored property
    // whose declared type the walker recorded. No single pass can type this:
    // `storedPropertyType` reads ONE property and declines anything with a
    // second dot in it.
    const t = table({ "Sources/Adapter.swift": [{ symbolId: "Adapter#adapt", scope: ["Adapter"] }] });
    const target = new SwiftCallResolver().resolve(
      call("self.session.adapter", "adapt"),
      ctx({
        callerFile: "Sources/Manager.swift",
        callerScope: ["Manager"],
        symbolTable: t,
        classFieldTypes: { Manager: { session: "Session" }, Session: { adapter: "Adapter" } },
      }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/Adapter.swift", targetSymbolId: "Adapter#adapt" });
  });

  it("seeds the head from a LOCAL binding", () => {
    const t = table({ "Sources/Hooks.swift": [{ symbolId: "HooksPhase#appendBefore", scope: ["HooksPhase"] }] });
    const target = new SwiftCallResolver().resolve(
      call("world.hooks", "appendBefore"),
      ctx({
        callerFile: "Sources/DSL.swift",
        symbolTable: t,
        localBindings: { world: [{ line: 4, type: "World" }] },
        classFieldTypes: { World: { hooks: "HooksPhase" } },
      }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/Hooks.swift", targetSymbolId: "HooksPhase#appendBefore" });
  });

  it("seeds the head from a STORED PROPERTY — Swift's implicit self, one hop up the chain", () => {
    // `currentGroup.hooks.appendBefore()` inside `World`: the head names no
    // local, so it is `self.currentGroup`, exactly as the single-hop pass reads
    // a bare receiver.
    const t = table({ "Sources/Hooks.swift": [{ symbolId: "HooksPhase#appendBefore", scope: ["HooksPhase"] }] });
    const target = new SwiftCallResolver().resolve(
      call("currentGroup.hooks", "appendBefore"),
      ctx({
        callerFile: "Sources/World.swift",
        callerScope: ["World"],
        symbolTable: t,
        classFieldTypes: { World: { currentGroup: "ExampleGroup" }, ExampleGroup: { hooks: "HooksPhase" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("HooksPhase#appendBefore");
  });

  it("seeds the head from a TYPE NAME the project declares — the shared-singleton spelling", () => {
    // `World.sharedWorld.beforeEach()`: `sharedWorld` is a static stored
    // property, and `classFieldTypes` records it beside the instance ones.
    const t = table({
      "Sources/World.swift": [
        { symbolId: "World", scope: [] },
        { symbolId: "World#beforeEach", scope: ["World"] },
      ],
    });
    const target = new SwiftCallResolver().resolve(
      call("World.sharedWorld", "beforeEach"),
      ctx({
        callerFile: "Sources/DSL.swift",
        symbolTable: t,
        classFieldTypes: { World: { sharedWorld: "World" } },
      }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/World.swift", targetSymbolId: "World#beforeEach" });
  });

  it("seeds the head from `Self`, which in a type body IS the enclosing type", () => {
    const t = table({ "Sources/Spec.swift": [{ symbolId: "QuickSpec#recordFailure", scope: ["QuickSpec"] }] });
    const target = new SwiftCallResolver().resolve(
      call("Self.current", "recordFailure"),
      ctx({
        callerFile: "Sources/Spec.swift",
        callerScope: ["QuickSpec"],
        symbolTable: t,
        classFieldTypes: { QuickSpec: { current: "QuickSpec" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("QuickSpec#recordFailure");
  });

  it("reads a field declared by the SUPERCLASS, through the same chain `super` walks", () => {
    // `self.eventMonitor.request()` inside `DataRequest`: `eventMonitor` is
    // declared on `Request`, so the own-type map answers nothing and the
    // single-property pass DROPS. The ancestor walk is what makes the field
    // reachable at all.
    const t = table({ "Sources/EventMonitor.swift": [{ symbolId: "EventMonitor#request", scope: ["EventMonitor"] }] });
    const target = new SwiftCallResolver().resolve(
      call("self.eventMonitor", "request"),
      ctx({
        callerFile: "Sources/DataRequest.swift",
        callerScope: ["DataRequest"],
        symbolTable: t,
        classExtends: { DataRequest: "Request" },
        classFieldTypes: { Request: { eventMonitor: "EventMonitor" } },
      }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/EventMonitor.swift", targetSymbolId: "EventMonitor#request" });
  });

  it("lets a LOCAL shadow the stored property at the head, which is Swift's own scoping", () => {
    const t = table({
      "Sources/Real.swift": [{ symbolId: "RealInner#go", scope: ["RealInner"] }],
      "Sources/Mock.swift": [{ symbolId: "MockInner#go", scope: ["MockInner"] }],
    });
    const target = new SwiftCallResolver().resolve(
      call("db.inner", "go"),
      ctx({
        callerFile: "Sources/Store.swift",
        callerScope: ["Store"],
        symbolTable: t,
        classFieldTypes: {
          Store: { db: "Database" },
          Database: { inner: "RealInner" },
          MockDatabase: { inner: "MockInner" },
        },
        localBindings: { db: [{ line: 5, type: "MockDatabase" }] },
      }),
    );
    expect(target?.targetSymbolId).toBe("MockInner#go");
  });

  it("reads the head binding in force AT the call line, not the first one recorded", () => {
    const t = table({
      "Sources/A.swift": [{ symbolId: "AlphaInner#go", scope: ["AlphaInner"] }],
      "Sources/B.swift": [{ symbolId: "BetaInner#go", scope: ["BetaInner"] }],
    });
    const target = new SwiftCallResolver().resolve(
      call("v.inner", "go", 20),
      ctx({
        callerFile: "Sources/Store.swift",
        symbolTable: t,
        classFieldTypes: { Alpha: { inner: "AlphaInner" }, Beta: { inner: "BetaInner" } },
        localBindings: {
          v: [
            { line: 2, type: "Alpha" },
            { line: 15, type: "Beta" },
          ],
        },
      }),
    );
    expect(target?.targetSymbolId).toBe("BetaInner#go");
  });

  it("STOPS at the first unknown hop instead of walking past it", () => {
    // `self.db.unknown.write()`: `db` types, `unknown` does not. Emitting an
    // edge here would mean guessing what the second link holds, and the decoy
    // is what such a guess would land on.
    const t = table({ "Sources/Other.swift": [{ symbolId: "Other#write", scope: ["Other"] }] });
    const target = new SwiftCallResolver().resolve(
      call("self.db.unknown", "write"),
      ctx({
        callerFile: "Sources/Store.swift",
        callerScope: ["Store"],
        symbolTable: t,
        classFieldTypes: { Store: { db: "Database" } },
      }),
    );
    expect(target).toBeNull();
  });

  it("DROPS a fully-typed receiver whose type declares no such member", () => {
    // `self.body` is a `Data` — a standard-library type. `append` is declared
    // in the project on something else entirely, and the folded type is
    // authoritative: no edge, rather than the namesake.
    const t = table({ "Sources/Buffer.swift": [{ symbolId: "Buffer#append", scope: ["Buffer"] }] });
    const target = new SwiftCallResolver().resolve(
      call("self.body", "append"),
      ctx({
        callerFile: "Sources/Store.swift",
        callerScope: ["Store"],
        symbolTable: t,
        classFieldTypes: { Store: { body: "Data" } },
      }),
    );
    expect(target).toBeNull();
  });

  it("emits nothing for a head the project knows nothing about", () => {
    // `NotificationCenter.default.post()` — the head is a Foundation type, so
    // no channel types it and the fold never starts.
    const t = table({ "Sources/Bus.swift": [{ symbolId: "Bus#post", scope: ["Bus"] }] });
    const target = new SwiftCallResolver().resolve(
      call("NotificationCenter.default", "post"),
      ctx({ callerFile: "Sources/Store.swift", callerScope: ["Store"], symbolTable: t }),
    );
    expect(target).toBeNull();
  });

  it("refuses a chain longer than the hop cap rather than half-walking it", () => {
    // Every link below is typed, so only the cap can decline this receiver.
    const t = table({ "Sources/E.swift": [{ symbolId: "E#go", scope: ["E"] }] });
    const target = new SwiftCallResolver().resolve(
      call("self.a.b.c.d", "go"),
      ctx({
        callerFile: "Sources/Store.swift",
        callerScope: ["Store"],
        symbolTable: t,
        classFieldTypes: {
          Store: { a: "A" },
          A: { b: "B" },
          B: { c: "C" },
          C: { d: "E" },
        },
      }),
    );
    expect(target).toBeNull();
  });

  it("reads a hop's field type from ANOTHER file, through the run-global address", () => {
    // The shape the whole pass exists for. `classFieldTypes` is threaded
    // per-FILE, so `Database`'s own fields are invisible to a caller in
    // `Store.swift`; `classFieldTypesByClassKey` is where they survive the
    // pass-1 barrier, and without this read the chain dies at hop 2.
    const t = table({ "Sources/Inner.swift": [{ symbolId: "Inner#go", scope: ["Inner"] }] });
    const target = new SwiftCallResolver().resolve(
      call("self.db.inner", "go"),
      ctx({
        callerFile: "Sources/Store.swift",
        callerScope: ["Store"],
        symbolTable: t,
        classFieldTypes: { Store: { db: "Database" } },
        classFieldTypesByClassKey: { "Sources/Database.swift::Database": { inner: "Inner" } },
      }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/Inner.swift", targetSymbolId: "Inner#go" });
  });

  it("makes a type SPLIT across files whole again", () => {
    // `struct World` in one file, `extension World` in another. Swift types are
    // routinely re-opened, so one type's fields live under several keys and the
    // reader has to union them or half its properties vanish.
    const t = table({
      "Sources/World.swift": [{ symbolId: "World", scope: [] }],
      "Sources/Hooks.swift": [{ symbolId: "HooksPhase#appendBefore", scope: ["HooksPhase"] }],
    });
    const target = new SwiftCallResolver().resolve(
      call("World.sharedWorld.hooks", "appendBefore"),
      ctx({
        callerFile: "Sources/DSL.swift",
        symbolTable: t,
        classFieldTypesByClassKey: {
          "Sources/World.swift::World": { sharedWorld: "World" },
          "Sources/World+Hooks.swift::World": { hooks: "HooksPhase" },
        },
      }),
    );
    expect(target?.targetSymbolId).toBe("HooksPhase#appendBefore");
  });

  it("lets the caller's OWN file outrank the run-global union", () => {
    // The per-file map is the caller's own source text, not an inference across
    // the run. It is read first, so nothing that resolves today can move.
    const t = table({
      "Sources/Local.swift": [{ symbolId: "LocalInner#go", scope: ["LocalInner"] }],
      "Sources/Global.swift": [{ symbolId: "GlobalInner#go", scope: ["GlobalInner"] }],
    });
    const target = new SwiftCallResolver().resolve(
      call("self.db.inner", "go"),
      ctx({
        callerFile: "Sources/Store.swift",
        callerScope: ["Store"],
        symbolTable: t,
        classFieldTypes: { Store: { db: "Database" }, Database: { inner: "LocalInner" } },
        classFieldTypesByClassKey: { "Sources/Database.swift::Database": { inner: "GlobalInner" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("LocalInner#go");
  });

  it("refuses a namesake type from ANOTHER LANGUAGE's entry in the shared channel", () => {
    // The channel is run-global across every language: Go keys
    // `<relPath>::<Type>` exactly as Swift does, and Go's `Context` must never
    // type a Swift receiver. Same guard `lookupSwiftSymbols` applies to the
    // symbol table, applied to the field channel.
    const t = table({ "Sources/Inner.swift": [{ symbolId: "Inner#go", scope: ["Inner"] }] });
    const target = new SwiftCallResolver().resolve(
      call("self.db.inner", "go"),
      ctx({
        callerFile: "Sources/Store.swift",
        callerScope: ["Store"],
        symbolTable: t,
        classFieldTypes: { Store: { db: "Database" } },
        classFieldTypesByClassKey: { "internal/db/database.go::Database": { inner: "Inner" } },
      }),
    );
    expect(target).toBeNull();
  });

  it("reads a SUPERCLASS's field out of the run-global union too", () => {
    // The ancestor walk and the cross-file read compose: `eventMonitor` is
    // declared on `Request`, in `Request.swift`, and called from
    // `DataRequest.swift`.
    const t = table({ "Sources/EventMonitor.swift": [{ symbolId: "EventMonitor#request", scope: ["EventMonitor"] }] });
    const target = new SwiftCallResolver().resolve(
      call("self.eventMonitor", "request"),
      ctx({
        callerFile: "Sources/DataRequest.swift",
        callerScope: ["DataRequest"],
        symbolTable: t,
        classExtends: { DataRequest: "Request" },
        classFieldTypesByClassKey: { "Sources/Request.swift::Request": { eventMonitor: "EventMonitor" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("EventMonitor#request");
  });

  it("still resolves at exactly the hop cap", () => {
    const t = table({ "Sources/D.swift": [{ symbolId: "D#go", scope: ["D"] }] });
    const target = new SwiftCallResolver().resolve(
      call("self.a.b.c", "go"),
      ctx({
        callerFile: "Sources/Store.swift",
        callerScope: ["Store"],
        symbolTable: t,
        classFieldTypes: { Store: { a: "A" }, A: { b: "B" }, B: { c: "D" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("D#go");
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

/**
 * `super.X()` — chain index 0, and a GUARD: it resolves or it drops, never
 * falls through.
 *
 * Swift's grammar is what keeps the walk linear. An inheritance clause mixes a
 * superclass with protocols and marks neither, but the language requires the
 * superclass to come FIRST, so the first specifier is the only one `super` can
 * mean — which makes `classExtends`, a single-base channel, the right shape
 * rather than a compromise. A class key is the type's SHORT name, safe here in
 * a way it is not in Python: Swift forbids two types of one name in a module,
 * so the short name already identifies the type.
 *
 * Terminality is the other half. A `super` miss that fell through would reach
 * the bare-call and short-name passes, which know nothing about `super` and
 * would pin the call to an unrelated namesake — the false-edge family recorded
 * as bd tea-rags-mcp-4rgg for TypeScript and bd tea-rags-mcp-pic4 for Python.
 */
describe("SwiftCallResolver — super", () => {
  it("resolves `super.X()` to the superclass member", () => {
    const t = table({
      "Sources/Base.swift": [{ symbolId: "Base#reset", scope: ["Base"] }],
      "Sources/Derived.swift": [{ symbolId: "Derived#reset", scope: ["Derived"] }],
    });
    const target = new SwiftCallResolver().resolve(
      call("super", "reset"),
      ctx({
        callerFile: "Sources/Derived.swift",
        callerScope: ["Derived"],
        symbolTable: t,
        classExtends: { Derived: "Base" },
      }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/Base.swift", targetSymbolId: "Base#reset" });
  });

  it("starts the walk AFTER the enclosing class, so the caller's own override never answers", () => {
    // `Derived#reset` calling `super.reset()` is the canonical override shape.
    // Answering with the caller's own member would make the edge a self-loop
    // and hide the call the developer actually made.
    const t = table({
      "Sources/Base.swift": [{ symbolId: "Base#reset", scope: ["Base"] }],
      "Sources/Derived.swift": [{ symbolId: "Derived#reset", scope: ["Derived"] }],
    });
    const target = new SwiftCallResolver().resolve(
      call("super", "reset"),
      ctx({
        callerFile: "Sources/Derived.swift",
        callerScope: ["Derived"],
        symbolTable: t,
        classExtends: { Derived: "Base" },
      }),
    );
    expect(target?.targetSymbolId).not.toBe("Derived#reset");
  });

  it("keeps walking past a superclass that does not declare the member", () => {
    const t = table({
      "Sources/Root.swift": [{ symbolId: "Root#describe", scope: ["Root"] }],
      "Sources/Middle.swift": [{ symbolId: "Middle#other", scope: ["Middle"] }],
    });
    const target = new SwiftCallResolver().resolve(
      call("super", "describe"),
      ctx({
        callerFile: "Sources/Leaf.swift",
        callerScope: ["Leaf"],
        symbolTable: t,
        classExtends: { Leaf: "Middle", Middle: "Root" },
      }),
    );
    expect(target?.targetSymbolId).toBe("Root#describe");
  });

  it("resolves a static member on the superclass when only the `.` form exists", () => {
    const t = table({ "Sources/Base.swift": [{ symbolId: "Base.make", scope: ["Base"] }] });
    const target = new SwiftCallResolver().resolve(
      call("super", "make"),
      ctx({
        callerFile: "Sources/Derived.swift",
        callerScope: ["Derived"],
        symbolTable: t,
        classExtends: { Derived: "Base" },
      }),
    );
    expect(target?.targetSymbolId).toBe("Base.make");
  });

  it("DROPS rather than falling through to a same-named member of an unrelated type", () => {
    // Nothing on the hierarchy declares `render`, but another type does. The
    // terminal passes would pin it; `super` must not let them.
    const t = table({
      "Sources/Base.swift": [{ symbolId: "Base#other", scope: ["Base"] }],
      "Sources/Unrelated.swift": [{ symbolId: "Unrelated#render", scope: ["Unrelated"] }],
    });
    const target = new SwiftCallResolver().resolve(
      call("super", "render"),
      ctx({
        callerFile: "Sources/Derived.swift",
        callerScope: ["Derived"],
        symbolTable: t,
        classExtends: { Derived: "Base" },
      }),
    );
    expect(target).toBeNull();
  });

  it("DROPS when the index carries no inheritance at all, rather than guessing", () => {
    const t = table({ "Sources/Unrelated.swift": [{ symbolId: "Unrelated#render", scope: ["Unrelated"] }] });
    const target = new SwiftCallResolver().resolve(
      call("super", "render"),
      ctx({ callerFile: "Sources/Derived.swift", callerScope: ["Derived"], symbolTable: t }),
    );
    expect(target).toBeNull();
  });

  it("terminates on a cyclic inheritance record instead of looping", () => {
    // A cycle cannot occur in compilable Swift, but an index can carry one from
    // a partially-rewritten tree. The walk must end.
    const t = table({ "Sources/Unrelated.swift": [{ symbolId: "Unrelated#render", scope: ["Unrelated"] }] });
    const target = new SwiftCallResolver().resolve(
      call("super", "render"),
      ctx({
        callerFile: "Sources/A.swift",
        callerScope: ["A"],
        symbolTable: t,
        classExtends: { A: "B", B: "A" },
      }),
    );
    expect(target).toBeNull();
  });
});
