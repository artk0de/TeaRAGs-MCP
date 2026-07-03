/**
 * dry-rb contract / schema DSL grammar (dry-validation, dry-schema, dry-struct,
 * dry-initializer). An EXTERNAL vocabulary: a bare `filled`/`maybe`/`rule` inside
 * a `Dry::Validation::Contract` / `Dry::Schema.Params` block targets the gem's
 * schema-builder runtime, not any in-project method — so it is honestly external
 * (excluded from the resolveSuccessRate denominator rather than a resolver miss).
 *
 * SAFE-SUBSET, empirically curated (bd tea-rags-mcp-adx5p.9). The dry surface
 * (required, optional, filled, maybe, value, rule, schema, params, hash, array,
 * each, key, config, option, json) overlaps ubiquitous Ruby/Rails method names.
 * Classifying those external — even gem-gated — would STEAL real in-project edges
 * wherever the corpus defines a method of that name, gaming the recall
 * denominator. KEPT only the dry-SPECIFIC contract predicates:
 *
 *   KEPT:    filled, maybe, rule  (dry-specific; no plausible in-project method)
 *   DROPPED: value, each, key, hash, array, config, option, json (ubiquitous
 *            Enumerable/Object names); required, optional, schema (common English
 *            method names); params (already a Rails runtime builtin).
 *
 * Gem-gated by `activatedBy` so the grammar never loads for a non-dry project.
 * Pure external names → `runtimeBuiltins`, no declaring `entries`.
 */
import { defineFrameworkVocabulary } from "./framework-module.js";

export const DRY_VOCABULARY = defineFrameworkVocabulary("dry", {}, new Set(["filled", "maybe", "rule"]), {
  activatedBy: new Set(["dry-validation", "dry-schema", "dry-struct", "dry-initializer"]),
});
