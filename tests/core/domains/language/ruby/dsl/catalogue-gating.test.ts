import { describe, expect, it } from "vitest";

import {
  composeRubyCatalogue,
  filterActiveFrameworks,
} from "../../../../../../src/core/domains/language/ruby/dsl/catalogue.js";
import { defineFrameworkVocabulary } from "../../../../../../src/core/domains/language/ruby/dsl/framework-module.js";

const base = defineFrameworkVocabulary("rails", { has_many: { category: "association" } }); // unconditional
const dry = defineFrameworkVocabulary("dry", { param: { category: "accessor" } }, undefined, {
  activatedBy: new Set(["dry-initializer", "dry-struct", "dry-schema"]),
});
const devise = defineFrameworkVocabulary("devise", { devise: { category: "other" } }, undefined, {
  activatedBy: new Set(["devise"]),
});

describe("filterActiveFrameworks — gem gating", () => {
  it("null activeGems → the full list (no Gemfile / gating off, zero regression)", () => {
    const out = filterActiveFrameworks([base, dry, devise], null);
    expect(out).toHaveLength(3);
  });

  it("keeps unconditional vocabs but drops gem-gated ones absent from the project", () => {
    const out = filterActiveFrameworks([base, dry, devise], new Set(["rails", "pg"]));
    expect(out.map((f) => f.framework)).toEqual(["rails"]); // dry/devise not declared → dropped
  });

  it("activates a gem-gated vocab when ANY family member is present (dry-struct → dry grammar)", () => {
    const out = filterActiveFrameworks([base, dry, devise], new Set(["dry-struct"]));
    expect(out.map((f) => f.framework).sort()).toEqual(["dry", "rails"]);
  });

  it("activates devise on its exact gem", () => {
    const out = filterActiveFrameworks([base, dry, devise], new Set(["devise", "dry-schema"]));
    expect(out.map((f) => f.framework).sort()).toEqual(["devise", "dry", "rails"]);
  });
});

describe("composeRubyCatalogue — full-catalogue default", () => {
  it("null → full catalogue matching the module surface (rails + sidekiq present)", () => {
    const full = composeRubyCatalogue(null);
    expect(full.entries.has_many).toBeDefined(); // rails association macro
    expect(full.enqueueDispatch.perform_async).toBe("perform"); // sidekiq
    expect(full.isExternalBareCall("params")).toBe(true); // rails runtime builtin
  });

  it("an empty gem set still yields the unconditional base stack (rails/ruby-core/AS)", () => {
    const gated = composeRubyCatalogue(new Set<string>());
    // rails / ruby-core / activesupport / sidekiq / pundit / routing are all
    // unconditional today → identical to full until a gated vocab is added.
    expect(gated.entries.has_many).toBeDefined();
    expect(gated.enqueueDispatch.perform_async).toBe("perform");
  });
});
