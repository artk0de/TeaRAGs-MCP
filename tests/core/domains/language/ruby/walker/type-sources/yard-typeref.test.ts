/**
 * INFRA-A: yardBracketToRef union + container parsing.
 * Tests that the YARD type source emits union and container RubyTypeRefs.
 */
import { describe, expect, it } from "vitest";

import { rubyYardTypeSource } from "../../../../../../../src/core/domains/language/ruby/walker/type-sources/yard.js";
import type { RubyExtractInput } from "../../../../../../../src/core/domains/language/ruby/walker/walker.js";

function makeInput(code: string): RubyExtractInput {
  return { code, relPath: "test.rb", language: "ruby", tree: {} as RubyExtractInput["tree"], chunks: [] };
}

describe("rubyYardTypeSource — union + container RubyTypeRef (INFRA-A)", () => {
  // ── union params: [A, B] ────────────────────────────────────────────────────

  it("emits union typeRef for [A, B] param", () => {
    const code = ["# @param val [String, Integer]", "def set(val)", "end"].join("\n");
    const facts = rubyYardTypeSource.extract(makeInput(code));
    expect(facts).toHaveLength(1);
    const f = facts[0];
    expect(f?.type).toEqual({
      form: "union",
      members: [
        { form: "instance", name: "String" },
        { form: "instance", name: "Integer" },
      ],
    });
    expect(f?.kind).toBe("param");
    expect(f?.name).toBe("val");
  });

  it("emits union typeRef for 3-member union [A, B, C]", () => {
    const code = ["# @param result [User, Admin, Guest]", "def find(result)", "end"].join("\n");
    const facts = rubyYardTypeSource.extract(makeInput(code));
    expect(facts).toHaveLength(1);
    expect(facts[0]?.type).toEqual({
      form: "union",
      members: [
        { form: "instance", name: "User" },
        { form: "instance", name: "Admin" },
        { form: "instance", name: "Guest" },
      ],
    });
  });

  it("emits union with qualified constants [Acme::User, Acme::Admin]", () => {
    const code = ["# @param actor [Acme::User, Acme::Admin]", "def act(actor)", "end"].join("\n");
    const facts = rubyYardTypeSource.extract(makeInput(code));
    expect(facts).toHaveLength(1);
    expect(facts[0]?.type).toEqual({
      form: "union",
      members: [
        { form: "instance", name: "Acme::User" },
        { form: "instance", name: "Acme::Admin" },
      ],
    });
  });

  it("drops union member that is not a constant (lowercase)", () => {
    // [String, integer] — 'integer' is lowercase, so union is partially invalid.
    // Behavior: entire union dropped (member fails YARD_CONST) → no fact emitted.
    const code = ["# @param val [String, integer]", "def set(val)", "end"].join("\n");
    const facts = rubyYardTypeSource.extract(makeInput(code));
    // 'integer' fails YARD_CONST → undefined member → union not emitted
    expect(facts).toHaveLength(0);
  });

  // ── container params: Array<T> ───────────────────────────────────────────────

  it("emits container typeRef for Array<Post> param (not flattened to element)", () => {
    const code = ["# @param posts [Array<Post>]", "def publish(posts)", "end"].join("\n");
    const facts = rubyYardTypeSource.extract(makeInput(code));
    expect(facts).toHaveLength(1);
    expect(facts[0]?.type).toEqual({
      form: "container",
      element: { form: "instance", name: "Post" },
    });
  });

  it("emits container typeRef for Enumerable<User>", () => {
    const code = ["# @param users [Enumerable<User>]", "def process(users)", "end"].join("\n");
    const facts = rubyYardTypeSource.extract(makeInput(code));
    expect(facts).toHaveLength(1);
    expect(facts[0]?.type).toEqual({
      form: "container",
      element: { form: "instance", name: "User" },
    });
  });

  // ── bare const: unchanged (instance form) ───────────────────────────────────

  it("still emits instance form for bare constant param (backward compat)", () => {
    const code = ["# @param user [User]", "def save(user)", "end"].join("\n");
    const facts = rubyYardTypeSource.extract(makeInput(code));
    expect(facts).toHaveLength(1);
    expect(facts[0]?.type).toEqual({ form: "instance", name: "User" });
  });
});
