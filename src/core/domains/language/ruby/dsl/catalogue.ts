/**
 * Ruby/Rails class-body declaration DSL catalogue — the SINGLE declarative
 * source of "this identifier is a class-body declaration of category X (and, if
 * method-declaring, synthesises these methods / redirects this alias)".
 *
 * The catalogue is COMPOSED from per-framework modules (`ruby-core.ts`,
 * `activesupport.ts`, `rails.ts`), each a `RubyDslModule`. `composeModules`
 * merges their entries into the flat `RUBY_DSL` lookup the consumers read; the
 * dup-key guard forbids a keyword living in two modules. Adding a framework = a
 * new `dsl/<framework>.ts` module + one line in `MODULES`.
 *
 * Consumers (each reads only the facet it needs):
 *   - `ruby/chunking/class-body-chunker.ts` — `category` → chunk group (via its
 *     own `CATEGORY_TO_GROUP`; the group name is the chunker's policy, not an
 *     intrinsic fact, so it lives there not here).
 *   - `ruby/walker/macro-expansion.ts` — `declares(base)` → synthetic methods
 *     (shared by chunker `macros.ts` and codegraph `name-of.ts`).
 *   - `ruby/walker/walker.ts` — `emits` → synthetic class-body macro edges
 *     (alias_method redirect, delegate target, callback self-instance,
 *     association model-constant, via `emitDslEdges`); `redirectTarget` → the
 *     `alias`-keyword redirect `CallRef`.
 *
 * RSpec / FactoryBot testing-DSL keywords are deliberately ABSENT — they are
 * chunked by the separate `rspec-scope-chunker` and must not enter this Rails
 * catalogue. AST argument extraction stays in the consumer engine, never here.
 */

import { AASM_VOCABULARY } from "./aasm.js";
import { ROUTING_VOCABULARY } from "./action-dispatch-routing.js";
import { ACTIVESUPPORT_VOCABULARY } from "./activesupport.js";
import { AMS_VOCABULARY } from "./ams.js";
import { CANCANCAN_VOCABULARY } from "./cancancan.js";
import { CARRIERWAVE_VOCABULARY } from "./carrierwave.js";
import { CHEWY_VOCABULARY } from "./chewy.js";
import { DEVISE_VOCABULARY } from "./devise.js";
import { DRY_VOCABULARY } from "./dry.js";
import { GEOCODER_VOCABULARY } from "./geocoder.js";
import { PAPER_TRAIL_VOCABULARY } from "./paper_trail.js";
import { PUNDIT_VOCABULARY } from "./pundit.js";
import { ACTIVE_RECORD_INSTANCE_BUILTINS } from "./rails-runtime.js";
import { RAILS_VOCABULARY } from "./rails.js";
import { RUBY_CORE_VOCABULARY } from "./ruby-core.js";
import { SIDEKIQ_VOCABULARY } from "./sidekiq.js";
import { STATE_MACHINES_VOCABULARY } from "./state_machines.js";
import type { RubyDslEntry, RubyFrameworkVocabulary } from "./types.js";

/**
 * Merge per-framework `entries` into one keyword → entry lookup. Throws on a
 * duplicate keyword across modules (a keyword must belong to exactly one
 * framework) — a programming error caught at module load, not a user fault.
 */
export function composeEntries(modules: readonly RubyFrameworkVocabulary[]): Record<string, RubyDslEntry> {
  const out: Record<string, RubyDslEntry> = {};
  for (const mod of modules) {
    for (const [keyword, entry] of Object.entries(mod.entries)) {
      if (keyword in out) {
        throw new Error(`Ruby DSL catalogue: duplicate keyword "${keyword}" (module "${mod.framework}")`);
      }
      out[keyword] = entry;
    }
  }
  return out;
}

const FRAMEWORKS: readonly RubyFrameworkVocabulary[] = [
  RUBY_CORE_VOCABULARY,
  ACTIVESUPPORT_VOCABULARY,
  RAILS_VOCABULARY,
  SIDEKIQ_VOCABULARY,
  PUNDIT_VOCABULARY,
  ROUTING_VOCABULARY,
  // Gem-gated grammars (activatedBy) — composed into a project catalogue only
  // when its Gemfile declares the gem (composeRubyCatalogue / catalogueForGemfile).
  DRY_VOCABULARY,
  CHEWY_VOCABULARY,
  AMS_VOCABULARY,
  CARRIERWAVE_VOCABULARY,
  AASM_VOCABULARY,
  PAPER_TRAIL_VOCABULARY,
  GEOCODER_VOCABULARY,
  STATE_MACHINES_VOCABULARY,
  CANCANCAN_VOCABULARY,
  DEVISE_VOCABULARY,
];

