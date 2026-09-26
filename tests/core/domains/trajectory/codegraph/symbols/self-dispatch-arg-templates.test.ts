/**
 * bd tea-rags-mcp-emazx — the self-dispatch ARGUMENT channel, discovery half.
 *
 * `extractSelfDispatchMethods` folds the walker's `sendNameTemplate` /
 * `positionalArgAtoms` into `SelfDispatchMethodDecl.argTemplate`: the method
 * whose `send("can_#{ability}?")` names a hook by interpolating ITS OWN
 * parameter, and every same-file method that forwards one of its own parameters
 * into that position through a self-shaped call (`result(ability)`,
 * `new(...).authorize!(ability)`). `param` is the position in the carrying
 * method's signature; `via` the hop chain a call site must still resolve to.
 *
 * Silent, never approximate: a hole that is not a parameter, a forwarded value
 * that is computed, two different templates, a hop outside the file — each
 * leaves the method without a template.
 */
import { describe, expect, it } from "vitest";

import type { CallRef, ChunkExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  collectSelfDispatchArgTemplates,
  extractSelfDispatchMethods,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/self-dispatch-discovery.js";

const call = (receiver: string | null, member: string, extra: Partial<CallRef> = {}): CallRef => ({
  callText: `${receiver ?? ""}.${member}`,
  receiver,
  member,
  startLine: 1,
  ...extra,
});

const method = (symbolId: string, paramNames: string[], calls: CallRef[]): ChunkExtraction => ({
  symbolId,
  scope: [symbolId.split(/[#.]/)[0]],
  paramNames,
  calls,
});

const sendCan = (hole: string): CallRef =>
  call(null, "send", { dynamicSend: true, sendNameTemplate: { prefix: "can_", suffix: "?", identifier: hole } });

const templateOf = (chunks: ChunkExtraction[], symbolId: string) =>
  extractSelfDispatchMethods(chunks).find((m) => m.symbolId === symbolId)?.argTemplate;

/** The taxdome AbstractPolicy shape, declared out of order to exercise the fixpoint. */
const policyChunks = (): ChunkExtraction[] => [
  method(
    "AbstractPolicy.authorize!",
    ["user", "actor", "ability"],
    [call("new(user, actor, res, options)", "authorize!", { positionalArgAtoms: [{ identifier: "ability" }] })],
  ),
  method(
    "AbstractPolicy.authorize",
    ["user", "actor", "ability"],
    [call("new(user, actor, res, options)", "result", { positionalArgAtoms: [{ identifier: "ability" }] })],
  ),
  method(
    "AbstractPolicy#authorize!",
    ["ability"],
    [call(null, "result", { positionalArgAtoms: [{ identifier: "ability" }] })],
  ),
  method("AbstractPolicy#result", ["ability"], [call(null, "admin?"), sendCan("ability")]),
];

describe("extractSelfDispatchMethods — argument templates (emazx)", () => {
  it("records the template of a method that sends an interpolation of its own parameter", () => {
    expect(templateOf(policyChunks(), "AbstractPolicy#result")).toEqual({
      prefix: "can_",
      suffix: "?",
      param: 0,
      via: [],
    });
  });

  it("carries the parameter back across same-file self hops to the entry's signature position", () => {
    expect(templateOf(policyChunks(), "AbstractPolicy#authorize!")).toEqual({
      prefix: "can_",
      suffix: "?",
      param: 0,
      via: ["AbstractPolicy#result"],
    });
    expect(templateOf(policyChunks(), "AbstractPolicy.authorize!")).toEqual({
      prefix: "can_",
      suffix: "?",
      param: 2,
      via: ["AbstractPolicy#authorize!", "AbstractPolicy#result"],
    });
    expect(templateOf(policyChunks(), "AbstractPolicy.authorize")).toEqual({
      prefix: "can_",
      suffix: "?",
      param: 2,
      via: ["AbstractPolicy#result"],
    });
  });

  it("declines a hole that is not a parameter of the sending method", () => {
    const chunks = [method("P#result", ["ability"], [sendCan("kind")])];
    expect(templateOf(chunks, "P#result")).toBeUndefined();
  });

  it("declines a send on a receiver that is not self", () => {
    const chunks = [
      method(
        "P#result",
        ["ability"],
        [call("other", "send", { sendNameTemplate: { prefix: "can_", suffix: "?", identifier: "ability" } })],
      ),
    ];
    expect(templateOf(chunks, "P#result")).toBeUndefined();
  });

  it("does not carry a computed argument across a hop", () => {
    const chunks = [
      method("P.authorize!", ["ability"], [call("new", "result", { positionalArgAtoms: [null] })]),
      method("P#result", ["ability"], [sendCan("ability")]),
    ];
    expect(templateOf(chunks, "P.authorize!")).toBeUndefined();
  });

  it("does not carry a forwarded identifier that is not the caller's parameter", () => {
    const chunks = [
      method("P.authorize!", ["user"], [call("new", "result", { positionalArgAtoms: [{ identifier: "ability" }] })]),
      method("P#result", ["ability"], [sendCan("ability")]),
    ];
    expect(templateOf(chunks, "P.authorize!")).toBeUndefined();
  });

  it("declines a method reaching two different templates", () => {
    const chunks = [
      method(
        "P#both",
        ["ability"],
        [
          sendCan("ability"),
          call(null, "send", { sendNameTemplate: { prefix: "may_", suffix: "?", identifier: "ability" } }),
        ],
      ),
    ];
    expect(templateOf(chunks, "P#both")).toBeUndefined();
  });

  it("does not hop to a method the file does not define on the same type", () => {
    const chunks = [
      method("P.authorize!", ["ability"], [call("new", "result", { positionalArgAtoms: [{ identifier: "ability" }] })]),
      method("Q#result", ["ability"], [sendCan("ability")]),
    ];
    expect(templateOf(chunks, "P.authorize!")).toBeUndefined();
  });
});

describe("collectSelfDispatchArgTemplates (emazx)", () => {
  it("indexes every method carrying a template by symbolId", () => {
    const registry = collectSelfDispatchArgTemplates(extractSelfDispatchMethods(policyChunks()));
    expect(Object.keys(registry).sort()).toEqual([
      "AbstractPolicy#authorize!",
      "AbstractPolicy#result",
      "AbstractPolicy.authorize",
      "AbstractPolicy.authorize!",
    ]);
    expect(registry["AbstractPolicy.authorize!"].param).toBe(2);
  });
});
