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
  splitReceiverHops,
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

describe("splitReceiverHops", () => {
  it("splits a plain dotted receiver exactly as a bare split would", () => {
    expect(splitReceiverHops("a.b.c")).toEqual(["a", "b", "c"]);
    expect(splitReceiverHops("u")).toEqual(["u"]);
    expect(splitReceiverHops(".foo")).toEqual(["", "foo"]);
  });

  it("keeps a constructor call with dotted ARGUMENTS as one hop", () => {
    expect(splitReceiverHops("Notification(user=self.user, event=self.t())")).toEqual([
      "Notification(user=self.user, event=self.t())",
    ]);
  });

  it("does not descend into a generic subscript or the call that follows it", () => {
    expect(splitReceiverHops("datatable.Datatable[A, B](x.y())")).toEqual(["datatable", "Datatable[A, B](x.y())"]);
  });

  it("treats an index expression as part of its own hop", () => {
    expect(splitReceiverHops("d[k.j].m")).toEqual(["d[k.j]", "m"]);
    expect(splitReceiverHops("{a.b: c.d}.keys()")).toEqual(["{a.b: c.d}", "keys()"]);
  });

  it("counts quotes, so a dotted string literal cannot open a hop", () => {
    expect(splitReceiverHops("f('a.b').g")).toEqual(["f('a.b')", "g"]);
    expect(splitReceiverHops('"a.b".upper()')).toEqual(['"a.b"', "upper()"]);
    expect(splitReceiverHops("f('a(b').g")).toEqual(["f('a(b')", "g"]);
  });

  it("falls back to ONE hop on an unbalanced receiver rather than throwing", () => {
    expect(splitReceiverHops("f(a.b")).toEqual(["f(a.b"]);
    expect(splitReceiverHops("f('a.b).g")).toEqual(["f('a.b).g"]);
  });
});

describe("propagateReceiverType — the hop-split PORT", () => {
  // The port is opt-in: Ruby measured 34 mastodon sites the bracket-aware split
  // newly types, so the fold's DEFAULT stays the `split(".")` every language
  // shipped and Python supplies the other one (bd tea-rags-mcp-w205u).
  const bracketAware = portsWith.bind(null);

  it("splits on every dot by DEFAULT, brackets included", () => {
    const seedHead = vi.fn(() => undefined);
    const singleHopType = vi.fn(() => undefined);
    expect(
      propagateReceiverType("Notification(user=self.u)", 5, ctx(), portsWith({ seedHead, singleHopType })),
    ).toBeUndefined();
    expect(seedHead).toHaveBeenCalledWith("Notification(user=self", "u)", expect.anything());
  });

  it("sends a receiver whose only dots sit inside brackets to singleHopType, when the port says so", () => {
    const singleHopType = vi.fn(() => instance("Notification"));
    const ports = bracketAware({ singleHopType, splitReceiverHops });
    expect(propagateReceiverType("Notification(user=self.u)", 5, ctx(), ports)).toEqual(instance("Notification"));
    expect(singleHopType).toHaveBeenCalledWith("Notification(user=self.u)", 5, expect.anything());
  });

  it("hands the seed a first link that still carries its subscript and its args", () => {
    const seedHead = vi.fn(() => undefined);
    const ports = bracketAware({ seedHead, splitReceiverHops });
    expect(propagateReceiverType("datatable.Datatable[A, B](x.y)", 5, ctx(), ports)).toBeUndefined();
    expect(seedHead).toHaveBeenCalledWith("datatable", "Datatable[A, B](x.y)", expect.anything());
  });

  it("counts hops after the bracket-aware split, not before it", () => {
    // `split(".")` would see five segments here and refuse the two-hop chain.
    const ports = bracketAware({
      singleHopType: (receiver) => (receiver === "f(a.b, c.d)" ? instance("Client") : undefined),
      memberTypeOf: (recv, member) => (member === "run" ? instance("Job") : undefined),
      maxHops: () => 2,
      splitReceiverHops,
    });
    expect(propagateReceiverType("f(a.b, c.d).run", 5, ctx(), ports)).toEqual(instance("Job"));
  });
});

describe("stripCallArgs", () => {
  it("drops a trailing argument list and leaves a bare segment alone", () => {
    expect(stripCallArgs("new(post)")).toBe("new");
    expect(stripCallArgs("find")).toBe("find");
    expect(stripCallArgs("f(")).toBe("f");
  });
});
