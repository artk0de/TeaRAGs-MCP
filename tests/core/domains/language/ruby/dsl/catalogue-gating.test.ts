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

describe("gem-gated dispatch grammar — cancancan ability (adx5p.9)", () => {
  const CHECK_VERBS = ["authorize!", "can?", "cannot?", "authorize_resource", "load_and_authorize_resource"] as const;

  it("the permission-check family emits ability-dispatch ONLY when cancancan is declared", () => {
    const withCanCan = composeRubyCatalogue(new Set(["cancancan"]));
    const withoutCanCan = composeRubyCatalogue(new Set(["rails", "pundit"]));
    for (const verb of CHECK_VERBS) {
      expect(withCanCan.entries[verb]?.emits, verb).toBe("ability-dispatch");
      expect(withoutCanCan.entries[verb], verb).toBeUndefined();
    }
  });

  it("the rule verbs `can` / `cannot` emit the ability subject ref ONLY under the gem", () => {
    const withCanCan = composeRubyCatalogue(new Set(["cancancan"]));
    const withoutCanCan = composeRubyCatalogue(new Set(["rails"]));
    expect(withCanCan.entries.can?.emits).toBe("ability-subject-ref");
    expect(withCanCan.entries.cannot?.emits).toBe("ability-subject-ref");
    expect(withoutCanCan.entries.can).toBeUndefined();
    expect(withoutCanCan.entries.cannot).toBeUndefined();
  });

  it("activates on the legacy `cancan` gem name too (same grammar, renamed gem)", () => {
    expect(composeRubyCatalogue(new Set(["cancan"])).entries["authorize!"]?.emits).toBe("ability-dispatch");
  });

  it("a project without cancancan keeps `can` / `can?` free for its OWN methods (no external steal)", () => {
    const withoutCanCan = composeRubyCatalogue(new Set(["rails"]));
    expect(withoutCanCan.isExternalBareCall("can?")).toBe(false);
    expect(withoutCanCan.isExternalBareCall("can")).toBe(false);
  });

  it("null (no Gemfile / gating off) → the cancancan grammar is active (FULL default)", () => {
    expect(composeRubyCatalogue(null).entries["authorize!"]?.emits).toBe("ability-dispatch");
  });
});

describe("gem-gated type-source grammar — devise scoped receivers (adx5p.9)", () => {
  it("the `current_` receiver prefix is composed ONLY when devise is declared", () => {
    expect(composeRubyCatalogue(new Set(["devise"])).instanceReceiverPrefixes.has("current_")).toBe(true);
    expect(composeRubyCatalogue(new Set(["rails", "pundit"])).instanceReceiverPrefixes.has("current_")).toBe(false);
  });

  it("a project without devise composes NO receiver prefixes at all (empty facet, not a default)", () => {
    expect(composeRubyCatalogue(new Set(["rails"])).instanceReceiverPrefixes.size).toBe(0);
  });

  it("the `devise` model macro is an entry ONLY under the gem", () => {
    expect(composeRubyCatalogue(new Set(["devise"])).entries.devise).toBeDefined();
    expect(composeRubyCatalogue(new Set(["rails"])).entries.devise).toBeUndefined();
  });

  it("null (no Gemfile / gating off) → the devise grammar is active (FULL default)", () => {
    expect(composeRubyCatalogue(null).instanceReceiverPrefixes.has("current_")).toBe(true);
  });
});

