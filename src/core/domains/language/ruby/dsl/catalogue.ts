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
 *   - `ruby/walker/walker.ts` — `redirectTarget` → alias redirect `CallRef`,
 *     `category === "callback"` → callback symbol emission.
 *
 * RSpec / FactoryBot testing-DSL keywords are deliberately ABSENT — they are
 * chunked by the separate `rspec-scope-chunker` and must not enter this Rails
 * catalogue. AST argument extraction stays in the consumer engine, never here.
 */

import { ACTIVESUPPORT_VOCABULARY } from "./activesupport.js";
import { RAILS_VOCABULARY } from "./rails.js";
import { RUBY_CORE_VOCABULARY } from "./ruby-core.js";
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
];

export const RUBY_DSL: Record<string, RubyDslEntry> = composeEntries(FRAMEWORKS);

/**
 * Is `member` an external bare-call name in ANY registered framework — a
 * declaring macro (`entries`) OR a runtime/kernel helper (`runtimeBuiltins`)?
 * Fold over the registry; adding a framework needs no edit here. Equivalent to
 * the legacy `member in RUBY_DSL || RUBY_KERNEL_BUILTINS.has || RAILS_RUNTIME_BUILTINS.has`.
 */
export const isExternalBareCall = (member: string): boolean => FRAMEWORKS.some((f) => f.hasExternalMember(member));
