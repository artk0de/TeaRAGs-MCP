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

import type {
  CodegraphPass1FileAggregates,
  FileExtraction,
  SelfDispatchMethodDecl,
} from "../../../../contracts/types/codegraph.js";

/** The extraction fields the persisted slice carries. */
type Pass1AggregateSource = Pick<
  FileExtraction,
  "relPath" | "language" | "classAncestors" | "classPrependedAncestors" | "classExtends" | "compactDeclaredClasses"
> &
  Pick<FileExtraction, "inheritanceEdges" | "structuredReturnTypes" | "functionReturnTypes"> &
  Pick<FileExtraction, "classFieldTypesByClassKey" | "moduleReexports">;

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
): CodegraphPass1FileAggregates | undefined {
  const slice: CodegraphPass1FileAggregates = { relPath: extraction.relPath, language: extraction.language };
  if (hasKeys(extraction.classAncestors)) slice.classAncestors = extraction.classAncestors;
  if (hasKeys(extraction.classPrependedAncestors)) slice.classPrependedAncestors = extraction.classPrependedAncestors;
  if (hasKeys(extraction.classExtends)) slice.classExtends = extraction.classExtends;
  if ((extraction.compactDeclaredClasses?.length ?? 0) > 0) {
    slice.compactDeclaredClasses = extraction.compactDeclaredClasses;
  }
  if ((extraction.inheritanceEdges?.length ?? 0) > 0) slice.inheritanceEdges = extraction.inheritanceEdges;
  if (selfDispatchMethods.length > 0) slice.selfDispatchMethods = selfDispatchMethods;
  if (hasKeys(extraction.structuredReturnTypes)) slice.structuredReturnTypes = extraction.structuredReturnTypes;
  if (hasKeys(extraction.functionReturnTypes)) slice.functionReturnTypes = extraction.functionReturnTypes;
  // The Python pair (bd tea-rags-mcp-4yvms). `moduleReexports` is a LIST rather
  // than a map, so emptiness is a length — and the list is common enough (any
  // file with a `from` import has one) that emitting `[]` would add a key to
  // most rows in a Python project for nothing.
  if (hasKeys(extraction.classFieldTypesByClassKey)) {
    slice.classFieldTypesByClassKey = extraction.classFieldTypesByClassKey;
  }
  if ((extraction.moduleReexports?.length ?? 0) > 0) slice.moduleReexports = extraction.moduleReexports;
  return carriesFacts(slice) ? slice : undefined;
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

function hasKeys(record: Record<string, unknown> | undefined): boolean {
  return record !== undefined && Object.keys(record).length > 0;
}

function carriesFacts(slice: CodegraphPass1FileAggregates): boolean {
  return (
    slice.classAncestors !== undefined ||
    slice.classPrependedAncestors !== undefined ||
    slice.classExtends !== undefined ||
    slice.compactDeclaredClasses !== undefined ||
    slice.inheritanceEdges !== undefined ||
    slice.selfDispatchMethods !== undefined ||
    slice.structuredReturnTypes !== undefined ||
    slice.functionReturnTypes !== undefined ||
    slice.classFieldTypesByClassKey !== undefined ||
    slice.moduleReexports !== undefined
  );
}