export const RUBY_DSL: Record<string, RubyDslEntry> = composeEntries(FRAMEWORKS);

/** Every framework facet that is a plain string SET, foldable by union. */
type SetFacet = "instanceReturning" | "relationReturning" | "structuredMacros" | "instanceReceiverPrefixes";

/** Union a set-valued facet across the modules — the ONE fold every set facet
 *  uses, so a new one costs a `SetFacet` member and nothing else. */
function composeFacetSet(modules: readonly RubyFrameworkVocabulary[], facet: SetFacet): ReadonlySet<string> {
  const out = new Set<string>();
  for (const mod of modules) for (const m of mod[facet] ?? []) out.add(m);
  return out;
}

export const RUBY_INSTANCE_RETURNING = composeFacetSet(FRAMEWORKS, "instanceReturning");
export const RUBY_RELATION_RETURNING = composeFacetSet(FRAMEWORKS, "relationReturning");

function composeEnqueueDispatch(modules: readonly RubyFrameworkVocabulary[]): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const mod of modules) for (const [k, v] of Object.entries(mod.enqueueDispatch ?? {})) out[k] = v;
  return out;
}

export const RUBY_ENQUEUE_DISPATCH = composeEnqueueDispatch(FRAMEWORKS);
export const enqueueEntrypoint = (member: string): string | undefined => RUBY_ENQUEUE_DISPATCH[member];

/**
 * Is `member` an external bare-call name in ANY registered framework — a
 * declaring macro (`entries`) OR a runtime/kernel helper (`runtimeBuiltins`)?
 * Fold over the registry; adding a framework needs no edit here. Equivalent to
 * the legacy `member in RUBY_DSL || RUBY_KERNEL_BUILTINS.has || RAILS_RUNTIME_BUILTINS.has`.
 */
export const isExternalBareCall = (member: string): boolean => FRAMEWORKS.some((f) => f.hasExternalMember(member));

/**
 * bd tea-rags-mcp-83cl7 — is `member` a Ruby CORE member (Kernel/Object plus the
 * Enumerable/Array/Hash/String universals)? Fold over the registry, same shape as
 * {@link isExternalBareCall}; only `ruby-core` declares the facet, so a gem verb
 * answers false. NOT gem-gated: the core vocabulary is present in every project
 * regardless of its Gemfile.
 *
 * This answers the VOCABULARY half of the core-homonym classification. The
 * TYPEDNESS half (is the receiver untyped?) lives in `RubyExternalVocabulary` —
 * both are composed by `ExternalCallClassifier.targetsCoreAmbiguousMember`.
 */
export const isCoreAmbiguousMember = (member: string): boolean =>
  FRAMEWORKS.some((f) => f.hasCoreAmbiguousMember(member));

/**
 * A composed, per-project Ruby DSL catalogue — the same surface as the full
 * module-level `RUBY_*` consts, but built from only the ACTIVE frameworks. The
 * default full catalogue (`composeRubyCatalogue(null)`) is what the `RUBY_*`
 * consts above expose; a gem-gated project threads its Gemfile gem set through
 * `composeRubyCatalogue(activeGems)` (bd tea-rags-mcp-adx5p.1).
 */
export interface RubyDslCatalogue {
  readonly entries: Record<string, RubyDslEntry>;
  readonly instanceReturning: ReadonlySet<string>;
  readonly relationReturning: ReadonlySet<string>;
  readonly enqueueDispatch: Readonly<Record<string, string>>;
  /** Active STRUCTURED-macro names (`enum`, `aasm`) — gates the walker's
   *  structured-expander dispatch by gem, the structured analogue of `entries`. */
  readonly activeStructuredMacros: ReadonlySet<string>;
  /** Active receiver-name prefixes (devise's `current_`) — a bare receiver
   *  `<prefix><scope>` is an instance of `camelize(scope)` (adx5p.9). */
  readonly instanceReceiverPrefixes: ReadonlySet<string>;
  isExternalBareCall: (member: string) => boolean;
}

const setsIntersect = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  for (const x of a) if (b.has(x)) return true;
  return false;
};

