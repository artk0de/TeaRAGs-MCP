import { describe, expect, it } from "vitest";

import {
  catalogueFor,
  composeRubyCatalogue,
  filterActiveFrameworks,
} from "../../../../../../src/core/domains/language/ruby/dsl/catalogue.js";
import { defineFrameworkVocabulary } from "../../../../../../src/core/domains/language/ruby/dsl/framework-module.js";

// Representative KEPT verbs of each gem-gated grammar's empirical safe-subset —
// dry-/chewy-specific names that survived the collision sweep. Ubiquitous method
// names (each/value/filter/field/index/…) were DROPPED to avoid stealing real
// in-project edges, so they are deliberately NOT asserted as external here.
const DRY_KEPT = ["filled", "maybe", "rule"] as const;
const CHEWY_KEPT = ["crutch", "template", "agg", "update_index"] as const;

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

describe("catalogueFor — memoised per-project catalogue (the consumer entry point)", () => {
  it("undefined gems → the shared full catalogue (gating off, identical to the module consts)", () => {
    const full = catalogueFor(undefined);
    expect(full.entries.has_many).toBeDefined(); // rails association macro
    expect(full.enqueueDispatch.perform_async).toBe("perform"); // sidekiq
    expect(full.isExternalBareCall("params")).toBe(true); // rails runtime builtin
  });

  it("null and undefined both return the SAME full-catalogue instance (referential identity)", () => {
    expect(catalogueFor(null)).toBe(catalogueFor(undefined));
  });

  it("memoises by gem-set instance — same Set yields the same catalogue instance", () => {
    const gems = new Set(["rails", "sidekiq"]);
    expect(catalogueFor(gems)).toBe(catalogueFor(gems));
  });

  it("a concrete gem set still exposes the unconditional base stack (every vocab unconditional today)", () => {
    // No vocab carries `activatedBy` yet, so a concrete gem set composes to the
    // same surface as full — the threading is zero-behaviour-change until a
    // gem-gated grammar lands (bd tea-rags-mcp-adx5p.9).
    const gated = catalogueFor(new Set(["rails"]));
    expect(gated.entries.has_many).toBeDefined();
    expect(gated.enqueueDispatch.perform_async).toBe("perform");
    expect(gated.isExternalBareCall("params")).toBe(true);
  });
});

describe("gem-gated grammars — dry / chewy / active_model_serializers (adx5p.9)", () => {
  it("dry contract verbs are external ONLY when a dry gem is declared", () => {
    const withDry = composeRubyCatalogue(new Set(["dry-schema"]));
    const withoutDry = composeRubyCatalogue(new Set(["rails", "sidekiq"]));
    for (const v of DRY_KEPT) {
      expect(withDry.isExternalBareCall(v), v).toBe(true);
      expect(withoutDry.isExternalBareCall(v), v).toBe(false); // dry absent → not classified
    }
  });

  it("dry activates on ANY family member (dry-validation / dry-struct / dry-initializer)", () => {
    for (const gem of ["dry-validation", "dry-struct", "dry-initializer"]) {
      expect(composeRubyCatalogue(new Set([gem])).isExternalBareCall("filled"), gem).toBe(true);
    }
  });

  it("chewy index-DSL verbs are external ONLY when chewy is declared", () => {
    const withChewy = composeRubyCatalogue(new Set(["chewy"]));
    const withoutChewy = composeRubyCatalogue(new Set(["rails"]));
    for (const v of CHEWY_KEPT) {
      expect(withChewy.isExternalBareCall(v), v).toBe(true);
      expect(withoutChewy.isExternalBareCall(v), v).toBe(false);
    }
  });

  it("AMS `attributes` emit entry is composed ONLY when active_model_serializers is declared", () => {
    const withAms = composeRubyCatalogue(new Set(["active_model_serializers"]));
    const withoutAms = composeRubyCatalogue(new Set(["rails"]));
    expect(withAms.entries.attributes?.emits).toBe("serialized-attribute");
    expect(withoutAms.entries.attributes).toBeUndefined(); // AMS absent → keyword not present
  });

  it("null (no Gemfile / gating off) → every gated grammar is active (FULL default)", () => {
    const full = composeRubyCatalogue(null);
    expect(full.isExternalBareCall("filled")).toBe(true); // dry
    expect(full.isExternalBareCall("crutch")).toBe(true); // chewy
    expect(full.entries.attributes?.emits).toBe("serialized-attribute"); // ams
  });

  it("safe-subset EXCLUDES ubiquitous colliders — a dropped verb stays non-external under the gem", () => {
    const withDry = composeRubyCatalogue(new Set(["dry-schema"]));
    const withChewy = composeRubyCatalogue(new Set(["chewy"]));
    // dry-dropped Enumerable/Object/common names (params excluded — Rails owns it).
    for (const v of ["value", "each", "key", "schema"]) expect(withDry.isExternalBareCall(v), v).toBe(false);
    // chewy-dropped ubiquitous names (`def index` is on every Rails controller).
    for (const v of ["field", "index", "filter"]) expect(withChewy.isExternalBareCall(v), v).toBe(false);
  });
});

describe("gem-gated DECLARES grammars — carrierwave / aasm (bd tea-rags-mcp-o5kwh)", () => {
  it("carrierwave mount_uploader declaring entries are composed ONLY when carrierwave is declared", () => {
    const withCw = composeRubyCatalogue(new Set(["carrierwave"]));
    const withoutCw = composeRubyCatalogue(new Set(["rails"]));
    expect(withCw.entries.mount_uploader?.declares).toBeDefined();
    expect(withCw.entries.mount_uploaders?.declares).toBeDefined();
    expect(withoutCw.entries.mount_uploader).toBeUndefined();
    expect(withoutCw.entries.mount_uploaders).toBeUndefined();
  });

  it("aasm structured macro is active ONLY when the aasm gem is declared; enum is unconditional", () => {
    const withAasm = composeRubyCatalogue(new Set(["aasm"]));
    const withoutAasm = composeRubyCatalogue(new Set(["rails"]));
    expect(withAasm.activeStructuredMacros.has("aasm")).toBe(true);
    expect(withoutAasm.activeStructuredMacros.has("aasm")).toBe(false);
    // enum is a Rails/AR built-in structured macro → always active.
    expect(withAasm.activeStructuredMacros.has("enum")).toBe(true);
    expect(withoutAasm.activeStructuredMacros.has("enum")).toBe(true);
  });

  it("null (no Gemfile / gating off) → every gated DECLARES grammar active (FULL default)", () => {
    const full = composeRubyCatalogue(null);
    expect(full.entries.mount_uploader?.declares).toBeDefined(); // carrierwave
    expect(full.activeStructuredMacros.has("aasm")).toBe(true); // aasm
    expect(full.activeStructuredMacros.has("enum")).toBe(true); // enum (unconditional)
  });
});
