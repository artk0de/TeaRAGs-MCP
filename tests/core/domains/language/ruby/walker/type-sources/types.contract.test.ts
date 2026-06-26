import { describe, expect, it } from "vitest";

import type { RubyTypeRef } from "../../../../../../../../src/core/contracts/types/language.js";
import type {
  RubyInlineTypeSource,
  RubyTypeFact,
} from "../../../../../../../../src/core/domains/language/ruby/walker/type-sources/types.js";

describe("RubyTypeFact contract", () => {
  it("models class/instance/union/container type refs", () => {
    const klass: RubyTypeRef = { form: "class", name: "User" };
    const inst: RubyTypeRef = { form: "instance", name: "User" };
    const union: RubyTypeRef = { form: "union", members: [klass, inst] };
    const arr: RubyTypeRef = {
      form: "container",
      element: { form: "instance", name: "Post" },
    };
    expect([klass.form, inst.form, union.form, arr.form]).toEqual(["class", "instance", "union", "container"]);
  });

  it("an inline source emits position-scoped param facts", () => {
    const src: RubyInlineTypeSource = {
      name: "fixture",
      extract: () => [
        {
          kind: "param",
          symbolScope: ["Octokit", "Client"],
          methodName: "repo",
          name: "id",
          line: 10,
          type: { form: "instance", name: "Repository" },
        },
      ],
    };
    const facts: RubyTypeFact[] = src.extract({} as never);
    expect(facts[0]).toMatchObject({ kind: "param", name: "id", line: 10 });
  });
});