/**
 * Compose the Ruby DSL catalogue for a project. `activeGems === null` → the FULL
 * catalogue (no Gemfile / gating off — zero regression, identical to the module
 * consts). A gem set → keep every UNCONDITIONAL vocabulary (`activatedBy`
 * undefined — ruby-core/activesupport/rails) plus any gem-gated vocabulary whose
 * `activatedBy` family intersects the project's gems. A gem's grammar never
 * loads for a project that doesn't declare it (no misfire).
 */
export function filterActiveFrameworks(
  frameworks: readonly RubyFrameworkVocabulary[],
  activeGems: ReadonlySet<string> | null,
): readonly RubyFrameworkVocabulary[] {
  if (activeGems === null) return frameworks;
  // Unconditional (`activatedBy` undefined) always loads; gem-gated loads iff its
  // activation family intersects the project's declared gems.
  return frameworks.filter((f) => f.activatedBy === undefined || setsIntersect(f.activatedBy, activeGems));
}

export function composeRubyCatalogue(activeGems: ReadonlySet<string> | null): RubyDslCatalogue {
  const active = filterActiveFrameworks(FRAMEWORKS, activeGems);
  const enqueueDispatch = composeEnqueueDispatch(active);
  return {
    entries: composeEntries(active),
    instanceReturning: composeFacetSet(active, "instanceReturning"),
    relationReturning: composeFacetSet(active, "relationReturning"),
    enqueueDispatch,
    activeStructuredMacros: composeFacetSet(active, "structuredMacros"),
    instanceReceiverPrefixes: composeFacetSet(active, "instanceReceiverPrefixes"),
    isExternalBareCall: (member) => active.some((f) => f.hasExternalMember(member)),
  };
}

/**
 * The FULL catalogue (every framework, gating off) — the shared default every
 * consumer falls back to when no gem set is threaded. Byte-identical to the
 * pre-gating module consts (`RUBY_DSL` / `RUBY_ENQUEUE_DISPATCH` / …), so a
 * consumer that passes no gems is behaviourally unchanged. Exported as the
 * default parameter value for extraction-time consumers whose gated catalogue is
 * threaded from the walk input (bd tea-rags-mcp-adx5p.1b).
 */
export const FULL_RUBY_CATALOGUE: RubyDslCatalogue = composeRubyCatalogue(null);

/**
 * Per-gem-set catalogue cache, keyed by the gem-set INSTANCE (weak → auto-evicts
 * with the Set). One live entry per distinct gem-set instance held by a caller.
 */
const catalogueByGems = new WeakMap<ReadonlySet<string>, RubyDslCatalogue>();

/**
 * The Ruby DSL catalogue for a resolved gem set, MEMOISED by the gem-set
 * instance. `null`/`undefined` (no Gemfile detected, gating off) returns the
 * shared {@link FULL_RUBY_CATALOGUE} — identical to the pre-gating consts, so a
 * caller that has no gem set is unchanged. A concrete gem set is composed once
 * via {@link composeRubyCatalogue} and cached against that Set instance. The
 * Set-keyed primitive; the resolver reaches it through the content-keyed
 * `catalogueForGemfile` adapter (which parses the raw Gemfile once per run) —
 * this function's `undefined` branch is the FULL fallback both share
 * (bd tea-rags-mcp-adx5p.1).
 */
export function catalogueFor(activeGems: ReadonlySet<string> | null | undefined): RubyDslCatalogue {
  // null / undefined → FULL (gating off). An empty Set is truthy → falls through
  // to composeRubyCatalogue, which keeps the unconditional stack (correct).
  if (!activeGems) return FULL_RUBY_CATALOGUE;
  const cached = catalogueByGems.get(activeGems);
  if (cached) return cached;
  const built = composeRubyCatalogue(activeGems);
  catalogueByGems.set(activeGems, built);
  return built;
}

/**
 * Is `member` an AR/core instance method that, on an UNTYPED qualified receiver
 * (`agent.update`), targets an external base class rather than any in-project
 * def of the same name? Direct membership in the curated set — single source,
 * NOT a framework fold (the set is Rails/AR-specific). The dynamic-dispatch
 * guard + external classifier consult this (bd tea-rags-mcp-i9id8).
 */
export const isExternalQualifiedMember = (member: string): boolean => ACTIVE_RECORD_INSTANCE_BUILTINS.has(member);
