/**
 * The per-file PASS-1 AGGREGATE record — the slice of a `FileExtraction` that
 * pass-2 reads run-globally rather than per file, persisted so a run that does
 * NOT re-walk the file can still absorb it (bd tea-rags-mcp-znxg8).
 *
 * ── Why this exists ──
 * Codegraph resolution reads two kinds of state, and until this record they had
 * different lifetimes:
 *
 *   - the `GlobalSymbolTable`, hydrated from `cg_symbols` when the collection
 *     opens (`codegraph/factory.ts` `initHook`), so DEFINITION lookups see the
 *     whole corpus on every run;
 *   - `CodegraphRunState`'s run-global maps — ancestry, the hierarchy view, the
 *     self-dispatch template registry — assembled ONLY from the files walked in
 *     the current batch (`extraction-sink.ts` `write` → `RunState#absorb`).
 *
 * An incremental run walks the changed files and nothing else, so the second
 * set covers the batch while the first covers the project. The resolver then
 * answers a call site with a complete symbol table and a registry that has a
 * hole exactly where the unchanged files were — and the hole is not silent, it
 * is WRONG: with `KindOfService#call` missing from `selfDispatchTemplates`, the
 * Ruby entry strategy CONTINUEs and the constant strategy's ancestor walk lands
 * every concrete `SomeService.call(...)` on the shared mixin's own method. The
 * field report measured 200 of 200 sampled caller edges of one such hub node
 * degraded that way, from 134 distinct files, while `inProjectEdgeRecall`
 * reported 1.0 — every degraded edge resolved to *a* symbol, just not the right
 * one. Where ancestry was missing too, the edge vanished instead.
 *
 * ── What it holds, and what it deliberately does not ──
 * The ANCESTRY family (`classAncestors` / `classPrependedAncestors` /
 * `classExtends` / `compactDeclaredClasses` / `inheritanceEdges`) and the
 * SELF-DISPATCH family (`selfDispatchMethods`). Those are what the reported
 * defect depends on, they are per-CLASS or per-METHOD-signature rather than per
 * call site, and they are small: a Ruby file declares one or two classes.
 *
 * The type-inference family that `RunState#absorb` also merges run-globally —
 * `ivarTypes`, `instantiatedTypes`, `dispatchTables`, `callbackParams`,
 * `knownTargetCallArgs`, `paramNames` — has the SAME batch-scoped lifetime and
 * therefore the same class of incremental divergence, but every one of them was
 * measured at exactly ZERO recovered edges (bd tea-rags-mcp-8qyax on a Ruby
 * corpus, bd tea-rags-mcp-4yvms on three Python ones). They are left unpersisted
 * on the strength of those numbers, not on the per-method size argument that
 * first deferred them — see `structuredReturnTypes` below for how that argument
 * fared.
 *
 * ── Why the fields are stored verbatim rather than derived back ──
 * `cg_symbols_inheritance` already persists every ancestry fact, so inverting
 * it into the three legacy Records looks like a free fix. It is not: the write
 * direction is lossy in the direction that matters. Ruby's walker flattens
 * superclass AND mixins into `classAncestors`, which `normalizeInheritanceEdges`
 * re-tags per channel (`classExtends` → `super`, `classAncestors` → `include`),
 * so inverting by kind hands back a `classAncestors` with the superclass
 * missing — and the MRO walk that resolves `Create.call` through
 * `Create < KindOfService` is exactly what needs it. Folding `super` back into
 * `classAncestors` would fix Ruby by changing what every TypeScript file's
 * ancestry looks like. Storing what pass-1 actually produced keeps hydration
 * exact and language-neutral.
 *
 * Re-exported verbatim by the `codegraph.ts` barrel.
 */

import type { ModuleReexport } from "./codegraph-extraction.js";
import type { InheritanceEdgeDecl } from "./codegraph-hierarchy.js";
import type { RelPath, SymbolId } from "./codegraph-symbols.js";
import type { RubyTypeRef } from "./language.js";

/**
 * One method's self-reach: the members it invokes on `self`, normalized to bare
 * names. Declared here rather than in the discovery module because it is now
 * PERSISTED — the pass-1→pass-2 barrier folds it into the self-dispatch template
 * registry, and an incremental run reads it back for files it did not walk.
 *
 * Same vocabulary position as {@link InheritanceEdgeDecl}: what the walker
 * DECLARED, before any structural verdict is folded over it.
 */
export interface SelfDispatchMethodDecl {
  /** symbolId of the method, e.g. `KindOfService#call` or `BaseProcessor.process_result`. */
  readonly symbolId: SymbolId;
  /** the enclosing type FQ, e.g. `KindOfService`. */
  readonly enclosingType: string;
  /** members this method invokes on `self` (bare / `self.X` / `self.new.X`), bare-normalized. */
  readonly selfHookCandidates: readonly string[];
}

/**
 * One file's persisted pass-1 aggregate slice. Every field is optional and
 * absent-when-empty, so a file that declares no class and no self-dispatching
 * method round-trips as an (almost) empty record rather than a bag of `{}`s.
 *
 * `language` rides along because hydration must not disturb the per-language
 * run statistics: a hydrated file was NOT extracted by this run, and nothing
 * that counts extractions may see it. It is carried for diagnosis and for a
 * future language-scoped hydration, not to be counted.
 */
