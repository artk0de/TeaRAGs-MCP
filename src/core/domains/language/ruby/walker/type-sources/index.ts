import type { RubyInlineTypeSource } from "./types.js";
import { rubyAstInferenceTypeSource } from "./ast-inference.js";
import { rubyYardTypeSource } from "./yard.js";

/**
 * Ordered registry of inline type sources for a Ruby file.
 * YARD precedes AST so that when both sources emit a fact for the same
 * binding (e.g. a YARD `@param` + an assignment in the body), the
 * position-aware merge in `RubyTypeFactStore` produces deterministic results.
 */
export const INLINE_TYPE_SOURCES: readonly RubyInlineTypeSource[] = [rubyYardTypeSource, rubyAstInferenceTypeSource];
