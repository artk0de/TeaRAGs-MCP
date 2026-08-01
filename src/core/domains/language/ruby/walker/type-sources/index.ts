import type { RubyInlineTypeSource } from "./types.js";
import { rubyAssociationTypeSource } from "./associations.js";
import { rubyAstInferenceTypeSource } from "./ast-inference.js";
import { rubyBodyLastExprTypeSource } from "./body-last-expr.js";
import { rubyDraperTypeSource } from "./draper.js";
import { rubyYardTypeSource } from "./yard.js";

/**
 * Ordered registry of inline type sources for a Ruby file.
 * YARD precedes associations precedes body-last-expr precedes AST so that when
 * more than one source emits a fact for the same binding (e.g. a YARD `@return`
 * + a `belongs_to`, or a YARD `@return` + a service `call` body inference of the
 * same name), the source-ranked merge in `RubyTypeFactStore` produces
 * deterministic results (annotation > macro inflection > service-body inference
 * > raw AST inference).
 */
export const INLINE_TYPE_SOURCES: readonly RubyInlineTypeSource[] = [
  rubyYardTypeSource,
  rubyAssociationTypeSource,
  rubyDraperTypeSource,
  rubyBodyLastExprTypeSource,
  rubyAstInferenceTypeSource,
];