describe("gem-gated delegation grammar — draper decorators (adx5p.9)", () => {
  it("the decorator macros are composed ONLY when draper is declared", () => {
    const withDraper = composeRubyCatalogue(new Set(["draper"]));
    const withoutDraper = composeRubyCatalogue(new Set(["rails"]));
    for (const verb of ["delegate_all", "decorates", "decorates_association", "decorates_associations"]) {
      expect(withDraper.entries[verb], verb).toBeDefined();
      expect(withoutDraper.entries[verb], verb).toBeUndefined();
    }
  });

  it("`decorates_association :author` declares the accessor the decorator gains", () => {
    const withDraper = composeRubyCatalogue(new Set(["draper"]));
    expect(withDraper.entries.decorates_association?.declares?.("author")).toEqual([
      { name: "author", kind: "instance" },
    ]);
  });

  it("`delegate_all` is a delegation macro, not an external no-op", () => {
    expect(composeRubyCatalogue(new Set(["draper"])).entries.delegate_all?.category).toBe("delegation");
  });

  it("null (no Gemfile / gating off) → the draper grammar is active (FULL default)", () => {
    expect(composeRubyCatalogue(null).entries.delegate_all).toBeDefined();
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

describe("gem-gated declaresFixed grammars — paper_trail / geocoder (declaresFixed facet)", () => {
  it("paper_trail has_paper_trail fixed-declare entry is composed ONLY when paper_trail is declared", () => {
    const withPt = composeRubyCatalogue(new Set(["paper_trail"]));
    const withoutPt = composeRubyCatalogue(new Set(["rails"]));
    expect(withPt.entries.has_paper_trail?.declaresFixed).toBeDefined();
    expect(withPt.entries.has_paper_trail?.declaresFixed?.map((m) => m.name)).toEqual([
      "versions",
      "version_at",
      "paper_trail",
    ]);
    expect(withoutPt.entries.has_paper_trail).toBeUndefined();
  });

  it("geocoder geocoded_by / reverse_geocoded_by fixed-declare entries are composed ONLY when geocoder is declared", () => {
    const withGeo = composeRubyCatalogue(new Set(["geocoder"]));
    const withoutGeo = composeRubyCatalogue(new Set(["rails"]));
    expect(withGeo.entries.geocoded_by?.declaresFixed?.map((m) => m.name)).toEqual(["geocode"]);
    expect(withGeo.entries.reverse_geocoded_by?.declaresFixed?.map((m) => m.name)).toEqual(["reverse_geocode"]);
    expect(withoutGeo.entries.geocoded_by).toBeUndefined();
    expect(withoutGeo.entries.reverse_geocoded_by).toBeUndefined();
  });

  it("state_machines state_machine structured macro is active ONLY when a state_machines/state_machine gem is declared", () => {
    const withSm = composeRubyCatalogue(new Set(["state_machines"]));
    const withLegacy = composeRubyCatalogue(new Set(["state_machine"]));
    const withoutSm = composeRubyCatalogue(new Set(["rails"]));
    expect(withSm.activeStructuredMacros.has("state_machine")).toBe(true);
    expect(withLegacy.activeStructuredMacros.has("state_machine")).toBe(true); // legacy gem name
    expect(withoutSm.activeStructuredMacros.has("state_machine")).toBe(false);
  });

  it("null (no Gemfile / gating off) → paper_trail / geocoder / state_machines grammars all active (FULL default)", () => {
    const full = composeRubyCatalogue(null);
    expect(full.entries.has_paper_trail?.declaresFixed).toBeDefined(); // paper_trail
    expect(full.entries.geocoded_by?.declaresFixed).toBeDefined(); // geocoder
    expect(full.activeStructuredMacros.has("state_machine")).toBe(true); // state_machines
  });
});

describe("gem-gated relation grammar — kaminari pagination (bd tea-rags-mcp-lo9u2)", () => {
  const KAMINARI_RELATION_VERBS = ["page", "per", "padding", "without_count"] as const;

  it("the pagination scopes are relation-returning ONLY when kaminari is declared", () => {
    const withKaminari = composeRubyCatalogue(new Set(["kaminari"]));
    const withoutKaminari = composeRubyCatalogue(new Set(["rails"]));
    for (const verb of KAMINARI_RELATION_VERBS) {
      expect(withKaminari.relationReturning.has(verb), verb).toBe(true);
      expect(withoutKaminari.relationReturning.has(verb), verb).toBe(false);
    }
  });

  it("activates on the kaminari-activerecord sub-gem too (split-gem install)", () => {
    expect(composeRubyCatalogue(new Set(["kaminari-activerecord"])).relationReturning.has("page")).toBe(true);
  });

  it("the per-model config macros are entries ONLY under the gem", () => {
    const withKaminari = composeRubyCatalogue(new Set(["kaminari"]));
    const withoutKaminari = composeRubyCatalogue(new Set(["rails"]));
    for (const macro of ["paginates_per", "max_paginates_per"]) {
      expect(withKaminari.entries[macro], macro).toBeDefined();
      expect(withoutKaminari.entries[macro], macro).toBeUndefined();
    }
  });

  it("a project without kaminari keeps `page` / `per` free for its OWN methods (no external steal)", () => {
    const withoutKaminari = composeRubyCatalogue(new Set(["rails"]));
    expect(withoutKaminari.isExternalBareCall("page")).toBe(false);
    expect(withoutKaminari.isExternalBareCall("per")).toBe(false);
  });

  it("the config macros declare NOTHING — they tune per-page defaults, not method names", () => {
    const withKaminari = composeRubyCatalogue(new Set(["kaminari"]));
    expect(withKaminari.entries.paginates_per?.declares).toBeUndefined();
    expect(withKaminari.entries.paginates_per?.declaresFixed).toBeUndefined();
  });

  it("null (no Gemfile / gating off) → the kaminari grammar is active (FULL default)", () => {
    const full = composeRubyCatalogue(null);
    expect(full.relationReturning.has("page")).toBe(true);
    expect(full.entries.paginates_per).toBeDefined();
  });
});

describe("gem-gated relation grammar — ransack search (bd tea-rags-mcp-lo9u2)", () => {
  it("`ransack` / `result` are relation-returning ONLY when ransack is declared", () => {
    const withRansack = composeRubyCatalogue(new Set(["ransack"]));
    const withoutRansack = composeRubyCatalogue(new Set(["rails"]));
    for (const verb of ["ransack", "result"]) {
      expect(withRansack.relationReturning.has(verb), verb).toBe(true);
      expect(withoutRansack.relationReturning.has(verb), verb).toBe(false);
    }
  });

  it("the `ransacker` custom-attribute macro is an entry ONLY under the gem", () => {
    expect(composeRubyCatalogue(new Set(["ransack"])).entries.ransacker).toBeDefined();
    expect(composeRubyCatalogue(new Set(["rails"])).entries.ransacker).toBeUndefined();
  });

  it("a project without ransack keeps `result` free for its OWN methods (no external steal)", () => {
    expect(composeRubyCatalogue(new Set(["rails"])).isExternalBareCall("result")).toBe(false);
  });

  it("the allowlist hooks stay OUT of the vocabulary — Ransack 4 makes the APP define them", () => {
    // `def self.ransackable_attributes` is in-project source; classifying it
    // external would steal a real edge from the very def that answers the call.
    const withRansack = composeRubyCatalogue(new Set(["ransack"]));
    for (const hook of ["ransackable_attributes", "ransackable_associations", "ransackable_scopes"]) {
      expect(withRansack.isExternalBareCall(hook), hook).toBe(false);
    }
  });

  it("null (no Gemfile / gating off) → the ransack grammar is active (FULL default)", () => {
    const full = composeRubyCatalogue(null);
    expect(full.relationReturning.has("ransack")).toBe(true);
    expect(full.entries.ransacker).toBeDefined();
  });
});
