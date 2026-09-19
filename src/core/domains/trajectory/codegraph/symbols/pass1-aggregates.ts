/**
 * The per-file PASS-1 AGGREGATE slice — built in pass-2 from the spilled
 * extraction, persisted per file, and absorbed back by a LATER run that does not
 * re-walk the file (bd tea-rags-mcp-znxg8).
 *
 * ── The asymmetry this closes ──
 * `GlobalSymbolTable` hydrates from `cg_symbols` when the collection opens, so
 * DEFINITION lookups always see the whole project. The run-global maps pass-2
 * resolves against — ancestry, the hierarchy view, the self-dispatch template
 * registry — were assembled only from the files the CURRENT batch walked. An
 * incremental run therefore matched a project-wide symbol table against a
 * batch-sized registry.
 *
 * That combination does not under-resolve, it MIS-resolves. With
 * `KindOfService#call` absent from `selfDispatchTemplates`, the Ruby entry
 * strategy stands down (it CONTINUEs, by design, on a registry miss) and
 * `RubyConstantSymbolResolutionStrategy`'s ancestor walk picks the call up and
 * lands it on the shared mixin's own method. The field report sampled 200 caller
 * edges of one such node: 200 of 200 were concrete `SomeService.call(...)`
 * entries degraded that way, from 134 files, while `inProjectEdgeRecall` read
 * 1.0 — every one of them resolved to *a* symbol. Where the ancestry map was
 * missing too, the walk found nothing and the edge vanished instead, which is
 * the same defect wearing its other face.
 *
 * ── Why the whole slice rather than a derivation ──
 * `cg_symbols_inheritance` already holds every ancestry fact, so inverting it
 * back into the three legacy Records looks free. It is not. Ruby's walker
 * flattens superclass AND mixins into `classAncestors`, which
 * `normalizeInheritanceEdges` then re-tags per channel (`classExtends` →
 * `super`, `classAncestors` → `include`); inverting by kind hands back a
 * `classAncestors` with the superclass missing, and the MRO walk that resolves
 * `Create.call` through `Create < KindOfService` is precisely what needs it.
 * Folding `super` back in would fix Ruby by silently changing what every
 * TypeScript file's ancestry looks like. Storing what pass-1 actually produced
 * keeps hydration exact and language-neutral.
 */

import type { CodegraphPass1FileAggregates, SelfDispatchMethodDecl } from "../../../../contracts/types/codegraph.js";
import { PASS1_AGGREGATE_SLICE_FIELDS, type Pass1AggregateSlice } from "./run-global-map-registry.js";

/**
 * The extraction fields the persisted slice carries: every slice field except
 * the self-dispatch list, which is derived from the chunks and handed in beside
 * the extraction. Derived from the registry's hydrate entries (bd
 * tea-rags-mcp-39xca.6), so a new hydrate channel is a new source field here
 * without an edit.
 */
type Pass1AggregateSource = Omit<Pass1AggregateSlice, "selfDispatchMethods">;

/**
 * Build one file's persisted slice, or `undefined` when the file declares
 * nothing pass-2 would read run-globally.
 *
 * The `undefined` is not an optimisation detail — it is what keeps the table
 * proportional to the project's CLASSES rather than to its files. A codebase is
 * mostly modules that declare no ancestry and no self-dispatching method, and a
 * row of empty objects for each of them would say nothing at the cost of one row
 * per file.
 *
 * Empty sub-maps are dropped for the same reason, one level down: a file with
 * ancestry but no self-dispatch stores no `selfDispatchMethods` key at all,
 * rather than an empty array, so the round trip is shape-identical to what the
 * walker produced.
 */
export function buildPass1Aggregates(
  extraction: Pass1AggregateSource,
  selfDispatchMethods: readonly SelfDispatchMethodDecl[],
): Pass1AggregateSlice | undefined {
  // One view over every slice field, so the loop needs no per-field branch: the
  // self-dispatch list simply joins the extraction's own fields.
  const source: Pass1AggregateSlice = { ...extraction, selfDispatchMethods };
  const slice: Pass1AggregateSlice = { relPath: extraction.relPath, language: extraction.language };
  // Registry order IS the persisted key order — see RUN_GLOBAL_MAP_PERSISTENCE.
  for (const field of PASS1_AGGREGATE_SLICE_FIELDS) {
    if (carriesFacts(source[field])) Object.assign(slice, { [field]: source[field] });
  }
  return PASS1_AGGREGATE_SLICE_FIELDS.some((field) => slice[field] !== undefined) ? slice : undefined;
}

/**
 * The slices worth absorbing at the barrier: every persisted row whose file this
 * run did NOT walk.
 *
 * The filter is load-bearing, not a saving. Pass-2 has not written this run's
 * rows yet, so a walked file's row on disk still describes its PREVIOUS content
 * — absorbing it would resurrect a class the file just renamed away, keyed
 * identically to the fresh fact and indistinguishable from it. Skipping walked
 * files is what makes "the freshly walked extraction is authoritative" true by
 * construction rather than by merge order.
 */
export function selectHydratablePass1Aggregates(
  rows: readonly CodegraphPass1FileAggregates[],
  walkedRelPaths: ReadonlySet<string>,
): CodegraphPass1FileAggregates[] {
  return rows.filter((row) => !walkedRelPaths.has(row.relPath));
}

/**
 * Does one slice field carry a fact? Emptiness goes by shape — a list with no
 * entries, a map with no keys and an empty string all say nothing — which is
 * what keeps `moduleReexports` (a LIST any Python file with a `from` import
 * has, bd tea-rags-mcp-4yvms) from adding an empty key to most rows of a Python
 * project. A string field is a per-file scalar (Go's `buildConstraint`, bd
 * tea-rags-mcp-e6xx).
 */
function carriesFacts(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "object" && Object.keys(value).length > 0;
}
