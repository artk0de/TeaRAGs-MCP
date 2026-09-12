/**
 * bd tea-rags-mcp-1v12o.3 — an UNRESOLVED Python call whose DEFINITION lies
 * outside the project is `externalSkipped`, not a recall hole.
 *
 * `prime` read `resolveSuccessRate 0.76` for python on ugnest while the jedi +
 * pyright oracle measured recall 0.985 with zero phantoms. The gap was entirely
 * denominator: `serializer.is_valid()` (DRF base), `self.save()` /
 * `Model.objects.create()` (Django), `obj.get()` on a `dict`, and every
 * `super().m()` reaching a library base sat in `missWithInProjectDef` because
 * the vocabulary only classified calls whose RECEIVER TEXT was rooted at an
 * external import.
 *
 * The invariant these pin: a miss is a recall hole only when the project can
 * PROVE the member absent. A receiver typed to a class nothing in the project
 * declares, or to a project class whose ancestor closure is `external`, proves
 * nothing — `AncestorClosure` already says so in as many words. An UNTYPED
 * receiver stays exactly where it is: no evidence, no reclassification.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  CallResultBinding,
  ImportRef,
  LocalBinding,
} from "../../../../../../src/core/contracts/types/codegraph.js";
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
  readonly callerScope?: readonly string[];
  readonly files?: Record<string, readonly string[]>;
  readonly classAncestors?: Record<string, readonly string[]>;
  readonly localBindings?: Record<string, LocalBinding[]>;
  readonly callResultBindings?: Record<string, CallResultBinding[]>;
  readonly imports?: readonly ImportRef[];
}

/**
 * `Ticket` in `app/models.py` extends the EXTERNAL `django.db.models::Model`;
 * `Plain` in `app/plain.py` extends nothing, so its closure is `closed`.
 */
function ctxWith(spec: CtxSpec = {}): CallContext {
  return {
    callerFile: "app/views.py",
    callerScope: [...(spec.callerScope ?? [])],
    imports: [...(spec.imports ?? [])],
    symbolTable: tableWith(
      spec.files ?? {
        "app/models.py": ["Ticket", "Ticket#describe"],
        "app/plain.py": ["Plain", "Plain#describe"],
        "app/views.py": ["TicketView", "TicketView#toggle"],
      },
    ),
    classAncestors: spec.classAncestors ?? {
      "app/models.py::Ticket": ["django.db.models::Model"],
      "app/plain.py::Plain": [],
    },
    ...(spec.localBindings === undefined ? {} : { localBindings: spec.localBindings }),
    ...(spec.callResultBindings === undefined ? {} : { callResultBindings: spec.callResultBindings }),
  };
}

const resolver = new PythonCallResolver();

function call(receiver: string | null, member: string, startLine = 20): CallRef {
  return { callText: `${receiver ?? ""}.${member}()`, receiver, member, startLine };
}

describe("PythonCallResolver.targetsExternalImport — external-typed receivers (1v12o.3)", () => {
  it("flags a receiver whose local binding types to a class the project never declares", () => {
    const ctx = ctxWith({ localBindings: { payload: [{ line: 10, type: "dict" }] } });
    expect(resolver.targetsExternalImport(call("payload", "describe"), ctx)).toBe(true);
  });

  it("flags a receiver typed to a PROJECT class whose MRO leaves the project without the member", () => {
    const ctx = ctxWith({ localBindings: { ticket: [{ line: 10, type: "Ticket" }] } });
    expect(resolver.targetsExternalImport(call("ticket", "save"), ctx)).toBe(true);
  });

  it("keeps a miss on a project class whose MRO is CLOSED — absence there is real evidence", () => {
    const ctx = ctxWith({ localBindings: { plain: [{ line: 10, type: "Plain" }] } });
    expect(resolver.targetsExternalImport(call("plain", "save"), ctx)).toBe(false);
  });

  it("does not reclassify a member the receiver's own class DOES declare", () => {
    const ctx = ctxWith({ localBindings: { ticket: [{ line: 10, type: "Ticket" }] } });
    expect(resolver.targetsExternalImport(call("ticket", "describe"), ctx)).toBe(false);
  });

  it("leaves an UNTYPED receiver exactly where it is today", () => {
    expect(resolver.targetsExternalImport(call("whatever", "save"), ctxWith())).toBe(false);
  });

  it("flags `super()` whose ancestor closure is external", () => {
    const ctx = ctxWith({ callerScope: ["Ticket"], files: { "app/models.py": ["Ticket"] } });
    const superCall: CallRef = { callText: "super().save()", receiver: "super", member: "save", startLine: 20 };
    expect(resolver.targetsExternalImport(superCall, { ...ctx, callerFile: "app/models.py" })).toBe(true);
  });

  it("leaves `super()` alone when the hierarchy is closed", () => {
    const ctx = ctxWith({ callerScope: ["Plain"], files: { "app/plain.py": ["Plain"] } });
    const superCall: CallRef = { callText: "super().save()", receiver: "super", member: "save", startLine: 20 };
    expect(resolver.targetsExternalImport(superCall, { ...ctx, callerFile: "app/plain.py" })).toBe(false);
  });

  it("flags a chain hop the project cannot prove absent on an external-closure class", () => {
    // `Ticket.objects.create(...)` — Django attaches `objects`, so the hop is
    // unprovable on a class whose MRO left the project.
    const ctx = ctxWith();
    const chain: CallRef = {
      callText: "Ticket.objects.create(x=1)",
      receiver: "Ticket.objects",
      member: "create",
      startLine: 20,
    };
    expect(resolver.targetsExternalImport(chain, ctx)).toBe(true);
  });

  it("flags a receiver bound from a call whose own chain leaves the project", () => {
    const ctx = ctxWith({ callResultBindings: { row: [{ line: 12, callee: "Ticket.objects.get" }] } });
    expect(resolver.targetsExternalImport(call("row", "save"), ctx)).toBe(true);
  });

  it("flags a bare CAPITALIZED receiver no project file declares", () => {
    expect(resolver.targetsExternalImport(call("Faker", "seed"), ctxWith())).toBe(true);
  });

  it("flags a single-segment MODULE receiver bound by an external import", () => {
    const ctx = ctxWith({ imports: [{ importText: "httpx", startLine: 1 }] });
    expect(resolver.targetsExternalImport(call("httpx", "post"), ctx)).toBe(true);
  });

  it("does NOT flag a single-segment receiver bound by a FIRST-PARTY import", () => {
    const ctx = ctxWith({
      imports: [{ importText: "app.models", startLine: 1 }],
      files: { "app/models.py": ["Ticket"] },
    });
    const local: CallRef = { callText: "models.helper()", receiver: "models", member: "helper", startLine: 20 };
    expect(resolver.targetsExternalImport(local, ctx)).toBe(false);
  });
});
