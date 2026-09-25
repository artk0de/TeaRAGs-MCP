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

/**
 * bd tea-rags-mcp-y99pg.36 — same-named nested types in one file. The walker
 * publishes each under its nesting path, and the short name keeps only what
 * every namesake agrees on; the enclosing type's fields are read by path.
 */
describe("SwiftCallResolver — a nested type's fields beside a same-named namesake", () => {
  const t = table({
    "Source/Core/Request.swift": [{ symbolId: "Request#cancel", scope: ["Request"] }],
    "Source/Core/DownloadRequest.swift": [{ symbolId: "DownloadRequest#cancel", scope: ["DownloadRequest"] }],
    "Source/Features/Combine.swift": [
      { symbolId: "DataResponsePublisher.Inner", scope: ["DataResponsePublisher"] },
      { symbolId: "DownloadResponsePublisher.Inner", scope: ["DownloadResponsePublisher"] },
    ],
  });
  const fields = {
    "DataResponsePublisher.Inner": { request: "DataRequest" },
    "DownloadResponsePublisher.Inner": { request: "DownloadRequest" },
  };

  it("types an implicit-self property through the enclosing type's nesting path", () => {
    const target = new SwiftCallResolver().resolve(
      call("request", "cancel", 486),
      ctx({
        callerFile: "Source/Features/Combine.swift",
        callerScope: ["DownloadResponsePublisher", "Inner"],
        symbolTable: t,
        classFieldTypes: fields,
      }),
    );
    expect(target).toEqual({
      targetRelPath: "Source/Core/DownloadRequest.swift",
      targetSymbolId: "DownloadRequest#cancel",
    });
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
    // INVARIANT CHANGED (bd tea-rags-mcp-y99pg.34): the cap moved from three
    // links to five, so the refused chain carries six (was `self.a.b.c.d`).
    const t = table({ "Sources/E.swift": [{ symbolId: "E#go", scope: ["E"] }] });
    const target = new SwiftCallResolver().resolve(
      call("self.a.b.c.d.e.f", "go"),
      ctx({
        callerFile: "Sources/Store.swift",
        callerScope: ["Store"],
        symbolTable: t,
        classFieldTypes: {
          Store: { a: "A" },
          A: { b: "B" },
          B: { c: "C" },
          C: { d: "D" },
          D: { e: "F" },
          F: { f: "E" },
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

  // bd tea-rags-mcp-3ievc — a nested type's scope is `["Outer", "Inner"]`
  // while its members compose as `Outer.Inner#m`, so the enclosing type has to
  // be read QUALIFIED, and a bare name walks the lexical scopes outward the way
  // Swift's unqualified lookup does.
  it("resolves a bare call inside a NESTED type to that type's qualified member", () => {
    const t = table({ "Sources/Outer.swift": [{ symbolId: "Outer.Inner#helper", scope: ["Outer", "Inner"] }] });
    const target = new SwiftCallResolver().resolve(
      call(null, "helper"),
      ctx({ callerFile: "Sources/Outer.swift", callerScope: ["Outer", "Inner"], symbolTable: t }),
    );
    expect(target?.targetSymbolId).toBe("Outer.Inner#helper");
  });

  it("lets the innermost type's member shadow the outer type's namesake", () => {
    const t = table({
      "Sources/Outer.swift": [
        { symbolId: "Outer.Inner.make", scope: ["Outer", "Inner"] },
        { symbolId: "Outer.make", scope: ["Outer"] },
      ],
    });
    const target = new SwiftCallResolver().resolve(
      call(null, "make"),
      ctx({ callerFile: "Sources/Outer.swift", callerScope: ["Outer", "Inner"], symbolTable: t }),
    );
    expect(target?.targetSymbolId).toBe("Outer.Inner.make");
  });

  it("walks OUTWARD to a sibling nested type — the construction `Options(rawValue:)` inside `Options`", () => {
    // A type chunk's own calls run in the type (its bodyScope), so a static
    // initializer constructing the type itself is found one scope further out.
    const t = table({
      "Sources/Download.swift": [
        { symbolId: "Download.Options", scope: ["Download"] },
        { symbolId: "Options", scope: [] },
      ],
      "Sources/Other.swift": [{ symbolId: "Options", scope: [] }],
    });
    const target = new SwiftCallResolver().resolve(
      call(null, "Options"),
      ctx({ callerFile: "Sources/Download.swift", callerScope: ["Download", "Options"], symbolTable: t }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/Download.swift", targetSymbolId: "Download.Options" });
  });

  it("skips a FUNCTION scope — a local function's bare call reaches the enclosing type", () => {
    const t = table({ "Sources/Store.swift": [{ symbolId: "Store#helper", scope: ["Store"] }] });
    const target = new SwiftCallResolver().resolve(
      call(null, "helper"),
      ctx({ callerFile: "Sources/Store.swift", callerScope: ["Store", "run"], symbolTable: t }),
    );
    expect(target?.targetSymbolId).toBe("Store#helper");
  });
});

describe("SwiftCallResolver — selfMember in nested scopes (bd tea-rags-mcp-3ievc)", () => {
  it("reads `self` as the innermost TYPE, qualified", () => {
    const t = table({
      "Sources/Outer.swift": [
        { symbolId: "Outer.Inner#helper", scope: ["Outer", "Inner"] },
        { symbolId: "Outer#helper", scope: ["Outer"] },
      ],
    });
    const target = new SwiftCallResolver().resolve(
      call("self", "helper"),
      ctx({ callerFile: "Sources/Outer.swift", callerScope: ["Outer", "Inner"], symbolTable: t }),
    );
    expect(target?.targetSymbolId).toBe("Outer.Inner#helper");
  });

  it("never reads `self` as an OUTER type — a nested type has no implicit outer self", () => {
    const t = table({ "Sources/Outer.swift": [{ symbolId: "Outer#helper", scope: ["Outer"] }] });
    const target = new SwiftCallResolver().resolve(
      call("self", "helper"),
      ctx({ callerFile: "Sources/Outer.swift", callerScope: ["Outer", "Inner"], symbolTable: t }),
    );
    expect(target).toBeNull();
  });

  it("reads `self` inside a local function as the type enclosing that function", () => {
    const t = table({ "Sources/Store.swift": [{ symbolId: "Store#helper", scope: ["Store"] }] });
    const target = new SwiftCallResolver().resolve(
      call("self", "helper"),
      ctx({ callerFile: "Sources/Store.swift", callerScope: ["Store", "run"], symbolTable: t }),
    );
    expect(target?.targetSymbolId).toBe("Store#helper");
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

describe("SwiftCallResolver — call-result and cast receiver heads (bd tea-rags-mcp-kkwg3, ll93g)", () => {
  const t = table({
    "Sources/Provider.swift": [{ symbolId: "Provider#request", scope: ["Provider"] }],
    "Sources/Request.swift": [
      { symbolId: "Request", scope: [] },
      { symbolId: "Request#didFail", scope: ["Request"] },
    ],
    "Sources/Upload.swift": [{ symbolId: "Upload", scope: [] }],
  });

  it("types a CALL hop by the callee's published return type", () => {
    // `provider.request(for: task.id).didFail()` — the dot inside the argument
    // list belongs to the argument, not to the chain.
    const target = new SwiftCallResolver().resolve(
      call("provider.request(for: task.id)", "didFail"),
      ctx({
        callerFile: "Sources/Delegate.swift",
        symbolTable: t,
        localBindings: { provider: [{ line: 5, type: "Provider" }] },
        structuredReturnTypes: { "Provider#request": { form: "instance", name: "Request" } },
      }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/Request.swift", targetSymbolId: "Request#didFail" });
  });

  it("reads the return type of the method the call ACTUALLY lands on, inherited ones included", () => {
    const target = new SwiftCallResolver().resolve(
      call("upload.request(for: x)", "didFail"),
      ctx({
        callerFile: "Sources/Delegate.swift",
        symbolTable: t,
        classExtends: { Upload: "Provider" },
        localBindings: { upload: [{ line: 5, type: "Upload" }] },
        structuredReturnTypes: { "Provider#request": { form: "instance", name: "Request" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("Request#didFail");
  });

  it("emits nothing for a call hop whose callee publishes no return type", () => {
    const target = new SwiftCallResolver().resolve(
      call("provider.request(for: x)", "didFail"),
      ctx({
        callerFile: "Sources/Delegate.swift",
        symbolTable: t,
        localBindings: { provider: [{ line: 5, type: "Provider" }] },
      }),
    );
    expect(target).toBeNull();
  });

  it("types a PARENTHESISED CAST head by the type it names", () => {
    for (const receiver of ["(value as Request)", "(value as? Request)", "(value as! Request)"]) {
      const target = new SwiftCallResolver().resolve(
        call(receiver, "didFail"),
        ctx({ callerFile: "Sources/Delegate.swift", symbolTable: t }),
      );
      expect(target?.targetSymbolId).toBe("Request#didFail");
    }
  });

  it("threads a cast head through a further hop", () => {
    const target = new SwiftCallResolver().resolve(
      call("(value as Provider).request(for: x)", "didFail"),
      ctx({
        callerFile: "Sources/Delegate.swift",
        symbolTable: t,
        structuredReturnTypes: { "Provider#request": { form: "instance", name: "Request" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("Request#didFail");
  });

  it("types an ARRAY or DICTIONARY literal head as the collection it builds", () => {
    // Swift spells `[a, b]` an `Array` and `[k: v]` a `Dictionary`; a member
    // only the project's own `extension Array` declares is then reachable.
    const withExtensions = table({
      "Sources/Array+Ext.swift": [{ symbolId: "Array#joinedWithAmpersands", scope: ["Array"] }],
      "Sources/Dictionary+Ext.swift": [{ symbolId: "Dictionary#merged", scope: ["Dictionary"] }],
    });
    const array = new SwiftCallResolver().resolve(
      call("[first, second]", "joinedWithAmpersands"),
      ctx({ callerFile: "Sources/Encoder.swift", symbolTable: withExtensions }),
    );
    expect(array?.targetSymbolId).toBe("Array#joinedWithAmpersands");
    const dictionary = new SwiftCallResolver().resolve(
      call('["a": 1]', "merged"),
      ctx({ callerFile: "Sources/Encoder.swift", symbolTable: withExtensions }),
    );
    expect(dictionary?.targetSymbolId).toBe("Dictionary#merged");
  });

  it("types a collection cast as the collection, and DROPs a member the project never declares on it", () => {
    // `(allHeaderFields as [String: String]).map` is a `Dictionary.map` — the
    // standard library's, which no project symbol answers.
    const target = new SwiftCallResolver().resolve(
      call("(value as [String: String])", "map"),
      ctx({ callerFile: "Sources/Delegate.swift", symbolTable: t }),
    );
    expect(target).toBeNull();
  });
});

describe("SwiftCallResolver — a SHORT type name reaches its NESTED declaration", () => {
  // A walker type fact is the name as WRITTEN — `let token: CancellationToken`
  // inside `DataStreamRequest` — while the type composes as
  // `DataStreamRequest.CancellationToken`. Swift resolves the written name
  // lexically; so must the member lookup.
  it("qualifies a field's short type name to the one nested type declaring it", () => {
    const t = table({
      "Sources/Stream.swift": [
        { symbolId: "DataStreamRequest.CancellationToken", scope: ["DataStreamRequest"] },
        { symbolId: "DataStreamRequest.CancellationToken#cancel", scope: ["DataStreamRequest", "CancellationToken"] },
      ],
    });
    const target = new SwiftCallResolver().resolve(
      call("token", "cancel"),
      ctx({
        callerFile: "Sources/Stream.swift",
        callerScope: ["DataStreamRequest", "Stream"],
        symbolTable: t,
        classFieldTypes: { Stream: { token: "CancellationToken" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("DataStreamRequest.CancellationToken#cancel");
  });

  const twoStates = table({
    "Sources/Request.swift": [
      { symbolId: "Request.State", scope: ["Request"] },
      { symbolId: "Request.State#canTransitionTo", scope: ["Request", "State"] },
    ],
    "Sources/Socket.swift": [
      { symbolId: "Socket.State", scope: ["Socket"] },
      { symbolId: "Socket.State#canTransitionTo", scope: ["Socket", "State"] },
    ],
  });

  it("picks the namesake nested in the CALLER's own enclosing type when several exist", () => {
    const target = new SwiftCallResolver().resolve(
      call("state", "canTransitionTo"),
      ctx({
        callerFile: "Sources/Request.swift",
        callerScope: ["Request"],
        symbolTable: twoStates,
        localBindings: { state: [{ line: 5, type: "State" }] },
      }),
    );
    expect(target?.targetSymbolId).toBe("Request.State#canTransitionTo");
  });

  // A FIELD's type is written inside the type that declares the field, so Swift
  // resolves it from THERE outward — not from wherever the call happens to sit.
  // `mutableState.state` called in `DownloadRequest` reads `state: State`
  // written in `Request.MutableState`, which means `Request.State` even though
  // no scope of the caller mentions `Request`.
  const nestedFieldTable = table({
    "Sources/Request.swift": [
      { symbolId: "Request", scope: [] },
      { symbolId: "Request.MutableState", scope: ["Request"] },
      { symbolId: "Request.State", scope: ["Request"] },
      { symbolId: "Request.State#canTransitionTo", scope: ["Request", "State"] },
    ],
    "Sources/Socket.swift": [
      { symbolId: "Socket.State", scope: ["Socket"] },
      { symbolId: "Socket.State#canTransitionTo", scope: ["Socket", "State"] },
    ],
    "Sources/Download.swift": [{ symbolId: "DownloadRequest#cancel", scope: ["DownloadRequest"] }],
  });
  const nestedFieldFacts = {
    "Sources/Request.swift::Request": { mutableState: "MutableState" },
    "Sources/Request.swift::MutableState": { state: "State" },
  };

  it("qualifies a field's type from the type that DECLARES the field, not from the caller", () => {
    const target = new SwiftCallResolver().resolve(
      call("mutableState.state", "canTransitionTo"),
      ctx({
        callerFile: "Sources/Download.swift",
        callerScope: ["DownloadRequest"],
        symbolTable: nestedFieldTable,
        classExtends: { DownloadRequest: "Request" },
        classFieldTypesByClassKey: nestedFieldFacts,
      }),
    );
    expect(target?.targetSymbolId).toBe("Request.State#canTransitionTo");
  });

  it("types a subclass's implicit-self field hop by hop through the base's nested types", () => {
    const target = new SwiftCallResolver().resolve(
      call("self.mutableState.state", "canTransitionTo"),
      ctx({
        callerFile: "Sources/Download.swift",
        callerScope: ["DownloadRequest"],
        symbolTable: nestedFieldTable,
        classExtends: { DownloadRequest: "Request" },
        classFieldTypesByClassKey: nestedFieldFacts,
      }),
    );
    expect(target?.targetSymbolId).toBe("Request.State#canTransitionTo");
  });

  it("stays silent when several nested namesakes exist and none encloses the caller", () => {
    const target = new SwiftCallResolver().resolve(
      call("state", "canTransitionTo"),
      ctx({
        callerFile: "Sources/Other.swift",
        callerScope: ["Other"],
        symbolTable: twoStates,
        localBindings: { state: [{ line: 5, type: "State" }] },
      }),
    );
    expect(target).toBeNull();
  });

  it("keeps a TOP-LEVEL declaration of the name ahead of any nested namesake", () => {
    const t = table({
      "Sources/State.swift": [
        { symbolId: "State", scope: [] },
        { symbolId: "State#canTransitionTo", scope: ["State"] },
      ],
      "Sources/Request.swift": [
        { symbolId: "Request.State", scope: ["Request"] },
        { symbolId: "Request.State#canTransitionTo", scope: ["Request", "State"] },
      ],
    });
    const target = new SwiftCallResolver().resolve(
      call("state", "canTransitionTo"),
      ctx({
        callerFile: "Sources/Other.swift",
        callerScope: ["Other"],
        symbolTable: t,
        localBindings: { state: [{ line: 5, type: "State" }] },
      }),
    );
    expect(target?.targetSymbolId).toBe("State#canTransitionTo");
  });
});

describe("SwiftCallResolver — a member INHERITED from the superclass", () => {
  // `DataRequest: Request` — `resume()` / `cancel()` live on `Request`, and a
  // receiver typed `DataRequest` (a local, a stored property, `self`) dispatches
  // there statically unless the subclass overrides.
  const hierarchy = {
    "Sources/Request.swift": [
      { symbolId: "Request", scope: [] },
      { symbolId: "Request#resume", scope: ["Request"] },
      { symbolId: "Request#cancel", scope: ["Request"] },
    ],
    "Sources/DataRequest.swift": [
      { symbolId: "DataRequest", scope: [] },
      { symbolId: "DataRequest#cancel", scope: ["DataRequest"] },
    ],
  };
  const classExtends = { DataRequest: "Request" };

  it("resolves a call on a LOCAL of the subclass type to the superclass's member", () => {
    const target = new SwiftCallResolver().resolve(
      call("req", "resume"),
      ctx({
        callerFile: "Sources/Task.swift",
        symbolTable: table(hierarchy),
        classExtends,
        localBindings: { req: [{ line: 5, type: "DataRequest" }] },
      }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/Request.swift", targetSymbolId: "Request#resume" });
  });

  it("lets the subclass's OWN override win over the inherited member", () => {
    const target = new SwiftCallResolver().resolve(
      call("req", "cancel"),
      ctx({
        callerFile: "Sources/Task.swift",
        symbolTable: table(hierarchy),
        classExtends,
        localBindings: { req: [{ line: 5, type: "DataRequest" }] },
      }),
    );
    expect(target?.targetSymbolId).toBe("DataRequest#cancel");
  });

  it("resolves a STORED PROPERTY of the subclass type to the superclass's member", () => {
    const target = new SwiftCallResolver().resolve(
      call("request", "resume"),
      ctx({
        callerFile: "Sources/Task.swift",
        callerScope: ["DataTask"],
        symbolTable: table(hierarchy),
        classExtends,
        classFieldTypes: { DataTask: { request: "DataRequest" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("Request#resume");
  });

  it("resolves `self.member()` and a bare call inside the subclass to the inherited member", () => {
    for (const receiver of ["self", null]) {
      const target = new SwiftCallResolver().resolve(
        call(receiver, "resume"),
        ctx({
          callerFile: "Sources/DataRequest.swift",
          callerScope: ["DataRequest"],
          symbolTable: table(hierarchy),
          classExtends,
        }),
      );
      expect(target?.targetSymbolId).toBe("Request#resume");
    }
  });

  it("does NOT fall through to the superclass when the subclass's own member is AMBIGUOUS", () => {
    // Two files declaring `DataRequest#resume` is a cross-file ambiguity the
    // strict gate drops; answering with `Request#resume` instead would pick the
    // one declaration the source provably does NOT call.
    const t = table({
      ...hierarchy,
      "Sources/A.swift": [{ symbolId: "DataRequest#resume", scope: ["DataRequest"] }],
      "Sources/B.swift": [{ symbolId: "DataRequest#resume", scope: ["DataRequest"] }],
    });
    const target = new SwiftCallResolver().resolve(
      call("req", "resume"),
      ctx({
        callerFile: "Sources/Task.swift",
        symbolTable: t,
        classExtends,
        localBindings: { req: [{ line: 5, type: "DataRequest" }] },
      }),
    );
    expect(target).toBeNull();
  });
});

/**
 * `typeDeclarations` (bd tea-rags-mcp-y99pg.1) — which file DECLARES a type and
 * which only re-opens it. Both compose the same id, so without this fact a type
 * extended in another file reads as ambiguous, and a type the project only
 * extends reads as one it declares.
 */
describe("SwiftCallResolver — a type's declaration versus its re-openings", () => {
  const reopened = table({
    "Sources/World.swift": [{ symbolId: "World", scope: [] }],
    "Sources/World+DSL.swift": [{ symbolId: "World", scope: [] }],
    "Sources/Spec.swift": [{ symbolId: "Spec#run", scope: ["Spec"] }],
  });
  const reopenedFacts = {
    "Sources/World.swift": [{ typeId: "World", reopens: false }],
    "Sources/World+DSL.swift": [{ typeId: "World", reopens: true }],
  };

  it("lands a construction of a type re-opened in another file on the file that declares it", () => {
    const target = new SwiftCallResolver().resolve(
      call(null, "World"),
      ctx({
        callerFile: "Sources/Spec.swift",
        callerScope: ["Spec"],
        symbolTable: reopened,
        typeDeclarations: reopenedFacts,
      }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/World.swift", targetSymbolId: "World" });
  });

  it("keeps the cross-file ambiguity when no run published the fact", () => {
    const target = new SwiftCallResolver().resolve(
      call(null, "World"),
      ctx({ callerFile: "Sources/Spec.swift", callerScope: ["Spec"], symbolTable: reopened }),
    );
    expect(target).toBeNull();
  });

  const extendedOnly = table({
    "Sources/JSONDecoder+Alamofire.swift": [{ symbolId: "JSONDecoder", scope: [] }],
    "Sources/Request.swift": [{ symbolId: "Request#decode", scope: ["Request"] }],
  });
  const extendedOnlyFacts = {
    "Sources/JSONDecoder+Alamofire.swift": [{ typeId: "JSONDecoder", reopens: true, conforms: ["DataDecoder"] }],
  };

  it("emits no edge for a construction of a type the project only extends", () => {
    const resolver = new SwiftCallResolver();
    const site = call(null, "JSONDecoder");
    const context = ctx({
      callerFile: "Sources/Request.swift",
      callerScope: ["Request"],
      symbolTable: extendedOnly,
      typeDeclarations: extendedOnlyFacts,
    });
    expect(resolver.resolve(site, context)).toBeNull();
    // The SDK's initializer is what runs — nothing in the project defines it.
    expect(resolver.hasInProjectDefinition(site, context)).toBe(false);
  });

  it("keeps the edge and the denominator when an extension declares an initializer", () => {
    const withInit = table({
      "Sources/URLRequest+Alamofire.swift": [
        { symbolId: "URLRequest", scope: [] },
        { symbolId: "URLRequest#init", scope: ["URLRequest"] },
      ],
      "Sources/Session.swift": [{ symbolId: "Session#request", scope: ["Session"] }],
    });
    const resolver = new SwiftCallResolver();
    const site = call(null, "URLRequest");
    const context = ctx({
      callerFile: "Sources/Session.swift",
      callerScope: ["Session"],
      symbolTable: withInit,
      typeDeclarations: { "Sources/URLRequest+Alamofire.swift": [{ typeId: "URLRequest", reopens: true }] },
    });
    // Which initializer runs is an argument-label question; a call carrying
    // no label evidence keeps the edge into the extension that declares one
    // (label-narrowed below, bd tea-rags-mcp-y99pg.15).
    expect(resolver.resolve(site, context)).toEqual({
      targetRelPath: "Sources/URLRequest+Alamofire.swift",
      targetSymbolId: "URLRequest",
    });
    expect(resolver.hasInProjectDefinition(site, context)).toBe(true);
  });
});

/**
 * Conformances (bd tea-rags-mcp-y99pg.4) — a member a PROTOCOL declares, or a
 * protocol extension provides, is reachable from every type conforming to it,
 * and Swift declares conformances in extensions as often as on the type:
 * `extension SecTrust: AlamofireExtended {}` is what makes `trust.af` exist.
 */
describe("SwiftCallResolver — members reached through protocol conformances", () => {
  const afTable = table({
    "Sources/AlamofireExtended.swift": [
      { symbolId: "AlamofireExtension", scope: [] },
      { symbolId: "AlamofireExtended", scope: [] },
    ],
    "Sources/ServerTrust.swift": [
      { symbolId: "SecTrust", scope: [] },
      { symbolId: "AlamofireExtension#performValidation", scope: ["AlamofireExtension"] },
      { symbolId: "Evaluator#evaluate", scope: ["Evaluator"] },
    ],
  });
  const afDeclarations = {
    "Sources/AlamofireExtended.swift": [
      { typeId: "AlamofireExtension", reopens: false },
      { typeId: "AlamofireExtended", reopens: false },
      { typeId: "AlamofireExtended", reopens: true },
    ],
    "Sources/ServerTrust.swift": [
      { typeId: "SecTrust", reopens: true, conforms: ["AlamofireExtended"] },
      { typeId: "AlamofireExtension", reopens: true },
    ],
  };

  it("types a property a protocol extension provides to a type that conforms in an extension", () => {
    const target = new SwiftCallResolver().resolve(
      call("trust.af", "performValidation"),
      ctx({
        callerFile: "Sources/ServerTrust.swift",
        callerScope: ["Evaluator"],
        symbolTable: afTable,
        typeDeclarations: afDeclarations,
        localBindings: { trust: [{ line: 5, type: "SecTrust" }] },
        classFieldTypesByClassKey: {
          "Sources/AlamofireExtended.swift::AlamofireExtended": { af: "AlamofireExtension" },
        },
      }),
    );
    expect(target?.targetSymbolId).toBe("AlamofireExtension#performValidation");
  });

  const monitorTable = table({
    "Sources/Monitor.swift": [
      { symbolId: "Monitor", scope: [] },
      { symbolId: "Monitor#tick", scope: ["Monitor"] },
    ],
    "Sources/Clock.swift": [
      { symbolId: "Clock", scope: [] },
      { symbolId: "Clock#run", scope: ["Clock"] },
      { symbolId: "Base", scope: [] },
    ],
  });
  const monitorDeclarations = {
    "Sources/Monitor.swift": [
      { typeId: "Monitor", reopens: false },
      { typeId: "Monitor", reopens: true },
    ],
    "Sources/Clock.swift": [
      { typeId: "Clock", reopens: false, conforms: ["Base", "Monitor"] },
      { typeId: "Base", reopens: false },
    ],
  };

  it("dispatches a typed receiver's call to the protocol member its type conforms to", () => {
    const target = new SwiftCallResolver().resolve(
      call("clock", "tick"),
      ctx({
        callerFile: "Sources/Clock.swift",
        callerScope: ["Clock"],
        symbolTable: monitorTable,
        typeDeclarations: monitorDeclarations,
        classExtends: { Clock: "Base" },
        localBindings: { clock: [{ line: 5, type: "Clock" }] },
      }),
    );
    expect(target?.targetSymbolId).toBe("Monitor#tick");
  });

  it("never sends `super` into a protocol — only the superclass chain answers it", () => {
    const target = new SwiftCallResolver().resolve(
      call("super", "tick"),
      ctx({
        callerFile: "Sources/Clock.swift",
        callerScope: ["Clock"],
        symbolTable: monitorTable,
        typeDeclarations: monitorDeclarations,
        classExtends: { Clock: "Base" },
      }),
    );
    expect(target).toBeNull();
  });
});

/**
 * A local recorded by its right-hand side's SPELLING (`callResultBindings`) is
 * typed by folding that spelling as a receiver chain (bd tea-rags-mcp-y99pg.6).
 */
describe("SwiftCallResolver — locals bound to a value chain", () => {
  const t = table({
    "Sources/Manager.swift": [
      { symbolId: "Manager", scope: [] },
      { symbolId: "Manager#evaluator", scope: ["Manager"] },
    ],
    "Sources/Evaluating.swift": [
      { symbolId: "Evaluating", scope: [] },
      { symbolId: "Evaluating#evaluate", scope: ["Evaluating"] },
    ],
    "Sources/Delegate.swift": [
      { symbolId: "Delegate", scope: [] },
      { symbolId: "Delegate#evaluate", scope: ["Delegate"] },
    ],
  });
  const base = {
    callerFile: "Sources/Delegate.swift",
    callerScope: ["Delegate", "go"],
    symbolTable: t,
    localBindings: { manager: [{ line: 2, type: "Manager" }] },
    structuredReturnTypes: { "Manager#evaluator": { form: "instance" as const, name: "Evaluating" } },
  };

  it("folds the spelling to type a bare receiver", () => {
    const target = new SwiftCallResolver().resolve(
      call("evaluator", "evaluate", 6),
      ctx({ ...base, callResultBindings: { evaluator: [{ line: 5, callee: "manager.evaluator" }] } }),
    );
    expect(target?.targetSymbolId).toBe("Evaluating#evaluate");
  });

  it("folds it for the head of a dotted receiver too", () => {
    const tt = table({
      "Sources/Evaluating.swift": [
        { symbolId: "Evaluating", scope: [] },
        { symbolId: "Policy", scope: [] },
        { symbolId: "Policy#check", scope: ["Policy"] },
      ],
      "Sources/Manager.swift": [{ symbolId: "Manager#evaluator", scope: ["Manager"] }],
    });
    const target = new SwiftCallResolver().resolve(
      call("evaluator.policy", "check", 6),
      ctx({
        ...base,
        symbolTable: tt,
        classFieldTypesByClassKey: { "Sources/Evaluating.swift::Evaluating": { policy: "Policy" } },
        callResultBindings: { evaluator: [{ line: 5, callee: "manager.evaluator" }] },
      }),
    );
    expect(target?.targetSymbolId).toBe("Policy#check");
  });

  it("never lets a local's own right-hand side read the local it binds", () => {
    // `var manager = manager.evaluator` — the right-hand side names the
    // PARAMETER above, not the local being declared.
    const target = new SwiftCallResolver().resolve(
      call("manager", "evaluate", 6),
      ctx({ ...base, callResultBindings: { manager: [{ line: 5, callee: "manager.evaluator" }] } }),
    );
    expect(target?.targetSymbolId).toBe("Evaluating#evaluate");
  });

  it("a later typed binding shadows an earlier spelling", () => {
    const target = new SwiftCallResolver().resolve(
      call("evaluator", "evaluate", 8),
      ctx({
        ...base,
        localBindings: { ...base.localBindings, evaluator: [{ line: 7, type: "Delegate" }] },
        callResultBindings: { evaluator: [{ line: 5, callee: "manager.evaluator" }] },
      }),
    );
    expect(target?.targetSymbolId).toBe("Delegate#evaluate");
  });

  it("a spelling it cannot fold leaves the receiver to the passes after it, as an unrecorded local did", () => {
    const target = new SwiftCallResolver().resolve(
      call("evaluator", "evaluate", 6),
      ctx({
        ...base,
        classFieldTypes: { Delegate: { evaluator: "Evaluating" } },
        callResultBindings: { evaluator: [{ line: 5, callee: "unknown.thing" }] },
      }),
    );
    expect(target?.targetSymbolId).toBe("Evaluating#evaluate");
  });
});

/**
 * `NotificationCenter.default`, `DispatchQueue.main`, `URLSession.shared` — a
 * type's own singleton, named by Swift's API convention, is an instance of the
 * type, and a project extension of that type is where its calls land
 * (bd tea-rags-mcp-y99pg.5).
 */
describe("SwiftCallResolver — a type's conventional singleton", () => {
  const t = table({
    "Sources/Notifications.swift": [
      { symbolId: "NotificationCenter", scope: [] },
      { symbolId: "NotificationCenter#postNotification", scope: ["NotificationCenter"] },
    ],
    "Sources/Config.swift": [
      { symbolId: "Config", scope: [] },
      { symbolId: "Settings", scope: [] },
      { symbolId: "Settings#reload", scope: ["Settings"] },
      { symbolId: "Config#reload", scope: ["Config"] },
    ],
  });
  const declarations = {
    "Sources/Notifications.swift": [{ typeId: "NotificationCenter", reopens: true }],
    "Sources/Config.swift": [
      { typeId: "Config", reopens: false },
      { typeId: "Settings", reopens: false },
    ],
  };

  it("types `Type.default` as the type itself", () => {
    const target = new SwiftCallResolver().resolve(
      call("NotificationCenter.default", "postNotification"),
      ctx({ callerFile: "Sources/Request.swift", symbolTable: t, typeDeclarations: declarations }),
    );
    expect(target?.targetSymbolId).toBe("NotificationCenter#postNotification");
  });

  it("reads a declared property of that name instead, when the project declares one", () => {
    const target = new SwiftCallResolver().resolve(
      call("Config.shared", "reload"),
      ctx({
        callerFile: "Sources/Request.swift",
        symbolTable: t,
        typeDeclarations: declarations,
        classFieldTypesByClassKey: { "Sources/Config.swift::Config": { shared: "Settings" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("Settings#reload");
  });

  it("reads no singleton off an instance", () => {
    const target = new SwiftCallResolver().resolve(
      call("config.shared", "reload"),
      ctx({
        callerFile: "Sources/Request.swift",
        symbolTable: t,
        typeDeclarations: declarations,
        localBindings: { config: [{ line: 5, type: "Config" }] },
      }),
    );
    expect(target).toBeNull();
  });
});

/**
 * `_URLEncodedFormEncoder` is a TYPE: Swift's convention marks an internal
 * type with a leading underscore, and the UpperCamelCase test must read past
 * it (bd tea-rags-mcp-y99pg.9).
 */
describe("SwiftCallResolver — underscore-prefixed type names", () => {
  const t = table({
    "Sources/Encoder.swift": [
      { symbolId: "_Encoder", scope: [] },
      { symbolId: "_Encoder~2", scope: [] },
      { symbolId: "_Encoder.Inner", scope: ["_Encoder"] },
      { symbolId: "Outer", scope: [] },
      { symbolId: "Outer.Inner", scope: ["Outer"] },
    ],
  });

  it("collapses a same-file re-opening of an underscore-prefixed type for a construction", () => {
    const target = new SwiftCallResolver().resolve(
      call(null, "_Encoder"),
      ctx({ callerFile: "Sources/Other.swift", symbolTable: t }),
    );
    expect(target?.targetSymbolId).toBe("_Encoder");
  });

  it("constructs a nested type through its underscore-prefixed outer type", () => {
    const outer = new SwiftCallResolver().resolve(
      call("Outer", "Inner"),
      ctx({ callerFile: "Sources/Other.swift", symbolTable: t }),
    );
    const underscored = new SwiftCallResolver().resolve(
      call("_Encoder", "Inner"),
      ctx({ callerFile: "Sources/Other.swift", symbolTable: t }),
    );
    expect(outer?.targetSymbolId).toBe("Outer.Inner");
    expect(underscored?.targetSymbolId).toBe("_Encoder.Inner");
  });
});

/**
 * Argument labels select among overloads (bd tea-rags-mcp-y99pg.7). A Swift
 * call names its labels and whether it passes a trailing closure; a declaration
 * that cannot accept them is not the target, however near it sits.
 */
describe("SwiftCallResolver — argument-label overload selection", () => {
  type Def = {
    symbolId: string;
    scope: string[];
    arity?: { minRequired: number; maxPositional: number; hasSplat: boolean };
    kwargs?: { required: string[]; optional: string[]; hasSplat: boolean };
    acceptsBlock?: boolean;
  };
  function signedTable(rows: Record<string, Def[]>): InMemoryGlobalSymbolTable {
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
  const none = { minRequired: 0, maxPositional: 0, hasSplat: false };
  const noLabels = { required: [], optional: [], hasSplat: false };
  const t = signedTable({
    "Sources/Validation.swift": [
      { symbolId: "DataRequest", scope: [] },
      {
        symbolId: "DataRequest#validate",
        scope: ["DataRequest"],
        arity: none,
        kwargs: { required: ["statusCode"], optional: [], hasSplat: false },
        acceptsBlock: false,
      },
      {
        symbolId: "DataRequest#validate~2",
        scope: ["DataRequest"],
        arity: none,
        kwargs: noLabels,
        acceptsBlock: false,
      },
    ],
    "Sources/DataRequest.swift": [
      { symbolId: "DataRequest", scope: [] },
      {
        symbolId: "DataRequest#validate",
        scope: ["DataRequest"],
        arity: { minRequired: 0, maxPositional: 1, hasSplat: false },
        kwargs: noLabels,
        acceptsBlock: true,
      },
    ],
  });
  const declarations = {
    "Sources/DataRequest.swift": [{ typeId: "DataRequest", reopens: false }],
    "Sources/Validation.swift": [{ typeId: "DataRequest", reopens: true }],
  };
  const inValidation = {
    callerFile: "Sources/Validation.swift",
    callerScope: ["DataRequest", "validate"],
    symbolTable: t,
    typeDeclarations: declarations,
  };

  it("passes over a same-file overload that cannot take a trailing closure", () => {
    const target = new SwiftCallResolver().resolve(
      { ...call(null, "validate"), argCount: 0, kwargKeys: [], passesBlock: true },
      ctx(inValidation),
    );
    expect(target).toEqual({ targetRelPath: "Sources/DataRequest.swift", targetSymbolId: "DataRequest#validate" });
  });

  it("lands on the overload whose labels the call writes", () => {
    const labelled = new SwiftCallResolver().resolve(
      { ...call("self", "validate"), argCount: 0, kwargKeys: ["statusCode"], passesBlock: false },
      ctx(inValidation),
    );
    const bare = new SwiftCallResolver().resolve(
      { ...call(null, "validate"), argCount: 0, kwargKeys: [], passesBlock: false },
      ctx(inValidation),
    );
    expect(labelled?.targetSymbolId).toBe("DataRequest#validate");
    expect(labelled?.targetRelPath).toBe("Sources/Validation.swift");
    expect(bare?.targetSymbolId).toBe("DataRequest#validate~2");
  });

  it("keeps the nearest declaration when the call carries no signature evidence", () => {
    const target = new SwiftCallResolver().resolve(call(null, "validate"), ctx(inValidation));
    expect(target?.targetRelPath).toBe("Sources/Validation.swift");
  });

  it("emits nothing when no declaration accepts the call's labels", () => {
    const notes = signedTable({
      "Sources/Notifications.swift": [
        { symbolId: "Notification", scope: [] },
        {
          symbolId: "Notification#init",
          scope: ["Notification"],
          arity: none,
          kwargs: { required: ["name", "request"], optional: [], hasSplat: false },
          acceptsBlock: false,
        },
      ],
    });
    const target = new SwiftCallResolver().resolve(
      { ...call("self", "init"), argCount: 0, kwargKeys: ["name", "object", "userInfo"], passesBlock: false },
      ctx({
        callerFile: "Sources/Notifications.swift",
        callerScope: ["Notification", "init"],
        symbolTable: notes,
        typeDeclarations: { "Sources/Notifications.swift": [{ typeId: "Notification", reopens: true }] },
      }),
    );
    expect(target).toBeNull();
  });
});

/**
 * bd tea-rags-mcp-y99pg.36 — an initializer that delegates to ITSELF never
 * terminates, so `self.init(…)` inside `init` X never names X. Alamofire's
 * `extension OperationQueue { convenience init(qualityOfService: … = .default,
 * …) { self.init() } }` delegates to Foundation's `init()`, which the index
 * does not hold: the only project fit is the caller, and that is no target.
 */
describe("SwiftCallResolver — `self.init` never delegates to the calling initializer", () => {
  const optionalOnly = (labels: string[]) => ({
    arity: { minRequired: 0, maxPositional: 0, hasSplat: false },
    kwargs: { required: [], optional: labels, hasSplat: false },
    acceptsBlock: false,
  });
  function initTable(defs: ({ symbolId: string } & ReturnType<typeof optionalOnly>)[]): InMemoryGlobalSymbolTable {
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile(
      "Source/OperationQueue+Alamofire.swift",
      defs.map((d) => ({
        ...d,
        fqName: d.symbolId,
        shortName: "init",
        relPath: "Source/OperationQueue+Alamofire.swift",
        scope: ["OperationQueue"],
      })),
    );
    return t;
  }
  const selfInit = { ...call("self", "init", 42), argCount: 0, kwargKeys: [], passesBlock: false };
  const inExtension = (symbolTable: InMemoryGlobalSymbolTable, callerSymbolId: string) =>
    ctx({
      callerFile: "Source/OperationQueue+Alamofire.swift",
      callerScope: ["OperationQueue"],
      callerSymbolId,
      symbolTable,
      typeDeclarations: { "Source/OperationQueue+Alamofire.swift": [{ typeId: "OperationQueue", reopens: true }] },
    });

  it("emits nothing when the calling initializer is the only project fit", () => {
    const t = initTable([{ symbolId: "OperationQueue#init", ...optionalOnly(["qualityOfService", "name"]) }]);
    expect(new SwiftCallResolver().resolve(selfInit, inExtension(t, "OperationQueue#init"))).toBeNull();
  });

  it("lands on another overload the call fits rather than on the caller", () => {
    const t = initTable([
      { symbolId: "OperationQueue#init", ...optionalOnly(["qualityOfService", "name"]) },
      { symbolId: "OperationQueue#init~2", ...optionalOnly([]) },
    ]);
    expect(new SwiftCallResolver().resolve(selfInit, inExtension(t, "OperationQueue#init"))).toEqual({
      targetRelPath: "Source/OperationQueue+Alamofire.swift",
      targetSymbolId: "OperationQueue#init~2",
    });
  });

  it("charges no in-project miss when the SDK declares the initializer the delegation runs", () => {
    const t = initTable([{ symbolId: "OperationQueue#init", ...optionalOnly(["qualityOfService", "name"]) }]);
    expect(new SwiftCallResolver().hasInProjectDefinition(selfInit, inExtension(t, "OperationQueue#init"))).toBe(false);
  });

  it("still resolves `self.init(…)` from any other member of the type", () => {
    const t = initTable([{ symbolId: "OperationQueue#init", ...optionalOnly(["qualityOfService", "name"]) }]);
    expect(new SwiftCallResolver().resolve(selfInit, inExtension(t, "OperationQueue.make"))?.targetSymbolId).toBe(
      "OperationQueue#init",
    );
  });
});

describe("SwiftCallResolver — a trailing closure stands in for one possible-closure requirement", () => {
  it("resolves `world.configure { … }` onto `configure(_ closure: QuickConfigurer)`", () => {
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("Sources/World.swift", [
      { symbolId: "World", fqName: "World", shortName: "World", relPath: "Sources/World.swift", scope: [] },
      {
        symbolId: "World#configure",
        fqName: "World#configure",
        shortName: "configure",
        relPath: "Sources/World.swift",
        scope: ["World"],
        arity: { minRequired: 1, maxPositional: 1, hasSplat: false },
        kwargs: { required: [], optional: [], hasSplat: false },
        acceptsBlock: true,
      },
    ]);
    const base = {
      callerFile: "Sources/Config.swift",
      symbolTable: t,
      localBindings: { world: [{ line: 5, type: "World" }] },
    };
    const closure = new SwiftCallResolver().resolve(
      { ...call("world", "configure"), argCount: 0, kwargKeys: [], passesBlock: true },
      ctx(base),
    );
    const empty = new SwiftCallResolver().resolve(
      { ...call("world", "configure"), argCount: 0, kwargKeys: [], passesBlock: false },
      ctx(base),
    );
    expect(closure?.targetSymbolId).toBe("World#configure");
    expect(empty).toBeNull();
  });
});

describe("SwiftCallResolver — closure parameters typed by a generic callee in another file", () => {
  const t = table({
    "Sources/Protected.swift": [
      { symbolId: "Protected", scope: [] },
      { symbolId: "Protected#write", scope: ["Protected"] },
    ],
    "Sources/Request.swift": [
      { symbolId: "Request", scope: [] },
      { symbolId: "Request.MutableState", scope: ["Request"] },
      { symbolId: "Request.MutableState#updateCredential", scope: ["Request", "MutableState"] },
    ],
  });
  const typeDeclarations = {
    "Sources/Protected.swift": [
      {
        typeId: "Protected",
        reopens: false,
        genericParameters: ["Value"],
        memberClosureParameters: { write: ["Value"] },
      },
    ],
    "Sources/Request.swift": [
      { typeId: "Request", reopens: false, fieldTypeArguments: { mutableState: ["MutableState"] } },
      { typeId: "Request.MutableState", reopens: false },
    ],
  };
  const base = {
    callerFile: "Sources/Request.swift",
    callerScope: ["Request"],
    symbolTable: t,
    typeDeclarations,
    classFieldTypes: { Request: { mutableState: "Protected" } },
  };

  it("types a named closure parameter from the receiver's generic argument", () => {
    const target = new SwiftCallResolver().resolve(
      call("mutableState", "updateCredential", 11),
      ctx({
        ...base,
        callResultBindings: {
          mutableState: [{ line: 10, callee: "mutableState.write", closureParameter: 0, scopeEndLine: 12 }],
        },
      }),
    );
    expect(target?.targetSymbolId).toBe("Request.MutableState#updateCredential");
  });

  it("types `$0` on the line that opens the closure", () => {
    const target = new SwiftCallResolver().resolve(
      call("$0", "updateCredential", 11),
      ctx({
        ...base,
        callResultBindings: {
          $0: [{ line: 11, callee: "mutableState.write", closureParameter: 0, scopeEndLine: 11 }],
        },
      }),
    );
    expect(target?.targetSymbolId).toBe("Request.MutableState#updateCredential");
  });

  it("types nothing when the receiver's field declares no type arguments", () => {
    const target = new SwiftCallResolver().resolve(
      call("mutableState", "updateCredential", 11),
      ctx({
        ...base,
        typeDeclarations: { ...typeDeclarations, "Sources/Request.swift": [{ typeId: "Request", reopens: false }] },
        callResultBindings: {
          mutableState: [{ line: 10, callee: "mutableState.write", closureParameter: 0, scopeEndLine: 12 }],
        },
      }),
    );
    expect(target).toBeNull();
  });
});

describe("SwiftCallResolver — a stored property seen as a binding still lends its type arguments", () => {
  it("types the closure parameter when the receiver's binding is the property's own type", () => {
    const t = table({
      "Sources/Protected.swift": [
        { symbolId: "Protected", scope: [] },
        { symbolId: "Protected#write", scope: ["Protected"] },
      ],
      "Sources/Retrier.swift": [
        { symbolId: "Retrier", scope: [] },
        { symbolId: "Retrier.State", scope: ["Retrier"] },
        { symbolId: "Retrier.State#cleanup", scope: ["Retrier", "State"] },
      ],
    });
    const context = ctx({
      callerFile: "Sources/Retrier.swift",
      callerScope: ["Retrier"],
      symbolTable: t,
      typeDeclarations: {
        "Sources/Protected.swift": [
          {
            typeId: "Protected",
            reopens: false,
            genericParameters: ["Value"],
            memberClosureParameters: { write: ["Value"] },
          },
        ],
        "Sources/Retrier.swift": [
          { typeId: "Retrier", reopens: false, fieldTypeArguments: { state: ["State"] } },
          { typeId: "Retrier.State", reopens: false },
        ],
      },
      classFieldTypes: { Retrier: { state: "Protected" } },
      // A `deinit` is not chunked, so its calls see the property as a binding.
      localBindings: { state: [{ line: 3, type: "Protected" }] },
      callResultBindings: { state: [{ line: 10, callee: "state.write", closureParameter: 0, scopeEndLine: 12 }] },
    });
    expect(new SwiftCallResolver().resolve(call("state", "cleanup", 11), context)?.targetSymbolId).toBe(
      "Retrier.State#cleanup",
    );
  });
});

/**
 * The miss classifier's denominator question for a RECEIVER call (bd
 * tea-rags-mcp-y99pg.11): Swift is statically typed, so once the receiver's
 * type is known, the only declarations a call can reach are that type's own,
 * its ancestors' and conformances', and a project extension of a protocol the
 * SDK may make it conform to. A project member of the same name anywhere else
 * is a namesake, not a definition this call has.
 */
describe("SwiftCallResolver — in-project definition of a typed receiver's member", () => {
  const sdkReceiverTable = table({
    "Sources/Request.swift": [
      { symbolId: "Request", scope: [] },
      { symbolId: "Request#resume", scope: ["Request"] },
      { symbolId: "Request#cancel", scope: ["Request"] },
    ],
    "Sources/MultipartFormData.swift": [
      { symbolId: "MultipartFormData", scope: [] },
      { symbolId: "MultipartFormData#append", scope: ["MultipartFormData"] },
    ],
    "Sources/Session.swift": [{ symbolId: "Session", scope: [] }],
  });
  const declarations = {
    "Sources/Request.swift": [{ typeId: "Request", reopens: false }],
    "Sources/MultipartFormData.swift": [{ typeId: "MultipartFormData", reopens: false }],
    "Sources/Session.swift": [{ typeId: "Session", reopens: false }],
  };

  it("answers false for an SDK-typed local whose member only a project namesake declares", () => {
    const context = ctx({
      callerFile: "Sources/Session.swift",
      callerScope: ["Session"],
      symbolTable: sdkReceiverTable,
      typeDeclarations: declarations,
      localBindings: { task: [{ line: 5, type: "URLSessionTask" }] },
    });
    const resolver = new SwiftCallResolver();
    expect(resolver.resolve(call("task", "resume"), context)).toBeNull();
    expect(resolver.hasInProjectDefinition(call("task", "resume"), context)).toBe(false);
  });

  it("keeps the denominator for an undeclared UpperCamelCase receiver, which may be a global value", () => {
    const context = ctx({
      callerFile: "Sources/Session.swift",
      callerScope: ["Session"],
      symbolTable: sdkReceiverTable,
      typeDeclarations: declarations,
    });
    // `let AF = Session.default` — nothing the index publishes types it.
    expect(new SwiftCallResolver().hasInProjectDefinition(call("AF", "resume"), context)).toBe(true);
  });

  it("keeps the denominator for a receiver typed AnyObject, where lookup is dynamic", () => {
    const context = ctx({
      callerFile: "Sources/Session.swift",
      callerScope: ["Session"],
      symbolTable: sdkReceiverTable,
      typeDeclarations: declarations,
      localBindings: { target: [{ line: 5, type: "AnyObject" }] },
    });
    expect(new SwiftCallResolver().hasInProjectDefinition(call("target", "resume"), context)).toBe(true);
  });

  it("keeps the denominator when the typed receiver's own hierarchy declares the member", () => {
    const context = ctx({
      callerFile: "Sources/Session.swift",
      callerScope: ["Session"],
      symbolTable: sdkReceiverTable,
      typeDeclarations: declarations,
      localBindings: { request: [{ line: 5, type: "Request" }] },
    });
    expect(new SwiftCallResolver().hasInProjectDefinition(call("request", "resume"), context)).toBe(true);
  });

  it("keeps the denominator when a project extension of an SDK protocol declares the member", () => {
    const withProtocolExtension = table({
      "Sources/Collection+Alamofire.swift": [
        { symbolId: "Collection", scope: [] },
        { symbolId: "Collection#resume", scope: ["Collection"] },
      ],
      "Sources/Session.swift": [{ symbolId: "Session", scope: [] }],
    });
    const context = ctx({
      callerFile: "Sources/Session.swift",
      callerScope: ["Session"],
      symbolTable: withProtocolExtension,
      typeDeclarations: {
        "Sources/Collection+Alamofire.swift": [{ typeId: "Collection", reopens: true }],
        "Sources/Session.swift": [{ typeId: "Session", reopens: false }],
      },
      localBindings: { tasks: [{ line: 5, type: "Array" }] },
    });
    // `Array: Collection` is the SDK's fact, not the project's — it cannot be
    // ruled out, so the site stays a miss the chain is charged for.
    expect(new SwiftCallResolver().hasInProjectDefinition(call("tasks", "resume"), context)).toBe(true);
  });

  it("keeps the denominator for a receiver it cannot type", () => {
    const context = ctx({
      callerFile: "Sources/Session.swift",
      callerScope: ["Session"],
      symbolTable: sdkReceiverTable,
      typeDeclarations: declarations,
    });
    expect(new SwiftCallResolver().hasInProjectDefinition(call("$0", "append"), context)).toBe(true);
  });

  it("answers false for a construction whose labels no extension initializer declares", () => {
    const withInit = table({
      "Sources/Result+Alamofire.swift": [
        { symbolId: "Result", scope: [] },
        { symbolId: "Result#init", scope: ["Result"] },
      ],
      "Sources/Session.swift": [{ symbolId: "Session", scope: [] }],
    });
    withInit.upsertFile("Sources/Result+Alamofire.swift", [
      {
        symbolId: "Result",
        fqName: "Result",
        shortName: "Result",
        relPath: "Sources/Result+Alamofire.swift",
        scope: [],
      },
      {
        symbolId: "Result#init",
        fqName: "Result#init",
        shortName: "init",
        relPath: "Sources/Result+Alamofire.swift",
        scope: ["Result"],
        arity: { minRequired: 0, maxPositional: 0, hasSplat: false },
        kwargs: { required: ["value", "error"], optional: [], hasSplat: false },
        acceptsBlock: false,
      },
    ]);
    const context = ctx({
      callerFile: "Sources/Session.swift",
      callerScope: ["Session"],
      symbolTable: withInit,
      typeDeclarations: {
        "Sources/Result+Alamofire.swift": [{ typeId: "Result", reopens: true }],
        "Sources/Session.swift": [{ typeId: "Session", reopens: false }],
      },
    });
    const resolver = new SwiftCallResolver();
    const catching = { ...call(null, "Result"), argCount: 0, kwargKeys: [], passesBlock: true };
    const valueError = { ...call(null, "Result"), argCount: 0, kwargKeys: ["value", "error"], passesBlock: false };
    expect(resolver.hasInProjectDefinition(catching, context)).toBe(false);
    expect(resolver.hasInProjectDefinition(valueError, context)).toBe(true);
  });
});

describe("SwiftCallResolver — in-project definition of an SDK type receiver and of super", () => {
  const t = table({
    "Sources/Request.swift": [
      { symbolId: "Request", scope: [] },
      { symbolId: "Request#data", scope: ["Request"] },
      { symbolId: "Request#run", scope: ["Request"] },
    ],
    "Sources/Spec.swift": [
      { symbolId: "Spec", scope: [] },
      { symbolId: "Spec#recordFailure", scope: ["Spec"] },
    ],
  });
  const typeDeclarations = {
    "Sources/Request.swift": [{ typeId: "Request", reopens: false }],
    "Sources/Spec.swift": [{ typeId: "Spec", reopens: false, conforms: ["XCTestCase"] }],
  };

  it("answers false for a member read off an SDK type the vocabulary names", () => {
    const context = ctx({
      callerFile: "Sources/Request.swift",
      callerScope: ["Request"],
      symbolTable: t,
      typeDeclarations,
    });
    const resolver = new SwiftCallResolver();
    expect(resolver.hasInProjectDefinition(call("JSONSerialization", "data"), context)).toBe(false);
    expect(resolver.hasInProjectDefinition(call("MainActor", "run"), context)).toBe(false);
  });

  it("answers false for super when the SDK superclass is where the member lives", () => {
    const context = ctx({
      callerFile: "Sources/Spec.swift",
      callerScope: ["Spec"],
      symbolTable: t,
      typeDeclarations,
      classExtends: { Spec: "XCTestCase" },
    });
    // `Spec#recordFailure` is the override calling up, not the target.
    expect(new SwiftCallResolver().hasInProjectDefinition(call("super", "recordFailure"), context)).toBe(false);
  });
});

describe("SwiftCallResolver — an implicit initializer of a project type stays in the denominator", () => {
  it("keeps super.init() on a project superclass that declares no initializer", () => {
    const t = table({
      "Sources/World.swift": [
        { symbolId: "WrapperBase", scope: [] },
        { symbolId: "Wrapper", scope: [] },
        { symbolId: "Other#init", scope: ["Other"] },
        { symbolId: "Other", scope: [] },
      ],
    });
    const context = ctx({
      callerFile: "Sources/World.swift",
      callerScope: ["Wrapper"],
      symbolTable: t,
      typeDeclarations: {
        "Sources/World.swift": [
          { typeId: "WrapperBase", reopens: false, conforms: ["NSObject"] },
          { typeId: "Wrapper", reopens: false, conforms: ["WrapperBase"] },
          { typeId: "Other", reopens: false },
        ],
      },
      classExtends: { Wrapper: "WrapperBase", WrapperBase: "NSObject" },
    });
    expect(new SwiftCallResolver().hasInProjectDefinition(call("super", "init"), context)).toBe(true);
  });
});

describe("SwiftCallResolver — an Array receiver reaches `extension [T]` (bd tea-rags-mcp-y99pg.14)", () => {
  it("resolves onto a member declared under the array sugar spelling", () => {
    const t = table({
      "Sources/HTTPHeaders.swift": [
        { symbolId: "HTTPHeaders", scope: [] },
        { symbolId: "[HTTPHeader]", scope: [] },
        { symbolId: "[HTTPHeader]#index", scope: ["[HTTPHeader]"] },
      ],
    });
    const context = ctx({
      callerFile: "Sources/HTTPHeaders.swift",
      callerScope: ["HTTPHeaders"],
      symbolTable: t,
      typeDeclarations: {
        "Sources/HTTPHeaders.swift": [
          { typeId: "HTTPHeaders", reopens: false },
          { typeId: "[HTTPHeader]", reopens: true },
        ],
      },
      localBindings: { headers: [{ line: 5, type: "Array" }] },
    });
    const resolver = new SwiftCallResolver();
    expect(resolver.resolve(call("headers", "index"), context)?.targetSymbolId).toBe("[HTTPHeader]#index");
    expect(resolver.hasInProjectDefinition(call("headers", "sort"), context)).toBe(false);
  });
});

describe("SwiftCallResolver — a construction picks the extension whose initializer its labels fit", () => {
  function reopenedTwice(): InMemoryGlobalSymbolTable {
    const t = new InMemoryGlobalSymbolTable();
    const def = (relPath: string, symbolId: string, scope: string[], extra: object = {}) => ({
      symbolId,
      fqName: symbolId,
      shortName: (symbolId.split(/[#.]/).pop() ?? symbolId).replace(/~\d+$/, ""),
      relPath,
      scope,
      ...extra,
    });
    t.upsertFile("Sources/URLConvertible.swift", [
      def("Sources/URLConvertible.swift", "URLRequest", []),
      def("Sources/URLConvertible.swift", "URLRequest#init", ["URLRequest"], {
        arity: { minRequired: 0, maxPositional: 0, hasSplat: false },
        kwargs: { required: ["url", "method"], optional: ["headers"], hasSplat: false },
        acceptsBlock: false,
      }),
    ]);
    t.upsertFile("Sources/URLRequest+Alamofire.swift", [
      def("Sources/URLRequest+Alamofire.swift", "URLRequest", []),
      def("Sources/URLRequest+Alamofire.swift", "URLRequest#validate", ["URLRequest"]),
    ]);
    return t;
  }
  const typeDeclarations = {
    "Sources/URLConvertible.swift": [{ typeId: "URLRequest", reopens: true }],
    "Sources/URLRequest+Alamofire.swift": [{ typeId: "URLRequest", reopens: true }],
  };

  it("resolves into the file whose extension declares the fitting initializer", () => {
    const context = ctx({ callerFile: "Sources/Session.swift", symbolTable: reopenedTwice(), typeDeclarations });
    const site = {
      ...call(null, "URLRequest"),
      argCount: 0,
      kwargKeys: ["url", "method", "headers"],
      passesBlock: false,
    };
    expect(new SwiftCallResolver().resolve(site, context)).toEqual({
      targetRelPath: "Sources/URLConvertible.swift",
      targetSymbolId: "URLRequest",
    });
  });

  it("emits nothing when no extension initializer takes the labels — the SDK's runs", () => {
    const context = ctx({ callerFile: "Sources/Session.swift", symbolTable: reopenedTwice(), typeDeclarations });
    const site = { ...call(null, "URLRequest"), argCount: 0, kwargKeys: ["url"], passesBlock: false };
    const resolver = new SwiftCallResolver();
    expect(resolver.resolve(site, context)).toBeNull();
    expect(resolver.hasInProjectDefinition(site, context)).toBe(false);
  });
});

describe("SwiftCallResolver — a bare construction does not see another type's nested namesake", () => {
  const nested = table({
    "Sources/Result+Alamofire.swift": [
      { symbolId: "Result", scope: [] },
      { symbolId: "Result#init", scope: ["Result"] },
    ],
    "Sources/OfflineRetrier.swift": [
      { symbolId: "PathMonitor", scope: [] },
      { symbolId: "PathMonitor.Result", scope: ["PathMonitor"] },
    ],
  });
  const typeDeclarations = {
    "Sources/Result+Alamofire.swift": [{ typeId: "Result", reopens: true }],
    "Sources/OfflineRetrier.swift": [
      { typeId: "PathMonitor", reopens: false },
      { typeId: "PathMonitor.Result", reopens: false },
    ],
  };

  it("reaches the project's Result extension from outside PathMonitor", () => {
    const context = ctx({
      callerFile: "Sources/WebSocketRequest.swift",
      callerScope: ["WebSocketRequest", "send"],
      symbolTable: nested,
      typeDeclarations,
    });
    expect(new SwiftCallResolver().resolve(call(null, "Result"), context)).toEqual({
      targetRelPath: "Sources/Result+Alamofire.swift",
      targetSymbolId: "Result",
    });
  });

  it("still sees the nested type from inside its container", () => {
    const context = ctx({
      callerFile: "Sources/OfflineRetrier.swift",
      callerScope: ["PathMonitor", "startListening"],
      symbolTable: nested,
      typeDeclarations,
    });
    expect(new SwiftCallResolver().hasInProjectDefinition(call(null, "Result"), context)).toBe(true);
  });
});

describe("SwiftCallResolver — enum case payload bindings (bd tea-rags-mcp-y99pg.16)", () => {
  const t = table({
    "Sources/ExampleGroup.swift": [
      { symbolId: "ExampleGroup", scope: [] },
      { symbolId: "ExampleGroup#walkDownExamples", scope: ["ExampleGroup"] },
      { symbolId: "ExampleUnit", scope: [] },
    ],
    "Sources/AsyncExampleGroup.swift": [
      { symbolId: "AsyncExampleGroup", scope: [] },
      { symbolId: "AsyncExampleGroup#walkDownExamples", scope: ["AsyncExampleGroup"] },
    ],
  });
  const typeDeclarations = {
    "Sources/ExampleGroup.swift": [
      { typeId: "ExampleGroup", reopens: false },
      { typeId: "ExampleUnit", reopens: false, enumCasePayloads: { group: ["ExampleGroup"], example: ["Example"] } },
    ],
    "Sources/AsyncExampleGroup.swift": [{ typeId: "AsyncExampleGroup", reopens: false }],
  };
  const base = {
    callerFile: "Sources/ExampleGroup.swift",
    callerScope: ["ExampleGroup", "walkDownExamples"],
    symbolTable: t,
    typeDeclarations,
    localBindings: { unit: [{ line: 3, type: "ExampleUnit" }] },
  };

  it("types a payload name by the case the subject's enum declares", () => {
    const target = new SwiftCallResolver().resolve(
      call("exampleGroup", "walkDownExamples", 6),
      ctx({
        ...base,
        callResultBindings: {
          exampleGroup: [{ line: 5, callee: "unit", enumPayload: { caseName: "group", index: 0 }, scopeEndLine: 6 }],
        },
      }),
    );
    expect(target).toEqual({
      targetRelPath: "Sources/ExampleGroup.swift",
      targetSymbolId: "ExampleGroup#walkDownExamples",
    });
  });

  it("types nothing for a case the enum does not declare", () => {
    const target = new SwiftCallResolver().resolve(
      call("exampleGroup", "walkDownExamples", 6),
      ctx({
        ...base,
        callResultBindings: {
          exampleGroup: [{ line: 5, callee: "unit", enumPayload: { caseName: "nested", index: 0 }, scopeEndLine: 6 }],
        },
      }),
    );
    expect(target).toBeNull();
  });
});

describe("SwiftCallResolver — file-private enum namesakes (bd tea-rags-mcp-y99pg.17)", () => {
  const t = table({
    "Sources/ExampleGroup.swift": [
      { symbolId: "ExampleGroup", scope: [] },
      { symbolId: "ExampleGroup#walkDownExamples", scope: ["ExampleGroup"] },
      { symbolId: "ExampleUnit", scope: [] },
    ],
    "Sources/AsyncExampleGroup.swift": [
      { symbolId: "AsyncExampleGroup", scope: [] },
      { symbolId: "AsyncExampleGroup#walkDownExamples", scope: ["AsyncExampleGroup"] },
      { symbolId: "ExampleUnit", scope: [] },
    ],
  });
  const typeDeclarations = {
    "Sources/ExampleGroup.swift": [
      { typeId: "ExampleGroup", reopens: false },
      { typeId: "ExampleUnit", reopens: false, enumCasePayloads: { group: ["ExampleGroup"] } },
    ],
    "Sources/AsyncExampleGroup.swift": [
      { typeId: "AsyncExampleGroup", reopens: false },
      { typeId: "ExampleUnit", reopens: false, enumCasePayloads: { group: ["AsyncExampleGroup"] } },
    ],
  };
  const site = (callerFile: string, callerScope: string[]) =>
    ctx({
      callerFile,
      callerScope,
      symbolTable: t,
      typeDeclarations,
      localBindings: { unit: [{ line: 3, type: "ExampleUnit" }] },
      callResultBindings: {
        exampleGroup: [{ line: 5, callee: "unit", enumPayload: { caseName: "group", index: 0 }, scopeEndLine: 6 }],
      },
    });

  it("reads the payload off the enum the caller's own file declares", () => {
    const resolver = new SwiftCallResolver();
    const call6 = call("exampleGroup", "walkDownExamples", 6);
    expect(
      resolver.resolve(call6, site("Sources/AsyncExampleGroup.swift", ["AsyncExampleGroup", "walk"]))?.targetSymbolId,
    ).toBe("AsyncExampleGroup#walkDownExamples");
    expect(resolver.resolve(call6, site("Sources/ExampleGroup.swift", ["ExampleGroup", "walk"]))?.targetSymbolId).toBe(
      "ExampleGroup#walkDownExamples",
    );
  });

  it("types nothing from a third file when two files declare the enum", () => {
    const target = new SwiftCallResolver().resolve(
      call("exampleGroup", "walkDownExamples", 6),
      site("Sources/World.swift", ["World", "all"]),
    );
    expect(target).toBeNull();
  });
});

describe("SwiftCallResolver — `-> Self` returns and implicit-self call heads (bd tea-rags-mcp-y99pg.18)", () => {
  const t = table({
    "Sources/Request.swift": [
      { symbolId: "Request", scope: [] },
      { symbolId: "Request#configured", scope: ["Request"] },
      { symbolId: "DataRequest", scope: [] },
      { symbolId: "DataRequest#resume", scope: ["DataRequest"] },
    ],
    "Sources/Validation.swift": [
      { symbolId: "DataRequest", scope: [] },
      {
        symbolId: "DataRequest#validate",
        scope: ["DataRequest"],
        arity: { minRequired: 0, maxPositional: 0, hasSplat: false },
        kwargs: { required: ["statusCode"], optional: [], hasSplat: false },
        acceptsBlock: false,
      },
      {
        symbolId: "DataRequest#validate~2",
        scope: ["DataRequest"],
        arity: { minRequired: 0, maxPositional: 0, hasSplat: false },
        kwargs: { required: ["contentType"], optional: [], hasSplat: false },
        acceptsBlock: false,
      },
      {
        symbolId: "DataRequest#validate~3",
        scope: ["DataRequest"],
        arity: { minRequired: 0, maxPositional: 0, hasSplat: false },
        kwargs: { required: [], optional: [], hasSplat: false },
        acceptsBlock: false,
      },
    ],
  });
  const base = {
    symbolTable: t,
    typeDeclarations: {
      "Sources/Request.swift": [
        { typeId: "Request", reopens: false },
        { typeId: "DataRequest", reopens: false, conforms: ["Request"] },
      ],
      "Sources/Validation.swift": [{ typeId: "DataRequest", reopens: true }],
    },
    classExtends: { DataRequest: "Request" },
    structuredReturnTypes: {
      "Request#configured": { form: "instance" as const, name: "Self" },
      "DataRequest#validate": { form: "instance" as const, name: "Self" },
      "DataRequest#validate~2": { form: "instance" as const, name: "Self" },
      "DataRequest#validate~3": { form: "instance" as const, name: "Self" },
    },
  };

  it("types an implicit-self call head by the overloads' agreed `Self` return", () => {
    const site = {
      ...call("validate(statusCode: acceptableStatusCodes)", "validate", 12),
      argCount: 0,
      kwargKeys: ["contentType"],
      passesBlock: false,
    };
    const target = new SwiftCallResolver().resolve(
      site,
      ctx({ ...base, callerFile: "Sources/Validation.swift", callerScope: ["DataRequest", "validate"] }),
    );
    expect(target?.targetSymbolId).toBe("DataRequest#validate~2");
  });

  it("substitutes `Self` with the receiver's type, not the declaring type", () => {
    const target = new SwiftCallResolver().resolve(
      call("request.configured()", "resume", 8),
      ctx({
        ...base,
        callerFile: "Sources/Session.swift",
        callerScope: ["Session", "run"],
        localBindings: { request: [{ line: 7, type: "DataRequest" }] },
      }),
    );
    expect(target?.targetSymbolId).toBe("DataRequest#resume");
  });
});

describe("SwiftCallResolver — standard-library conformances of SDK collections (bd tea-rags-mcp-y99pg.19)", () => {
  const t = table({
    "Sources/HTTPHeaders.swift": [
      { symbolId: "HTTPHeaders", scope: [] },
      { symbolId: "Collection", scope: [] },
      { symbolId: "Collection#qualityEncoded", scope: ["Collection"] },
      { symbolId: "Sequence", scope: [] },
      { symbolId: "Sequence#joinedPairs", scope: ["Sequence"] },
    ],
  });
  const context = (type: string) =>
    ctx({
      callerFile: "Sources/HTTPHeaders.swift",
      callerScope: ["HTTPHeaders", "make"],
      symbolTable: t,
      typeDeclarations: {
        "Sources/HTTPHeaders.swift": [
          { typeId: "HTTPHeaders", reopens: false },
          { typeId: "Collection", reopens: true },
          { typeId: "Sequence", reopens: true },
        ],
      },
      localBindings: { encodings: [{ line: 3, type }] },
    });

  it("reaches a `Collection` extension from an Array receiver", () => {
    expect(
      new SwiftCallResolver().resolve(call("encodings", "qualityEncoded", 4), context("Array"))?.targetSymbolId,
    ).toBe("Collection#qualityEncoded");
  });

  it("reaches a `Sequence` extension from a Collection-typed receiver through its refinement", () => {
    expect(
      new SwiftCallResolver().resolve(call("encodings", "joinedPairs", 4), context("Collection"))?.targetSymbolId,
    ).toBe("Sequence#joinedPairs");
  });

  it("reaches neither from a type the SDK does not make a collection", () => {
    expect(new SwiftCallResolver().resolve(call("encodings", "qualityEncoded", 4), context("URL"))).toBeNull();
  });
});

describe("SwiftCallResolver — a generic-argument extension's spelled id (bd tea-rags-mcp-y99pg.19)", () => {
  it("reaches members composed under `Collection<String>` from an Array receiver", () => {
    const t = table({
      "Sources/HTTPHeaders.swift": [
        { symbolId: "HTTPHeaders", scope: [] },
        { symbolId: "Collection<String>", scope: [] },
        { symbolId: "Collection<String>#qualityEncoded", scope: ["Collection<String>"] },
      ],
    });
    const context = ctx({
      callerFile: "Sources/HTTPHeaders.swift",
      callerScope: ["HTTPHeaders", "make"],
      symbolTable: t,
      typeDeclarations: {
        "Sources/HTTPHeaders.swift": [
          { typeId: "HTTPHeaders", reopens: false },
          { typeId: "Collection", reopens: true, spelledAs: "Collection<String>" },
        ],
      },
      localBindings: { encodings: [{ line: 3, type: "Array" }] },
    });
    const resolver = new SwiftCallResolver();
    expect(resolver.resolve(call("encodings", "qualityEncoded", 4), context)?.targetSymbolId).toBe(
      "Collection<String>#qualityEncoded",
    );
    expect(resolver.hasInProjectDefinition(call("encodings", "qualityEncoded", 4), context)).toBe(true);
  });
});

describe("SwiftCallResolver — `try` call heads and nested type heads (bd tea-rags-mcp-y99pg.20)", () => {
  it("types a `try`-prefixed implicit-self call head", () => {
    const t = table({
      "Sources/Box.swift": [
        { symbolId: "Box", scope: [] },
        { symbolId: "Box#make", scope: ["Box"] },
        { symbolId: "Widget", scope: [] },
        { symbolId: "Widget#run", scope: ["Widget"] },
      ],
    });
    const target = new SwiftCallResolver().resolve(
      call("try make(policy: policy)", "run", 5),
      ctx({
        callerFile: "Sources/Box.swift",
        callerScope: ["Box", "go"],
        symbolTable: t,
        structuredReturnTypes: { "Box#make": { form: "instance", name: "Widget" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("Widget#run");
  });

  it("types a chain head naming a type nested in an enclosing type", () => {
    const t = table({
      "Sources/Encoder.swift": [
        { symbolId: "Encoder", scope: [] },
        { symbolId: "Encoder.DateEncoding", scope: ["Encoder"] },
        { symbolId: "Encoder.DateEncoding#read", scope: ["Encoder", "DateEncoding"] },
      ],
    });
    const target = new SwiftCallResolver().resolve(
      call("DateEncoding.shared", "read", 5),
      ctx({ callerFile: "Sources/Encoder.swift", callerScope: ["Encoder", "DateEncoding", "encode"], symbolTable: t }),
    );
    expect(target?.targetSymbolId).toBe("Encoder.DateEncoding#read");
  });
});

describe("SwiftCallResolver — `super.init()` into a superclass with an implicit initializer (bd tea-rags-mcp-y99pg.21)", () => {
  const t = table({
    "Sources/World.swift": [
      { symbolId: "_ExampleWrapperBase", scope: [] },
      { symbolId: "ExampleWrapper", scope: [] },
      { symbolId: "ExampleWrapper#init", scope: ["ExampleWrapper"] },
    ],
  });
  const base = {
    callerFile: "Sources/World.swift",
    callerScope: ["ExampleWrapper", "init"],
    symbolTable: t,
  };

  it("lands on the superclass it initializes when the project declares no initializer of it", () => {
    const target = new SwiftCallResolver().resolve(
      call("super", "init", 9),
      ctx({ ...base, classExtends: { ExampleWrapper: "_ExampleWrapperBase" } }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/World.swift", targetSymbolId: "_ExampleWrapperBase" });
  });

  it("emits nothing when the superclass is not the project's", () => {
    const target = new SwiftCallResolver().resolve(
      call("super", "init", 9),
      ctx({ ...base, classExtends: { ExampleWrapper: "NSObject" } }),
    );
    expect(target).toBeNull();
  });
});

describe("SwiftCallResolver — a stored closure of a function typealias as a chain head (bd tea-rags-mcp-y99pg.22)", () => {
  it("types `responseHandler { … }` by what its alias's function type returns", () => {
    const t = table({
      "Sources/Combine.swift": [
        { symbolId: "DataResponsePublisher", scope: [] },
        { symbolId: "DataResponsePublisher.Inner", scope: ["DataResponsePublisher"] },
      ],
      "Sources/DataRequest.swift": [
        { symbolId: "DataRequest", scope: [] },
        { symbolId: "DataRequest#resume", scope: ["DataRequest"] },
      ],
    });
    const target = new SwiftCallResolver().resolve(
      call("responseHandler { response in\n  _ = downstream.receive(response)\n}", "resume", 12),
      ctx({
        callerFile: "Sources/Combine.swift",
        callerScope: ["DataResponsePublisher", "Inner", "request"],
        symbolTable: t,
        typeDeclarations: {
          "Sources/Combine.swift": [
            { typeId: "DataResponsePublisher", reopens: false, functionAliasReturns: { Handler: "DataRequest" } },
            { typeId: "DataResponsePublisher.Inner", reopens: false },
          ],
          "Sources/DataRequest.swift": [{ typeId: "DataRequest", reopens: false }],
        },
        classFieldTypes: { Inner: { responseHandler: "Handler" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("DataRequest#resume");
  });
});

describe("SwiftCallResolver — the generated SDK substrate (bd tea-rags-mcp-y99pg.24)", () => {
  const t = table({
    "Sources/Stream+Alamofire.swift": [
      { symbolId: "Stream", scope: [] },
      { symbolId: "Stream#closeQuietly", scope: ["Stream"] },
    ],
    "Sources/Publisher+Alamofire.swift": [
      { symbolId: "Publisher", scope: [] },
      { symbolId: "Publisher#resume", scope: ["Publisher"] },
    ],
    "Sources/Session.swift": [
      { symbolId: "Session", scope: [] },
      { symbolId: "Session#runActivity", scope: ["Session"] },
    ],
  });
  const typeDeclarations = {
    "Sources/Stream+Alamofire.swift": [{ typeId: "Stream", reopens: true }],
    "Sources/Publisher+Alamofire.swift": [{ typeId: "Publisher", reopens: true }],
    "Sources/Session.swift": [{ typeId: "Session", reopens: false }],
  };
  const context = (bindings: CallContext["localBindings"]): CallContext =>
    ctx({
      callerFile: "Sources/Session.swift",
      callerScope: ["Session", "go"],
      symbolTable: t,
      typeDeclarations,
      localBindings: bindings,
    });

  it("reaches a project extension of an SDK superclass from a subclass receiver", () => {
    const site = call("stream", "closeQuietly", 6);
    const resolver = new SwiftCallResolver();
    const within = context({ stream: [{ line: 5, type: "OutputStream" }] });
    expect(resolver.resolve(site, within)?.targetSymbolId).toBe("Stream#closeQuietly");
    expect(resolver.hasInProjectDefinition(site, within)).toBe(true);
  });

  it("proves external a member only an SDK protocol outside the receiver's hierarchy re-opens", () => {
    // `Data` conforms to no `Publisher`: the project's `extension Publisher`
    // is a namesake, whatever the protocol's name suggests.
    const site = call("payload", "resume", 6);
    const within = context({ payload: [{ line: 5, type: "Data" }] });
    expect(new SwiftCallResolver().hasInProjectDefinition(site, within)).toBe(false);
  });

  it("keeps a member the receiver's SDK conformances reach", () => {
    const site = call("upstream", "resume", 6);
    const within = context({ upstream: [{ line: 5, type: "AnyPublisher" }] });
    expect(new SwiftCallResolver().hasInProjectDefinition(site, within)).toBe(true);
  });

  it("reads a sugar-spelled extension id as the SDK type it re-opens", () => {
    const sugared = table({
      "Sources/HTTPHeaders.swift": [
        { symbolId: "[HTTPHeader]", scope: [] },
        { symbolId: "[HTTPHeader]#index", scope: ["[HTTPHeader]"] },
      ],
      "Sources/Session.swift": [{ symbolId: "Session", scope: [] }],
    });
    const within = ctx({
      callerFile: "Sources/Session.swift",
      callerScope: ["Session", "go"],
      symbolTable: sugared,
      typeDeclarations: {
        "Sources/HTTPHeaders.swift": [{ typeId: "[HTTPHeader]", reopens: true }],
        "Sources/Session.swift": [{ typeId: "Session", reopens: false }],
      },
      localBindings: { key: [{ line: 5, type: "String" }] },
    });
    // `String` is no Array: `extension [HTTPHeader]`'s `index` is a namesake.
    expect(new SwiftCallResolver().hasInProjectDefinition(call("key", "index", 6), within)).toBe(false);
  });

  it("types an SDK type spelled as the receiver from the substrate, not a list", () => {
    const site = call("XCTContext", "runActivity", 6);
    expect(new SwiftCallResolver().hasInProjectDefinition(site, context({}))).toBe(false);
  });
});

describe("SwiftCallResolver — SDK member types and SDK closure parameters (bd tea-rags-mcp-y99pg.25)", () => {
  const t = table({
    "Sources/AFError.swift": [
      { symbolId: "AFError", scope: [] },
      { symbolId: "Error", scope: [] },
      { symbolId: "Error#asAFError", scope: ["Error"] },
    ],
    "Sources/HTTPHeaders.swift": [
      { symbolId: "HTTPHeaders", scope: [] },
      { symbolId: "Collection<String>", scope: [] },
      { symbolId: "Collection<String>#qualityEncoded", scope: ["Collection<String>"] },
      { symbolId: "String", scope: [] },
      { symbolId: "String#indentingNewlines", scope: ["String"] },
    ],
    "Sources/Request.swift": [
      { symbolId: "Request", scope: [] },
      { symbolId: "Request#cancel", scope: ["Request"] },
      { symbolId: "Request#append", scope: ["Request"] },
      { symbolId: "Request#map", scope: ["Request"] },
    ],
    "Sources/Session.swift": [{ symbolId: "Session", scope: [] }],
  });
  const typeDeclarations = {
    "Sources/AFError.swift": [
      { typeId: "AFError", reopens: false },
      { typeId: "Error", reopens: true },
    ],
    "Sources/HTTPHeaders.swift": [
      { typeId: "HTTPHeaders", reopens: false },
      { typeId: "Collection", reopens: true, spelledAs: "Collection<String>" },
      { typeId: "String", reopens: true },
    ],
    "Sources/Request.swift": [{ typeId: "Request", reopens: false }],
    "Sources/Session.swift": [{ typeId: "Session", reopens: false }],
  };
  const context = (over: Partial<CallContext> = {}): CallContext =>
    ctx({
      callerFile: "Sources/Session.swift",
      callerScope: ["Session", "go"],
      symbolTable: t,
      typeDeclarations,
      ...over,
    });

  it("types an SDK static property and an SDK method's associated-type return along a chain", () => {
    // `Locale.preferredLanguages` is `[String]`; `prefix(_:)` returns
    // `Self.SubSequence`, which `Array` aliases to `ArraySlice<Element>`.
    const target = new SwiftCallResolver().resolve(
      call("Locale.preferredLanguages.prefix(6)", "qualityEncoded", 6),
      context(),
    );
    expect(target?.targetSymbolId).toBe("Collection<String>#qualityEncoded");
  });

  it("types a construction head of an SDK type and an SDK method's return", () => {
    const target = new SwiftCallResolver().resolve(
      call("String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespaces)", "indentingNewlines", 6),
      context(),
    );
    expect(target?.targetSymbolId).toBe("String#indentingNewlines");
  });

  it("types a string-literal head as a String", () => {
    const target = new SwiftCallResolver().resolve(call('"\\(headers.sorted())"', "indentingNewlines", 6), context());
    expect(target?.targetSymbolId).toBe("String#indentingNewlines");
  });

  it("types an SDK closure's parameter by an unbound generic parameter's constraint", () => {
    // `Result { … }.mapError { $0 … }`: the closure takes `Failure`, which
    // nothing binds here and which every `Result` constrains to `Error`.
    const target = new SwiftCallResolver().resolve(
      call("$0", "asAFError", 7),
      context({
        callResultBindings: {
          $0: [{ line: 7, callee: "Result { try serializer.serialize(data) }.mapError", closureParameter: 0 }],
        },
      }),
    );
    expect(target?.targetSymbolId).toBe("Error#asAFError");
  });

  it("reads an optional through Optional's own members", () => {
    // `error.map { $0.asAFError() }` on an `Error?` the walker collapsed to `Error`.
    const target = new SwiftCallResolver().resolve(
      call("$0", "asAFError", 7),
      context({
        localBindings: { error: [{ line: 3, type: "Error" }] },
        callResultBindings: { $0: [{ line: 7, callee: "error.map", closureParameter: 0 }] },
      }),
    );
    expect(target?.targetSymbolId).toBe("Error#asAFError");
  });

  it("binds an SDK generic's parameter by the receiver's generic argument", () => {
    // `requests.forEach { $0.cancel() }` on a `requests: [Request]` field.
    const target = new SwiftCallResolver().resolve(
      call("$0", "cancel", 7),
      context({
        classFieldTypes: { Session: { requests: "Array" } },
        typeDeclarations: {
          ...typeDeclarations,
          "Sources/Session.swift": [
            { typeId: "Session", reopens: false, fieldTypeArguments: { requests: ["Request"] } },
          ],
        },
        callResultBindings: { $0: [{ line: 7, callee: "requests.forEach", closureParameter: 0 }] },
      }),
    );
    expect(target?.targetSymbolId).toBe("Request#cancel");
  });

  it("types a chain of SDK links", () => {
    // `ProcessInfo` → `processInfo: ProcessInfo` → `arguments: [String]` → `first: String`.
    const site = call("ProcessInfo.processInfo.arguments.first", "append", 6);
    expect(new SwiftCallResolver().hasInProjectDefinition(site, context())).toBe(false);
  });

  it("types a FIVE-link chain of SDK links (bd tea-rags-mcp-y99pg.34)", () => {
    // Alamofire's default User-Agent: `…first?.split(separator: "/").last.map(String.init)` —
    // `split` returns `[Substring]`, `last` a `Substring`; `map` is the SDK's, never `Request#map`.
    const site = call('ProcessInfo.processInfo.arguments.first.split(separator: "/").last', "map", 6);
    expect(new SwiftCallResolver().hasInProjectDefinition(site, context())).toBe(false);
  });

  it("types an implicit-self property and call head the SDK declares on the enclosing type", () => {
    const resolver = new SwiftCallResolver();
    const inRequest = context({ callerScope: ["URLRequest", "headers"] });
    expect(resolver.hasInProjectDefinition(call("httpBody", "append", 6), inRequest)).toBe(false);
    const inCollection = context({ callerScope: ["Collection<String>", "qualityEncoded"] });
    expect(resolver.hasInProjectDefinition(call("enumerated()", "map", 6), inCollection)).toBe(false);
  });

  it("proves external a call whose labels fit no project overload of a member the SDK declares too", () => {
    const withInit = table({ "Sources/Session.swift": [{ symbolId: "Session", scope: [] }] });
    withInit.upsertFile("Sources/URLRequest+Alamofire.swift", [
      {
        symbolId: "URLRequest",
        fqName: "URLRequest",
        shortName: "URLRequest",
        relPath: "Sources/URLRequest+Alamofire.swift",
        scope: [],
      },
      {
        symbolId: "URLRequest#init",
        fqName: "URLRequest#init",
        shortName: "init",
        relPath: "Sources/URLRequest+Alamofire.swift",
        scope: ["URLRequest"],
        arity: { minRequired: 1, maxPositional: 1, hasSplat: false },
        kwargs: { required: ["method"], optional: ["headers"], hasSplat: false },
        acceptsBlock: false,
      },
    ]);
    const within = ctx({
      callerFile: "Sources/URLRequest+Alamofire.swift",
      callerScope: ["URLRequest", "init"],
      symbolTable: withInit,
      typeDeclarations: {
        "Sources/URLRequest+Alamofire.swift": [{ typeId: "URLRequest", reopens: true }],
        "Sources/Session.swift": [{ typeId: "Session", reopens: false }],
      },
    });
    const resolver = new SwiftCallResolver();
    const sdkInit = { ...call("self", "init", 6), argCount: 0, kwargKeys: ["url", "cachePolicy"], passesBlock: false };
    const projectInit = { ...call("self", "init", 6), argCount: 1, kwargKeys: ["method"], passesBlock: false };
    expect(resolver.hasInProjectDefinition(sdkInit, within)).toBe(false);
    expect(resolver.hasInProjectDefinition(projectInit, within)).toBe(true);
  });

  it("keeps the denominator for a value known only by its generic parameter's constraint", () => {
    // `requests.forEach { $0.cancel() }` on a `Set` whose element nothing
    // states: `$0` is some `Hashable`, which may well be a `Request`.
    const site = call("$0", "cancel", 7);
    const within = context({
      localBindings: { requests: [{ line: 3, type: "Set" }] },
      callResultBindings: { $0: [{ line: 7, callee: "requests.forEach", closureParameter: 0 }] },
    });
    expect(new SwiftCallResolver().hasInProjectDefinition(site, within)).toBe(true);
  });

  it("proves external a call on an SDK-typed chain whose member only a project namesake declares", () => {
    // `components.percentEncodedQuery.append` — a `String?` — never reaches `Request#append`.
    const site = call("components.percentEncodedQuery", "append", 6);
    const within = context({ localBindings: { components: [{ line: 3, type: "URLComponents" }] } });
    const resolver = new SwiftCallResolver();
    expect(resolver.resolve(site, within)).toBeNull();
    expect(resolver.hasInProjectDefinition(site, within)).toBe(false);
  });
});

describe("SwiftCallResolver — a construction-initialized field's generic arguments (bd tea-rags-mcp-y99pg.26)", () => {
  const t = table({
    "Sources/Protected.swift": [
      { symbolId: "Protected", scope: [] },
      { symbolId: "Protected#write", scope: ["Protected"] },
    ],
    "Sources/DataRequest.swift": [
      { symbolId: "DataRequest", scope: [] },
      { symbolId: "DataRequest.DataMutableState", scope: ["DataRequest"] },
      { symbolId: "DataRequest.DataMutableState#reset", scope: ["DataRequest", "DataMutableState"] },
    ],
  });
  const protectedFact = {
    typeId: "Protected",
    reopens: false,
    genericParameters: ["Value"],
    memberClosureParameters: { write: ["Value"] },
    genericInitializers: [{ labels: [null], binds: ["Value"] }],
  };
  const context = (label: string | null) =>
    ctx({
      callerFile: "Sources/DataRequest.swift",
      callerScope: ["DataRequest"],
      symbolTable: t,
      typeDeclarations: {
        "Sources/Protected.swift": [protectedFact],
        "Sources/DataRequest.swift": [
          {
            typeId: "DataRequest",
            reopens: false,
            fieldConstructions: {
              dataMutableState: { type: "Protected", arguments: [{ label, type: "DataMutableState" }] },
            },
          },
          { typeId: "DataRequest.DataMutableState", reopens: false },
        ],
      },
      classFieldTypes: { DataRequest: { dataMutableState: "Protected" } },
      callResultBindings: {
        state: [{ line: 10, callee: "dataMutableState.write", closureParameter: 0, scopeEndLine: 12 }],
      },
    });

  it("binds the generic parameter through the initializer the construction's labels select", () => {
    const target = new SwiftCallResolver().resolve(call("state", "reset", 11), context(null));
    expect(target?.targetSymbolId).toBe("DataRequest.DataMutableState#reset");
  });

  it("binds nothing when no initializer takes the construction's labels", () => {
    expect(new SwiftCallResolver().resolve(call("state", "reset", 11), context("value"))).toBeNull();
  });
});

describe("SwiftCallResolver — closures passed to a BARE callee (bd tea-rags-mcp-y99pg.29)", () => {
  const t = table({
    "Sources/Request.swift": [
      { symbolId: "Request", scope: [] },
      { symbolId: "Request#resume", scope: ["Request"] },
      { symbolId: "Request#finish", scope: ["Request"] },
      { symbolId: "Request#withState", scope: ["Request"] },
      { symbolId: "Request.State", scope: ["Request"] },
      { symbolId: "Request.State#canTransitionTo", scope: ["Request", "State"] },
    ],
  });
  const typeDeclarations = {
    "Sources/Request.swift": [
      { typeId: "Request", reopens: false, memberClosureParameters: { withState: ["Request.State"] } },
      { typeId: "Request.State", reopens: false },
    ],
  };
  const context = (callee: string, name = "continuation", symbolTable = t): CallContext =>
    ctx({
      callerFile: "Sources/Request.swift",
      callerScope: ["Request", "run"],
      symbolTable,
      typeDeclarations,
      callResultBindings: { [name]: [{ line: 10, callee, closureParameter: 0, scopeEndLine: 12 }] },
    });

  it("types the closure parameter of a module-level SDK function", () => {
    // `withCheckedContinuation { continuation in continuation.resume(…) }` runs
    // `CheckedContinuation.resume`, never the project's `Request#resume`.
    const resolver = new SwiftCallResolver();
    const site = call("continuation", "resume", 11);
    expect(resolver.hasInProjectDefinition(site, context("withCheckedContinuation"))).toBe(false);
    expect(resolver.hasInProjectDefinition(site, context("withCheckedThrowingContinuation"))).toBe(false);
  });

  it("keeps the denominator when the project declares a module-level namesake of the SDK function", () => {
    const shadowed = table({
      "Sources/Request.swift": [
        { symbolId: "Request", scope: [] },
        { symbolId: "Request#resume", scope: ["Request"] },
      ],
      "Sources/Helpers.swift": [{ symbolId: "withCheckedContinuation", scope: [] }],
    });
    const site = call("continuation", "resume", 11);
    const within = context("withCheckedContinuation", "continuation", shadowed);
    expect(new SwiftCallResolver().hasInProjectDefinition(site, within)).toBe(true);
  });

  it("types the closure parameter of an implicit-self method of the enclosing type", () => {
    const target = new SwiftCallResolver().resolve(call("$0", "canTransitionTo", 11), context("withState", "$0"));
    expect(target?.targetSymbolId).toBe("Request.State#canTransitionTo");
  });

  it("types the closure parameter of a project type's initializer", () => {
    const withStream = table({
      "Sources/Request.swift": [
        { symbolId: "Request", scope: [] },
        { symbolId: "Request#finish", scope: ["Request"] },
      ],
      "Sources/StreamOf.swift": [{ symbolId: "StreamOf", scope: [] }],
    });
    const within = ctx({
      callerFile: "Sources/Request.swift",
      callerScope: ["Request", "run"],
      symbolTable: withStream,
      typeDeclarations: {
        ...typeDeclarations,
        "Sources/StreamOf.swift": [
          {
            typeId: "StreamOf",
            reopens: false,
            genericParameters: ["Element"],
            memberClosureParameters: { init: ["Continuation"] },
          },
        ],
      },
      callResultBindings: {
        continuation: [{ line: 10, callee: "StreamOf", closureParameter: 0, scopeEndLine: 12 }],
      },
    });
    expect(new SwiftCallResolver().hasInProjectDefinition(call("continuation", "finish", 11), within)).toBe(false);
  });

  it("types the closure parameter of an SDK type's initializer", () => {
    // `AsyncStream { continuation in … }` calls its builder with an `AsyncStream.Continuation`.
    const site = call("continuation", "finish", 11);
    expect(new SwiftCallResolver().hasInProjectDefinition(site, context("AsyncStream"))).toBe(false);
  });

  it("proves external a bare call the enclosing type's SDK conformance declares", () => {
    // `map(\.result)` inside `struct DataResponsePublisher: Publisher` is
    // `self.map` — Combine's `Publisher.map` — never `DataResponse#map`.
    const withPublisher = table({
      "Sources/Combine.swift": [
        { symbolId: "DataResponsePublisher", scope: [] },
        { symbolId: "DataResponsePublisher#result", scope: ["DataResponsePublisher"] },
      ],
      "Sources/Response.swift": [
        { symbolId: "DataResponse", scope: [] },
        { symbolId: "DataResponse#map", scope: ["DataResponse"] },
      ],
    });
    const within = (callerScope: string[], conforms: string[]): CallContext =>
      ctx({
        callerFile: "Sources/Combine.swift",
        callerScope,
        symbolTable: withPublisher,
        typeDeclarations: {
          "Sources/Combine.swift": [{ typeId: "DataResponsePublisher", reopens: false, conforms }],
          "Sources/Response.swift": [{ typeId: "DataResponse", reopens: false }],
        },
      });
    const resolver = new SwiftCallResolver();
    const site = call(null, "map", 11);
    expect(resolver.hasInProjectDefinition(site, within(["DataResponsePublisher", "result"], ["Publisher"]))).toBe(
      false,
    );
    // INVARIANT CHANGED (bd tea-rags-mcp-y99pg.39): with no SDK supertype
    // declaring `map`, the bare name still cannot be `DataResponse#map` — that
    // type is off `DataResponsePublisher`'s lookup, so the site leaves the
    // denominator whatever the SDK says. A project member ON the lookup keeps
    // it (see "a bare name reaches only what lexical lookup reaches").
    expect(resolver.hasInProjectDefinition(site, within(["DataResponsePublisher", "result"], []))).toBe(false);
  });

  it("types nothing for a bare callee neither the enclosing type nor the SDK declares", () => {
    const site = call("continuation", "finish", 11);
    expect(new SwiftCallResolver().hasInProjectDefinition(site, context("makeStream"))).toBe(true);
  });
});

describe("SwiftCallResolver — a nested enum's payload bound through `self` (bd tea-rags-mcp-y99pg.31)", () => {
  // `case let .formatted(formatter): formatter.string(from: date)` inside a
  // method of `URLEncodedFormEncoder.DateEncoding`: `self` names the NESTED
  // enum, whose cases are published under its qualified id.
  const t = table({
    "Sources/URLEncodedFormEncoder.swift": [
      { symbolId: "URLEncodedFormEncoder", scope: [] },
      { symbolId: "URLEncodedFormEncoder.DateEncoding", scope: ["URLEncodedFormEncoder"] },
      {
        symbolId: "URLEncodedFormEncoder.DateEncoding#encode",
        scope: ["URLEncodedFormEncoder", "DateEncoding"],
      },
    ],
    "Sources/ResponseSerialization.swift": [
      { symbolId: "StringResponseSerializer", scope: [] },
      { symbolId: "StringResponseSerializer.string", scope: ["StringResponseSerializer"] },
    ],
  });
  const within = ctx({
    callerFile: "Sources/URLEncodedFormEncoder.swift",
    callerScope: ["URLEncodedFormEncoder", "DateEncoding", "encode"],
    symbolTable: t,
    typeDeclarations: {
      "Sources/URLEncodedFormEncoder.swift": [
        { typeId: "URLEncodedFormEncoder", reopens: false },
        {
          typeId: "URLEncodedFormEncoder.DateEncoding",
          reopens: false,
          enumCasePayloads: { formatted: ["DateFormatter"] },
        },
      ],
      "Sources/ResponseSerialization.swift": [{ typeId: "StringResponseSerializer", reopens: false }],
    },
    callResultBindings: {
      formatter: [{ line: 5, callee: "self", enumPayload: { caseName: "formatted", index: 0 }, scopeEndLine: 6 }],
    },
  });

  it("types the payload name, so an SDK member only a project namesake shares leaves the denominator", () => {
    const site = call("formatter", "string", 6);
    const resolver = new SwiftCallResolver();
    expect(resolver.resolve(site, within)).toBeNull();
    expect(resolver.hasInProjectDefinition(site, within)).toBe(false);
  });
});

/**
 * A MODULE-LEVEL value (bd tea-rags-mcp-y99pg.30): `public let AF =
 * Session.default` at file scope is visible to every file of the module, and
 * `AF.request(…)` is a project call. The walker publishes such a value under
 * the module-scope key `<relPath>::` — typed on `classFieldTypesByClassKey`
 * where the declaration spells its type, by SPELLING on
 * `classFieldCallResults` where only the resolver can fold it.
 */
describe("SwiftCallResolver — module-level values (bd tea-rags-mcp-y99pg.30)", () => {
  const t = table({
    "Sources/Session.swift": [
      { symbolId: "Session", scope: [] },
      { symbolId: "Session#request", scope: ["Session"] },
    ],
    "Sources/DataRequest.swift": [
      { symbolId: "DataRequest", scope: [] },
      { symbolId: "DataRequest#responseDecodable", scope: ["DataRequest"] },
    ],
    "Sources/Store.swift": [
      { symbolId: "Store", scope: [] },
      { symbolId: "Store#save", scope: ["Store"] },
      { symbolId: "Other", scope: [] },
      { symbolId: "Other#request", scope: ["Other"] },
    ],
  });
  const typeDeclarations = {
    "Sources/Session.swift": [{ typeId: "Session", reopens: false }],
    "Sources/DataRequest.swift": [{ typeId: "DataRequest", reopens: false }],
    "Sources/Store.swift": [
      { typeId: "Store", reopens: false },
      { typeId: "Other", reopens: false },
    ],
  };
  const spelled = { "Sources/Alamofire.swift::": { AF: "Session.default" } };

  it("types a module value by folding its spelling in module scope", () => {
    const target = new SwiftCallResolver().resolve(
      call("AF", "request"),
      ctx({
        callerFile: "Example/Master.swift",
        callerScope: ["Master", "prepare"],
        symbolTable: t,
        typeDeclarations,
        classFieldCallResults: spelled,
      }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/Session.swift", targetSymbolId: "Session#request" });
  });

  it("types a module value its declaration types", () => {
    const target = new SwiftCallResolver().resolve(
      call("sharedStore", "save"),
      ctx({
        callerFile: "Sources/Caller.swift",
        symbolTable: t,
        typeDeclarations,
        classFieldTypesByClassKey: { "Sources/Globals.swift::": { sharedStore: "Store" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("Store#save");
  });

  it("types a module value as the HEAD of a chain", () => {
    const target = new SwiftCallResolver().resolve(
      call('AF.request("https://x")', "responseDecodable"),
      ctx({
        callerFile: "Example/Networking.swift",
        callerScope: ["Networking", "perform"],
        symbolTable: t,
        typeDeclarations,
        classFieldCallResults: spelled,
        structuredReturnTypes: { "Session#request": { form: "instance", name: "DataRequest" } },
      }),
    );
    expect(target?.targetSymbolId).toBe("DataRequest#responseDecodable");
  });

  it("lets a local of the same name shadow the module value", () => {
    const target = new SwiftCallResolver().resolve(
      call("AF", "request"),
      ctx({
        callerFile: "Example/Master.swift",
        symbolTable: t,
        typeDeclarations,
        classFieldCallResults: spelled,
        localBindings: { AF: [{ line: 5, type: "Other" }] },
      }),
    );
    expect(target?.targetSymbolId).toBe("Other#request");
  });

  it("types nothing when two files declare a module value of that name", () => {
    const target = new SwiftCallResolver().resolve(
      call("AF", "request"),
      ctx({
        callerFile: "Example/Master.swift",
        symbolTable: t,
        typeDeclarations,
        classFieldCallResults: { ...spelled, "Sources/Other.swift::": { AF: "Other.shared" } },
      }),
    );
    expect(target).toBeNull();
  });

  it("keeps a module-value receiver in the denominator only for its own type's members", () => {
    const context = ctx({
      callerFile: "Example/Master.swift",
      symbolTable: t,
      typeDeclarations,
      classFieldTypesByClassKey: { "Sources/Globals.swift::": { sharedStore: "Store" } },
    });
    const resolver = new SwiftCallResolver();
    // `Other#request` is a namesake: a `Store` cannot reach it.
    expect(resolver.hasInProjectDefinition(call("sharedStore", "request"), context)).toBe(false);
    expect(resolver.hasInProjectDefinition(call("sharedStore", "save"), context)).toBe(true);
  });
});

/**
 * `extension Download where Self: DataSerializer` (bd tea-rags-mcp-y99pg.33):
 * inside that body `Self` conforms to BOTH protocols, so a bare
 * `serialize(…)` is `DataSerializer`'s requirement — Alamofire's
 * `serializeDownload` default. Only the extension carrying the constraint
 * sees it: a sibling extension of the same protocol in the same file does not.
 */
describe("SwiftCallResolver — a protocol extension's `where Self` constraints (bd tea-rags-mcp-y99pg.33)", () => {
  const t = table({
    "Sources/ResponseSerialization.swift": [
      { symbolId: "DataSerializer", scope: [] },
      { symbolId: "DataSerializer#serialize", scope: ["DataSerializer"] },
      { symbolId: "Download", scope: [] },
      { symbolId: "Download#serializeDownload", scope: ["Download"] },
      { symbolId: "Download#other", scope: ["Download"] },
    ],
    // A namesake on an unrelated type: the short name alone is ambiguous.
    "Sources/StringSerializer.swift": [
      { symbolId: "StringSerializer", scope: [] },
      { symbolId: "StringSerializer#serialize", scope: ["StringSerializer"] },
    ],
  });
  const within = ctx({
    callerFile: "Sources/ResponseSerialization.swift",
    callerScope: ["Download", "serializeDownload"],
    symbolTable: t,
    typeDeclarations: {
      "Sources/ResponseSerialization.swift": [
        { typeId: "DataSerializer", reopens: false },
        { typeId: "Download", reopens: false },
        {
          typeId: "Download",
          reopens: true,
          selfConstraints: { types: ["DataSerializer"], startLine: 20, endLine: 30 },
        },
        { typeId: "Download", reopens: true },
      ],
    },
  });

  it("resolves a bare call to the constraint's member inside the constrained extension", () => {
    expect(new SwiftCallResolver().resolve(call(null, "serialize", 25), within)).toEqual({
      targetRelPath: "Sources/ResponseSerialization.swift",
      targetSymbolId: "DataSerializer#serialize",
    });
  });

  it("resolves `self.` the same way", () => {
    expect(new SwiftCallResolver().resolve(call("self", "serialize", 25), within)?.targetSymbolId).toBe(
      "DataSerializer#serialize",
    );
  });

  it("does not lend the constraint to a line outside that extension", () => {
    expect(new SwiftCallResolver().resolve(call(null, "serialize", 40), within)).toBeNull();
  });

  it("still prefers the extended protocol's own member", () => {
    expect(new SwiftCallResolver().resolve(call(null, "other", 25), within)?.targetSymbolId).toBe("Download#other");
  });
});

/**
 * `$result` on a property-wrapped stored property (bd tea-rags-mcp-y99pg.33)
 * is the wrapper's `projectedValue` — Swift synthesizes it only when the
 * outermost wrapper declares one. `@Published var result` projects a
 * `Published<Value>.Publisher`, so `$result.compactMap(\.self).map { … }` is
 * Combine's `Publisher.map`, and a project `map` on an unrelated type is a
 * namesake the site can never reach.
 */
describe("SwiftCallResolver — a property wrapper's projected value `$name` (bd tea-rags-mcp-y99pg.33)", () => {
  const t = table({
    "Sources/DataResponse.swift": [
      { symbolId: "DataResponse", scope: [] },
      { symbolId: "DataResponse#map", scope: ["DataResponse"] },
    ],
    "Sources/Guarded.swift": [
      { symbolId: "Guarded", scope: [] },
      { symbolId: "GuardedProjection", scope: [] },
      { symbolId: "GuardedProjection#reset", scope: ["GuardedProjection"] },
      { symbolId: "GuardedProjection#map", scope: ["GuardedProjection"] },
    ],
    "Example/Networking.swift": [
      { symbolId: "Networking", scope: [] },
      { symbolId: "Networking#init", scope: ["Networking"] },
    ],
  });
  const typeDeclarations = {
    "Sources/DataResponse.swift": [{ typeId: "DataResponse", reopens: false }],
    "Sources/Guarded.swift": [
      { typeId: "Guarded", reopens: false },
      { typeId: "GuardedProjection", reopens: false },
    ],
    "Example/Networking.swift": [
      {
        typeId: "Networking",
        reopens: false,
        propertyAttributeTypes: { result: ["Published"], state: ["Guarded"], level: ["MainActor"] },
      },
    ],
  };
  const within = ctx({
    callerFile: "Example/Networking.swift",
    callerScope: ["Networking", "init"],
    symbolTable: t,
    typeDeclarations,
    classFieldTypesByClassKey: {
      "Sources/Guarded.swift::Guarded": { wrappedValue: "State", projectedValue: "GuardedProjection" },
    },
  });

  it("types `$name` as an SDK wrapper's projected value, proving Combine's `map` external", () => {
    const resolver = new SwiftCallResolver();
    expect(resolver.hasInProjectDefinition(call("$result\n    .compactMap(\\.self)", "map"), within)).toBe(false);
    expect(resolver.hasInProjectDefinition(call("self.$result", "map"), within)).toBe(false);
  });

  it("types `$name` as a project wrapper's projected value, and resolves on it", () => {
    expect(new SwiftCallResolver().resolve(call("$state", "reset"), within)?.targetSymbolId).toBe(
      "GuardedProjection#reset",
    );
  });

  it("types nothing through an attribute that is not a property wrapper", () => {
    expect(new SwiftCallResolver().hasInProjectDefinition(call("$level", "map"), within)).toBe(true);
  });
});

/**
 * `T?` is `Optional<T>` (bd tea-rags-mcp-y99pg.33). A member written straight
 * on an optional — no `?` / `!` between them — is `Optional`'s own: Alamofire's
 * `response.map(\.statusCode).map { … }` on an `HTTPURLResponse?` runs
 * `Optional.map` twice, and a project `map` on another type is a namesake.
 * Behind `?` / `!` the member is the wrapped type's. A member `Optional` does
 * not declare is read off the wrapped type either way, which is where a value
 * the index believes optional but the source unwrapped some other way lands.
 */
describe("SwiftCallResolver — Optional values and unwrap sugar (bd tea-rags-mcp-y99pg.33)", () => {
  const t = table({
    "Sources/DataResponse.swift": [
      { symbolId: "DataResponse", scope: [] },
      { symbolId: "DataResponse#map", scope: ["DataResponse"] },
    ],
    "Sources/Box.swift": [
      { symbolId: "Box", scope: [] },
      { symbolId: "Box#map", scope: ["Box"] },
      { symbolId: "Box#open", scope: ["Box"] },
    ],
    "Sources/Completion.swift": [{ symbolId: "Completion", scope: [] }],
  });
  const typeDeclarations = {
    "Sources/DataResponse.swift": [{ typeId: "DataResponse", reopens: false }],
    "Sources/Box.swift": [{ typeId: "Box", reopens: false }],
    "Sources/Completion.swift": [{ typeId: "Completion", reopens: false, optionalProperties: ["error", "box"] }],
  };
  const optional = (name: string) => ({
    form: "instance" as const,
    name: "Optional",
    args: [{ form: "instance" as const, name }],
  });
  const within = ctx({
    callerFile: "Sources/Serializer.swift",
    callerScope: ["Serializer", "run"],
    symbolTable: t,
    typeDeclarations,
    localBindings: {
      response: [{ line: 5, type: "HTTPURLResponse", typeRef: optional("HTTPURLResponse") }],
      request: [{ line: 5, type: "URLRequest", typeRef: optional("URLRequest") }],
      box: [{ line: 5, type: "Box", typeRef: optional("Box") }],
      completion: [{ line: 5, type: "Completion" }],
    },
    classFieldTypesByClassKey: { "Sources/Completion.swift::Completion": { error: "AFError", box: "Box" } },
  });
  const written = (receiver: string, writtenReceiver: string, member: string) => ({
    ...call(receiver, member),
    writtenReceiver,
  });

  it("reads a member written straight on an optional off `Optional`", () => {
    const resolver = new SwiftCallResolver();
    expect(resolver.hasInProjectDefinition(call("response.map(\\.statusCode)", "map"), within)).toBe(false);
    expect(
      resolver.hasInProjectDefinition(
        call("request.flatMap(\\.httpMethod)\n  .flatMap(HTTPMethod.init)", "map"),
        within,
      ),
    ).toBe(false);
    expect(resolver.hasInProjectDefinition(call("box", "map"), within)).toBe(false);
    expect(resolver.resolve(call("box", "map"), within)).toBeNull();
  });

  it("reads a member behind `?` / `!` off the wrapped type", () => {
    const resolver = new SwiftCallResolver();
    expect(resolver.resolve(written("box", "box?", "map"), within)?.targetSymbolId).toBe("Box#map");
    expect(resolver.resolve(written("box", "box!", "map"), within)?.targetSymbolId).toBe("Box#map");
  });

  it("reads a member `Optional` does not declare off the wrapped type", () => {
    expect(new SwiftCallResolver().resolve(call("box", "open"), within)?.targetSymbolId).toBe("Box#open");
  });

  it("types a property declared optional as an Optional", () => {
    const resolver = new SwiftCallResolver();
    // `completion.box` is a `Box?`: `.map` on it is `Optional.map`, never `Box#map`.
    expect(resolver.hasInProjectDefinition(call("completion.box", "map"), within)).toBe(false);
    expect(resolver.resolve(written("completion.box", "completion.box?", "map"), within)?.targetSymbolId).toBe(
      "Box#map",
    );
  });
});

/**
 * `compactMap { stream in … }` inside `struct DataStreamPublisher: Publisher`
 * is Combine's `Publisher.compactMap`, whose closure takes `Self.Output` —
 * and on this conformer `Output` is what its own `typealias Output = …`
 * names (bd tea-rags-mcp-y99pg.33).
 */
describe("SwiftCallResolver — a conformer's member typealias binds `Self.X` (bd tea-rags-mcp-y99pg.33)", () => {
  const t = table({
    "Sources/Combine.swift": [
      { symbolId: "DataStreamPublisher", scope: [] },
      { symbolId: "DataStreamPublisher#result", scope: ["DataStreamPublisher"] },
    ],
    "Sources/DataStreamRequest.swift": [
      { symbolId: "DataStreamRequest", scope: [] },
      { symbolId: "DataStreamRequest.Stream", scope: ["DataStreamRequest"] },
      { symbolId: "DataStreamRequest.Stream#cancel", scope: ["DataStreamRequest", "Stream"] },
    ],
    "Sources/Request.swift": [
      { symbolId: "Request", scope: [] },
      { symbolId: "Request#cancel", scope: ["Request"] },
    ],
  });
  const within = (memberTypeAliases?: Record<string, string>): CallContext =>
    ctx({
      callerFile: "Sources/Combine.swift",
      callerScope: ["DataStreamPublisher", "result"],
      symbolTable: t,
      typeDeclarations: {
        "Sources/Combine.swift": [
          {
            typeId: "DataStreamPublisher",
            reopens: false,
            conforms: ["Publisher"],
            genericParameters: ["Value"],
            ...(memberTypeAliases ? { memberTypeAliases } : {}),
          },
        ],
        "Sources/DataStreamRequest.swift": [
          { typeId: "DataStreamRequest", reopens: false },
          { typeId: "DataStreamRequest.Stream", reopens: false, genericParameters: ["Success", "Failure"] },
        ],
        "Sources/Request.swift": [{ typeId: "Request", reopens: false }],
      },
      callResultBindings: { stream: [{ line: 10, callee: "compactMap", closureParameter: 0, scopeEndLine: 12 }] },
    });

  it("types the SDK closure's `Self.Output` parameter by the conformer's alias", () => {
    const target = new SwiftCallResolver().resolve(
      call("stream", "cancel", 11),
      within({ Output: "DataStreamRequest.Stream" }),
    );
    expect(target?.targetSymbolId).toBe("DataStreamRequest.Stream#cancel");
  });

  it("types nothing when the conformer declares no such alias", () => {
    expect(new SwiftCallResolver().resolve(call("stream", "cancel", 11), within())).toBeNull();
  });
});

describe("SwiftCallResolver — a closure parameter declared with generic arguments (bd tea-rags-mcp-y99pg.32)", () => {
  // Session.swift: `guard let adapter = adapter(for: request)`, then
  // `adapter.adapt(initialRequest, using: state) { result in
  //    let adaptedRequest = try result.get(); try adaptedRequest.validate() }`
  // with `completion: (Result<URLRequest, any Error>) -> Void` declared on the
  // protocol in another file.
  const t = table({
    "Sources/RequestInterceptor.swift": [
      { symbolId: "RequestAdapter", scope: [] },
      { symbolId: "RequestAdapter#adapt", scope: ["RequestAdapter"] },
    ],
    "Sources/URLRequest+Alamofire.swift": [
      { symbolId: "URLRequest", scope: [] },
      { symbolId: "URLRequest#validate", scope: ["URLRequest"] },
    ],
    "Sources/Session.swift": [
      { symbolId: "Session", scope: [] },
      { symbolId: "Session#perform", scope: ["Session"] },
    ],
  });
  const declarations = (adapt: string) => ({
    "Sources/RequestInterceptor.swift": [
      { typeId: "RequestAdapter", reopens: false, memberClosureParameters: { adapt: [adapt] } },
    ],
    "Sources/URLRequest+Alamofire.swift": [{ typeId: "URLRequest", reopens: true }],
    "Sources/Session.swift": [{ typeId: "Session", reopens: false }],
  });
  const context = (adapt: string): CallContext =>
    ctx({
      callerFile: "Sources/Session.swift",
      callerScope: ["Session", "perform"],
      symbolTable: t,
      typeDeclarations: declarations(adapt),
      localBindings: { adapter: [{ line: 9, type: "RequestAdapter", scopeEndLine: 15 }] },
      callResultBindings: {
        result: [{ line: 10, callee: "adapter.adapt", closureParameter: 0, scopeEndLine: 15 }],
        adaptedRequest: [{ line: 11, callee: "result.get", scopeEndLine: 15 }],
      },
    });

  it("substitutes the declared arguments into the SDK member the parameter is read through", () => {
    const target = new SwiftCallResolver().resolve(
      call("adaptedRequest", "validate", 12),
      context("Result<URLRequest, Error>"),
    );
    expect(target?.targetSymbolId).toBe("URLRequest#validate");
  });

  it("types nothing through a closure parameter published without its arguments", () => {
    const target = new SwiftCallResolver().resolve(call("adaptedRequest", "validate", 12), context("Result"));
    expect(target).toBeNull();
  });
});

describe("SwiftCallResolver — a constrained extension binds the extended type's generic parameters (bd tea-rags-mcp-y99pg.34)", () => {
  const t = table({
    "Sources/Protected.swift": [
      { symbolId: "Protected", scope: [] },
      { symbolId: "Protected#attemptToTransitionTo", scope: ["Protected"] },
    ],
    "Sources/Request.swift": [
      { symbolId: "Request", scope: [] },
      { symbolId: "Request.MutableState", scope: ["Request"] },
      { symbolId: "Request.State", scope: ["Request"] },
      { symbolId: "Request.State#canTransitionTo", scope: ["Request", "State"] },
    ],
    "Sources/Other.swift": [
      { symbolId: "Other", scope: [] },
      { symbolId: "Other#canTransitionTo", scope: ["Other"] },
    ],
    "Sources/AlamofireExtended.swift": [{ symbolId: "AlamofireExtension", scope: [] }],
    "Sources/Response.swift": [
      { symbolId: "DataResponse", scope: [] },
      { symbolId: "DataResponse#map", scope: ["DataResponse"] },
    ],
  });
  const typeDeclarations = {
    "Sources/Protected.swift": [
      { typeId: "Protected", reopens: false, genericParameters: ["Value"], genericFieldParameters: { value: "Value" } },
      {
        typeId: "Protected",
        reopens: true,
        whereClause: { startLine: 9, endLine: 15, sameType: { Value: "Request.MutableState" } },
      },
    ],
    "Sources/Request.swift": [
      { typeId: "Request", reopens: false },
      { typeId: "Request.MutableState", reopens: false },
      { typeId: "Request.State", reopens: false },
    ],
    "Sources/Other.swift": [{ typeId: "Other", reopens: false }],
    "Sources/Response.swift": [{ typeId: "DataResponse", reopens: false }],
    "Sources/AlamofireExtended.swift": [
      {
        typeId: "AlamofireExtension",
        reopens: false,
        genericParameters: ["ExtendedType"],
        genericFieldParameters: { type: "ExtendedType" },
      },
    ],
    "Sources/Certificates.swift": [
      {
        typeId: "AlamofireExtension",
        reopens: true,
        whereClause: { startLine: 1, endLine: 5, sameType: { ExtendedType: "[SecCertificate]" } },
      },
    ],
  };
  const protectedContext = ctx({
    callerFile: "Sources/Protected.swift",
    callerScope: ["Protected"],
    symbolTable: t,
    typeDeclarations,
    classFieldTypes: { MutableState: { state: "State" } },
  });

  it("types a generic-typed stored property by the clause's same-type binding", () => {
    // `value.state.canTransitionTo(state)` inside `extension Protected where Value == Request.MutableState`.
    const target = new SwiftCallResolver().resolve(call("value.state", "canTransitionTo", 11), protectedContext);
    expect(target?.targetSymbolId).toBe("Request.State#canTransitionTo");
  });

  it("binds nothing outside the lines the clause scopes", () => {
    expect(new SwiftCallResolver().resolve(call("value.state", "canTransitionTo", 30), protectedContext)).toBeNull();
  });

  it("proves an SDK member on a same-type-bound SDK value is not in the project", () => {
    // `type.map { … }` inside `extension AlamofireExtension where ExtendedType == [SecCertificate]`.
    const context = ctx({
      callerFile: "Sources/Certificates.swift",
      callerScope: ["AlamofireExtension"],
      symbolTable: t,
      typeDeclarations,
    });
    const resolver = new SwiftCallResolver();
    expect(resolver.hasInProjectDefinition(call("type", "map", 3), context)).toBe(false);
    expect(resolver.hasInProjectDefinition(call("type", "map", 20), context)).toBe(true);
  });

  describe("a value known only by a CLASS bound", () => {
    // `type.paths(forResourcesOfType:inDirectory:)` inside `extension
    // AlamofireExtension where ExtendedType: Bundle`, beside the project's own
    // `AlamofireExtension.paths(forResourcesOfTypes:)`.
    const bounded = (bound: string, extra: Record<string, { symbolId: string; scope: string[] }[]> = {}) => {
      const symbolTable = table({
        "Sources/AlamofireExtended.swift": [
          { symbolId: "AlamofireExtension", scope: [] },
          { symbolId: "AlamofireExtension#paths", scope: ["AlamofireExtension"] },
        ],
        ...extra,
      });
      const declarations: Record<string, { typeId: string; reopens: boolean; conforms?: string[] }[]> = {};
      for (const [relPath, defs] of Object.entries(extra)) {
        declarations[relPath] = defs
          .filter((d) => d.scope.length === 0)
          .map((d) => ({ typeId: d.symbolId, reopens: false, conforms: [bound] }));
      }
      return ctx({
        callerFile: "Sources/Bundle.swift",
        callerScope: ["AlamofireExtension"],
        symbolTable,
        typeDeclarations: {
          ...declarations,
          "Sources/AlamofireExtended.swift": typeDeclarations["Sources/AlamofireExtended.swift"],
          "Sources/Bundle.swift": [
            {
              typeId: "AlamofireExtension",
              reopens: true,
              whereClause: { startLine: 1, endLine: 9, bounds: { ExtendedType: bound } },
            },
          ],
        },
      });
    };

    it("proves external a member only a project type outside the bound's hierarchy declares", () => {
      expect(new SwiftCallResolver().hasInProjectDefinition(call("type", "paths", 3), bounded("Bundle"))).toBe(false);
    });

    it("keeps the denominator when a project subclass of the bound declares the member", () => {
      const withSubclass = bounded("Bundle", {
        "Sources/AppBundle.swift": [
          { symbolId: "AppBundle", scope: [] },
          { symbolId: "AppBundle#paths", scope: ["AppBundle"] },
        ],
      });
      expect(new SwiftCallResolver().hasInProjectDefinition(call("type", "paths", 3), withSubclass)).toBe(true);
    });

    it("keeps the denominator under a PROTOCOL bound, whose conformers need not say so", () => {
      expect(new SwiftCallResolver().hasInProjectDefinition(call("type", "paths", 3), bounded("Hashable"))).toBe(true);
    });
  });
});

/**
 * Alamofire `Session.deinit`: `let requests = mutableState.read(\.activeRequests)`,
 * then `for request in requests { request.finish(…) }` (bd tea-rags-mcp-y99pg.37).
 * `read<U>(_: (Value) throws -> U) -> U` returns what its closure returns; a
 * key path `\.p` passed as that closure returns `Value.p`, so `U` is the
 * property's type, and the loop draws that sequence's `Element`.
 */
describe("SwiftCallResolver — a key-path argument binds a generic method's return", () => {
  const t = table({
    "Sources/Protected.swift": [
      { symbolId: "Protected", scope: [] },
      { symbolId: "Protected#read", scope: ["Protected"] },
    ],
    "Sources/Request.swift": [
      { symbolId: "Request", scope: [] },
      { symbolId: "Request#finish", scope: ["Request"] },
    ],
    "Sources/Session.swift": [
      { symbolId: "Session", scope: [] },
      { symbolId: "Session.MutableState", scope: ["Session"] },
      { symbolId: "Session.MutableState#reset", scope: ["Session", "MutableState"] },
    ],
  });
  const protectedFact = (closureResultMembers: string[] | null) => ({
    typeId: "Protected",
    reopens: false,
    genericParameters: ["Value"],
    memberClosureParameters: { read: ["Value"] },
    ...(closureResultMembers ? { closureResultMembers } : {}),
  });
  const context = (callee: string, closureResultMembers: string[] | null = ["read"]) =>
    ctx({
      callerFile: "Sources/Session.swift",
      callerScope: ["Session"],
      symbolTable: t,
      typeDeclarations: {
        "Sources/Protected.swift": [protectedFact(closureResultMembers)],
        "Sources/Session.swift": [
          { typeId: "Session", reopens: false, fieldTypeArguments: { mutableState: ["MutableState"] } },
          {
            typeId: "Session.MutableState",
            reopens: false,
            fieldTypeArguments: { activeRequests: ["Request"] },
          },
        ],
      },
      classFieldTypes: { Session: { mutableState: "Protected" }, MutableState: { activeRequests: "Set" } },
      callResultBindings: {
        requests: [{ line: 10, callee }],
        request: [{ line: 11, callee: "requests", sequenceElement: true, scopeEndLine: 13 }],
        state: [{ line: 10, callee }],
      },
    });

  it("types the for-in item as the element of the key path's property", () => {
    const target = new SwiftCallResolver().resolve(
      call("request", "finish", 12),
      context("mutableState.read(\\.activeRequests)"),
    );
    expect(target?.targetSymbolId).toBe("Request#finish");
  });

  // `deinit` is not chunked, so its calls sit in the type's chunk, where the
  // stored property's own declaration reads as a binding of its bare type.
  it("keeps the property's generic arguments when the type chunk binds the property itself", () => {
    const withPropertyBinding = {
      ...context("mutableState.read(\\.activeRequests)"),
      localBindings: { mutableState: [{ line: 2, type: "Protected" }] },
    };
    const target = new SwiftCallResolver().resolve(call("request", "finish", 12), withPropertyBinding);
    expect(target?.targetSymbolId).toBe("Request#finish");
  });

  it("binds `\\.self` to the closure's parameter type itself", () => {
    const target = new SwiftCallResolver().resolve(call("state", "reset", 12), context("mutableState.read(\\.self)"));
    expect(target?.targetSymbolId).toBe("Session.MutableState#reset");
  });

  it("types nothing when the method does not return its closure's result", () => {
    const target = new SwiftCallResolver().resolve(
      call("request", "finish", 12),
      context("mutableState.read(\\.activeRequests)", null),
    );
    expect(target).toBeNull();
  });

  it("types nothing when the argument is not a key path", () => {
    const target = new SwiftCallResolver().resolve(call("request", "finish", 12), context("mutableState.read(x)"));
    expect(target).toBeNull();
  });
});

/**
 * A call on an `AnyObject` / `AnyClass` value is Objective-C dynamic lookup:
 * the runtime sends the selector to whatever class the value is, so the only
 * project Swift code it can land on is a method a CLASS implements. A member
 * every Swift declaration of which sits on a protocol, a struct or an enum —
 * or at module scope — has no such implementation in the project, and the
 * site leaves the denominator (bd tea-rags-mcp-y99pg.35). Quick's
 * `(specClass as AnyClass).buildExamplesIfNeeded()` reaches the Objective-C
 * `+[QuickSpec buildExamplesIfNeeded]` through a requirement of the `@objc`
 * protocol `_QuickSpecInternal`, which nothing in Swift conforms to.
 */
describe("SwiftCallResolver — Objective-C dynamic lookup on AnyObject / AnyClass (bd tea-rags-mcp-y99pg.35)", () => {
  const rows = {
    "Sources/QuickTestObservation.swift": [
      { symbolId: "_QuickSpecInternal", scope: [] },
      { symbolId: "_QuickSpecInternal.buildExamplesIfNeeded", scope: ["_QuickSpecInternal"] },
      { symbolId: "QuickTestObservation", scope: [] },
      { symbolId: "QuickTestObservation#buildAllExamplesIfNeeded", scope: ["QuickTestObservation"] },
    ],
    "Sources/Values.swift": [
      { symbolId: "Point", scope: [] },
      { symbolId: "Point#reset", scope: ["Point"] },
      { symbolId: "Mode", scope: [] },
      { symbolId: "Mode#reset", scope: ["Mode"] },
      { symbolId: "reset", scope: [] },
    ],
  };
  const declarations = {
    "Sources/QuickTestObservation.swift": [
      { typeId: "_QuickSpecInternal", reopens: false, declarationKind: "protocol" as const },
      { typeId: "QuickTestObservation", reopens: false, declarationKind: "class" as const, conforms: ["NSObject"] },
    ],
    "Sources/Values.swift": [
      { typeId: "Point", reopens: false, declarationKind: "struct" as const },
      { typeId: "Mode", reopens: false, declarationKind: "enum" as const },
    ],
  };
  const at = (over: Partial<CallContext> = {}): CallContext =>
    ctx({
      callerFile: "Sources/QuickTestObservation.swift",
      callerScope: ["QuickTestObservation", "buildAllExamplesIfNeeded"],
      symbolTable: table(rows),
      typeDeclarations: declarations,
      ...over,
    });

  it("answers false for a cast to AnyClass whose member only an @objc protocol requirement declares", () => {
    const site = call("(specClass as AnyClass)", "buildExamplesIfNeeded", 33);
    const resolver = new SwiftCallResolver();
    expect(resolver.resolve(site, at())).toBeNull();
    expect(resolver.hasInProjectDefinition(site, at())).toBe(false);
  });

  it("answers false for an AnyObject local whose member only structs, enums and free functions declare", () => {
    const context = at({ localBindings: { target: [{ line: 5, type: "AnyObject" }] } });
    expect(new SwiftCallResolver().hasInProjectDefinition(call("target", "reset"), context)).toBe(false);
  });

  it("keeps the denominator when a project class declares the member", () => {
    const withClass = table({
      ...rows,
      "Sources/Spec.swift": [
        { symbolId: "Spec", scope: [] },
        { symbolId: "Spec.buildExamplesIfNeeded", scope: ["Spec"] },
      ],
    });
    const context = at({
      symbolTable: withClass,
      typeDeclarations: {
        ...declarations,
        "Sources/Spec.swift": [{ typeId: "Spec", reopens: false, declarationKind: "class" }],
      },
    });
    const site = call("(specClass as AnyClass)", "buildExamplesIfNeeded", 33);
    expect(new SwiftCallResolver().hasInProjectDefinition(site, context)).toBe(true);
  });

  it("keeps the denominator when an extension of a type the project does not declare holds the member", () => {
    // `extension NSObject { @objc func reset() }` — an Objective-C class the
    // project re-opens is exactly where a dynamic-lookup target may live.
    const withExtension = table({
      ...rows,
      "Sources/NSObject+Reset.swift": [
        { symbolId: "NSObject", scope: [] },
        { symbolId: "NSObject#reset", scope: ["NSObject"] },
      ],
    });
    const context = at({
      symbolTable: withExtension,
      typeDeclarations: {
        ...declarations,
        "Sources/NSObject+Reset.swift": [{ typeId: "NSObject", reopens: true }],
      },
      localBindings: { target: [{ line: 5, type: "AnyObject" }] },
    });
    expect(new SwiftCallResolver().hasInProjectDefinition(call("target", "reset"), context)).toBe(true);
  });

  it("keeps the denominator when the index recorded no declaration kind for the owner", () => {
    const context = at({
      typeDeclarations: {
        ...declarations,
        "Sources/QuickTestObservation.swift": [{ typeId: "_QuickSpecInternal", reopens: false }],
      },
    });
    const site = call("(specClass as AnyClass)", "buildExamplesIfNeeded", 33);
    expect(new SwiftCallResolver().hasInProjectDefinition(site, context)).toBe(true);
  });

  it("keeps the denominator when any declaration of the owner's name is a class", () => {
    const context = at({
      typeDeclarations: {
        ...declarations,
        "Sources/Other/Point.swift": [{ typeId: "Point", reopens: false, declarationKind: "class" }],
      },
      localBindings: { target: [{ line: 5, type: "AnyObject" }] },
    });
    expect(new SwiftCallResolver().hasInProjectDefinition(call("target", "reset"), context)).toBe(true);
  });

  describe("a cast sends the selector to the OPERAND's class", () => {
    // Quick's own shape: `AsyncSpec` implements `buildExamplesIfNeeded` as a
    // class method, but `specClass` is a `QuickSpec.Type`, and `AsyncSpec` is
    // neither an ancestor nor a subclass of `QuickSpec`.
    const withSpecs = (extra: Record<string, { symbolId: string; scope: string[] }[]> = {}) =>
      table({
        ...rows,
        "Sources/QuickSpec.swift": [
          { symbolId: "QuickSpec", scope: [] },
          { symbolId: "QuickSpec.spec", scope: ["QuickSpec"] },
        ],
        "Sources/Async/AsyncSpec.swift": [
          { symbolId: "AsyncSpec", scope: [] },
          { symbolId: "AsyncSpec.buildExamplesIfNeeded", scope: ["AsyncSpec"] },
        ],
        ...extra,
      });
    const specDeclarations = {
      ...declarations,
      "Sources/QuickSpec.swift": [
        { typeId: "QuickSpec", reopens: false, declarationKind: "class" as const, conforms: ["QuickSpecBase"] },
      ],
      "Sources/Async/AsyncSpec.swift": [
        { typeId: "AsyncSpec", reopens: false, declarationKind: "class" as const, conforms: ["AsyncSpecBase"] },
      ],
    };
    const site = call("(specClass as AnyClass)", "buildExamplesIfNeeded", 33);
    const bound = { specClass: [{ line: 31, type: "QuickSpec" }] };

    it("answers false when the only implementing class is outside the operand's lineage", () => {
      const context = at({ symbolTable: withSpecs(), typeDeclarations: specDeclarations, localBindings: bound });
      expect(new SwiftCallResolver().hasInProjectDefinition(site, context)).toBe(false);
    });

    it("keeps the denominator when the operand is untyped", () => {
      const context = at({ symbolTable: withSpecs(), typeDeclarations: specDeclarations });
      expect(new SwiftCallResolver().hasInProjectDefinition(site, context)).toBe(true);
    });

    it("keeps the denominator when a subclass of the operand's class implements the selector", () => {
      const context = at({
        symbolTable: withSpecs({
          "Tests/FunctionalSpec.swift": [
            { symbolId: "FunctionalSpec", scope: [] },
            { symbolId: "FunctionalSpec.buildExamplesIfNeeded", scope: ["FunctionalSpec"] },
          ],
        }),
        typeDeclarations: {
          ...specDeclarations,
          "Tests/FunctionalSpec.swift": [
            { typeId: "FunctionalSpec", reopens: false, declarationKind: "class", conforms: ["QuickSpec"] },
          ],
        },
        localBindings: bound,
      });
      expect(new SwiftCallResolver().hasInProjectDefinition(site, context)).toBe(true);
    });

    it("keeps the denominator when an ancestor of the operand's class implements the selector", () => {
      const context = at({
        symbolTable: withSpecs(),
        typeDeclarations: {
          ...specDeclarations,
          "Sources/QuickSpec.swift": [
            { typeId: "QuickSpec", reopens: false, declarationKind: "class", conforms: ["AsyncSpec"] },
          ],
        },
        localBindings: bound,
      });
      expect(new SwiftCallResolver().hasInProjectDefinition(site, context)).toBe(true);
    });

    it("keeps the denominator when the operand's type is a protocol, whose conformers need not say so", () => {
      const context = at({
        symbolTable: withSpecs(),
        typeDeclarations: specDeclarations,
        localBindings: { specClass: [{ line: 31, type: "_QuickSpecInternal" }] },
      });
      expect(new SwiftCallResolver().hasInProjectDefinition(site, context)).toBe(true);
    });
  });

  it("leaves a receiver typed by a project protocol to the typed rule", () => {
    // Not dynamic lookup: a `_QuickSpecInternal.Type` value dispatches the
    // requirement statically, and the requirement IS the project target.
    const context = at({ localBindings: { spec: [{ line: 5, type: "_QuickSpecInternal" }] } });
    expect(new SwiftCallResolver().hasInProjectDefinition(call("spec", "buildExamplesIfNeeded"), context)).toBe(true);
  });
});

/**
 * A BARE call is resolved lexically (bd tea-rags-mcp-y99pg.39): Swift looks an
 * unqualified name up in the enclosing types — their members, inherited and
 * conformed — and then at module scope. A member of any other type is not in
 * that lookup at all: from outside `AppIconArt`, `colour(…)` never names
 * `AppIconArt.colour`, however unique the short name is.
 */
describe("SwiftCallResolver — a bare name reaches only what lexical lookup reaches", () => {
  const scriptTable = table({
    "Scripts/MakeIcon.swift": [
      { symbolId: "colour", scope: [] },
      { symbolId: "makeContext", scope: [], arity: { minRequired: 1, maxPositional: 1, hasSplat: false } },
      { symbolId: "makeContext~2", scope: [], arity: { minRequired: 2, maxPositional: 2, hasSplat: false } },
      { symbolId: "MakeIcon", scope: [] },
      { symbolId: "MakeIcon.main", scope: ["MakeIcon"] },
    ],
    "Sources/AppIconArt.swift": [
      { symbolId: "AppIconArt", scope: [] },
      { symbolId: "AppIconArt.colour", scope: ["AppIconArt"] },
      { symbolId: "AppIconArt#makeContext", scope: ["AppIconArt"] },
    ],
    "Sources/Listener.swift": [
      { symbolId: "Listener", scope: [] },
      { symbolId: "Listener#stop", scope: ["Listener"] },
    ],
    "Sources/Stream.swift": [
      { symbolId: "ByteStream", scope: [] },
      { symbolId: "ByteStream#close", scope: ["ByteStream"] },
      { symbolId: "SocketStream", scope: [] },
      { symbolId: "SocketStream#close", scope: ["SocketStream"] },
    ],
  });
  const declarations = {
    "Scripts/MakeIcon.swift": [{ typeId: "MakeIcon", reopens: false }],
    "Sources/AppIconArt.swift": [{ typeId: "AppIconArt", reopens: false }],
    "Sources/Listener.swift": [{ typeId: "Listener", reopens: false }],
    "Sources/Stream.swift": [
      { typeId: "ByteStream", reopens: false, declarationKind: "protocol" as const },
      { typeId: "SocketStream", reopens: false, conforms: ["ByteStream"] },
    ],
  };
  const at = (callerFile: string, callerScope: string[]) =>
    ctx({ callerFile, callerScope, symbolTable: scriptTable, typeDeclarations: declarations });
  const bare = (member: string, argCount: number, startLine = 30): CallRef => ({
    callText: `${member}(…)`,
    receiver: null,
    member,
    startLine,
    argCount,
    kwargKeys: [],
  });

  it("lands a module-scope call on the top-level function, not a static namesake of another type", () => {
    expect(new SwiftCallResolver().resolve(bare("colour", 1), at("Scripts/MakeIcon.swift", []))).toEqual({
      targetRelPath: "Scripts/MakeIcon.swift",
      targetSymbolId: "colour",
    });
  });

  it("lands a call inside an unrelated type on the top-level function", () => {
    expect(
      new SwiftCallResolver().resolve(bare("colour", 1), at("Scripts/MakeIcon.swift", ["MakeIcon"]))?.targetSymbolId,
    ).toBe("colour");
  });

  it("picks the top-level overload the call's arguments fit", () => {
    expect(
      new SwiftCallResolver().resolve(bare("makeContext", 2), at("Scripts/MakeIcon.swift", ["MakeIcon"]))
        ?.targetSymbolId,
    ).toBe("makeContext~2");
  });

  it("proves a bare name external when only unrelated types declare it", () => {
    // `close(fd)` inside `Listener` is Darwin's `close`: neither stream type is
    // in `Listener`'s lookup.
    const resolver = new SwiftCallResolver();
    const site = bare("close", 1);
    const context = at("Sources/Listener.swift", ["Listener"]);
    expect(resolver.resolve(site, context)).toBeNull();
    expect(resolver.hasInProjectDefinition(site, context)).toBe(false);
  });

  it("keeps a member the enclosing type conforms to in reach", () => {
    const context = at("Sources/Stream.swift", ["SocketStream"]);
    expect(new SwiftCallResolver().hasInProjectDefinition(bare("close", 0), context)).toBe(true);
  });

  it("reaches a local function from inside its enclosing function only", () => {
    const locals = table({
      "Sources/Config.swift": [
        { symbolId: "Config", scope: [] },
        { symbolId: "Config#init", scope: ["Config"] },
        { symbolId: "Config#init#flag", scope: ["Config", "init"] },
        { symbolId: "Config#reset", scope: ["Config"] },
      ],
      "Sources/Other.swift": [
        { symbolId: "Other", scope: [] },
        { symbolId: "Other#run#flag", scope: ["Other", "run"] },
      ],
    });
    const inside = (callerSymbolId: string): CallContext =>
      ctx({
        callerFile: "Sources/Config.swift",
        callerScope: ["Config"],
        callerSymbolId,
        symbolTable: locals,
        typeDeclarations: {
          "Sources/Config.swift": [{ typeId: "Config", reopens: false }],
          "Sources/Other.swift": [{ typeId: "Other", reopens: false }],
        },
      });
    const resolver = new SwiftCallResolver();
    expect(resolver.resolve(bare("flag", 1), inside("Config#init"))?.targetSymbolId).toBe("Config#init#flag");
    expect(resolver.resolve(bare("flag", 1), inside("Config#init#flag"))?.targetSymbolId).toBe("Config#init#flag");
    // A local composes under its container's base name: `init~2` holds it too.
    expect(resolver.resolve(bare("flag", 1), inside("Config#init~2"))?.targetSymbolId).toBe("Config#init#flag");
    expect(resolver.resolve(bare("flag", 1), inside("Config#reset"))).toBeNull();
    expect(resolver.hasInProjectDefinition(bare("flag", 1), inside("Config#reset"))).toBe(false);
  });

  it("keeps every namesake in reach on an index with no type-declaration channel", () => {
    const context = ctx({ callerFile: "Sources/Listener.swift", callerScope: ["Listener"], symbolTable: scriptTable });
    expect(new SwiftCallResolver().hasInProjectDefinition(bare("close", 1), context)).toBe(true);
  });
});
