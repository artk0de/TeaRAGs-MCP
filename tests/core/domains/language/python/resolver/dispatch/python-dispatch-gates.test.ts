import { describe, expect, it, vi } from "vitest";

import type {
  CallContext,
  CallRef,
  ImportRef,
  SymbolDefinition,
  SymbolResolutionOutcome,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import type { SymbolResolutionStrategy } from "../../../../../../../src/core/contracts/types/language.js";
import {
  PythonChainAnswerProbe,
  pythonDynamicFanoutSuppressed,
} from "../../../../../../../src/core/domains/language/python/resolver/dispatch/index.js";
import { PYTHON_TYPESHED_MEMBERS } from "../../../../../../../src/core/domains/language/python/vocabulary/typeshed-members.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

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

const ctxOf = (over: Partial<CallContext> = {}): CallContext => ({
  callerFile: "app/caller.py",
  callerScope: [],
  imports: [],
  symbolTable: tableWith([
    "app/service.py",
    [sym("Service", "Service", "app/service.py", []), sym("Service#perform", "perform", "app/service.py", ["Service"])],
  ]),
  ...over,
});

const callOf = (receiver: string | null, member = "perform", startLine = 10): CallRef => ({
  callText: `${receiver ?? ""}.${member}()`,
  receiver,
  member,
  startLine,
});

/** A pass that never answers — the chain the probe runs when nothing resolves. */
class SilentPass implements SymbolResolutionStrategy {
  readonly name = "silent";
  calls = 0;
  attempt(): SymbolResolutionOutcome {
    this.calls += 1;
    return { kind: "continue" };
  }
}

/** A pass that always answers, so `probe.answers` reads true. */
class AnsweringPass implements SymbolResolutionStrategy {
  readonly name = "answering";
  calls = 0;
  attempt(): SymbolResolutionOutcome {
    this.calls += 1;
    return {
      kind: "resolved",
      target: { targetRelPath: "app/other.py", targetSymbolId: "app/other.py::Other#perform" },
    };
  }
}

const NEVER_CORE_AMBIGUOUS = (): boolean => false;

describe("PythonChainAnswerProbe (w205u — one chain run per call site)", () => {
  it("runs the chain ONCE for two resolves of the same CallRef under the same context", () => {
    const pass = new SilentPass();
    const probe = new PythonChainAnswerProbe([pass]);
    const call = callOf("service");
    const ctx = ctxOf();

    expect(probe.resolve(call, ctx)).toBeNull();
    expect(probe.answers(call, ctx)).toBe(false);
    expect(pass.calls).toBe(1);
  });

  it("memoises a non-null answer and reports it through `answers`", () => {
    const pass = new AnsweringPass();
    const probe = new PythonChainAnswerProbe([pass]);
    const call = callOf("service");
    const ctx = ctxOf();

    expect(probe.answers(call, ctx)).toBe(true);
    expect(probe.resolve(call, ctx)?.targetSymbolId).toBe("app/other.py::Other#perform");
    expect(pass.calls).toBe(1);
  });

  it("re-runs the chain when the CallContext identity changes", () => {
    const pass = new SilentPass();
    const probe = new PythonChainAnswerProbe([pass]);
    const call = callOf("service");

    probe.resolve(call, ctxOf());
    probe.resolve(call, ctxOf());
    expect(pass.calls).toBe(2);
  });

  it("runs the chain per distinct CallRef", () => {
    const pass = new SilentPass();
    const probe = new PythonChainAnswerProbe([pass]);
    const ctx = ctxOf();

    probe.resolve(callOf("service"), ctx);
    probe.resolve(callOf("repo"), ctx);
    expect(pass.calls).toBe(2);
  });
});

describe("pythonDynamicFanoutSuppressed (w205u — every shape another layer owns)", () => {
  const silentProbe = (): PythonChainAnswerProbe => new PythonChainAnswerProbe([new SilentPass()]);
  const suppressed = (
    call: CallRef,
    ctx: CallContext = ctxOf(),
    probe: PythonChainAnswerProbe = silentProbe(),
    coreAmbiguous = NEVER_CORE_AMBIGUOUS,
  ): boolean => pythonDynamicFanoutSuppressed(call, ctx, probe, coreAmbiguous);

  it("declines a bare call (receiver null)", () => {
    expect(suppressed(callOf(null))).toBe(true);
  });

  it("declines an empty receiver", () => {
    expect(suppressed(callOf(""))).toBe(true);
  });

  it("declines `self` and `cls`", () => {
    expect(suppressed(callOf("self"))).toBe(true);
    expect(suppressed(callOf("cls"))).toBe(true);
  });

  it("declines any dotted receiver", () => {
    expect(suppressed(callOf("self.repo"))).toBe(true);
    expect(suppressed(callOf("mod.thing"))).toBe(true);
    expect(suppressed(callOf("a.b.c"))).toBe(true);
  });

  it("declines a chain head and an element hop", () => {
    expect(suppressed(callOf("build()"))).toBe(true);
    expect(suppressed(callOf("items[0]"))).toBe(true);
  });

  it("declines a capitalised receiver (a class object, not a value)", () => {
    expect(suppressed(callOf("Repo"))).toBe(true);
  });

  it("declines a receiver spelled like a builtin — `super`, `int`, `type`", () => {
    // httpx: `super().add_unredirected_header(…)` reaches here as the bare text
    // `super` (the walker normalises the zero-arg form), and
    // `int.__new__(cls, value)` fanned onto `codes#__new__`. Both were phantoms.
    expect(suppressed(callOf("super", "add_unredirected_header"))).toBe(true);
    expect(suppressed(callOf("int", "__new__"))).toBe(true);
    expect(suppressed(callOf("type", "perform"))).toBe(true);
  });

  it("declines a SCREAMING_SNAKE constant receiver, leading underscore included", () => {
    // ugnest: `_TELEGRAM_RE.match(value)` fanned onto `DistrictMatcher#match`.
    expect(suppressed(callOf("_TELEGRAM_RE", "match"))).toBe(true);
    expect(suppressed(callOf("TIMEOUT", "perform"))).toBe(true);
  });

  it("declines a receiver bound to a `self.<member>` no project file declares", () => {
    // ugnest: `serializer = self.get_serializer(…)` then `serializer.is_valid()`
    // fanned onto `ConfirmationCode#is_valid` — the corpus's canonical phantom.
    const ctx = ctxOf({ callResultBindings: { serializer: [{ line: 4, callee: "self.get_serializer" }] } });
    expect(suppressed(callOf("serializer", "is_valid"), ctx)).toBe(true);
  });

  it("still fans a receiver bound to a `self.<member>` the project DOES declare", () => {
    const ctx = ctxOf({ callResultBindings: { service: [{ line: 4, callee: "self.perform" }] } });
    expect(suppressed(callOf("service", "perform"), ctx)).toBe(false);
  });

  it("declines a receiver bound to a FOREIGN call result", () => {
    // httpx: `logger = logging.getLogger(__name__)`, then `logger.info(…)` fanned
    // onto `Cookies._CookieCompatResponse#info`.
    const ctx = ctxOf({ callResultBindings: { logger: [{ line: 4, callee: "logging.getLogger" }] } });
    expect(suppressed(callOf("logger", "info"), ctx)).toBe(true);
  });

  it("still fans a receiver bound to an IN-PROJECT call result", () => {
    // 70 % of the target family: a local assigned from a project call the walker
    // could not type. The head IS declared, so the binding is not foreign.
    const ctx = ctxOf({ callResultBindings: { service: [{ line: 4, callee: "Service.build" }] } });
    expect(suppressed(callOf("service", "perform"), ctx)).toBe(false);
  });

  it("declines a receiver with a local binding in force at the call line", () => {
    const ctx = ctxOf({ localBindings: { service: [{ line: 3, type: "Service" }] } });
    expect(suppressed(callOf("service", "perform", 10), ctx)).toBe(true);
  });

  it("fans a receiver whose only binding is established AFTER the call line", () => {
    const ctx = ctxOf({ localBindings: { service: [{ line: 30, type: "Service" }] } });
    expect(suppressed(callOf("service", "perform", 10), ctx)).toBe(false);
  });

  it("declines a receiver bound by an import (a module alias)", () => {
    const imports: ImportRef[] = [
      { importText: "app.service", startLine: 1, importedBindings: { service: "service" } },
    ];
    expect(suppressed(callOf("service"), ctxOf({ imports }))).toBe(true);
  });

  it("declines a member the external vocabulary calls core-ambiguous", () => {
    const coreAmbiguous = vi.fn().mockReturnValue(true);
    expect(suppressed(callOf("rows", "get"), ctxOf(), silentProbe(), coreAmbiguous)).toBe(true);
    expect(coreAmbiguous).toHaveBeenCalledOnce();
  });

  it("declines a member that names a Python builtin", () => {
    expect(suppressed(callOf("thing", "format"))).toBe(true);
  });

  it("declines a call the chain answers", () => {
    const probe = new PythonChainAnswerProbe([new AnsweringPass()]);
    expect(suppressed(callOf("service"), ctxOf(), probe)).toBe(true);
  });

  it("does NOT decline a bare lowercase name with no binding, no import and an unanswered chain", () => {
    expect(suppressed(callOf("service"))).toBe(false);
  });

  it("asks the probe LAST — the cheap shape gates run first", () => {
    const pass = new SilentPass();
    const probe = new PythonChainAnswerProbe([pass]);
    expect(suppressed(callOf("self.repo"), ctxOf(), probe)).toBe(true);
    expect(pass.calls).toBe(0);
  });

  it("declines a member typeshed declares on a class — the decline set (w205u.14)", () => {
    for (const member of ["get", "append", "filter", "save", "execute", "json"]) {
      expect(suppressed(callOf("service", member))).toBe(true);
    }
  });

  it("leaves a member typeshed does not declare to the fan", () => {
    expect(PYTHON_TYPESHED_MEMBERS.has("perform")).toBe(false);
    expect(suppressed(callOf("service", "perform"))).toBe(false);
  });

  it("asks the decline set before the probe — it is a hash lookup, the chain is a walk", () => {
    const pass = new SilentPass();
    const probe = new PythonChainAnswerProbe([pass]);
    expect(suppressed(callOf("service", "append"), ctxOf(), probe)).toBe(true);
    expect(pass.calls).toBe(0);
  });
});
