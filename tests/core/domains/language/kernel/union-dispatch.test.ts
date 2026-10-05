/**
 * K2 kernel union dispatch (bd tea-rags-mcp-m99j1.1.10): a receiver typed as a
 * union `[A, B]` fans out to every arm that defines the member, as discounted
 * `cone` edges. The language supplies the receiver typing, the member walk and
 * the population filter (`ownsPath`); the kernel owns arm iteration, dedup,
 * the `coneMax` cut and the confidence split.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  DispatchEdge,
  SymbolResolutionTarget,
} from "../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../src/core/contracts/types/language.js";
import {
  createTypeMemberLookup,
  UnionDispatchResolver,
  type UnionDispatchPorts,
} from "../../../../../src/core/domains/language/kernel/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const ctx: CallContext = {
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  symbolTable: new InMemoryGlobalSymbolTable(),
};

const call = (receiver: string | null, member = "run"): CallRef => ({
  callText: receiver === null ? `${member}()` : `${receiver}.${member}()`,
  receiver,
  member,
  startLine: 3,
});

const instance = (name: string): TypeRef => ({ form: "instance", name });
const klass = (name: string): TypeRef => ({ form: "class", name });
const union = (...members: TypeRef[]): TypeRef => ({ form: "union", members });

/** `"<form>:<type>#<member>"` → target; anything absent misses. */
const lookupOver = (targets: Record<string, SymbolResolutionTarget>) =>
  createTypeMemberLookup((type, member) => targets[`${type.form}:${type.name}#${member}`] ?? null);

const portsTyping = (type: TypeRef | null, ownsPath = (p: string) => p.endsWith(".rb")): UnionDispatchPorts => ({
  typeOfReceiver: () => type,
  ownsPath,
});

const edgesOf = (resolver: UnionDispatchResolver, c: CallRef): DispatchEdge[] => {
  const outcome = resolver.resolveDispatch(c, ctx);
  if (outcome.kind !== "edges") throw new Error(`unexpected outcome ${outcome.kind}`);
  return outcome.edges;
};

const cone = (targetRelPath: string, targetSymbolId: string, confidence: number): DispatchEdge => ({
  sourceSymbolId: null,
  targetRelPath,
  targetSymbolId,
  edgeKind: "cone",
  confidence,
});

const targets: Record<string, SymbolResolutionTarget> = {
  "instance:A#run": { targetRelPath: "app/a.rb", targetSymbolId: "A#run" },
  "instance:B#run": { targetRelPath: "app/b.rb", targetSymbolId: "B#run" },
  "class:C#run": { targetRelPath: "app/c.rb", targetSymbolId: "C.run" },
  "instance:F#run": { targetRelPath: "app/f.rb", targetSymbolId: null },
  "instance:G#run": { targetRelPath: "vendor/g.py", targetSymbolId: "G#run" },
};

describe("UnionDispatchResolver (K2)", () => {
  it("fans a 2-arm union whose arms both define the member into 2 cone edges at 1/2", () => {
    const r = new UnionDispatchResolver(portsTyping(union(instance("A"), instance("B"))), lookupOver(targets), 8);
    expect(edgesOf(r, call("x"))).toEqual([cone("app/a.rb", "A#run", 1 / 2), cone("app/b.rb", "B#run", 1 / 2)]);
  });

  it("looks a class arm up as a static member", () => {
    const r = new UnionDispatchResolver(portsTyping(union(klass("C"), instance("A"))), lookupOver(targets), 8);
    expect(edgesOf(r, call("x"))).toEqual([cone("app/c.rb", "C.run", 1 / 2), cone("app/a.rb", "A#run", 1 / 2)]);
  });

  it("skips an arm with no definer and splits confidence over the arms that resolved", () => {
    const r = new UnionDispatchResolver(
      portsTyping(union(instance("A"), instance("Missing"), instance("B"))),
      lookupOver(targets),
      8,
    );
    expect(edgesOf(r, call("x"))).toEqual([cone("app/a.rb", "A#run", 1 / 2), cone("app/b.rb", "B#run", 1 / 2)]);
  });

  it("skips non-nominal arms, file-only targets and targets outside the language population", () => {
    const r = new UnionDispatchResolver(
      portsTyping(union({ form: "nil" }, instance("F"), instance("G"), instance("A"))),
      lookupOver(targets),
      8,
    );
    expect(edgesOf(r, call("x"))).toEqual([cone("app/a.rb", "A#run", 1)]);
  });

  it("emits one edge per distinct target symbol", () => {
    const r = new UnionDispatchResolver(portsTyping(union(instance("A"), instance("A"))), lookupOver(targets), 8);
    expect(edgesOf(r, call("x"))).toEqual([cone("app/a.rb", "A#run", 1)]);
  });

  it("returns empty when the resolved targets exceed coneMax, and fans out at exactly coneMax", () => {
    const type = union(instance("A"), instance("B"));
    expect(edgesOf(new UnionDispatchResolver(portsTyping(type), lookupOver(targets), 1), call("x"))).toEqual([]);
    expect(edgesOf(new UnionDispatchResolver(portsTyping(type), lookupOver(targets), 2), call("x"))).toHaveLength(2);
  });

  it("returns empty for a non-union receiver, an untyped receiver, and a receiverless call", () => {
    const lookup = lookupOver(targets);
    expect(edgesOf(new UnionDispatchResolver(portsTyping(instance("A")), lookup, 8), call("x"))).toEqual([]);
    expect(edgesOf(new UnionDispatchResolver(portsTyping(null), lookup, 8), call("x"))).toEqual([]);
    expect(edgesOf(new UnionDispatchResolver(portsTyping(union(instance("A"))), lookup, 8), call(null))).toEqual([]);
  });
});
