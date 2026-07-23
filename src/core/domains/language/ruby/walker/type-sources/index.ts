import type { RubyInlineTypeSource } from "./types.js";
import { rubyAssociationTypeSource } from "./associations.js";
import { rubyAstInferenceTypeSource } from "./ast-inference.js";
import { rubyYardTypeSource } from "./yard.js";

/**
 * Ordered registry of inline type sources for a Ruby file.
 * YARD precedes associations precedes AST so that when more than one source
 * emits a fact for the same binding (e.g. a YARD `@return` + a `belongs_to` of
 * the same name), the source-ranked merge in `RubyTypeFactStore` produces
 * deterministic results (annotation > inflection > body inference).
 */
export const INLINE_TYPE_SOURCES: readonly RubyInlineTypeSource[] = [
  rubyYardTypeSource,
  rubyAssociationTypeSource,
  rubyAstInferenceTypeSource,
];
