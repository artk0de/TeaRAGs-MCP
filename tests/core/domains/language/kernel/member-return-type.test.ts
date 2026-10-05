/**
 * K6 `MemberReturnTypeResolver` (bd tea-rags-mcp-m99j1.1.12): the owner →
 * ancestors → framework → flat precedence every dynamic language walks to type
 * a member call's result, stated once. Fake ports record what was asked, so
 * each test pins both the answer and how far the walk went.
 */
import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../src/core/contracts/types/language.js";
import {
  MemberReturnTypeResolver,
  type MemberReturnTypePorts,
  type NominalTypeRef,
} from "../../../../../src/core/domains/language/kernel/index.js";

const ctx = {} as CallContext;
const instance = (name: string): TypeRef => ({ form: "instance", name });
const OWNER: NominalTypeRef = { form: "instance", name: "Owner" };

interface FakeFacts {
  declared?: Record<string, TypeRef>;
  ancestors?: readonly string[];
  inherited?: Record<string, TypeRef>;
  framework?: TypeRef;
  flat?: TypeRef;
}

function fakePorts(facts: FakeFacts, withHooks = true): { ports: MemberReturnTypePorts; asked: string[] } {
  const asked: string[] = [];
  const ports: MemberReturnTypePorts = {
    declaredReturnType: (owner, member) => {
      asked.push(`declared:${owner.name}#${member}`);
      return facts.declared?.[`${owner.name}#${member}`] ?? null;
    },
    ancestorsOf: (owner) => {
      asked.push(`ancestors:${owner.name}`);
      return facts.ancestors ?? [];
    },
    ancestorReturnType: (ancestor, owner, member) => {
      asked.push(`ancestor:${ancestor}#${member}<${owner.name}`);
      return facts.inherited?.[`${ancestor}#${member}`] ?? null;
    },
  };
  if (withHooks) {
    ports.frameworkReturnType = (owner, member) => {
      asked.push(`framework:${owner.name}#${member}`);
      return facts.framework ?? null;
    };
    ports.flatReturnType = (member) => {
      asked.push(`flat:${member}`);
      return facts.flat ?? null;
    };
  }
  return { ports, asked };
}

describe("MemberReturnTypeResolver", () => {
  it("answers from the owner's own declaration and asks nothing further", () => {
    const { ports, asked } = fakePorts({
      declared: { "Owner#run": instance("Direct") },
      inherited: { "Base#run": instance("Inherited") },
      framework: instance("Framework"),
      flat: instance("Flat"),
    });
    expect(new MemberReturnTypeResolver(ports).returnTypeOf(OWNER, "run", ctx)).toEqual(instance("Direct"));
    expect(asked).toEqual(["declared:Owner#run"]);
  });

  it("falls through to the ancestors in linearized order, the NEAREST declaring one wins", () => {
    const { ports, asked } = fakePorts({
      ancestors: ["Mixin", "Base", "Root"],
      inherited: { "Base#run": instance("FromBase"), "Root#run": instance("FromRoot") },
      framework: instance("Framework"),
    });
    expect(new MemberReturnTypeResolver(ports).returnTypeOf(OWNER, "run", ctx)).toEqual(instance("FromBase"));
    expect(asked).toEqual([
      "declared:Owner#run",
      "ancestors:Owner",
      "ancestor:Mixin#run<Owner",
      "ancestor:Base#run<Owner",
    ]);
  });

  it("hands every ancestor read the OWNER, so a receiver-relative answer can name it", () => {
    const { ports } = fakePorts({ ancestors: ["Base"] });
    ports.ancestorReturnType = (_ancestor, owner) => instance(owner.name);
    expect(new MemberReturnTypeResolver(ports).returnTypeOf(OWNER, "run", ctx)).toEqual(instance("Owner"));
  });

  it("asks the framework hook only after every ancestor stayed silent", () => {
    const { ports, asked } = fakePorts({
      ancestors: ["Base"],
      framework: instance("Framework"),
      flat: instance("Flat"),
    });
    expect(new MemberReturnTypeResolver(ports).returnTypeOf(OWNER, "run", ctx)).toEqual(instance("Framework"));
    expect(asked).toEqual(["declared:Owner#run", "ancestors:Owner", "ancestor:Base#run<Owner", "framework:Owner#run"]);
  });

  it("reads the flat owner-less fact LAST", () => {
    const { ports, asked } = fakePorts({ ancestors: ["Base"], flat: instance("Flat") });
    expect(new MemberReturnTypeResolver(ports).returnTypeOf(OWNER, "run", ctx)).toEqual(instance("Flat"));
    expect(asked).toEqual([
      "declared:Owner#run",
      "ancestors:Owner",
      "ancestor:Base#run<Owner",
      "framework:Owner#run",
      "flat:run",
    ]);
  });

  it("answers null when every step is silent", () => {
    const { ports } = fakePorts({ ancestors: ["Base"] });
    expect(new MemberReturnTypeResolver(ports).returnTypeOf(OWNER, "run", ctx)).toBeNull();
  });

  it("skips the optional framework and flat steps a language does not have", () => {
    const { ports, asked } = fakePorts({ ancestors: ["Base"], framework: instance("X"), flat: instance("Y") }, false);
    expect(new MemberReturnTypeResolver(ports).returnTypeOf(OWNER, "run", ctx)).toBeNull();
    expect(asked).toEqual(["declared:Owner#run", "ancestors:Owner", "ancestor:Base#run<Owner"]);
  });

  it("does not consult the ancestors at all when the owner answers", () => {
    const { ports, asked } = fakePorts({ declared: { "Owner#run": instance("Direct") }, ancestors: ["Base"] });
    new MemberReturnTypeResolver(ports).returnTypeOf(OWNER, "run", ctx);
    expect(asked).not.toContain("ancestors:Owner");
  });
});
