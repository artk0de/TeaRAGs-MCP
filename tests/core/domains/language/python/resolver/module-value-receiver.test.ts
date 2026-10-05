/**
 * A module-level VALUE as a call receiver (P4, bd tea-rags-mcp-m99j1.1.15).
 *
 * `from django.apps import apps; apps.populate(x)` — `apps` is neither a symbol
 * nor a submodule; it is `apps = Apps(installed_apps=None)` in
 * `django/apps/registry.py`, re-exported by the package `__init__.py`. The
 * walker's `moduleValueTypes` says what the value holds, the import names the
 * file it came from, and the member is looked up on that class.
 *
 * The same-file shape — `connections = ConnectionHandler()` at module scope and
 * `connections.all()` inside a function of the same module — reads the same
 * channel under the caller's own file.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, ImportRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../../src/core/contracts/types/language.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

interface Def {
  readonly symbolId: string;
  readonly scope?: readonly string[];
}

function tableWith(files: Record<string, readonly Def[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      defs.map((def) => ({
        symbolId: def.symbolId,
        fqName: def.symbolId,
        shortName: def.symbolId.split(/[#.]/).pop() ?? def.symbolId,
        relPath,
        scope: [...(def.scope ?? [])],
      })),
    );
  }
  return table;
}

const instance = (name: string): TypeRef => ({ form: "instance", name });

const call = (receiver: string, member: string, startLine = 10): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine,
});

const fromImport = (importText: string, name: string): ImportRef => ({
  importText,
  startLine: 1,
  importedNames: [name],
  importedBindings: { [name]: name },
});

const DJANGO = tableWith({
  "django/__init__.py": [],
  "django/apps/__init__.py": [],
  "django/apps/registry.py": [{ symbolId: "Apps" }, { symbolId: "Apps#populate", scope: ["Apps"] }],
  "django/db/__init__.py": [{ symbolId: "close_old_connections" }],
  "django/db/utils.py": [
    { symbolId: "ConnectionHandler" },
    { symbolId: "ConnectionHandler#all", scope: ["ConnectionHandler"] },
  ],
  "django/core/management/base.py": [{ symbolId: "BaseCommand" }, { symbolId: "BaseCommand#execute" }],
  // An unrelated `populate` the short-name fallback could reach for.
  "django/contrib/sites/models.py": [{ symbolId: "populate" }],
});

const MODULE_VALUES: Record<string, TypeRef> = {
  "django/apps/registry.py::apps": instance("Apps"),
  "django/db/__init__.py::connections": instance("ConnectionHandler"),
};

const REEXPORTS: CallContext["moduleReexports"] = {
  "django/apps/__init__.py": [{ exportedName: "apps", sourceModule: ".registry", sourceName: "apps" }],
};

function ctx(parts: Partial<CallContext> & Pick<CallContext, "callerFile">): CallContext {
  return {
    callerScope: [],
    imports: [],
    symbolTable: DJANGO,
    moduleValueTypes: MODULE_VALUES,
    moduleReexports: REEXPORTS,
    ...parts,
  };
}

describe("module-level value receivers", () => {
  it("resolves an imported singleton through the package re-export to its class member", () => {
    const resolver = new PythonCallResolver();
    const target = resolver.resolve(
      call("apps", "populate"),
      ctx({ callerFile: "django/core/management/base.py", imports: [fromImport("django.apps", "apps")] }),
    );
    expect(target).toEqual({ targetRelPath: "django/apps/registry.py", targetSymbolId: "Apps#populate" });
  });

  it("resolves a same-file module variable read inside a function of that module", () => {
    const resolver = new PythonCallResolver();
    const target = resolver.resolve(
      call("connections", "all"),
      ctx({
        callerFile: "django/db/__init__.py",
        callerScope: ["close_old_connections"],
        imports: [fromImport("django.db.utils", "ConnectionHandler")],
      }),
    );
    expect(target).toEqual({ targetRelPath: "django/db/utils.py", targetSymbolId: "ConnectionHandler#all" });
  });

  it("reads the class from the VALUE's file when the caller spells the class name differently", () => {
    // The caller's own `Apps` is another class: the caller-context reading of
    // the type disagrees with the anchored one, so the fold declines and the
    // import arm answers from the declaring file.
    const table = tableWith({
      "django/__init__.py": [],
      "django/apps/__init__.py": [],
      "django/apps/registry.py": [{ symbolId: "Apps" }, { symbolId: "Apps#populate", scope: ["Apps"] }],
      "other/apps.py": [{ symbolId: "Apps" }, { symbolId: "Apps#populate", scope: ["Apps"] }],
      "other/__init__.py": [],
      "tools/run.py": [{ symbolId: "main" }],
    });
    const resolver = new PythonCallResolver();
    const target = resolver.resolve(
      call("apps", "populate"),
      ctx({
        callerFile: "tools/run.py",
        symbolTable: table,
        imports: [fromImport("django.apps", "apps"), fromImport("other.apps", "Apps")],
      }),
    );
    expect(target).toEqual({ targetRelPath: "django/apps/registry.py", targetSymbolId: "Apps#populate" });
  });

  it("lets a local binding in force shadow the module value", () => {
    const resolver = new PythonCallResolver();
    const target = resolver.resolve(
      call("connections", "all"),
      ctx({
        callerFile: "django/db/__init__.py",
        localBindings: { connections: [{ line: 5, type: "BaseCommand" }] },
      }),
    );
    expect(target?.targetSymbolId).not.toBe("ConnectionHandler#all");
  });

  it("says nothing without the channel — the pre-P4 index", () => {
    const resolver = new PythonCallResolver();
    const target = resolver.resolve(
      call("apps", "populate"),
      ctx({
        callerFile: "django/core/management/base.py",
        imports: [fromImport("django.apps", "apps")],
        moduleValueTypes: undefined,
      }),
    );
    expect(target?.targetSymbolId).not.toBe("Apps#populate");
  });
});

describe("a module value annotated with a NON-container generic (bd tea-rags-mcp-m99j1.1.33)", () => {
  // polar/worker/_enqueue.py:
  //   _job_queue_manager: contextvars.ContextVar["JobQueueManager | None"] = ...
  //   def f(): _job_queue_manager.set(manager)
  // The value is a `ContextVar`; its generic argument is what `.get()`
  // RETURNS, not what the receiver is. The snake_case name camelizes onto the
  // project's `JobQueueManager`, so the naming convention guessed
  // `JobQueueManager#set` — the annotation is a fact and the guess must yield.
  const POLAR = tableWith({
    "polar/worker/_enqueue.py": [
      { symbolId: "JobQueueManager" },
      { symbolId: "JobQueueManager#set", scope: ["JobQueueManager"] },
      { symbolId: "JobQueueManager#get", scope: ["JobQueueManager"] },
      { symbolId: "enqueue_job" },
    ],
  });
  const polarCtx = (moduleValueTypes: CallContext["moduleValueTypes"]): CallContext => ({
    callerFile: "polar/worker/_enqueue.py",
    callerScope: ["enqueue_job"],
    imports: [{ importText: "contextvars", startLine: 1, importedNames: ["contextvars"] }],
    symbolTable: POLAR,
    classAncestors: { "polar/worker/_enqueue.py::JobQueueManager": [] },
    moduleValueTypes,
  });

  it("control: with no module-value fact the convention guesses the camelized class", () => {
    const target = new PythonCallResolver().resolve(call("_job_queue_manager", "set"), polarCtx(undefined));
    expect(target?.targetSymbolId).toBe("JobQueueManager#set");
  });

  it("does not resolve `.set` / `.get` onto the generic argument's class", () => {
    const facts = { "polar/worker/_enqueue.py::_job_queue_manager": instance("contextvars.ContextVar") };
    const resolver = new PythonCallResolver();
    for (const member of ["set", "get"]) {
      const target = resolver.resolve(call("_job_queue_manager", member), polarCtx(facts));
      expect(target?.targetSymbolId).not.toBe(`JobQueueManager#${member}`);
    }
  });
});

describe("a module value read THROUGH a module alias (bd tea-rags-mcp-m99j1.1.72)", () => {
  // django/core/handlers/exception.py:
  //   from django.core import signals
  //   signals.got_request_exception.send(sender=None, request=request)
  // django/core/signals.py: `got_request_exception = Signal(providing_args=[...])`.
  // The head is a MODULE, its first link a module-level VALUE of that module;
  // the same fact that types `from django.core.signals import ...` types it.
  const SIGNALS = tableWith({
    "django/__init__.py": [],
    "django/core/__init__.py": [],
    "django/core/signals.py": [],
    "django/core/handlers/exception.py": [{ symbolId: "response_for_exception" }],
    "django/test/__init__.py": [],
    "django/test/signals.py": [{ symbolId: "clear_cache_handlers" }],
    "django/dispatch/__init__.py": [],
    "django/dispatch/dispatcher.py": [
      { symbolId: "Signal" },
      { symbolId: "Signal#send", scope: ["Signal"] },
      { symbolId: "Signal#connect", scope: ["Signal"] },
    ],
    // An unrelated `send` the short-name fallback could reach for.
    "django/core/mail/message.py": [{ symbolId: "send" }],
  });
  const SIGNAL_VALUES: Record<string, TypeRef> = {
    "django/core/signals.py::got_request_exception": instance("Signal"),
    "django/core/signals.py::setting_changed": instance("Signal"),
  };
  const SIGNAL_REEXPORTS: CallContext["moduleReexports"] = {
    "django/test/signals.py": [
      { exportedName: "setting_changed", sourceModule: "django.core.signals", sourceName: "setting_changed" },
    ],
  };
  const signalsCtx = (parts: Partial<CallContext> = {}): CallContext => ({
    callerFile: "django/core/handlers/exception.py",
    callerScope: ["response_for_exception"],
    imports: [fromImport("django.core", "signals")],
    symbolTable: SIGNALS,
    classAncestors: { "django/dispatch/dispatcher.py::Signal": [] },
    moduleValueTypes: SIGNAL_VALUES,
    moduleReexports: SIGNAL_REEXPORTS,
    ...parts,
  });

  it("resolves `<module alias>.<singleton>.<member>` on the singleton's class", () => {
    const target = new PythonCallResolver().resolve(call("signals.got_request_exception", "send"), signalsCtx());
    expect(target).toEqual({ targetRelPath: "django/dispatch/dispatcher.py", targetSymbolId: "Signal#send" });
  });

  it("follows the alias module's re-export of the singleton one hop", () => {
    const target = new PythonCallResolver().resolve(
      call("signals.setting_changed", "connect"),
      signalsCtx({ imports: [fromImport("django.test", "signals")] }),
    );
    expect(target).toEqual({ targetRelPath: "django/dispatch/dispatcher.py", targetSymbolId: "Signal#connect" });
  });

  it("resolves an imported singleton the bound module re-exports from another module", () => {
    // django/contrib/postgres/apps.py: `from django.test.signals import setting_changed`.
    const target = new PythonCallResolver().resolve(
      call("setting_changed", "connect"),
      signalsCtx({ imports: [fromImport("django.test.signals", "setting_changed")] }),
    );
    expect(target).toEqual({ targetRelPath: "django/dispatch/dispatcher.py", targetSymbolId: "Signal#connect" });
  });

  it("says nothing when the alias module holds no fact for the name", () => {
    const target = new PythonCallResolver().resolve(
      call("signals.got_request_exception", "send"),
      signalsCtx({ moduleValueTypes: {} }),
    );
    expect(target?.targetSymbolId).not.toBe("Signal#send");
  });

  it("does not type a CALL of the value as the value", () => {
    // `signals.factory().send()` reads what calling the value RETURNS.
    const target = new PythonCallResolver().resolve(call("signals.got_request_exception()", "send"), signalsCtx());
    expect(target?.targetSymbolId).not.toBe("Signal#send");
  });
});
