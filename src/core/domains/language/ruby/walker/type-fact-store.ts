/**
 * Ruby's type-fact store: the kernel `TypeFactStore` plus Ruby's source
 * precedence (E1 seam 2). The store moved; the ranks did not — which source
 * outranks which is language data, and this file is where Ruby states it.
 *
 * `RubyTypeFactStore` is a value + type pair rather than a class: it is used as
 * both (`.fromFacts` at 50 call sites, `RubyFileTypeEnv.store` as a type), and
 * nothing in the repo constructs it or tests it with `instanceof`.
 */
import { TypeFactStore } from "../../kernel/type-fact-store.js";
import type { TypeFact } from "../../kernel/type-facts.js";

/** Ruby source precedence: first = strongest. `associations` (Rails DSL
 *  inflection) ranks below YARD annotations; `body-last-expr` (service `call` /
 *  `perform` body last-expression inference) ranks below both — an annotation or
 *  a macro-declared type always beats a body-inferred return — but above raw AST
 *  local inference. */
export const RUBY_TYPE_SOURCE_ORDER: readonly string[] = [
  "sorbet",
  "rbs",
  "yard",
  "associations",
  "draper",
  "body-last-expr",
  "ast",
];

export type RubyTypeFactStore = TypeFactStore;

export const RubyTypeFactStore = {
  /** Ruby ranks by default so the walker suite's 49 order-less call sites keep
   *  their meaning; `file-type-env.ts` passes the order explicitly anyway. */
  fromFacts(facts: TypeFact[], sourceOrder: readonly string[] = RUBY_TYPE_SOURCE_ORDER): TypeFactStore {
    return TypeFactStore.fromFacts(facts, sourceOrder);
  },
};
