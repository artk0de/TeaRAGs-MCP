/**
 * `mergeExtraction` — the append-only merge one extraction pass's
 * `Partial<FileExtraction>` goes through on its way into a file's extraction
 * (E1 seam 0, bd tea-rags-mcp-qns77). Model A of the plugin design
 * (`docs/superpowers/specs/2026-06-18-plugin-system-design.md`, key decision 5):
 * a native walker monolith is never re-sliced — it runs first and owns every
 * channel it wrote; a pass may only ADD.
 *
 * Two properties the codegraph depends on:
 *
 *   - **Absent stays absent.** A channel neither side carries is not
 *     materialised as `{}` / `[]`, and an EMPTY incoming channel is a no-op.
 *     Ruby publishes its optional channels only when non-empty
 *     (`ruby/walker/walker.ts:113`, `class-hierarchy.ts`, `type-channels.ts:45`),
 *     and an empty object reaching the NDJSON spill moves the payload the
 *     schema-drift guard compares.
 *   - **Base never loses.** A key the native walker wrote is never overwritten.
 *     Precedence INSIDE a walker — YARD `@return` beating body inference at
 *     `ruby/walker/type-channels.ts:44`, body inference NOT overwriting the type
 *     store at `:79` — is that walker's own business and stays there. This merge
 *     governs only native-vs-pass and pass-vs-pass.
 *
 * Distinct from the run-global absorb at
 * `trajectory/codegraph/symbols/run-state.ts:1068`, which unions the SAME
 * channels across FILES with last-write-wins. Same channel names, opposite
 * precedence, different scope: do not unify them.
 *
 * Every channel of `FileExtraction` and `ChunkExtraction` has a row in a
 * rulebook below. The rulebook type is a mapped type with `-?` over `keyof`, so
 * a NEW channel fails to compile until it gets a row — the merge cannot silently
 * drop a facet somebody added to the contract.
 */

import type { ChunkExtraction, FileExtraction } from "../../../contracts/types/codegraph.js";

/**
 * How one channel `K` of `TOwner` merges: the base's value (which may be absent)
 * plus a pass's value (which by construction is not).
 */
export type ExtractionChannelMerger<TOwner, K extends keyof TOwner> = (
  baseValue: TOwner[K],
  passValue: NonNullable<TOwner[K]>,
) => TOwner[K];

/** One merger per channel. `-?` so an OPTIONAL channel still demands a row. */
export type ExtractionMergeRulebook<TOwner> = {
  [K in keyof TOwner]-?: ExtractionChannelMerger<TOwner, K>;
};

/** Union of two Records where a key the BASE already carries keeps the base's value. */
function unionBaseWins<V>(base: Record<string, V> | undefined, pass: Record<string, V>): Record<string, V> {
  return { ...pass, ...(base ?? {}) };
}

/** Union of two Record-of-Records, per outer key and then per inner key, base winning both times. */
function unionNestedBaseWins<V>(
  base: Record<string, Record<string, V>> | undefined,
  pass: Record<string, Record<string, V>>,
): Record<string, Record<string, V>> {
  const out: Record<string, Record<string, V>> = { ...(base ?? {}) };
  for (const [outerKey, inner] of Object.entries(pass)) {
    out[outerKey] = unionBaseWins(out[outerKey], inner);
  }
  return out;
}

/**
 * Union per variable. A variable both sides bind gets both arrays, re-sorted by
 * `line` — `resolveLocalBindingType` reads "greatest line <= the call", so an
 * unsorted concat would hand a call the pass's later binding purely because the
 * pass ran second.
 */
function mergeLocalBindings<T extends { readonly line: number }>(
  base: Record<string, T[]> | undefined,
  pass: Record<string, T[]>,
): Record<string, T[]> {
  const out: Record<string, T[]> = { ...(base ?? {}) };
  for (const [variable, incoming] of Object.entries(pass)) {
    const existing = out[variable];
    out[variable] = existing === undefined ? incoming : [...existing, ...incoming].sort((a, b) => a.line - b.line);
  }
  return out;
}

