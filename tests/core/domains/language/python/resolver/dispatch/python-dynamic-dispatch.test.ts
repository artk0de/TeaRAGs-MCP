import { afterEach, describe, expect, it } from "vitest";

import type {
  AritySignature,
  CallContext,
  CallRef,
  DispatchEdge,
  DispatchFanoutOutcome,
  KwargSignature,
  SymbolDefinition,
  SymbolResolutionOutcome,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import type { SymbolResolutionStrategy } from "../../../../../../../src/core/contracts/types/language.js";
import {
  PY_DISPATCH_FAN_MAX,
  PythonChainAnswerProbe,
  pythonDynamicDispatchEnabled,
  PythonDynamicDispatchResolver,
  resolvePythonDispatchFanMax,
} from "../../../../../../../src/core/domains/language/python/resolver/dispatch/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const sym = (
  symbolId: string,
  shortName: string,
  relPath: string,
  scope: string[],
  signature?: { arity?: AritySignature; kwargs?: KwargSignature },
): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
  ...(signature?.arity !== undefined ? { arity: signature.arity } : {}),
  ...(signature?.kwargs !== undefined ? { kwargs: signature.kwargs } : {}),
});

/** An instance member `Owner#execute` in its own file, optionally with a signature. */
const owner = (
  n: number,
  signature?: { arity?: AritySignature; kwargs?: KwargSignature },
): [string, SymbolDefinition[]] => {
  const relPath = `app/owner${String(n)}.py`;
  return [relPath, [sym(`Owner${String(n)}#execute`, "execute", relPath, [`Owner${String(n)}`], signature)]];
};

const tableWith = (...files: [string, SymbolDefinition[]][]): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
};

const ctxOf = (symbolTable: InMemoryGlobalSymbolTable, over: Partial<CallContext> = {}): CallContext => ({
  callerFile: "app/caller.py",
  callerScope: [],
  imports: [],
  symbolTable,
  ...over,
});

const call = (over: Partial<CallRef> = {}): CallRef => ({
  callText: "service.execute()",
  receiver: "service",
  member: "execute",
  startLine: 10,
  ...over,
});

class SilentPass implements SymbolResolutionStrategy {
  readonly name = "silent";
  attempt(): SymbolResolutionOutcome {
    return { kind: "continue" };
  }
}

const silentProbe = (): PythonChainAnswerProbe => new PythonChainAnswerProbe([new SilentPass()]);
const NEVER_CORE_AMBIGUOUS = (): boolean => false;

const build = (): PythonDynamicDispatchResolver =>
  new PythonDynamicDispatchResolver(silentProbe(), NEVER_CORE_AMBIGUOUS);

const edgesOf = (outcome: DispatchFanoutOutcome): DispatchEdge[] => {
  if (outcome.kind !== "edges") throw new Error(`expected edges outcome, got ${outcome.kind}`);
  return outcome.edges;
};

const ENV_KEY = "CODEGRAPH_PY_DISPATCH_FAN_MAX";

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("resolvePythonDispatchFanMax (w205u — the cap, read once at composition)", () => {
  it("defaults to the measured Python cap of 4", () => {
    expect(PY_DISPATCH_FAN_MAX).toBe(4);
    expect(resolvePythonDispatchFanMax(undefined)).toBe(4);
  });

  it("takes a positive integer override as the re-measure knob", () => {
    expect(resolvePythonDispatchFanMax("8")).toBe(8);
  });

  it("ignores a non-integer or non-positive override", () => {
    expect(resolvePythonDispatchFanMax("nope")).toBe(4);
    expect(resolvePythonDispatchFanMax("0")).toBe(4);
    expect(resolvePythonDispatchFanMax("2.5")).toBe(4);
  });
});

describe("pythonDynamicDispatchEnabled (w205u — D10, the component is parked)", () => {
  it("is OFF when the flag is absent or unset to anything but a yes", () => {
    expect(pythonDynamicDispatchEnabled(undefined)).toBe(false);
    expect(pythonDynamicDispatchEnabled("")).toBe(false);
    expect(pythonDynamicDispatchEnabled("0")).toBe(false);
    expect(pythonDynamicDispatchEnabled("false")).toBe(false);
    expect(pythonDynamicDispatchEnabled("off")).toBe(false);
  });

  it("is ON for the four spellings a re-measure would type", () => {
    expect(pythonDynamicDispatchEnabled("1")).toBe(true);
    expect(pythonDynamicDispatchEnabled("true")).toBe(true);
    expect(pythonDynamicDispatchEnabled(" TRUE ")).toBe(true);
    expect(pythonDynamicDispatchEnabled("on")).toBe(true);
    expect(pythonDynamicDispatchEnabled("yes")).toBe(true);
  });
});

