/**
 * CanCanCan authorization gem grammar (bd tea-rags-mcp-adx5p.9). Two facets, both
 * reconstructing edges the static graph cannot see because the gem instantiates
 * the ability out of band.
 *
 *   - PERMISSION CHECKS (`authorize!`, `can?`, `cannot?`, and the controller
 *     class-body filters `load_and_authorize_resource` / `authorize_resource`)
 *     all funnel through `current_ability`, which memoises `Ability.new(user)`.
 *     The project's rules live in that class's constructor, so the real edge is
 *     `caller → Ability#initialize` — the `ability-dispatch` emit. This mirrors
 *     Pundit's `policy-dispatch`: the class is named by CONVENTION (CanCanCan's
 *     `current_ability` builds `::Ability` unless the app overrides the method),
 *     and the convention string lives in the walker interpreter, not here.
 *   - RULE DECLARATIONS (`can` / `cannot` inside that constructor) name the
 *     SUBJECT class of each rule: `can :read, Post`. That constant reference is a
 *     genuine `Ability → Post` dependency the walker otherwise drops, since a
 *     constant sitting in an argument list is not an assignment (the only shape
 *     `emitRegistryConstantRefs` covers). The `ability-subject-ref` emit adds it.
 *
 * `skip_authorization_check` is an entry with no emit: a real gem verb with zero
 * in-project effect, the last-resort external case `ruby-dsl.md` reserves.
 *
 * Gem-gated by `activatedBy` — `can` / `can?` are plausible project method names,
 * so without the gem in the Gemfile this grammar must not exist at all (neither
 * the emits nor the external classification).
 */
import { defineFrameworkVocabulary } from "./framework-module.js";
import type { RubyDslEntry } from "./types.js";

/** A permission check — routes to the project's `Ability` constructor. */
const abilityCheck: RubyDslEntry = { category: "other", emits: "ability-dispatch" };
/** A rule declaration — names the subject class the rule governs. */
const abilityRule: RubyDslEntry = { category: "other", emits: "ability-subject-ref" };

export const CANCANCAN_VOCABULARY = defineFrameworkVocabulary(
  "cancancan",
  {
    "authorize!": abilityCheck,
    "can?": abilityCheck,
    "cannot?": abilityCheck,
    authorize_resource: abilityCheck,
    load_and_authorize_resource: abilityCheck,
    can: abilityRule,
    cannot: abilityRule,
    skip_authorization_check: { category: "other" },
  },
  undefined,
  // `cancan` is the pre-fork gem name; both ship the identical DSL.
  { activatedBy: new Set(["cancancan", "cancan"]) },
);
