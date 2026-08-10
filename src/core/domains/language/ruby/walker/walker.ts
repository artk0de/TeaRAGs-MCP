/**
 * Ruby extraction walker.
 *
 * Two import-discovery channels because Ruby has two distinct linking
 * regimes:
 *
 *   1. Explicit `require` / `require_relative` — emits an ImportRef
 *      with the literal string from the call. Resolver maps these to
 *      file paths via load-path heuristics (basename match) or
 *      file-relative paths.
 *
 *   2. Zeitwerk autoload (Rails / Hanami / Rodauth / modern gems) —
 *      no `require` at the use site. A reference like `User.find`
 *      depends on `User` being defined in `app/models/user.rb` (or
 *      `lib/user.rb`, etc.) per Zeitwerk's constant-to-filename rule.
 *      Discovery is two-phase:
 *
 *      a) Per file: emit `fileScope` = list of top-level constants
 *         this file DEFINES (class/module declarations, including
 *         nested under `class A::B`). The provider's symbol table
 *         indexes these.
 *      b) Per call site: when a constant reference appears (`User.find`,
 *         `Acme::Auth::Login.new`), emit an ImportRef with the full
 *         qualified-constant string PREFIXED with `zeitwerk:` so the
 *         resolver knows to do constant-to-file inference instead of
 *         load-path resolution.
 *
 * Output FileExtraction:
 *   - `imports[]` mixes explicit `require_relative './foo'`,
 *     `require 'foo'`, and Zeitwerk constant references.
 *   - `fileScope[]` holds constants this file defines (used by the
 *     resolver's reverse lookup).
 *   - `chunks[].calls[]` carries call sites for the method graph.
 *
 * This module is the ORCHESTRATOR: it runs the collection passes in order and
 * assembles their results into one FileExtraction. The passes themselves live
 * in siblings, one per extraction concern:
 *
 *   - `class-hierarchy.ts`     — inheritance edges, ancestors, mixins, and the
 *                                FileExtraction channels they fill
 *   - `constant-refs.ts`       — requires, Zeitwerk refs, defined constants
 *   - `method-signatures.ts`   — arity / kwargs / visibility, and the call-site
 *                                shapes the narrowers compare them against
 *   - `registry-dispatch.ts`   — `CONST = {…}.freeze` refs and dispatch tables
 *   - `call-collection.ts`     — the call-site walk and its emit helpers
 *   - `dsl-edge-emitters.ts`   — synthetic edges for Rails/DSL macros
 *   - `association-types.ts`   — the Rails association map
 *   - `bare-call-detection.ts` — is this bare identifier a call, or a local?
 *   - `file-type-env.ts`       — the file's type knowledge (fact store,
 *                                associations, ivar field types) behind one gate
 *   - `chunk-extractions.ts`   — the per-chunk pass: one ChunkExtraction each,
 *                                plus the line → type-environment lookup
 *   - `type-channels.ts`       — the FileExtraction's type-inference channels
 *
 * What is left here is sequencing: which pass feeds which, and in what order the
 * channels are published. Anything that reasons about a fact rather than routing
 * it belongs in one of the siblings above.
 *
 * The names those siblings own but that the resolver imports from HERE are
 * re-exported at the bottom, so `walker.js` stays the one address for them.
 */

import type { MaterializedTree } from "../../../../contracts/types/ast.js";
import type { FileExtraction, ImportRef } from "../../../../contracts/types/codegraph.js";
import { catalogueForGemfile } from "../gemfile.js";
import { collectRubyCalls } from "./call-collection.js";
import { buildRubyChunkExtractions } from "./chunk-extractions.js";
import { attachRubyClassHierarchyChannels } from "./class-hierarchy.js";
import { collectRubyConstantRefs, collectRubyDefinedConstants, collectRubyRequires } from "./constant-refs.js";
import { buildRubyFileTypeEnv } from "./file-type-env.js";
import { collectRubyDispatchTables } from "./registry-dispatch.js";
import { attachRubyTypeChannels } from "./type-channels.js";

export interface RubyExtractInput {
  tree: MaterializedTree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
  /**
   * Raw `Gemfile` contents for the run (mirrors `WalkInput.gemfileContent`).
   * Extraction consumers gate DSL grammar on it via `catalogueForGemfile`;
   * undefined → FULL catalogue (bd tea-rags-mcp-adx5p.1b).
   */
  gemfileContent?: string;
}

export function extractFromRubyFile(input: RubyExtractInput): FileExtraction {
  // Gem-gated DSL grammar at extraction time (adx5p.1b): compose the catalogue
  // for this project's Gemfile once; the emit + type-source consumers below read
  // its facets. undefined gemfileContent → the FULL catalogue (byte-identical).
  const catalogue = catalogueForGemfile(input.gemfileContent);
  const explicitImports = collectRubyRequires(input.tree.rootNode);
  const constantRefs = collectRubyConstantRefs(input.tree.rootNode);
  const fileScope = collectRubyDefinedConstants(input.tree.rootNode);
  const dispatchTables = collectRubyDispatchTables(input.tree.rootNode);
  const dispatchTableNames = new Set(Object.keys(dispatchTables));
  const calls = collectRubyCalls(input.tree.rootNode, dispatchTableNames, catalogue);
  const imports: ImportRef[] = [...explicitImports, ...constantRefs];
  // The file's type knowledge, built once and read by both passes below.
  const typeEnv = buildRubyFileTypeEnv(input, catalogue);
  const { chunks, siteContextAt } = buildRubyChunkExtractions(input, calls, typeEnv, catalogue);
  const out: FileExtraction = {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks,
    fileScope,
  };
  // Optional channels, structural first then inferred. Each publisher writes only
  // the fields it owns, and only when they carry something.
  attachRubyClassHierarchyChannels(out, input.tree.rootNode);
  if (Object.keys(dispatchTables).length > 0) out.dispatchTables = dispatchTables;
  attachRubyTypeChannels(out, input.tree.rootNode, typeEnv, siteContextAt, catalogue);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports — `walker.js` stays the single import address for the resolver,
// the type-sources and the recall-forensics script. The definitions moved to
// the sibling modules named in the header; the surface here is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export {
  associationAccessorName,
  associationModelConstant,
  camelizeModelName,
  collectRubyAssociationTypes,
  RUBY_ASSOCIATION_MACROS,
} from "./association-types.js";
export { SUPER_RECEIVER_SENTINEL } from "./call-collection.js";
export { ZEITWERK_PREFIX } from "./constant-refs.js";
export { isRubyCallbackMacro } from "./dsl-edge-emitters.js";
