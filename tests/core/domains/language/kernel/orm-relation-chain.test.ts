/**
 * ORM relation chains, the neutral half (bd tea-rags-mcp-2m83f.32.3): a hop that
 * yields a "relation of Model" forwards the next member to Model's class side.
 * The language supplies the framework gate, the relation reading of a type and
 * the class-side member walk; the kernel owns the verdict and the mixin `Self`
 * substitution.
 */
import { describe, expect, it, vi } from "vitest";

import { CONTINUE, resolved } from "../../../../../src/core/contracts/resolution.js";
import type {
  CallContext,
  CallRef,
  SymbolResolutionTarget,
} from "../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../src/core/contracts/types/language.js";
import {
  OrmRelationChainSymbolResolutionStrategy,
  substituteRelationSelf,
  type OrmRelationPorts,
  type ReceiverTypingPorts,
} from "../../../../../src/core/domains/language/kernel/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const ctx: CallContext = {
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  symbolTable: new InMemoryGlobalSymbolTable(),
};

const call = (receiver: string | null, member = "ordered"): CallRef => ({
  callText: receiver === null ? `${member}()` : `${receiver}.${member}()`,
  receiver,
  member,
  startLine: 3,
});

const relationOf = (name: string): TypeRef => ({ form: "container", element: { form: "instance", name } });
const pinned: SymbolResolutionTarget = { targetRelPath: "app/models/document.rb", targetSymbolId: "Document.ordered" };
const fileOnly: SymbolResolutionTarget = { targetRelPath: "app/models/document.rb", targetSymbolId: null };

const typing = (type: TypeRef | null): ReceiverTypingPorts => ({ typeOfReceiver: vi.fn(() => type) });

function ports(overrides: Partial<OrmRelationPorts> = {}): OrmRelationPorts {
  return {
    vocabularyActive: vi.fn(() => true),
    relationModelOf: vi.fn((type: TypeRef) =>
      type.form === "container" && type.element.form === "instance" ? type.element.name : undefined,
    ),
    memberOnModel: vi.fn(() => pinned),
    ...overrides,
  };
}

describe("OrmRelationChainSymbolResolutionStrategy", () => {
  it("keeps the name it was given", () => {
    expect(new OrmRelationChainSymbolResolutionStrategy("relationChain", typing(null), ports()).name).toBe(
      "relationChain",
    );
  });

  it("a relation receiver resolves the member on the model's class side", () => {
    const memberOnModel = vi.fn(() => pinned);
    const strategy = new OrmRelationChainSymbolResolutionStrategy(
      "s",
      typing(relationOf("Document")),
      ports({ memberOnModel }),
    );
    expect(strategy.attempt(call("dir.documents"), ctx)).toEqual(resolved(pinned));
    expect(memberOnModel).toHaveBeenCalledWith("Document", "ordered", ctx);
  });

  it("the framework vocabulary off → CONTINUE, receiver never typed", () => {
    const typeOfReceiver = vi.fn(() => relationOf("Document"));
    const strategy = new OrmRelationChainSymbolResolutionStrategy(
      "s",
      { typeOfReceiver },
      ports({ vocabularyActive: () => false }),
    );
    expect(strategy.attempt(call("dir.documents"), ctx)).toBe(CONTINUE);
    expect(typeOfReceiver).not.toHaveBeenCalled();
  });

  it("no receiver → CONTINUE", () => {
    expect(new OrmRelationChainSymbolResolutionStrategy("s", typing(null), ports()).attempt(call(null), ctx)).toBe(
      CONTINUE,
    );
  });

  it("an untyped receiver → CONTINUE", () => {
    expect(new OrmRelationChainSymbolResolutionStrategy("s", typing(null), ports()).attempt(call("x.y"), ctx)).toBe(
      CONTINUE,
    );
  });

  it("a type that is not a relation → CONTINUE, the model walk never asked", () => {
    const memberOnModel = vi.fn(() => pinned);
    const strategy = new OrmRelationChainSymbolResolutionStrategy(
      "s",
      typing({ form: "instance", name: "Document" }),
      ports({ memberOnModel }),
    );
    expect(strategy.attempt(call("doc"), ctx)).toBe(CONTINUE);
    expect(memberOnModel).not.toHaveBeenCalled();
  });

  it("the model declares no such member → CONTINUE (silence, never a guess)", () => {
    const strategy = new OrmRelationChainSymbolResolutionStrategy(
      "s",
      typing(relationOf("Document")),
      ports({ memberOnModel: () => null }),
    );
    expect(strategy.attempt(call("dir.documents"), ctx)).toBe(CONTINUE);
  });

  it("a file-only answer is not an edge on the model → CONTINUE", () => {
    const strategy = new OrmRelationChainSymbolResolutionStrategy(
      "s",
      typing(relationOf("Document")),
      ports({ memberOnModel: () => fileOnly }),
    );
    expect(strategy.attempt(call("dir.documents"), ctx)).toBe(CONTINUE);
  });
});

describe("substituteRelationSelf", () => {
  const isMixin = (name: string): boolean => name === "SoftDeletable";

  it("a relation over a mixin becomes a relation over the receiver's model", () => {
    expect(substituteRelationSelf(relationOf("SoftDeletable"), "Firm", isMixin)).toEqual(relationOf("Firm"));
  });

  it("a relation over a concrete model is kept", () => {
    expect(substituteRelationSelf(relationOf("Document"), "Firm", isMixin)).toEqual(relationOf("Document"));
  });

  it("the mixin itself as the receiver keeps its own relation", () => {
    expect(substituteRelationSelf(relationOf("SoftDeletable"), "SoftDeletable", isMixin)).toEqual(
      relationOf("SoftDeletable"),
    );
  });

  it("a non-relation answer is kept", () => {
    const instance: TypeRef = { form: "instance", name: "SoftDeletable" };
    expect(substituteRelationSelf(instance, "Firm", isMixin)).toBe(instance);
  });
});
