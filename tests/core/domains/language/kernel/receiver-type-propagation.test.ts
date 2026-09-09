/**
 * E1 seam 3: the language-neutral dotted-chain fold.
 *
 * Every port here is HAND-BUILT — the kernel test must not import anything
 * under `ruby/` or `python/`, or it stops testing the neutral engine and starts
 * testing a language.
 */

import { describe, expect, it, vi } from "vitest";

import type { CallContext } from "../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../src/core/contracts/types/language.js";
import {
  CHAIN_MAX_HOPS_DEFAULT,
  propagateReceiverType,
  stripCallArgs,
  type ReceiverTypePorts,
} from "../../../../../src/core/domains/language/kernel/receiver-type-propagation.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const ctx = (): CallContext => ({
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  symbolTable: new InMemoryGlobalSymbolTable(),
});

const instance = (name: string): TypeRef => ({ form: "instance", name });

const portsWith = (over: Partial<ReceiverTypePorts> = {}): ReceiverTypePorts => ({
  singleHopType: () => undefined,
  seedHead: () => undefined,
  memberTypeOf: () => undefined,
  maxHops: () => CHAIN_MAX_HOPS_DEFAULT,
  ...over,
});

describe("propagateReceiverType — single hop", () => {
  it("answers from singleHopType and collapses a nilable union to its one arm", () => {
    const ports = portsWith({
      singleHopType: (receiver) =>
        receiver === "u" ? { form: "union", members: [instance("Firm"), { form: "nil" }] } : undefined,
    });
    expect(propagateReceiverType("u", 5, ctx(), ports)).toEqual(instance("Firm"));
  });

  it("returns undefined for a nil-only head rather than throwing", () => {
    const ports = portsWith({ singleHopType: () => ({ form: "nil" }) });
    expect(propagateReceiverType("u", 5, ctx(), ports)).toBeUndefined();
  });
});

describe("propagateReceiverType — chain fold", () => {
  it("threads a two-hop chain through memberTypeOf left to right", () => {
    const returns: Record<string, TypeRef> = { "User#account": instance("Account"), "Account#owner": instance("User") };
    const ports = portsWith({
      singleHopType: (receiver) => (receiver === "u" ? instance("User") : undefined),
      memberTypeOf: (recv, member) => (recv.form === "instance" ? returns[`${recv.name}#${member}`] : undefined),
    });
    expect(propagateReceiverType("u.account.owner", 5, ctx(), ports)).toEqual(instance("User"));
  });

  it("STOPS at the first unknown hop and never asks about the hops after it", () => {
    const memberTypeOf = vi.fn((recv: TypeRef, member: string) =>
      member === "account" ? instance("Account") : undefined,
    );
    const ports = portsWith({
      singleHopType: () => instance("User"),
      memberTypeOf,
    });
    expect(propagateReceiverType("u.account.missing.owner", 5, ctx(), ports)).toBeUndefined();
    expect(memberTypeOf.mock.calls.map((c) => c[1])).toEqual(["account", "missing"]);
  });

  it("leaves a chain longer than maxHops untyped without touching the head", () => {
    const singleHopType = vi.fn(() => instance("User"));
    const ports = portsWith({ singleHopType, maxHops: () => 2, memberTypeOf: () => instance("User") });
    expect(propagateReceiverType("a.b.c.d", 5, ctx(), ports)).toBeUndefined();
    expect(singleHopType).not.toHaveBeenCalled();
  });

  it("returns undefined for an empty head", () => {
    const ports = portsWith({ singleHopType: () => instance("User"), memberTypeOf: () => instance("User") });
    expect(propagateReceiverType(".foo", 5, ctx(), ports)).toBeUndefined();
  });
});

describe("propagateReceiverType — seedHead", () => {
  it("starts the walk after the first link when the seed consumed it", () => {
    const memberTypeOf = vi.fn(() => instance("User"));
    const ports = portsWith({
      seedHead: () => ({ type: instance("Post"), consumedMembers: 1 }),
      memberTypeOf,
    });
    expect(propagateReceiverType("Post.new.author", 5, ctx(), ports)).toEqual(instance("User"));
    expect(memberTypeOf.mock.calls.map((c) => c[1])).toEqual(["author"]);
  });

  it("starts the walk at the first link when the seed typed the head alone", () => {
    const memberTypeOf = vi.fn((recv: TypeRef, member: string) =>
      member === "new" ? instance("Post") : instance("User"),
    );
    const ports = portsWith({
      seedHead: () => ({ type: { form: "class", name: "Post" }, consumedMembers: 0 }),
      memberTypeOf,
    });
    expect(propagateReceiverType("Post.new.author", 5, ctx(), ports)).toEqual(instance("User"));
    expect(memberTypeOf.mock.calls.map((c) => c[1])).toEqual(["new", "author"]);
  });

  it("hands the head to singleHopType when the seed declines", () => {
    const singleHopType = vi.fn(() => instance("User"));
    const ports = portsWith({ singleHopType, memberTypeOf: () => instance("Account") });
    expect(propagateReceiverType("u.account", 5, ctx(), ports)).toEqual(instance("Account"));
    expect(singleHopType).toHaveBeenCalledWith("u", 5, expect.anything());
  });

  it("receives the first link RAW so a call is distinguishable from a bare member", () => {
    const seedHead = vi.fn(() => undefined);
    const ports = portsWith({ seedHead, singleHopType: () => undefined });
    expect(propagateReceiverType("Post.new(attrs).author", 5, ctx(), ports)).toBeUndefined();
    expect(seedHead).toHaveBeenCalledWith("Post", "new(attrs)", expect.anything());
  });
});

describe("stripCallArgs", () => {
  it("drops a trailing argument list and leaves a bare segment alone", () => {
    expect(stripCallArgs("new(post)")).toBe("new");
    expect(stripCallArgs("find")).toBe("find");
    expect(stripCallArgs("f(")).toBe("f");
  });
});
