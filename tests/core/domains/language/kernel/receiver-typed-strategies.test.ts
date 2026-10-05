/**
 * K4 kernel skeletons (bd tea-rags-mcp-m99j1.1.5): the receiver-typed strategies
 * every dynamic language runs — a chained return type, a local binding, a naming
 * convention — expressed once over two ports. The language supplies the
 * receiver typing (`ReceiverTypingPorts`) and the member walk
 * (`TypeMemberLookup`); the kernel owns the three-state verdict.
 */
import { describe, expect, it, vi } from "vitest";

import { CONTINUE, DROP, resolved } from "../../../../../src/core/contracts/resolution.js";
import type {
  CallContext,
  CallRef,
  SymbolResolutionTarget,
} from "../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../src/core/contracts/types/language.js";
import {
  ChainTypeSymbolResolutionStrategy,
  ConventionReceiverSymbolResolutionStrategy,
  createTypeMemberLookup,
  LocalBindingSymbolResolutionStrategy,
  type ConventionReceiverTypingPorts,
  type ReceiverTypingPorts,
  type TypeMemberLookup,
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

const pinned: SymbolResolutionTarget = { targetRelPath: "app/a.rb", targetSymbolId: "A#run" };
const fileOnly: SymbolResolutionTarget = { targetRelPath: "app/a.rb", targetSymbolId: null };
const instanceA: TypeRef = { form: "instance", name: "A" };

const typing = (type: TypeRef | null): ReceiverTypingPorts => ({ typeOfReceiver: vi.fn(() => type) });
const lookup = (answer: SymbolResolutionTarget | null): TypeMemberLookup => createTypeMemberLookup(vi.fn(() => answer));

describe.each([
  ["ChainTypeSymbolResolutionStrategy", ChainTypeSymbolResolutionStrategy],
  ["LocalBindingSymbolResolutionStrategy", LocalBindingSymbolResolutionStrategy],
] as const)("%s", (_label, Strategy) => {
  it("keeps the name it was given — chain-tally --defer and oracle answeredBy key on it", () => {
    expect(new Strategy("chainType", typing(null), lookup(null), { dropOnTypedMiss: true }).name).toBe("chainType");
  });

  it("typed + member found → resolved(target), looked up on the typed ref", () => {
    const findMember = vi.fn(() => pinned);
    const strategy = new Strategy("s", typing(instanceA), { findMember }, { dropOnTypedMiss: true });
    expect(strategy.attempt(call("a"), ctx)).toEqual(resolved(pinned));
    expect(findMember).toHaveBeenCalledWith(instanceA, "run", ctx);
  });

  it("typed + member missing + dropOnTypedMiss → DROP", () => {
    const strategy = new Strategy("s", typing(instanceA), lookup(null), { dropOnTypedMiss: true });
    expect(strategy.attempt(call("a"), ctx)).toBe(DROP);
  });

  it("typed + member missing without dropOnTypedMiss → CONTINUE", () => {
    const strategy = new Strategy("s", typing(instanceA), lookup(null), { dropOnTypedMiss: false });
    expect(strategy.attempt(call("a"), ctx)).toBe(CONTINUE);
  });

  it("a dropOnTypedMiss predicate decides the miss per call", () => {
    const drops = vi.fn((type: TypeRef) => type.form === "instance" && type.name === "A");
    const strategy = new Strategy("s", typing(instanceA), lookup(null), { dropOnTypedMiss: drops });
    expect(strategy.attempt(call("a"), ctx)).toBe(DROP);
    expect(drops).toHaveBeenCalledWith(instanceA, call("a"), ctx);

    const keeps = new Strategy("s", typing({ form: "class", name: "B" }), lookup(null), { dropOnTypedMiss: drops });
    expect(keeps.attempt(call("b"), ctx)).toBe(CONTINUE);
  });

  it("a file-only target resolves by default", () => {
    const strategy = new Strategy("s", typing(instanceA), lookup(fileOnly), { dropOnTypedMiss: true });
    expect(strategy.attempt(call("a"), ctx)).toEqual(resolved(fileOnly));
  });

  it("requirePinnedTarget turns a file-only target into a miss", () => {
    const drop = new Strategy("s", typing(instanceA), lookup(fileOnly), {
      dropOnTypedMiss: true,
      requirePinnedTarget: true,
    });
    expect(drop.attempt(call("a"), ctx)).toBe(DROP);
    const cont = new Strategy("s", typing(instanceA), lookup(fileOnly), {
      dropOnTypedMiss: false,
      requirePinnedTarget: true,
    });
    expect(cont.attempt(call("a"), ctx)).toBe(CONTINUE);
  });

  it("untyped → CONTINUE", () => {
    const strategy = new Strategy("s", typing(null), lookup(pinned), { dropOnTypedMiss: true });
    expect(strategy.attempt(call("a"), ctx)).toBe(CONTINUE);
  });

  it("a non-nominal type (union / container / tuple / nil) → CONTINUE, never a lookup", () => {
    const findMember = vi.fn(() => pinned);
    const union: TypeRef = { form: "union", members: [instanceA, { form: "instance", name: "B" }] };
    for (const type of [union, { form: "container", element: instanceA }, { form: "nil" }] as TypeRef[]) {
      const strategy = new Strategy("s", typing(type), { findMember }, { dropOnTypedMiss: true });
      expect(strategy.attempt(call("a"), ctx)).toBe(CONTINUE);
    }
    expect(findMember).not.toHaveBeenCalled();
  });

  it("a receiverless call → CONTINUE without asking the typing port", () => {
    const ports = typing(instanceA);
    const strategy = new Strategy("s", ports, lookup(pinned), { dropOnTypedMiss: true });
    expect(strategy.attempt(call(null), ctx)).toBe(CONTINUE);
    expect(ports.typeOfReceiver).not.toHaveBeenCalled();
  });
});

describe("ConventionReceiverSymbolResolutionStrategy", () => {
  const conventionTyping = (type: TypeRef | null, typedElsewhere = false): ConventionReceiverTypingPorts => ({
    typeOfReceiver: vi.fn(() => type),
    isTypedElsewhere: vi.fn(() => typedElsewhere),
  });

  it("keeps the name it was given", () => {
    expect(
      new ConventionReceiverSymbolResolutionStrategy("conventionReceiver", conventionTyping(null), lookup(null)).name,
    ).toBe("conventionReceiver");
  });

  it("guessed type + pinned member → resolved(target)", () => {
    const strategy = new ConventionReceiverSymbolResolutionStrategy("c", conventionTyping(instanceA), lookup(pinned));
    expect(strategy.attempt(call("a"), ctx)).toEqual(resolved(pinned));
    expect(strategy.findTarget(call("a"), ctx)).toBe(pinned);
  });

  it("isTypedElsewhere → CONTINUE: a real fact wins", () => {
    const strategy = new ConventionReceiverSymbolResolutionStrategy(
      "c",
      conventionTyping(instanceA, true),
      lookup(pinned),
    );
    expect(strategy.attempt(call("a"), ctx)).toBe(CONTINUE);
    expect(strategy.findTarget(call("a"), ctx)).toBeNull();
  });

  it("no convention guess → CONTINUE", () => {
    const strategy = new ConventionReceiverSymbolResolutionStrategy("c", conventionTyping(null), lookup(pinned));
    expect(strategy.attempt(call("a"), ctx)).toBe(CONTINUE);
  });

  it("never DROPs: a miss and a file-only target both CONTINUE", () => {
    const miss = new ConventionReceiverSymbolResolutionStrategy("c", conventionTyping(instanceA), lookup(null));
    expect(miss.attempt(call("a"), ctx)).toBe(CONTINUE);
    const filed = new ConventionReceiverSymbolResolutionStrategy("c", conventionTyping(instanceA), lookup(fileOnly));
    expect(filed.attempt(call("a"), ctx)).toBe(CONTINUE);
  });

  it("a receiverless call → CONTINUE without asking either port", () => {
    const ports = conventionTyping(instanceA);
    const strategy = new ConventionReceiverSymbolResolutionStrategy("c", ports, lookup(pinned));
    expect(strategy.attempt(call(null), ctx)).toBe(CONTINUE);
    expect(ports.typeOfReceiver).not.toHaveBeenCalled();
    expect(ports.isTypedElsewhere).not.toHaveBeenCalled();
  });
});