describe("PythonDynamicDispatchResolver (w205u — untyped bare-name fan-out)", () => {
  it("emits ONE confidence-1 `dynamic` edge when a single owner declares the member", () => {
    const symbolTable = tableWith(owner(1));
    const edges = edgesOf(build().resolveDispatch(call(), ctxOf(symbolTable)));

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      targetRelPath: "app/owner1.py",
      targetSymbolId: "Owner1#execute",
      edgeKind: "dynamic",
      confidence: 1,
    });
  });

  it("fans three owners at `discount / m`", () => {
    const symbolTable = tableWith(owner(1), owner(2), owner(3));
    const edges = edgesOf(build().resolveDispatch(call(), ctxOf(symbolTable)));

    expect(edges).toHaveLength(3);
    for (const edge of edges) {
      expect(edge.edgeKind).toBe("dynamic");
      expect(edge.confidence).toBeCloseTo(0.5 / 3, 10);
    }
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["Owner1#execute", "Owner2#execute", "Owner3#execute"]);
  });

  it("declines to fan over the cap — `ambiguous`, no edges", () => {
    const symbolTable = tableWith(owner(1), owner(2), owner(3), owner(4), owner(5));
    const outcome = build().resolveDispatch(call(), ctxOf(symbolTable));

    expect(outcome).toEqual({ kind: "ambiguous", member: "execute", candidateCount: 5 });
  });

  it("reads the env cap ONCE at composition — a wider cap fans what the default would refuse", () => {
    const symbolTable = tableWith(owner(1), owner(2), owner(3), owner(4), owner(5));
    process.env[ENV_KEY] = "8";
    const wide = build();
    delete process.env[ENV_KEY];

    expect(edgesOf(wide.resolveDispatch(call(), ctxOf(symbolTable)))).toHaveLength(5);
  });

  it("cannot ask for a cap above the corpus-adaptive policy ceiling", () => {
    // 100 one-def short names hold the corpus p99 at 1, so the policy cap sits
    // on its floor of 16 — and 17 survivors are `ambiguous` however wide the ask.
    const filler: [string, SymbolDefinition[]] = [
      "app/filler.py",
      Array.from({ length: 100 }, (_, i) => sym(`Filler#m${String(i)}`, `m${String(i)}`, "app/filler.py", ["Filler"])),
    ];
    const owners = Array.from({ length: 17 }, (_, i) => owner(i + 1));
    const symbolTable = tableWith(filler, ...owners);
    process.env[ENV_KEY] = "32";
    const wide = build();
    delete process.env[ENV_KEY];

    expect(wide.resolveDispatch(call(), ctxOf(symbolTable)).kind).toBe("ambiguous");
  });

  it("narrows by ARITY: two owners take no argument, the call passes one", () => {
    const zero: AritySignature = { minRequired: 0, maxPositional: 0, hasSplat: false };
    const one: AritySignature = { minRequired: 1, maxPositional: 1, hasSplat: false };
    const symbolTable = tableWith(owner(1, { arity: zero }), owner(2, { arity: zero }), owner(3, { arity: one }));
    const withArity = call({ argCount: 1 });

    const edges = edgesOf(build().resolveDispatch(withArity, ctxOf(symbolTable)));
    expect(edges).toHaveLength(1);
    expect(edges[0].targetSymbolId).toBe("Owner3#execute");
    expect(edges[0].confidence).toBe(1);

    // Without the walker's `argCount` the same site keeps all three — this is
    // the channel E4.1.2 exists for.
    expect(edgesOf(build().resolveDispatch(call(), ctxOf(symbolTable)))).toHaveLength(3);
  });

  it("narrows by KWARG: an owner whose required keyword the call omits is dropped", () => {
    const symbolTable = tableWith(
      owner(1, { kwargs: { required: ["force"], optional: [], hasSplat: false } }),
      owner(2, { kwargs: { required: [], optional: ["dry_run"], hasSplat: false } }),
    );
    const edges = edgesOf(build().resolveDispatch(call({ kwargKeys: ["dry_run"] }), ctxOf(symbolTable)));

    expect(edges).toHaveLength(1);
    expect(edges[0].targetSymbolId).toBe("Owner2#execute");
  });

  it("never fans onto a same-named member in another language's file", () => {
    const symbolTable = tableWith(owner(1), [
      "web/Widget.tsx",
      [sym("Widget#execute", "execute", "web/Widget.tsx", ["Widget"])],
    ]);
    const edges = edgesOf(build().resolveDispatch(call(), ctxOf(symbolTable)));

    expect(edges.map((e) => e.targetRelPath)).toEqual(["app/owner1.py"]);
  });

  it("never fans onto a module function or a `Cls.static` — a value receiver dispatches an instance member", () => {
    const symbolTable = tableWith(owner(1), [
      "app/helpers.py",
      [sym("execute", "execute", "app/helpers.py", []), sym("Helper.execute", "execute", "app/helpers.py", ["Helper"])],
    ]);
    const edges = edgesOf(build().resolveDispatch(call(), ctxOf(symbolTable)));

    expect(edges.map((e) => e.targetSymbolId)).toEqual(["Owner1#execute"]);
  });

  it("returns no edges when a suppressed shape reaches it", () => {
    const symbolTable = tableWith(owner(1));
    expect(edgesOf(build().resolveDispatch(call({ receiver: "self.repo" }), ctxOf(symbolTable)))).toEqual([]);
  });

  it("returns no edges when no in-project Python class declares the member", () => {
    const symbolTable = tableWith(["app/other.py", [sym("Other#save", "save", "app/other.py", ["Other"])]]);
    expect(edgesOf(build().resolveDispatch(call(), ctxOf(symbolTable)))).toEqual([]);
  });
});
