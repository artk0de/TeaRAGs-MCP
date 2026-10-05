/**
 * bd tea-rags-mcp-m99j1.1.25 (P7 / K12) — a field or local typed by a
 * constructor imported from an EXTERNAL module is external.
 *
 * `self.ready_event = threading.Event()` records the field type as the text
 * `threading.Event`; a later `self.ready_event.set()` misses (no project
 * `set`), and the miss is a recall hole only if the project could have held
 * the definition. The constructor's module decides that: stdlib or a mapper
 * `external` verdict means the definition was never ours — even when a
 * project file happens to declare a class with the same short name.
 *
 * The reverse is the precision guard: a type that resolves to an in-project
 * class is never called external by this arm.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, ImportRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function tableWith(files: Record<string, readonly string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, ids] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      ids.map((symbolId) => ({
        symbolId,
        fqName: symbolId,
        shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
        relPath,
        scope: symbolId.includes("#") || symbolId.includes(".") ? [symbolId.split(/[#.]/)[0]] : [],
      })),
    );
  }
  return table;
}

interface CtxSpec {
  readonly imports: readonly ImportRef[];
  readonly fieldType?: string;
  readonly localType?: string;
  readonly files?: Record<string, readonly string[]>;
}

/**
 * `Server` in `app/server.py` is a closed project class. `app/events.py`
 * declares a project `Event` (closed, with `fire` only) — the namesake that
 * the short-name probe alone cannot tell apart from `threading.Event`.
 */
function ctxWith(spec: CtxSpec): CallContext {
  return {
    callerFile: "app/server.py",
    callerScope: ["Server"],
    imports: [...spec.imports],
    symbolTable: tableWith(
      spec.files ?? {
        "app/server.py": ["Server", "Server#run"],
        "app/events.py": ["Event", "Event#fire"],
      },
    ),
    classAncestors: { "app/server.py::Server": [], "app/events.py::Event": [] },
    ...(spec.fieldType === undefined ? {} : { classFieldTypes: { Server: { ready_event: spec.fieldType } } }),
    ...(spec.localType === undefined ? {} : { localBindings: { lock: [{ line: 10, type: spec.localType }] } }),
  };
}

const resolver = new PythonCallResolver();

function call(receiver: string, member: string): CallRef {
  return { callText: `${receiver}.${member}()`, receiver, member, startLine: 20 };
}

describe("Python external by type — receivers typed by external constructors (P7 / K12)", () => {
  it("flags `self.ready_event.set()` when the field is `threading.Event()` from the stdlib", () => {
    const ctx = ctxWith({ imports: [{ importText: "threading", startLine: 1 }], fieldType: "threading.Event" });
    expect(resolver.targetsExternalImport(call("self.ready_event", "set"), ctx)).toBe(true);
  });

  it("flags it even when a project namesake `Event` exists — the import, not the short name, decides", () => {
    const ctx = ctxWith({
      imports: [{ importText: "threading", startLine: 1 }],
      fieldType: "threading.Event",
      files: { "app/server.py": ["Server", "Server#run"], "app/events.py": ["Event", "Event#fire", "Event#set"] },
    });
    expect(resolver.targetsExternalImport(call("self.ready_event", "set"), ctx)).toBe(true);
  });

  it("flags a field typed by a bare constructor BOUND from a stdlib module (`from threading import Event`)", () => {
    const ctx = ctxWith({
      imports: [{ importText: "threading", startLine: 1, importedNames: ["Event"] }],
      fieldType: "Event",
    });
    expect(resolver.targetsExternalImport(call("self.ready_event", "set"), ctx)).toBe(true);
  });

  it("flags a field typed by a constructor from a third-party module the mapper calls external", () => {
    const ctx = ctxWith({
      imports: [{ importText: "redis", startLine: 1 }],
      fieldType: "redis.Redis",
      files: { "app/server.py": ["Server", "Server#run"], "app/cache.py": ["Redis", "Redis#ping"] },
    });
    expect(resolver.targetsExternalImport(call("self.ready_event", "get"), ctx)).toBe(true);
  });

  it("flags a LOCAL typed by an external constructor (`lock = threading.Lock()`)", () => {
    const ctx = ctxWith({
      imports: [{ importText: "threading", startLine: 1 }],
      localType: "threading.Lock",
      files: { "app/server.py": ["Server", "Server#run"], "app/locks.py": ["Lock", "Lock#release"] },
    });
    expect(resolver.targetsExternalImport(call("lock", "acquire"), ctx)).toBe(true);
  });

  it("never flags a field whose constructor resolves to an IN-PROJECT class", () => {
    const ctx = ctxWith({
      imports: [{ importText: "app.events", startLine: 1, importedNames: ["Event"] }],
      fieldType: "Event",
    });
    expect(resolver.targetsExternalImport(call("self.ready_event", "set"), ctx)).toBe(false);
  });

  it("never flags a field typed through a FIRST-PARTY module import (`app.events.Event`)", () => {
    const ctx = ctxWith({ imports: [{ importText: "app.events", startLine: 1 }], fieldType: "app.events.Event" });
    expect(resolver.targetsExternalImport(call("self.ready_event", "set"), ctx)).toBe(false);
  });
});