export interface CodegraphPass1FileAggregates {
  relPath: RelPath;
  language: string;
  classAncestors?: Record<string, readonly string[]>;
  classPrependedAncestors?: Record<string, readonly string[]>;
  classExtends?: Record<string, string>;
  compactDeclaredClasses?: readonly string[];
  inheritanceEdges?: readonly InheritanceEdgeDecl[];
  selfDispatchMethods?: readonly SelfDispatchMethodDecl[];
  /**
   * The two RETURN-TYPE channels, added by bd tea-rags-mcp-8qyax after the
   * measurement that this docblock previously used to justify excluding them.
   *
   * `structuredReturnTypes` keys `"<fqClass>#method"`, `functionReturnTypes`
   * keys a bare function name. Both are read by pass-2 to type a chained
   * receiver (`repo.fetch.render`), and without them an incremental run does
   * not merely miss the edge — it fans out over every class declaring the
   * member, so a pinned edge becomes a cone carrying phantom targets.
   *
   * Measured offline on taxdome with
   * `scripts/spikes/incremental-runglobal-delta.ts` (9945 attempted calls,
   * 250 files): an incremental run loses 168 edges, and handing it these two
   * recovers 131 — `structuredReturnTypes` 111, `functionReturnTypes` 20,
   * additive. Every OTHER type-inference family recovers exactly ZERO:
   * `instantiatedTypes`, `dispatchTables` + `callbackParams`, and the whole
   * param family (`paramNames`, `paramTypes`, `classFieldParamLinks`,
   * `derivedClassFieldTypes`). Those stay batch-scoped, deliberately.
   *
   * The size objection that deferred them did not survive contact either: on
   * the same corpus `structuredReturnTypes` holds 6518 entries and
   * `functionReturnTypes` 2597, against the 11099 per-class ancestry keys this
   * slice ALREADY carries — the per-method map is the smaller one, because most
   * methods carry no return fact.
   *
   * `ivarTypes` is NOT here and is NOT cleared: taxdome's map is empty (no type
   * source emits `kind:"ivar"` there, bd tea-rags-mcp-wr7ku), so the corpus
   * cannot see it either way. Re-run the harness's `--ablate ivar` on a corpus
   * with ivar annotations before concluding anything about it.
   */
  structuredReturnTypes?: Record<string, RubyTypeRef>;
  functionReturnTypes?: Record<string, string>;
  /**
   * The two PYTHON run-global channels, added by bd tea-rags-mcp-4yvms.
   *
   * `classFieldTypesByClassKey` keys `"<relPath>::<dotted class FQ>"` and feeds
   * Python's MRO field fold, so a subclass sees a base class's fields from
   * ANOTHER file (bd f0xaa) — cross-file by construction, therefore invisible to
   * a batch that walked only the subclass. `moduleReexports` is the file's `from`
   * statements verbatim, and the import mapper walks it to answer "which file
   * DECLARES this name" past a package `__init__.py` that only re-exports it (bd
   * xpl83.3) — a question asked about a package the CALLER does not own, so the
   * file holding the answer is one an incremental run has no reason to have
   * walked.
   *
   * Measured offline on three Python corpora with
   * `scripts/spikes/incremental-runglobal-delta.ts`, 4 batches x 40 files,
   * comparing CALL-EDGE SETS rather than counts:
   *
   *   netbox  1038 files, 7255 attempted, 1224 edges — 12 lost unablated;
   *           `--ablate cft` 9, `--ablate reexp` 0, both 12
   *   polar   1339 files, 9310 attempted, 2518 edges — 121 lost, 2 phantom,
   *           1 retargeted; `--ablate reexp` 118, `--ablate cft` 0, both 121
   *   ugnest   258 files, 2842 attempted,  435 edges — 0 either way
   *
   * They are persisted TOGETHER because neither alone recovers what the pair
   * does, and the reason is a real dependency rather than a measurement
   * artefact: the field fold addresses a class through
   * `pythonReceiverClassKey`, which resolves the receiver THROUGH the import
   * mapper, so a field lookup can only land once the re-export walk has named
   * the declaring file. Hence netbox 9 + 0 < 12 and polar 0 + 118 < 121 — the
   * remaining 3 on each corpus need both maps in scope at once. Every OTHER
   * family still measures exactly zero on all three corpora, ablated one at a
   * time (`ivar`, `rta`, `dispatch`, `params`, and — now that they are persisted
   * — `sret` / `fret` / `types`).
   *
   * Cost, against the per-class ancestry keys the slice already carries:
   * `classFieldTypesByClassKey` 1263 keys / 3384 fields on netbox (4218
   * ancestry keys), 2867 / 13294 on polar (3034), 35 / 98 on ugnest (258);
   * `moduleReexports` 933 files / 7589 entries on netbox, 1191 / 18400 on
   * polar, 226 / 1281 on ugnest. polar is where this is expensive — its
   * re-export entries outnumber its ancestry keys six to one — and 121 of 2518
   * edges (4.8%) is what buys it.
   *
   * `moduleReexports` merges at a different grain from every other channel here,
   * and deliberately: it is keyed by the DECLARING relPath and REPLACED on a
   * re-walk, because the list is the whole truth about one file's `from`
   * statements and accumulating would resurrect a statement the file has since
   * deleted. So hydration skips walked files (as every channel does) and its
   * batch-wins guard keys on relPath rather than on an exported name.
   */
  classFieldTypesByClassKey?: Record<string, Record<string, string>>;
  moduleReexports?: readonly ModuleReexport[];
}
