/**
 * bd tea-rags-mcp-q1g6s.10 — a call must never land, as an exact edge, on an
 * unrelated project method that merely shares (or does not even share) its name.
 *
 * Reproductions of the TaxDome rows:
 *   1. `Worker.perform_async_operation(...)` landed on `Worker#name` — the
 *      inherited class-method template was "narrowed" through a class-side
 *      `#{name}` read, resolved in INSTANCE form.
 *   2. `head(:ok)` in a controller landed on `DownloadedAttachment#head`, the
 *      only project `def head` — Rails' `ActionController::Head#head` is what runs.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, SymbolDefinition } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const tableWith = (...files: [string, SymbolDefinition[]][]): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
};

const bare = (member: string): CallRef => ({ callText: `${member}(:ok)`, receiver: null, member, startLine: 4 });

const ATTACHMENT = "app/lib/communication/mailbox/downloaded_attachment.rb";
const CONTROLLER = "app/controllers/events_controller.rb";

const controllerTable = (): InMemoryGlobalSymbolTable =>
  tableWith(
    [
      ATTACHMENT,
      [
        sym("DownloadedAttachment", "DownloadedAttachment", ATTACHMENT, []),
        sym("DownloadedAttachment#head", "head", ATTACHMENT, ["DownloadedAttachment"]),
        sym("DownloadedAttachment#streamed_helper", "streamed_helper", ATTACHMENT, ["DownloadedAttachment"]),
      ],
    ],
    [
      CONTROLLER,
      [
        sym("EventsController", "EventsController", CONTROLLER, []),
        sym("EventsController#create", "create", CONTROLLER, ["EventsController"]),
      ],
    ],
  );

const controllerCtx = (symbolTable = controllerTable()): CallContext => ({
  callerFile: CONTROLLER,
  callerScope: ["EventsController"],
  callerSymbolId: "EventsController#create",
  imports: [],
  symbolTable,
  classAncestors: { EventsController: ["ApplicationController"] },
});

describe("bareCall — a framework verb never lands on an unrelated project namesake (q1g6s.10)", () => {
  it("leaves `head(:ok)` in a controller unresolved instead of DownloadedAttachment#head", () => {
    const target = new RubyCallResolver().resolve(bare("head"), controllerCtx());
    expect(target?.targetSymbolId).not.toBe("DownloadedAttachment#head");
    expect(target).toBeNull();
  });

  it("still binds `head` when the caller's own class defines it", () => {
    const table = controllerTable();
    table.upsertFile(CONTROLLER, [
      sym("EventsController", "EventsController", CONTROLLER, []),
      sym("EventsController#create", "create", CONTROLLER, ["EventsController"]),
      sym("EventsController#head", "head", CONTROLLER, ["EventsController"]),
    ]);
    expect(new RubyCallResolver().resolve(bare("head"), controllerCtx(table))?.targetSymbolId).toBe(
      "EventsController#head",
    );
  });

  it("keeps the unique-namesake fallback for a name no framework claims", () => {
    expect(new RubyCallResolver().resolve(bare("streamed_helper"), controllerCtx())?.targetSymbolId).toBe(
      "DownloadedAttachment#streamed_helper",
    );
  });
});

const DECL = "app/lib/tech/async/declarations.rb";
const BASE = "lib/platform/async/operation/worker.rb";
const WORKER = "app/workers/process_event_worker.rb";
const ASYNC = "app/services/process_event_async.rb";

const workerTable = (): InMemoryGlobalSymbolTable =>
  tableWith(
    [
      DECL,
      [
        sym("Tech::Async::Declarations", "Declarations", DECL, ["Tech", "Async"]),
        sym("Tech::Async::Declarations.perform_async_operation", "perform_async_operation", DECL, [
          "Tech::Async::Declarations",
        ]),
      ],
    ],
    [
      BASE,
      [
        sym("Platform::Async::Operation::Worker", "Worker", BASE, ["Platform", "Async", "Operation"]),
        sym("Platform::Async::Operation::Worker#perform", "perform", BASE, ["Platform::Async::Operation::Worker"]),
        sym("Platform::Async::Operation::Worker#perform_operation", "perform_operation", BASE, [
          "Platform::Async::Operation::Worker",
        ]),
      ],
    ],
    [
      WORKER,
      [
        sym("ProcessEventWorker", "ProcessEventWorker", WORKER, []),
        sym("ProcessEventWorker#name", "name", WORKER, ["ProcessEventWorker"]),
        sym("ProcessEventWorker#perform_operation", "perform_operation", WORKER, ["ProcessEventWorker"]),
      ],
    ],
    [ASYNC, [sym("ProcessEventAsync", "ProcessEventAsync", ASYNC, [])]],
  );

const workerCtx = (selfDispatchTemplates: Record<string, string>): CallContext => ({
  callerFile: ASYNC,
  callerScope: ["ProcessEventAsync"],
  callerSymbolId: "ProcessEventAsync#start_operation",
  imports: [],
  symbolTable: workerTable(),
  classAncestors: {
    ProcessEventWorker: ["Platform::Async::Operation::Worker"],
    "Platform::Async::Operation::Worker": ["Tech::Async::Declarations"],
  },
  classExtends: { ProcessEventWorker: "Platform::Async::Operation::Worker" },
  selfDispatchTemplates,
});

const enqueue: CallRef = {
  callText: "ProcessEventWorker.perform_async_operation(owner.user, owner, args)",
  receiver: "ProcessEventWorker",
  member: "perform_async_operation",
  startLine: 9,
};

describe("enqueue wrapper — `perform_async_<x>` dispatches to the worker's run (q1g6s.10)", () => {
  it("lands on the concrete #perform_operation the worker's #perform template calls", () => {
    const target = new RubyCallResolver().resolve(
      enqueue,
      workerCtx({ "Platform::Async::Operation::Worker#perform": "perform_operation" }),
    );
    expect(target?.targetSymbolId).not.toBe("ProcessEventWorker#name");
    expect(target).toEqual({ targetRelPath: WORKER, targetSymbolId: "ProcessEventWorker#perform_operation" });
  });

  it("keeps the wrapper's own method edge when the worker's #perform is not pinned", () => {
    const table = workerTable();
    table.upsertFile(BASE, [
      sym("Platform::Async::Operation::Worker", "Worker", BASE, ["Platform", "Async", "Operation"]),
    ]);
    const ctx = { ...workerCtx({}), symbolTable: table };
    expect(new RubyCallResolver().resolve(enqueue, ctx)?.targetSymbolId).toBe(
      "Tech::Async::Declarations.perform_async_operation",
    );
  });

  it("never answers with a member whose name differs from the call's when no template narrows", () => {
    const target = new RubyCallResolver().resolve(enqueue, workerCtx({}));
    expect(target?.targetSymbolId).not.toBe("ProcessEventWorker#name");
    expect(target?.targetSymbolId).toBe("Platform::Async::Operation::Worker#perform");
  });
});
