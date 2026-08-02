/**
 * YARD nilable / union `@return` facts (bd tea-rags-mcp-27q0z).
 *
 * `@return [Firm, nil]` is the single commonest way a Ruby codebase states
 * "this may not find one" — 26 of taxdome's 33 widenable brackets. The channel
 * dropped every one of them because a return fact could hold one nominal name
 * and nothing else. These cases pin what it accepts now, and what it still
 * refuses.
 */
import { describe, expect, it } from "vitest";

import { rubyYardTypeSource } from "../../../../../../../src/core/domains/language/ruby/walker/type-sources/yard.js";
import type { RubyExtractInput } from "../../../../../../../src/core/domains/language/ruby/walker/walker.js";

function makeInput(code: string): RubyExtractInput {
  return { code, relPath: "test.rb", language: "ruby", tree: {} as RubyExtractInput["tree"], chunks: [] };
}

const returnFacts = (code: string) => rubyYardTypeSource.extract(makeInput(code)).filter((f) => f.kind === "return");

describe("rubyYardTypeSource — nilable @return", () => {
  it("emits a nilable union for `@return [Firm, nil]`", () => {
    const code = ["# @return [Firm, nil]", "def find_firm", "end"].join("\n");
    expect(returnFacts(code)[0]?.type).toEqual({
      form: "union",
      members: [
        { form: "instance", name: "Firm" },
        { form: "nil" },
      ],
    });
  });

  it("treats `NilClass` as the same nil arm as the `nil` literal", () => {
    const code = ["# @return [Firm, NilClass]", "def find_firm", "end"].join("\n");
    expect(returnFacts(code)[0]?.type).toEqual({
      form: "union",
      members: [
        { form: "instance", name: "Firm" },
        { form: "nil" },
      ],
    });
  });

  it("emits a multi-nominal union for `@return [User, Actor]`", () => {
    const code = ["# @return [User, Actor]", "def trigger_executor", "end"].join("\n");
    expect(returnFacts(code)[0]?.type).toEqual({
      form: "union",
      members: [
        { form: "instance", name: "User" },
        { form: "instance", name: "Actor" },
      ],
    });
  });

  it("keeps a single bare constant a plain nominal ref — no union wrapper", () => {
    const code = ["# @return [Firm]", "def firm", "end"].join("\n");
    expect(returnFacts(code)[0]?.type).toEqual({ form: "instance", name: "Firm" });
  });

  it("refuses a bracket with an unparseable arm — one bad arm silences the fact", () => {
    const code = ["# @return [Hash<Integer, Array<Actor>>]", "def assignees", "end"].join("\n");
    expect(returnFacts(code)).toHaveLength(0);
  });

  it("refuses a collection arm inside a union — a @return of a collection IS a collection", () => {
    const code = ["# @return [Array<Owner>, nil]", "def members", "end"].join("\n");
    expect(returnFacts(code)).toHaveLength(0);
  });

  it("refuses a bracket with no nominal arm at all", () => {
    const code = ["# @return [nil, nil]", "def nothing", "end"].join("\n");
    expect(returnFacts(code)).toHaveLength(0);
  });
});

describe("rubyYardTypeSource — nilable @param", () => {
  it("emits a nilable union for `@param firm [Firm, nil]`", () => {
    const code = ["# @param firm [Firm, nil]", "def call(firm)", "end"].join("\n");
    const fact = rubyYardTypeSource.extract(makeInput(code)).find((f) => f.kind === "param");
    expect(fact?.type).toEqual({
      form: "union",
      members: [
        { form: "instance", name: "Firm" },
        { form: "nil" },
      ],
    });
  });
});