const CHUNK_EXTRACTION_MERGE_RULEBOOK: ExtractionMergeRulebook<ChunkExtraction> = {
  // The merge key itself, and the lexical chain that travels with it.
  symbolId: (base) => base,
  scope: (base) => base,
  // The channel a pass is normally here to add to.
  calls: (base, pass) => [...base, ...pass],
  localBindings: (base, pass) => mergeLocalBindings(base, pass),
  localCallBindings: (base, pass) => unionBaseWins(base, pass),
  // Same position-aware read as `localBindings`, so the same union-and-re-sort
  // (bd tea-rags-mcp-z68v9): an unsorted concat would hand a call the pass's
  // later binding purely because the pass ran second.
  callResultBindings: (base, pass) => mergeLocalBindings(base, pass),
  // Scalars: the base's answer stands; a pass may only FILL one the walker left
  // absent. `??` and not a truthiness test — `acceptsBlock: false` is a proven
  // non-yielder, not a missing value.
  startLine: (base, pass) => base ?? pass,
  endLine: (base, pass) => base ?? pass,
  arity: (base, pass) => base ?? pass,
  paramNames: (base, pass) => base ?? pass,
  visibility: (base, pass) => base ?? pass,
  kwargs: (base, pass) => base ?? pass,
  acceptsBlock: (base, pass) => base ?? pass,
  isAbstractStub: (base, pass) => base ?? pass,
};

const FILE_EXTRACTION_MERGE_RULEBOOK: ExtractionMergeRulebook<FileExtraction> = {
  // File identity. A disagreement is caught by `assertSameFile` before the loop.
  relPath: (base) => base,
  language: (base) => base,
  // Append-only arrays: native entries first, pass entries after, order kept.
  imports: (base, pass) => [...base, ...pass],
  fileScope: (base, pass) => [...base, ...pass],
  inheritanceEdges: (base, pass) => [...(base ?? []), ...pass],
  knownTargetCallArgs: (base, pass) => [...(base ?? []), ...pass],
  moduleReexports: (base, pass) => [...(base ?? []), ...pass],
  // Set-like arrays: concat, then drop repeats KEEPING THE FIRST occurrence
  // (`Set` preserves insertion order; it never leaves this function, so the
  // NDJSON spill still sees a plain array).
  compactDeclaredClasses: (base, pass) => [...new Set([...(base ?? []), ...pass])],
  instantiatedTypes: (base, pass) => [...new Set([...(base ?? []), ...pass])],
  // Records: union of keys, base's value kept on a conflict.
  classExtends: (base, pass) => unionBaseWins(base, pass),
  classSchemaTables: (base, pass) => unionBaseWins(base, pass),
  functionReturnTypes: (base, pass) => unionBaseWins(base, pass),
  structuredReturnTypes: (base, pass) => unionBaseWins(base, pass),
  dispatchTables: (base, pass) => unionBaseWins(base, pass),
  // Nested Records: union per outer key, then per inner key; base wins both.
  classFieldTypes: (base, pass) => unionNestedBaseWins(base, pass),
  classFieldTypesByClassKey: (base, pass) => unionNestedBaseWins(base, pass),
  associationTypes: (base, pass) => unionNestedBaseWins(base, pass),
  ivarTypes: (base, pass) => unionNestedBaseWins(base, pass),
  classFieldParamLinks: (base, pass) => unionNestedBaseWins(base, pass),
  // Record-of-arrays: union of KEYS only. A key present in both keeps the base's
  // array UNCHANGED — these are order-sensitive (`classPrependedAncestors` is
  // read in reverse for MRO, `callbackParams` holds parameter POSITIONS), so
  // concatenating two passes' arrays would invent an order neither wrote.
  classAncestors: (base, pass) => unionBaseWins(base, pass),
  classPrependedAncestors: (base, pass) => unionBaseWins(base, pass),
  callbackParams: (base, pass) => unionBaseWins(base, pass),
  // Keyed by symbolId, not by position — see `mergeChunks`.
  chunks: (base, pass) => mergeChunks(base, pass),
};

