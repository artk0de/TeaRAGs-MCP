/**
 * The boundary shapes of the external-definition probe that
 * `python-external-receiver-type.test.ts` leaves open: receivers the probe must
 * refuse to judge (null, empty head, over-long chains, `super()` outside a
 * class), the `cls` head, the callee-result channel (bare callee, project
 * method with a recorded return, depth cap) and unknown-vs-external hops.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  CallResultBinding,
  ImportRef,
  LocalBinding,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../../src/core/contracts/types/language.js";
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
  readonly callerFile?: string;
  readonly callerScope?: readonly string[];
  readonly localBindings?: Record<string, LocalBinding[]>;
  readonly callResultBindings?: Record<string, CallResultBinding[]>;
  readonly imports?: readonly ImportRef[];
  readonly structuredReturnTypes?: Record<string, TypeRef>;
}

/** `Ticket` extends the external `django.db.models::Model`; `Plain` extends nothing. */
function ctxWith(spec: CtxSpec = {}): CallContext {
  return {
    callerFile: spec.callerFile ?? "app/views.py",
    callerScope: [...(spec.callerScope ?? [])],
    imports: [...(spec.imports ?? [])],
    symbolTable: tableWith({
      "app/models.py": ["Ticket", "Ticket#describe", "Ticket#owner"],
      "app/plain.py": ["Plain", "Plain#describe"],
      "app/views.py": ["TicketView", "TicketView#toggle", "load_ticket"],
    }),
    classAncestors: {
      "app/models.py::Ticket": ["django.db.models::Model"],
      "app/plain.py::Plain": [],
    },
    ...(spec.localBindings === undefined ? {} : { localBindings: spec.localBindings }),
    ...(spec.callResultBindings === undefined ? {} : { callResultBindings: spec.callResultBindings }),
    ...(spec.structuredReturnTypes === undefined ? {} : { structuredReturnTypes: spec.structuredReturnTypes }),
  };
}

const resolver = new PythonCallResolver();

function call(receiver: string | null, member: string, startLine = 20): CallRef {
  return { callText: `${receiver ?? ""}.${member}()`, receiver, member, startLine };
}

describe("external-definition probe — receivers it refuses to judge", () => {
  it("a receiver-less call, an empty head and a `super()` outside any class are never external", () => {
    const ctx = ctxWith();
    expect(resolver.targetsExternalImport(call(null, "save"), ctx)).toBe(false);
    expect(resolver.targetsExternalImport(call("", "save"), ctx)).toBe(false);
    const superCall: CallRef = { callText: "super().save()", receiver: "super", member: "save", startLine: 20 };
    expect(resolver.targetsExternalImport(superCall, ctx)).toBe(false);
  });

  it("a receiver chain longer than the hop cap stays unknown", () => {
    const ctx = ctxWith({ localBindings: { ticket: [{ line: 10, type: "Ticket" }] } });
    const deep = "ticket.a.b.c.d.e.f.g.h.i.j.k.l";
    expect(resolver.targetsExternalImport(call(deep, "save"), ctx)).toBe(false);
  });
});

describe("external-definition probe — `cls` and constant-spelled heads", () => {
  it("`cls.objects.create(...)` reads like `Ticket.objects.create(...)` inside a classmethod", () => {
    const ctx = ctxWith({ callerFile: "app/models.py", callerScope: ["Ticket", "build"] });
    const chain: CallRef = {
      callText: "cls.objects.create(x=1)",
      receiver: "cls.objects",
      member: "create",
      startLine: 20,
    };
    expect(resolver.targetsExternalImport(chain, ctx)).toBe(true);
  });

  it("a private-underscore constant no project file declares is external; a lowercase unbound name is not", () => {
    const ctx = ctxWith();
    expect(resolver.targetsExternalImport(call("_VK_RE", "match"), ctx)).toBe(true);
    expect(resolver.targetsExternalImport(call("vk_re", "match"), ctx)).toBe(false);
  });

  it("a capitalized receiver that IS a project symbol is left alone", () => {
    expect(resolver.targetsExternalImport(call("Plain", "describe"), ctxWith())).toBe(false);
  });
});

describe("external-definition probe — values bound from a call", () => {
  it("a bare project callee with no recorded return leaves its result unknown", () => {
    const ctx = ctxWith({ callResultBindings: { ticket: [{ line: 12, callee: "load_ticket" }] } });
    expect(resolver.targetsExternalImport(call("ticket", "save"), ctx)).toBe(false);
  });

  it("a project method's recorded return type carries the result into the next hop", () => {
    const ctx = ctxWith({
      localBindings: { plain: [{ line: 5, type: "Plain" }] },
      callResultBindings: { ticket: [{ line: 12, callee: "plain.describe" }] },
      structuredReturnTypes: { "Plain#describe": { form: "instance", name: "Ticket" } },
    });
    // Plain#describe yields a Ticket, whose MRO leaves the project without `save`.
    expect(resolver.targetsExternalImport(call("ticket", "save"), ctx)).toBe(true);
    // ... and `describe` is declared on Ticket, so it is no external miss.
    expect(resolver.targetsExternalImport(call("ticket", "describe"), ctx)).toBe(false);
  });

  it("a callee whose method the project declares but records no return for stays unknown", () => {
    const ctx = ctxWith({
      localBindings: { plain: [{ line: 5, type: "Plain" }] },
      callResultBindings: { ticket: [{ line: 12, callee: "plain.describe" }] },
    });
    expect(resolver.targetsExternalImport(call("ticket", "save"), ctx)).toBe(false);
  });

  it("a callee whose method the closed project class lacks stays unknown, not external", () => {
    const ctx = ctxWith({
      localBindings: { plain: [{ line: 5, type: "Plain" }] },
      callResultBindings: { ticket: [{ line: 12, callee: "plain.fetch" }] },
    });
    expect(resolver.targetsExternalImport(call("ticket", "save"), ctx)).toBe(false);
  });

  it("a callee member on an external-closure class makes the result external", () => {
    const ctx = ctxWith({
      localBindings: { ticket: [{ line: 5, type: "Ticket" }] },
      callResultBindings: { rows: [{ line: 12, callee: "ticket.objects_all" }] },
    });
    expect(resolver.targetsExternalImport(call("rows", "first"), ctx)).toBe(true);
  });

  it("a result bound from a call that is itself bound from a call is not chased past one level", () => {
    const ctx = ctxWith({
      callResultBindings: {
        outer: [{ line: 12, callee: "inner.make" }],
        inner: [{ line: 8, callee: "Ticket.objects.get" }],
      },
    });
    expect(resolver.targetsExternalImport(call("outer", "save"), ctx)).toBe(false);
  });
});

describe("external-definition probe — instance attributes typed by an external constructor", () => {
  it("a field recorded as an externally-constructed type makes the whole receiver external", () => {
    const ctx = ctxWith({
      callerFile: "app/models.py",
      callerScope: ["Ticket", "run"],
      imports: [{ importText: "import threading", startLine: 1 }],
      structuredReturnTypes: { "Ticket#ready_event": { form: "instance", name: "threading.Event" } },
    });
    expect(resolver.targetsExternalImport(call("self.ready_event", "set"), ctx)).toBe(true);
  });
});
