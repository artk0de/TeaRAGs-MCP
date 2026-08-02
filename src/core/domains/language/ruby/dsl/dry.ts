/**
 * dry-rb grammar (dry-validation, dry-schema, dry-struct, dry-initializer). Two
 * halves, and the split between them is the whole point.
 *
 * ── DECLARING half (`entries`) ──────────────────────────────────────────────
 * dry-initializer's `param` / `option` each define an `attr_reader` for the
 * argument they name, so the class really does gain a method no `def` in the
 * source declares:
 *
 *   param :source, Types::String        → source
 *   option :dry_run, default: proc { }  → dry_run
 *
 * A READER only — dry-initializer writes `attr_reader`, and a `Dry::Struct` is
 * immutable, so there is no writer to synthesise. `operands: "first-symbol"`
 * because the second positional argument is a TYPE (`Types::String`), not another
 * name. Two documented under-approximations, both silent rather than wrong-ish:
 * `as: :other` renames the reader (we emit the declared symbol), and
 * `reader: false` suppresses it (we emit it anyway). Both are rare and both cost
 * at most one unreferenced symbol.
 *
 * dry-struct's `attribute` is deliberately NOT here — `rails.ts` already owns
 * that keyword with the same first-symbol reader shape (plus a writer), and the
 * dup-key guard forbids a second owner.
 *
 * ── EXTERNAL half (`runtimeBuiltins`) ───────────────────────────────────────
 * A bare `filled` / `maybe` / `rule` inside a `Dry::Validation::Contract` block
 * targets the gem's schema-builder runtime, not any in-project method — honestly
 * external (excluded from the resolveSuccessRate denominator rather than counted
 * a resolver miss).
 *
 * SAFE-SUBSET, empirically curated (bd tea-rags-mcp-adx5p.9). The dry surface
 * (required, optional, filled, maybe, value, rule, schema, params, hash, array,
 * each, key, config, json) overlaps ubiquitous Ruby/Rails method names.
 * Classifying those external — even gem-gated — would STEAL real in-project edges
 * wherever the corpus defines a method of that name, gaming the recall
 * denominator. KEPT only the dry-SPECIFIC contract predicates:
 *
 *   KEPT:    filled, maybe, rule  (dry-specific; no plausible in-project method)
 *   DROPPED: value, each, key, hash, array, config, json (ubiquitous
 *            Enumerable/Object names); required, optional, schema (common English
 *            method names); params (already a Rails runtime builtin).
 *
 * `option` was on that DROPPED list and has moved to the declaring half — a
 * different facet answering a different question, not a reversal. The rejection
 * was of marking it external for its own sake, which builds no graph; here it
 * earns its place by SYNTHESISING the reader, and external classification is an
 * incidental consequence that only fires after the resolution chain has already
 * failed (`classifyMiss`), so a project's own `def option` still resolves first.
 *
 * Gem-gated by `activatedBy` so neither half loads for a non-dry project.
 */
import { defineFrameworkVocabulary } from "./framework-module.js";
import type { DeclaredMethodSpec } from "./types.js";

/** dry-initializer synthesises a reader, and only a reader, per named argument. */
const initializerReader = (b: string): DeclaredMethodSpec[] => [{ name: b, kind: "instance" }];

export const DRY_VOCABULARY = defineFrameworkVocabulary(
  "dry",
  {
    param: { category: "accessor", declares: initializerReader, operands: "first-symbol" },
    option: { category: "accessor", declares: initializerReader, operands: "first-symbol" },
  },
  new Set(["filled", "maybe", "rule"]),
  { activatedBy: new Set(["dry-validation", "dry-schema", "dry-struct", "dry-initializer"]) },
);