const FILE_MERGE_CHANNELS = Object.keys(FILE_EXTRACTION_MERGE_RULEBOOK) as (keyof FileExtraction)[];
const CHUNK_MERGE_CHANNELS = Object.keys(CHUNK_EXTRACTION_MERGE_RULEBOOK) as (keyof ChunkExtraction)[];

/**
 * A channel whose value is an empty array / empty object carries nothing, and
 * writing it would materialise a key the walker deliberately left absent. Scalars
 * are never "empty" — `visibility: "public"` and `acceptsBlock: false` are real
 * answers.
 */
function carriesNothing(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object" && value !== null) {
    return Object.keys(value).length === 0;
  }
  return false;
}

function applyChannel<TOwner>(
  rulebook: ExtractionMergeRulebook<TOwner>,
  out: TOwner,
  base: TOwner,
  pass: Partial<TOwner>,
  key: keyof TOwner,
): void {
  const incoming = pass[key];
  if (incoming === undefined || carriesNothing(incoming)) {
    return;
  }
  // Sound by the guard above: a generic indexed access does not narrow on its own.
  out[key] = rulebook[key](base[key], incoming as NonNullable<TOwner[keyof TOwner]>);
}

/**
 * Merge a pass's chunk records into the walker's, matched by `symbolId` — the
 * walker emits one record per `input.chunks` entry in the same order
 * (`ruby/walker/chunk-extractions.ts:26`), so position is an accident of the
 * chunk list while the id is the identity. A record whose id the walker did not
 * emit is a chunk the pass SYNTHESIZED (a Rails association accessor, say) and is
 * appended after the walker's own, in the pass's order.
 */
function mergeChunks(base: readonly ChunkExtraction[], pass: readonly ChunkExtraction[]): ChunkExtraction[] {
  const merged = [...base];
  const indexBySymbolId = new Map<string, number>();
  merged.forEach((entry, index) => {
    if (!indexBySymbolId.has(entry.symbolId)) {
      indexBySymbolId.set(entry.symbolId, index);
    }
  });
  for (const incoming of pass) {
    const at = indexBySymbolId.get(incoming.symbolId);
    if (at === undefined) {
      indexBySymbolId.set(incoming.symbolId, merged.length);
      merged.push(incoming);
      continue;
    }
    merged[at] = mergeOneChunk(merged[at], incoming);
  }
  return merged;
}

function mergeOneChunk(base: ChunkExtraction, pass: ChunkExtraction): ChunkExtraction {
  const out: ChunkExtraction = { ...base };
  for (const key of CHUNK_MERGE_CHANNELS) {
    applyChannel(CHUNK_EXTRACTION_MERGE_RULEBOOK, out, base, pass, key);
  }
  return out;
}

function assertSameFile(base: FileExtraction, partial: Partial<FileExtraction>): void {
  // Programming error, not user input — the one case `.claude/rules/typed-errors.md`
  // rule 5 lets stay a plain Error.
  if (partial.relPath !== undefined && partial.relPath !== base.relPath) {
    throw new Error(
      `mergeExtraction: a pass claimed relPath "${partial.relPath}" while the walker extracted "${base.relPath}"`,
    );
  }
  if (partial.language !== undefined && partial.language !== base.language) {
    throw new Error(
      `mergeExtraction: a pass claimed language "${partial.language}" while the walker extracted "${base.language}"`,
    );
  }
}

/**
 * Fold one pass's partial into a file's extraction. Pure: `base` is not mutated
 * and the result is a new object. A channel the partial omits — or carries empty
 * — leaves the base's channel exactly as it was, absent ones included.
 */
export function mergeExtraction(base: FileExtraction, partial: Partial<FileExtraction>): FileExtraction {
  assertSameFile(base, partial);
  const out: FileExtraction = { ...base };
  for (const key of FILE_MERGE_CHANNELS) {
    applyChannel(FILE_EXTRACTION_MERGE_RULEBOOK, out, base, partial, key);
  }
  return out;
}
