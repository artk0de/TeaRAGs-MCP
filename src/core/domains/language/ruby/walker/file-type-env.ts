/**
 * The file-scoped type knowledge every later Ruby extraction step reads.
 *
 * Three things, built once per file and passed around as one value:
 *
 *   - `store` — the declared type facts (YARD, Sorbet-ish sources, AST
 *     inference), indexed for per-chunk and per-method lookup.
 *   - `associationTypes` — the per-class Rails association map,
 *     `class → accessor → modelType`.
 *   - `ivarFieldTypes` — the per-class `@ivar` field types.
 *
 * They travel together because they are ONE decision with THREE effects. All
 * three are gated by the same env switch (`localTypeTrackingEnabled()`), all
 * three are read by both later passes, and the third is built FROM the second —
 * `collectRubyIvarFieldTypes` needs the association map to type an association
 * chain on an ivar's right-hand side. Leaving them loose in the orchestrator is
 * what forced it to know that build order, and to repeat the env gate at every
 * use site.
 *
 * Tracking off ⇒ an EMPTY env, not an absent one: a store over zero facts (so
 * `localBindingsForChunk` / `returnTypeByMethod` still answer, with empty maps)
 * and two empty Records. Consumers check `enabled` before doing work, exactly as
 * the inline `trackTypes` flag did.
 */

import type { RubyDslCatalogue } from "../dsl/index.js";
import { collectRubyAssociationTypes } from "./association-types.js";
import { collectRubyIvarFieldTypes, localTypeTrackingEnabled } from "./local-bindings.js";
import { RubyTypeFactStore } from "./type-fact-store.js";
import { INLINE_TYPE_SOURCES } from "./type-sources/index.js";
import type { RubyExtractInput } from "./walker.js";

export interface RubyFileTypeEnv {
  /** `localTypeTrackingEnabled()` for this run — the gate on every channel below. */
  readonly enabled: boolean;
  /** Declared type facts from `INLINE_TYPE_SOURCES`, indexed for chunk/method reads. */
  readonly store: RubyTypeFactStore;
  /** Per-class Rails association map: `class → accessor → modelType`. */
  readonly associationTypes: Record<string, Record<string, string>>;
  /** Per-class `@ivar` field types: `class → "@ivar" → typeName`. */
  readonly ivarFieldTypes: Record<string, Record<string, string>>;
}

/**
 * Build the file's type environment. Pure with respect to the AST; the only
 * ambient read is the env switch, taken ONCE here so no consumer re-reads it.
 */
export function buildRubyFileTypeEnv(input: RubyExtractInput, catalogue: RubyDslCatalogue): RubyFileTypeEnv {
  const trackTypes = localTypeTrackingEnabled();
  // Gather all inline type facts (YARD + AST) through the source registry and
  // build the store once per file. When tracking is off, an empty store is used
  // so localBindingsForChunk / returnTypeByMethod return empty maps cheaply.
  const facts = trackTypes ? INLINE_TYPE_SOURCES.flatMap((s) => s.extract(input)) : [];
  const store = RubyTypeFactStore.fromFacts(facts);
  // Per-class Rails association map (B1): `class → accessor → modelType`. Drives
  // compound-receiver chain typing (`event.user.agents`) in the binding pass and
  // is surfaced on the FileExtraction so resolvers can read it run-global.
  const associationTypes = trackTypes ? collectRubyAssociationTypes(input.tree.rootNode) : {};
  // `@ivar` field types (cai0 imass) — built HERE, ahead of the chunk pass, because
  // the known-target arg-hint pass reads them to type an `@ivar` ARGUMENT
  // (bd tea-rags-mcp-bvalc). Pure, so the position of the call is immaterial;
  // it is still surfaced on the extraction, unchanged.
  const ivarFieldTypes = trackTypes
    ? collectRubyIvarFieldTypes(input.tree.rootNode, associationTypes, input.code, catalogue)
    : {};
  return { enabled: trackTypes, store, associationTypes, ivarFieldTypes };
}
