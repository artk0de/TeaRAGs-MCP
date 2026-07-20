/**
 * taxdome-codegraph-recall-forensics.ts (bd lawlq.2 for taxdome)
 *
 * FAITHFUL, read-only, in-process re-resolution of taxdome's Ruby codegraph to
 * enumerate RECALL MISSES (unresolved in-project call-sites that HAVE an
 * in-project definition — the true recall hole). Mirrors
 * `CodegraphSymbolProvider.resolveExtraction` + the two-pass sink flow
 * (`buildFileSignals` → `extractOneFile` → `sink.write` → barrier →
 * `streamingResolveAndUpsert`/`resolveExtraction`) WITHOUT DuckDB, reusing the
 * REAL exports and re-implementing NO resolution logic.
 *
 * Divergence notes (reported honestly, per task):
 *   - Ruby-only. The symbol table + run-global maps are populated from ruby
 *     files ONLY (like lawlq.2 for mastodon). The real reindex's symbol table
 *     also holds TS/JS/py short-names; a ruby bareCall whose member collides
 *     with a cross-language short-name could bucket differently in cg_run_stats.
 *     For the ruby-intrinsic recall taxonomy this is the CORRECT scoping (a
 *     cross-language "resolution" is a false edge, not a real recall win).
 *   - File selection replicates the reindex's effective ruby corpus:
 *     whole-repo walk minus BUILTIN_IGNORE_PATTERNS + root .gitignore/.contextignore
 *     (FileScanner Layer 1) minus CODEGRAPH test/generated patterns (Layer 2).
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { homedir } from "node:os";

import Parser from "tree-sitter";
import ignore, { type Ignore } from "ignore";

import {
  LanguageFactory,
  collectSymbols,
  DefaultSymbolIdComposer,
} from "../src/core/domains/language/index.js";
import { rbNameOf } from "../src/core/domains/language/ruby/walker/index.js";
import type { AstNode } from "../src/core/contracts/types/ast.js";
import type {
  CallContext,
  CallRef,
  DispatchFanoutOutcome,
  FileExtraction,
  InheritanceEdgeRow,
  SymbolDefinition,
  DispatchTableDef,
  RubyTypeRef,
} from "../src/core/contracts/types/codegraph.js";
import { InMemoryGlobalSymbolTable } from "../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import {
  classifyReceiverKind,
  RECEIVER_KINDS,
  type ReceiverKind,
} from "../src/core/domains/trajectory/codegraph/symbols/receiver-kind.js";
import {
  buildIncludedBy,
  CODEGRAPH_LANGUAGES,
} from "../src/core/domains/trajectory/codegraph/symbols/provider.js";
import {
  buildHierarchySnapshot,
  normalizeInheritanceEdges,
} from "../src/core/domains/trajectory/codegraph/symbols/inheritance-edges.js";
import {
  buildSelfDispatchProbe,
  collectSelfInstantiatingClassMethods,
  discoverSelfDispatchTemplates,
  extractSelfDispatchMethods,
  foldSelfDispatchTemplates,
  type SelfDispatchMethod,
} from "../src/core/domains/trajectory/codegraph/symbols/self-dispatch-discovery.js";
import { MapHierarchyView } from "../src/core/infra/graph/hierarchy-view.js";
import { materializeTree } from "../src/core/infra/materialize.js";
import { buildCodegraphExclusionFilter } from "../src/core/domains/trajectory/codegraph/exclusion.js";
import { BUILTIN_IGNORE_PATTERNS } from "../src/core/domains/ingest/pipeline/ignore-defaults.js";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
const ROOT = process.env.TAXDOME_ROOT ?? join(homedir(), "Dev/Job/taxdome");
const OUT_DIR = "/Users/artk0re/.claude/jobs/24baee70/tmp";
const OUT_MISSES = join(OUT_DIR, "taxdome-misses.json");
const OUT_ORACLE = join(OUT_DIR, "g0-oracle-report.json");
const RUBY_EXT = ".rb";

// ---------------------------------------------------------------------------
// G0 VTA oracle gate (bd tea-rags-mcp-wbj3; spec
// docs/superpowers/specs/2026-07-10-vta-oracle-gate-design.md). ADDITIVE +
// env-gated: with CODEGRAPH_ORACLE unset the harness behaves byte-identically
// to before (no AST scan, no extra report), so the A/B recall metrics other
// groups depend on are untouched. The oracle is a FOLD over the same materialized
// AST + symbol table the harness already builds — no re-extraction, no resolver
// change, no reindex. It answers, per candidate site: IF the container/element
// type were known perfectly, would `member` resolve to an in-project def?
// ---------------------------------------------------------------------------
const ORACLE_ENABLED = process.env.CODEGRAPH_ORACLE === "1";

// ---------------------------------------------------------------------------
// verbatim helpers copied from provider.ts (lastSegment) — pure, no logic reuse
// concern; identical to provider's `lastSegment` used for defs.shortName.
// ---------------------------------------------------------------------------
function lastSegment(name: string): string {
  const slash = name.lastIndexOf("/");
  if (slash !== -1) return name.slice(slash + 1);
  const hash = name.lastIndexOf("#");
  const segment =
    hash !== -1
      ? name.slice(hash + 1)
      : (() => {
          const dot = name.lastIndexOf(".");
          return dot === -1 ? name : name.slice(dot + 1);
        })();
  return segment.replace(/~\d+$/, "");
}

// ---------------------------------------------------------------------------
// File discovery — mirrors discoverSupportedFiles two-layer filter for ruby.
// ---------------------------------------------------------------------------
function buildScannerFilter(root: string): Ignore {
  const ig = ignore();
  ig.add(BUILTIN_IGNORE_PATTERNS);
  for (const f of [".gitignore", ".contextignore"]) {
    const p = join(root, f);
    if (existsSync(p)) {
      try {
        ig.add(readFileSync(p, "utf8"));
      } catch {
        /* ignore */
      }
    }
  }
  return ig;
}

function discoverRubyFiles(root: string): string[] {
  const scannerFilter = buildScannerFilter(root);
  const codegraphFilter = buildCodegraphExclusionFilter({ excludeTests: true, customPatterns: [] });
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".claude-plugin") continue;
      const full = join(dir, entry.name);
      const relPath = relative(root, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        const dirRel = `${relPath}/`;
        if (scannerFilter.ignores(dirRel)) continue;
        if (codegraphFilter.ignores(dirRel)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extname(entry.name) !== RUBY_EXT) continue;
      if (scannerFilter.ignores(relPath)) continue;
      if (codegraphFilter.ignores(relPath)) continue;
      out.push(relPath);
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Real dependency wiring (identical to what bootstrap injects for codegraph).
// ---------------------------------------------------------------------------
const factory = new LanguageFactory(); // ambiguousResolveMode defaults to "strict"
const composer = new DefaultSymbolIdComposer();
const ruby = factory.create("ruby");
const walker = ruby.walker;
const resolver = ruby.resolver;
const rbConfig = CODEGRAPH_LANGUAGES[RUBY_EXT];

const gemfileContent = process.env.FORCE_FULL_CATALOGUE === "1"
  ? undefined // FULL catalogue (ungated) — apples-to-apples vs pre-gating baseline
  : (() => {
      try {
        return readFileSync(join(ROOT, "Gemfile"), "utf8");
      } catch {
        return undefined;
      }
    })();

// NOTE: extractOneFile (provider.ts:1825-1871) is inlined into main's PASS-1
// loop so it can also hand the materialized root to collectRealDefNames.

// ---------------------------------------------------------------------------
// Run-global state — mirrors the provider instance fields populated in
// sink.write (PASS-1). Ruby-only population.
// ---------------------------------------------------------------------------
const symbolTable = new InMemoryGlobalSymbolTable();
const runAncestors: Record<string, readonly string[]> = {};
const runCompactClasses = new Set<string>();
const runPrependedAncestors: Record<string, readonly string[]> = {};
const runExtends: Record<string, string> = {};
const runReturnTypes: Record<string, string> = {};
const runInstantiatedTypes = new Set<string>();
const runIvarTypes: Record<string, Record<string, string>> = {};
const runStructuredReturnTypes: Record<string, RubyTypeRef> = {};
const runInheritanceRows: InheritanceEdgeRow[] = [];
const runDispatchTables: Record<string, DispatchTableDef[]> = {};
const runCallbackParams: Record<string, number[]> = {};
// DEFECT 2 self-dispatch (env-gated A/B): the map is ALWAYS discovered (so the
// template count is reported), but only THREADED into ctx when
// CODEGRAPH_SELF_DISPATCH=1 — OFF reproduces the pre-2d baseline recall.
const SELF_DISPATCH_ENABLED = process.env.CODEGRAPH_SELF_DISPATCH === "1";
const runSelfDispatchMethods: SelfDispatchMethod[] = [];
let runSelfDispatchTemplates: Record<string, string> = {};
let runSelfInstantiatingClassMethods: string[] = [];

// Macro-provenance: union of short-names declared by REAL `method` /
// `singleton_method` AST nodes across all ruby files. A miss member NOT in this
// set but present in the symbol table is macro/DSL-synthesised (attr_*,
// associations, route helpers, delegate, enum, aasm, …).
const realDefShortNames = new Set<string>();

function collectRealDefNames(root: AstNode): void {
  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "method" || node.type === "singleton_method") {
      const ns = rbNameOf(node);
      if (ns && !Array.isArray(ns)) realDefShortNames.add(lastSegment(ns.name));
    }
    for (const c of node.children) stack.push(c);
  }
}

// sink.write mirror (provider.ts:748-879), ruby-only, no DuckDB.
function ingestPass1(extraction: FileExtraction, materializedRoot: AstNode): void {
  const defs: SymbolDefinition[] = extraction.chunks.map((c) => ({
    symbolId: c.symbolId,
    fqName: c.symbolId,
    shortName: lastSegment(c.symbolId),
    relPath: extraction.relPath,
    scope: c.scope,
    ...(c.arity !== undefined ? { arity: c.arity } : {}),
    ...(c.visibility !== undefined ? { visibility: c.visibility } : {}),
    ...(c.kwargs !== undefined ? { kwargs: c.kwargs } : {}),
    ...(c.acceptsBlock !== undefined ? { acceptsBlock: c.acceptsBlock } : {}),
  }));
  symbolTable.upsertFile(extraction.relPath, defs);
  if (extraction.classAncestors)
    for (const [k, v] of Object.entries(extraction.classAncestors)) runAncestors[k] = v;
  if (extraction.compactDeclaredClasses) for (const fq of extraction.compactDeclaredClasses) runCompactClasses.add(fq);
  if (extraction.classPrependedAncestors)
    for (const [k, v] of Object.entries(extraction.classPrependedAncestors)) runPrependedAncestors[k] = v;
  if (extraction.classExtends) for (const [k, v] of Object.entries(extraction.classExtends)) runExtends[k] = v;
  if (extraction.functionReturnTypes)
    for (const [k, v] of Object.entries(extraction.functionReturnTypes)) runReturnTypes[k] = v;
  if (extraction.ivarTypes) for (const [k, v] of Object.entries(extraction.ivarTypes)) runIvarTypes[k] = v;
  if (extraction.structuredReturnTypes)
    for (const [k, v] of Object.entries(extraction.structuredReturnTypes)) runStructuredReturnTypes[k] = v;
  if (extraction.instantiatedTypes) for (const t of extraction.instantiatedTypes) runInstantiatedTypes.add(t);
  const inheritanceRows = normalizeInheritanceEdges(extraction, () => null);
  if (inheritanceRows.length > 0) runInheritanceRows.push(...inheritanceRows);
  if (extraction.dispatchTables) {
    for (const [name, table] of Object.entries(extraction.dispatchTables)) {
      const arr = (runDispatchTables[name] ??= []);
      const at = arr.findIndex((d) => d.relPath === extraction.relPath);
      if (at >= 0) arr[at] = { relPath: extraction.relPath, table };
      else arr.push({ relPath: extraction.relPath, table });
    }
  }
  if (extraction.callbackParams)
    for (const [symbolId, indices] of Object.entries(extraction.callbackParams)) runCallbackParams[symbolId] = indices;
  runSelfDispatchMethods.push(...extractSelfDispatchMethods(extraction.chunks));
  collectRealDefNames(materializedRoot);
}

// ---------------------------------------------------------------------------
// Tally state (mirrors runStats + per-kind kindTally + languageKindTally).
// ---------------------------------------------------------------------------
type KindTally = { attempted: number; resolved: number; unresolvable: number; externalSkipped: number; noInProjectDef: number };
const emptyKind = (): KindTally => ({ attempted: 0, resolved: 0, unresolvable: 0, externalSkipped: 0, noInProjectDef: 0 });
const kindTally: Record<ReceiverKind, KindTally> = Object.fromEntries(
  RECEIVER_KINDS.map((k) => [k, emptyKind()]),
) as Record<ReceiverKind, KindTally>;
let callsAttempted = 0;
let callsResolved = 0;
let callsUnresolvable = 0;
let callsExternalSkipped = 0;
let callsNoInProjectDef = 0;
// DEFECT-2 signal: distinct in-project method symbolIds that RECEIVE ≥1 edge.
// DEFECT-2 redirects an entry `Const.member` from the shared template node to the
// concrete `Const#hook`, so ON adds hook targets that had get_callers()==[] OFF —
// the true recall win (invisible to callsResolved, which counts the entry either way).
const resolvedTargets = new Set<string>();

interface MissRecord {
  member: string;
  receiver: string | null;
  receiverKind: ReceiverKind;
  relPath: string;
  line: number;
  enclosingScope: string;
  callerSymbolId: string;
  defCount: number;
  category: string;
  callerFramework: string;
  callerTop: string;
  defPaths: string[];
}
const misses: MissRecord[] = [];

// Ruby core / Enumerable / ActiveRecord relation short-names. When one of these
// leaks into a recall hole it means an UNTYPED receiver whose member ALSO has a
// project homonym def — the external classifier's `lookupByShortName===0` gate is
// defeated by the homonym. Not a resolver bug, a homonym-pollution artefact.
const CORE_HOMONYMS = new Set([
  "each", "map", "select", "reject", "reduce", "inject", "to_s", "to_a", "to_h",
  "to_sym", "to_i", "first", "last", "merge", "merge!", "join", "fetch", "include?",
  "includes", "key?", "keys", "values", "count", "sum", "min", "max", "sort",
  "sort_by", "group_by", "flatten", "compact", "uniq", "find", "detect", "any?",
  "all?", "none?", "present?", "blank?", "dig", "push", "pop", "freeze", "dup",
  "then", "tap", "pluck", "where", "order", "as_json", "call", "new", "match?",
]);

function callerFrameworkOf(relPath: string): string {
  if (relPath.startsWith("db/migrate") || relPath.startsWith("db/data")) return "migration-schema";
  if (relPath.includes("/contracts/")) return "dry-validation(contracts)";
  if (relPath.includes("/chewy/") || relPath.endsWith("_index.rb")) return "chewy(index)";
  if (relPath.includes("/serializers/")) return "AMS(serializer)";
  if (relPath.includes("/exporters/")) return "csv-exporter(DSL)";
  if (relPath.includes("/graphql/")) return "graphql";
  if (relPath.includes("/forms/")) return "form-object";
  if (relPath.includes("/policies/")) return "policy";
  if (relPath.includes("/decorators/") || relPath.includes("/presenters/")) return "decorator/presenter";
  return "app";
}

// resolveExtraction PASS-2 mirror (provider.ts:2003-2145). ctx literal is
// copied VERBATIM incl. this session's additions (callerSymbolId,
// compactDeclaredClasses, gemfileContent).
function resolvePass2(extraction: FileExtraction): void {
  const ancestorsForResolver = Object.keys(runAncestors).length > 0 ? runAncestors : extraction.classAncestors;
  const prependedAncestorsForResolver =
    Object.keys(runPrependedAncestors).length > 0 ? runPrependedAncestors : extraction.classPrependedAncestors;
  const includedByForResolver = buildIncludedBy(ancestorsForResolver ?? {}, prependedAncestorsForResolver ?? {});
  const extendsForResolver = Object.keys(runExtends).length > 0 ? runExtends : extraction.classExtends;
  const returnTypesForResolver =
    Object.keys(runReturnTypes).length > 0 ? runReturnTypes : extraction.functionReturnTypes;
  const instantiatedForResolver =
    runInstantiatedTypes.size > 0 ? runInstantiatedTypes : new Set(extraction.instantiatedTypes ?? []);
  const ivarTypesForResolver = Object.keys(runIvarTypes).length > 0 ? runIvarTypes : extraction.ivarTypes;
  const structuredReturnTypesForResolver =
    Object.keys(runStructuredReturnTypes).length > 0 ? runStructuredReturnTypes : extraction.structuredReturnTypes;

  for (const chunk of extraction.chunks) {
    for (const call of chunk.calls) {
      callsAttempted += 1;
      const receiverKind = classifyReceiverKind(call, chunk.localBindings);
      kindTally[receiverKind].attempted += 1;
      const ctx: CallContext = {
        callerFile: extraction.relPath,
        callerScope: chunk.scope,
        callerSymbolId: chunk.symbolId,
        imports: extraction.imports,
        symbolTable,
        classFieldTypes: extraction.classFieldTypes,
        associationTypes: extraction.associationTypes,
        localBindings: chunk.localBindings,
        localCallBindings: chunk.localCallBindings,
        functionReturnTypes: returnTypesForResolver,
        ivarTypes: ivarTypesForResolver,
        structuredReturnTypes: structuredReturnTypesForResolver,
        classAncestors: ancestorsForResolver,
        compactDeclaredClasses: runCompactClasses,
        gemfileContent,
        classPrependedAncestors: prependedAncestorsForResolver,
        includedBy: includedByForResolver,
        classExtends: extendsForResolver,
        dispatchTables: runDispatchTables,
        callbackParams: runCallbackParams,
        hierarchy: hierarchyView,
        instantiatedTypes: instantiatedForResolver,
        selfDispatchTemplates: SELF_DISPATCH_ENABLED ? runSelfDispatchTemplates : undefined,
        selfInstantiatingClassMethods: SELF_DISPATCH_ENABLED ? runSelfInstantiatingClassMethods : undefined,
      };
      let resolved = false;
      const noteDispatch = (out: DispatchFanoutOutcome | undefined): boolean => {
        const edges = out?.kind === "edges" ? out.edges : [];
        for (const edge of edges) if (edge.targetSymbolId !== null) resolvedTargets.add(edge.targetSymbolId);
        return edges.length > 0;
      };
      if (call.dispatch) {
        if (noteDispatch(resolver.resolveDispatch?.(call, ctx))) resolved = true;
      } else if (call.dispatchArgs && call.dispatchArgs.length > 0) {
        const target = resolver.resolve(call, ctx);
        if (target) {
          resolved = true;
          if (target.targetSymbolId !== null) resolvedTargets.add(target.targetSymbolId);
        }
        if (noteDispatch(resolver.resolveDispatch?.(call, ctx))) resolved = true;
      } else {
        const out = resolver.resolveDispatch?.(call, ctx);
        if (noteDispatch(out)) {
          resolved = true;
        } else {
          const target = resolver.resolve(call, ctx);
          if (target) {
            resolved = true;
            if (target.targetSymbolId !== null) resolvedTargets.add(target.targetSymbolId);
          }
        }
      }

      if (resolved) {
        callsResolved += 1;
        kindTally[receiverKind].resolved += 1;
      } else if (call.dynamicSend === true) {
        callsUnresolvable += 1;
        kindTally[receiverKind].unresolvable += 1;
      } else if (resolver.targetsExternalImport?.(call, ctx) ?? false) {
        callsExternalSkipped += 1;
        kindTally[receiverKind].externalSkipped += 1;
      } else if (symbolTable.lookupByShortName(call.member).length === 0) {
        callsNoInProjectDef += 1;
        kindTally[receiverKind].noInProjectDef += 1;
      } else {
        // THE RECALL HOLE: unresolved, non-dynamic, non-external, has in-project def.
        recordMiss(call, receiverKind, extraction.relPath, chunk.scope, chunk.symbolId);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Miss categorisation (gap taxonomy).
// ---------------------------------------------------------------------------
function isConcernDef(d: SymbolDefinition): boolean {
  if (/\/concerns\//.test(d.relPath)) return true;
  // enclosing module namespace of the def (everything before last #/.)
  const fq = d.fqName;
  const cut = Math.max(fq.lastIndexOf("#"), fq.lastIndexOf("."));
  const ns = cut === -1 ? fq : fq.slice(0, cut);
  // module included-by-consensus somewhere?
  return ns.length > 0 && Object.prototype.hasOwnProperty.call(includedBy, ns);
}

function categorize(member: string, defs: SymbolDefinition[]): string {
  // Priority: pure DSL-synth (no real def anywhere) → concern → helper →
  // ≥2-def collision → single real def. `macroDeclared` is count-independent
  // and checked FIRST because it points at a missing DSL grammar, not a
  // narrowing failure.
  if (!realDefShortNames.has(member)) return "macroDeclared";
  const concern = defs.filter(isConcernDef).length;
  const helper = defs.filter((d) => /\/helpers\//.test(d.relPath)).length;
  if (concern > 0 && concern * 2 >= defs.length) return "concernScope";
  if (helper > 0 && helper * 2 >= defs.length) return "helperModule";
  if (defs.length >= 2) return "trueCollision";
  return "singleDefOther";
}

function recordMiss(
  call: CallRef,
  receiverKind: ReceiverKind,
  relPath: string,
  scope: string[],
  callerSymbolId: string,
): void {
  const defs = symbolTable.lookupByShortName(call.member);
  misses.push({
    member: call.member,
    receiver: call.receiver,
    receiverKind,
    relPath,
    line: call.startLine,
    enclosingScope: scope.join(" > "),
    callerSymbolId,
    defCount: defs.length,
    category: categorize(call.member, defs),
    callerFramework: callerFrameworkOf(relPath),
    callerTop: relPath.split("/").slice(0, 2).join("/"),
    defPaths: [...new Set(defs.map((d) => d.relPath))].slice(0, 4),
  });
}

// ===========================================================================
// G0 VTA ORACLE (spec docs/superpowers/specs/2026-07-10-vta-oracle-gate-design.md)
// A fold over the SAME materialized AST + symbol table the harness already
// builds. No re-extraction, no resolver change. Only runs when CODEGRAPH_ORACLE=1.
// ===========================================================================

/**
 * Enumerable iterators whose block parameter's static type IS the receiver's
 * element type — the exact VTA relationship (`coll.each { |x| x.m }`: knowing
 * `coll`'s element type gives `x`, hence `x.m`'s target). Slightly over-inclusive
 * on the memo/index param of `inject`/`each_with_index` (matched by receiver
 * name) — the gate reads an UPPER BOUND, so over-inclusion is the safe direction.
 */
const ITERATOR_METHODS = new Set<string>([
  "each", "each_with_index", "each_with_object", "map", "map!", "flat_map", "collect", "collect_concat",
  "select", "select!", "filter", "filter_map", "reject", "reject!", "detect", "find", "find_all",
  "each_pair", "reduce", "inject", "sort_by", "min_by", "max_by", "group_by", "partition",
  "chunk_while", "slice_when", "each_slice", "each_cons", "take_while", "drop_while", "find_each",
  "find_in_batches", "in_batches", "count", "sum", "any?", "all?", "none?", "one?", "index_by",
]);

/**
 * ActiveRecord query-interface / relation-returning methods. A `coll.map(&:m)`
 * whose receiver TAIL is one of these is typed by G1's query-interface return-type
 * source (epic G1 = "AR association + query-interface return types"), so it is
 * G1-typable, NOT VTA-remainder. Crediting these to G1 keeps the VTA remainder
 * honest — the direction that never inflates the VTA gate.
 */
const QUERY_INTERFACE_TAILS = new Set<string>([
  "all", "where", "order", "reorder", "includes", "joins", "left_joins", "left_outer_joins",
  "preload", "eager_load", "references", "distinct", "limit", "offset", "group", "having",
  "select", "none", "unscoped", "except", "only", "not", "or", "and", "merge", "extending",
  "readonly", "from", "reselect", "rewhere", "regroup", "excluding", "ids", "pluck", "to_a",
]);

/** Class-body declaration macros counted as "hidden" when they sit inside a
 *  non-transparent `prepended do` block (D2). Bare-receiver form only. */
const CONCERN_BODY_MACROS = new Set<string>([
  "has_many", "has_one", "belongs_to", "has_and_belongs_to_many", "has_one_attached", "has_many_attached",
  "validates", "validate", "validates_with", "validates_each", "before_save", "after_save",
  "before_create", "after_create", "before_update", "after_update", "before_destroy", "after_destroy",
  "before_validation", "after_validation", "after_commit", "after_rollback", "before_action",
  "after_action", "around_action", "skip_before_action", "scope", "default_scope", "enum", "attribute",
  "attr_accessor", "attr_reader", "attr_writer", "delegate", "delegate_missing_to", "cattr_accessor",
  "mattr_accessor", "class_attribute", "serialize", "store", "store_accessor",
  "accepts_nested_attributes_for", "alias_method", "alias_attribute", "composed_of", "aasm",
  "state_machine", "acts_as_list", "acts_as_tree", "helper_method", "rescue_from", "after_initialize",
]);

interface OracleSite {
  member: string;
  receiverTail: string | null;
  relPath: string;
  line: number;
  startIndex: number;
}

const bucketA: OracleSite[] = []; // iterator block-param calls `x.m`
const bucketB: OracleSite[] = []; // `coll.map(&:m)` symbol-to-proc
const collectionAssocNames = new Set<string>(); // has_many / habtm accessor names, project-wide
const legacyExtendMembers = new Set<string>(); // class-method names reachable via legacy self.included+extend (D1)
let d1HookCount = 0;
const d2HiddenDefs: OracleSite[] = []; // method/singleton_method inside `prepended do`
const d2HiddenMacros: OracleSite[] = []; // DSL macro calls inside `prepended do`
let d2PrependedBlocks = 0;
const includedDoRanges = new Map<string, Array<[number, number]>>();
let includedDoBlockCount = 0;
const seenSite = new Set<string>(); // dedup A/B by relPath:startIndex

function isCallNode(n: AstNode): boolean {
  return n.type === "call" || n.type === "method_call";
}

function receiverTailOf(recv: AstNode | null): string | null {
  if (!recv) return null;
  const method = recv.childForFieldName("method");
  if (method) return method.text;
  if (recv.type === "scope_resolution") return recv.childForFieldName("name")?.text ?? recv.text;
  const t = recv.text;
  const dot = t.lastIndexOf(".");
  return dot === -1 ? t : t.slice(dot + 1);
}

function blockChildOf(callNode: AstNode): AstNode | null {
  const direct = callNode.children.find((c) => c.type === "block" || c.type === "do_block");
  if (direct) return direct;
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  return args?.namedChildren.find((c) => c.type === "block" || c.type === "do_block") ?? null;
}

function blockParamNames(block: AstNode): Set<string> {
  const out = new Set<string>();
  const params = block.childForFieldName("parameters") ?? block.namedChildren.find((c) => c.type === "block_parameters");
  if (!params) return out;
  const collect = (n: AstNode): void => {
    if (n.type === "identifier") {
      out.add(n.text);
      return;
    }
    if (n.type === "destructured_parameter") {
      for (const c of n.namedChildren) collect(c);
      return;
    }
    if (
      n.type === "optional_parameter" ||
      n.type === "keyword_parameter" ||
      n.type === "splat_parameter" ||
      n.type === "hash_splat_parameter" ||
      n.type === "block_parameter"
    ) {
      const name = n.childForFieldName("name");
      if (name?.type === "identifier") out.add(name.text);
    }
  };
  for (const c of params.namedChildren) collect(c);
  return out;
}

/** `&:m` symbol-to-proc arg → "m". Mirrors walker `extractBlockPassMethod`. */
function blockPassSymbol(callNode: AstNode): string | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  for (const arg of args.namedChildren) {
    if (arg.type !== "block_argument") continue;
    const child = arg.namedChildren[0];
    if (child?.type === "simple_symbol") return child.text.startsWith(":") ? child.text.slice(1) : child.text;
  }
  return null;
}

function firstSymbolArg(callNode: AstNode): string | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  const a = args?.namedChildren[0];
  if (a?.type === "simple_symbol") return a.text.startsWith(":") ? a.text.slice(1) : a.text;
  return null;
}

/** Within an iterator block, record every direct `param.m` call (bucket A). */
function collectBlockParamCalls(block: AstNode, params: Set<string>, relPath: string): void {
  const stack: AstNode[] = [block];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (isCallNode(n)) {
      const recv = n.childForFieldName("receiver");
      const method = n.childForFieldName("method");
      if (recv && recv.type === "identifier" && params.has(recv.text) && method) {
        const key = `${relPath}:${n.startIndex}:A`;
        if (!seenSite.has(key)) {
          seenSite.add(key);
          bucketA.push({ member: method.text, receiverTail: recv.text, relPath, line: n.startPosition.row + 1, startIndex: n.startIndex });
        }
      }
    }
    for (const c of n.children) stack.push(c);
  }
}

/** Method defs + DSL macros inside a non-transparent `prepended do` block (D2). */
function collectPrependedHidden(block: AstNode, relPath: string): void {
  const stack: AstNode[] = [block];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === "method" || n.type === "singleton_method") {
      const nm = n.childForFieldName("name")?.text ?? "?";
      d2HiddenDefs.push({ member: nm, receiverTail: null, relPath, line: n.startPosition.row + 1, startIndex: n.startIndex });
      continue; // don't descend into the def body
    }
    if (isCallNode(n) && !n.childForFieldName("receiver")) {
      const m = n.childForFieldName("method")?.text;
      if (m && CONCERN_BODY_MACROS.has(m))
        d2HiddenMacros.push({ member: m, receiverTail: null, relPath, line: n.startPosition.row + 1, startIndex: n.startIndex });
    }
    for (const c of n.children) stack.push(c);
  }
}

/** Legacy Concern surface: `def self.included(base); base.extend(X); end` (D1). */
function scanLegacyExtendHook(hook: AstNode, fileRoot: AstNode): void {
  const params = hook.childForFieldName("parameters");
  const paramName =
    params?.namedChildren.find((c) => c.type === "identifier")?.text ?? params?.namedChildren[0]?.text;
  const body = hook.childForFieldName("body");
  if (!body) return;
  const extendedConsts: string[] = [];
  const bstack: AstNode[] = [body];
  while (bstack.length > 0) {
    const n = bstack.pop()!;
    if (isCallNode(n) && n.childForFieldName("method")?.text === "extend") {
      const recv = n.childForFieldName("receiver");
      if (recv && (paramName === undefined || recv.text === paramName || recv.type === "self")) {
        const args = n.childForFieldName("arguments") ?? n.children.find((c) => c.type === "argument_list");
        for (const a of args?.namedChildren ?? []) {
          if (a.type === "constant") extendedConsts.push(a.text);
          else if (a.type === "scope_resolution") extendedConsts.push(a.childForFieldName("name")?.text ?? a.text);
        }
      }
    }
    for (const c of n.children) bstack.push(c);
  }
  if (extendedConsts.length === 0) return;
  d1HookCount += 1;
  for (const cst of extendedConsts) collectModuleMethodNames(fileRoot, cst, legacyExtendMembers);
}

/** Method names defined directly under a `module <last>` in this file. */
function collectModuleMethodNames(fileRoot: AstNode, moduleConst: string, out: Set<string>): void {
  const last = moduleConst.split("::").pop()!;
  const stack: AstNode[] = [fileRoot];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === "module" || n.type === "class") {
      const nm = n.childForFieldName("name");
      const nmText = nm?.type === "scope_resolution" ? (nm.childForFieldName("name")?.text ?? nm.text) : nm?.text;
      if (nmText === last) {
        const dstack: AstNode[] = [n];
        while (dstack.length > 0) {
          const d = dstack.pop()!;
          if (d !== n && (d.type === "class" || d.type === "module")) continue; // stay within this type
          if (d.type === "method" || d.type === "singleton_method") {
            const mn = d.childForFieldName("name")?.text;
            if (mn) out.add(mn);
            continue;
          }
          for (const c of d.children) dstack.push(c);
        }
      }
    }
    for (const c of n.children) stack.push(c);
  }
}

/** Single DFS over a file's materialized AST, populating every oracle bucket. */
function scanOracleAst(root: AstNode, relPath: string): void {
  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;

    if (isCallNode(node)) {
      const method = node.childForFieldName("method")?.text;
      const bareReceiver = !node.childForFieldName("receiver");

      // collection associations (has_many / habtm) → G1-typable name set
      if (bareReceiver && (method === "has_many" || method === "has_and_belongs_to_many")) {
        const acc = firstSymbolArg(node);
        if (acc) collectionAssocNames.add(acc);
      }

      // bucket A: iterator block-param calls
      if (method && ITERATOR_METHODS.has(method)) {
        const block = blockChildOf(node);
        if (block) {
          const params = blockParamNames(block);
          if (params.size > 0) collectBlockParamCalls(block, params, relPath);
        }
      }

      // bucket B: `&:m` symbol-to-proc
      const sym = blockPassSymbol(node);
      if (sym) {
        const key = `${relPath}:${node.startIndex}:B`;
        if (!seenSite.has(key)) {
          seenSite.add(key);
          bucketB.push({
            member: sym,
            receiverTail: receiverTailOf(node.childForFieldName("receiver")),
            relPath,
            line: node.startPosition.row + 1,
            startIndex: node.startIndex,
          });
        }
      }

      // D2 / D3: prepended do (hidden surface) + included do (transparent ranges)
      if (bareReceiver && method === "prepended") {
        const block = blockChildOf(node);
        if (block) {
          d2PrependedBlocks += 1;
          collectPrependedHidden(block, relPath);
        }
      } else if (bareReceiver && method === "included") {
        const block = blockChildOf(node);
        if (block) {
          const arr = includedDoRanges.get(relPath) ?? [];
          arr.push([block.startPosition.row + 1, block.endPosition.row + 1]);
          includedDoRanges.set(relPath, arr);
          includedDoBlockCount += 1;
        }
      }
    }

    // D1: legacy `def self.included(base); base.extend(X); end`
    if (node.type === "singleton_method" && node.childForFieldName("name")?.text === "included") {
      scanLegacyExtendHook(node, root);
    }

    for (const c of node.children) stack.push(c);
  }
}

function topN(sites: { member: string; relPath: string }[], key: "member" | "relPath", n = 10): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const s of sites) m.set(s[key], (m.get(s[key]) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
}

// Compute + emit the oracle report. Reads `misses` / `symbolTable` / `kindTally`
// populated by the standard PASS-2. `member has in-project def` is the oracle
// (would resolve if the element/receiver type were known perfectly).
function runOracle(elapsedMs: number, files: number): void {
  const L = (s: string) => console.log(s);
  const inProjectDef = (member: string): number => symbolTable.lookupByShortName(member).length;
  const missKey = new Set(misses.map((m) => `${m.relPath} ${m.line} ${m.member}`));
  const isMiss = (s: OracleSite): boolean => missKey.has(`${s.relPath} ${s.line} ${s.member}`);
  const inIncludedDo = (relPath: string, line: number): boolean =>
    (includedDoRanges.get(relPath) ?? []).some(([s, e]) => line >= s && line <= e);

  // ---- Bucket A: iterator block-param calls ----
  const aResolvable = bucketA.filter((s) => inProjectDef(s.member) > 0);
  const aMiss = aResolvable.filter(isMiss);

  // ---- Bucket B: symbol-to-proc, split G1-typable vs VTA-remainder ----
  const bResolvable = bucketB.filter((s) => inProjectDef(s.member) > 0);
  const isG1Typable = (s: OracleSite): boolean =>
    s.receiverTail !== null && (collectionAssocNames.has(s.receiverTail) || QUERY_INTERFACE_TAILS.has(s.receiverTail));
  const bG1 = bResolvable.filter(isG1Typable);
  const bRemainder = bResolvable.filter((s) => !isG1Typable(s));
  const bRemainderMiss = bRemainder.filter(isMiss);

  // ---- Bucket C: index-receiver recall holes (obj[k].m) ----
  const cSites = misses.filter((m) => m.receiverKind === "index");

  // ---- Bucket D1: legacy-extend addressable entries ----
  const d1Entries = misses.filter((m) => legacyExtendMembers.has(m.member));

  // ---- Bucket D3: bareCall misses inside `included do` ----
  const d3 = misses.filter((m) => m.receiverKind === "bareCall" && inIncludedDo(m.relPath, m.line));

  // ---- gate arithmetic ----
  const VTA_THRESHOLD = 5000;
  // spec-literal upper bound (member-has-in-project-def, monomorphic 1 edge/site)
  const vtaUpperBound = aResolvable.length + bRemainder.length + cSites.length;
  // honest new-recall bound (only sites that are ALSO currently unresolved) —
  // B `&:m` already emits a bareCall short-name edge (walker emitBlockPassEdge),
  // so many B/A sites already resolve ambiguously; VTA adds precision there, a
  // NEW edge only for the currently-missing subset.
  const vtaNewRecall = aMiss.length + bRemainderMiss.length + cSites.length;
  const verdict = vtaUpperBound >= VTA_THRESHOLD ? "IN" : "OUT";
  const d1Verdict = d1Entries.length > 500 ? "FILE (legacy-Concern grammar)" : "modern idiom only / negligible";
  const d2Total = d2HiddenDefs.length + d2HiddenMacros.length;
  const d2Verdict = d2Total > 100 ? "FILE (prepended-do transparency fix)" : "modern idiom only / negligible";

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      root: ROOT,
      files,
      symbols: symbolTable.size(),
      elapsedSec: +(elapsedMs / 1000).toFixed(1),
      resolverNote:
        "run against the live worktree resolver (may include other groups' uncommitted in-flight edits); A/B oracle edges are AST+symbolTable-derived and resolver-independent, C/D1/D3 are misses-derived and may shift marginally.",
      selfDispatch: SELF_DISPATCH_ENABLED,
      rawBucketSites: {
        A_iteratorBlockParamCalls: bucketA.length,
        B_symbolToProc: bucketB.length,
        collectionAssocNames: collectionAssocNames.size,
        d1LegacyExtendHooks: d1HookCount,
        d2PrependedDoBlocks: d2PrependedBlocks,
        includedDoBlocks: includedDoBlockCount,
      },
    },
    gate: {
      vtaThreshold: VTA_THRESHOLD,
      vtaUpperBoundEdges: vtaUpperBound,
      vtaNewRecallEdges: vtaNewRecall,
      breakdownUpperBound: { A: aResolvable.length, B_remainder: bRemainder.length, C: cSites.length },
      breakdownNewRecall: { A: aMiss.length, B_remainder: bRemainderMiss.length, C: cSites.length },
      verdict,
      verdictNote:
        verdict === "OUT"
          ? "Even the spec-literal upper bound is below 5000 → VTA-OUT; close wbj3 with this report."
          : "Upper bound >= 5000; check vtaNewRecallEdges — if that is < 5000 the win is precision not recall.",
      d1: { unresolvedEntries: d1Entries.length, threshold: 500, verdict: d1Verdict },
      d2: { hiddenDefsPlusMacros: d2Total, threshold: 100, verdict: d2Verdict },
      d3: { bareCallMisses: d3.length, note: "feeds vh0yh prioritization (not a gate)" },
    },
    buckets: {
      A: {
        desc: "coll.each { |x| x.m } — iterator block-param member calls",
        sites: bucketA.length,
        oracleEdges: aResolvable.length,
        currentlyMissEdges: aMiss.length,
        topMembers: topN(aResolvable, "member"),
        topFiles: topN(aResolvable, "relPath"),
      },
      B: {
        desc: "coll.map(&:m) — symbol-to-proc, split by G1 association/query-interface typability",
        sites: bucketB.length,
        oracleEdges: bResolvable.length,
        g1TypableEdges: bG1.length,
        vtaRemainderEdges: bRemainder.length,
        vtaRemainderCurrentlyMiss: bRemainderMiss.length,
        topMembersRemainder: topN(bRemainder, "member"),
        topFilesRemainder: topN(bRemainder, "relPath"),
        topReceiverTailsG1: (() => {
          const m = new Map<string, number>();
          for (const s of bG1) if (s.receiverTail) m.set(s.receiverTail, (m.get(s.receiverTail) ?? 0) + 1);
          return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
        })(),
      },
      C: {
        desc: "obj[k].m — index-receiver recall holes (missWithDef)",
        sites: cSites.length,
        edges: cSites.length,
        indexAttempted: kindTally.index.attempted,
        indexResolved: kindTally.index.resolved,
        topMembers: topN(cSites, "member"),
        topFiles: topN(cSites, "relPath"),
      },
      D1: {
        desc: "legacy `def self.included(base); base.extend(ClassMethods); end` addressable class-method entries",
        legacyExtendHooks: d1HookCount,
        addressableMembers: legacyExtendMembers.size,
        unresolvedEntries: d1Entries.length,
        topMembers: topN(d1Entries, "member"),
        topFiles: topN(d1Entries, "relPath"),
      },
      D2: {
        desc: "`prepended do` — hidden method defs + DSL macros (non-transparent block)",
        prependedDoBlocks: d2PrependedBlocks,
        hiddenDefs: d2HiddenDefs.length,
        hiddenMacros: d2HiddenMacros.length,
        topMembers: topN([...d2HiddenDefs, ...d2HiddenMacros], "member"),
        topFiles: topN([...d2HiddenDefs, ...d2HiddenMacros], "relPath"),
      },
      D3: {
        desc: "`included do` bareCall misses (feeds vh0yh)",
        includedDoBlocks: includedDoBlockCount,
        bareCallMisses: d3.length,
        topMembers: topN(d3, "member"),
        topFiles: topN(d3, "relPath"),
      },
    },
  };

  writeFileSync(OUT_ORACLE, JSON.stringify(report, null, 2));

  L("");
  L("═══════════════════════════════════════════════════════════════════");
  L("  G0 VTA ORACLE GATE");
  L("═══════════════════════════════════════════════════════════════════");
  L(`bucket A (iterator block-param):  sites=${bucketA.length}  oracleEdges=${aResolvable.length}  currMiss=${aMiss.length}`);
  L(`bucket B (&:sym symbol-to-proc):  sites=${bucketB.length}  oracleEdges=${bResolvable.length}  g1Typable=${bG1.length}  vtaRemainder=${bRemainder.length}  (remMiss=${bRemainderMiss.length})`);
  L(`bucket C (index obj[k].m):        sites=${cSites.length}  edges=${cSites.length}  (index attempted=${kindTally.index.attempted} resolved=${kindTally.index.resolved})`);
  L("");
  L(`VTA gate = A + B_remainder + C  (threshold ${VTA_THRESHOLD})`);
  L(`  upper bound   : ${aResolvable.length} + ${bRemainder.length} + ${cSites.length} = ${vtaUpperBound}  → VTA-${verdict}`);
  L(`  new-recall    : ${aMiss.length} + ${bRemainderMiss.length} + ${cSites.length} = ${vtaNewRecall}  (B &:sym already emits bareCall short-name edges — see report)`);
  L("");
  L(`D1 legacy-extend: hooks=${d1HookCount} addressableMembers=${legacyExtendMembers.size} unresolvedEntries=${d1Entries.length} (>500?) → ${d1Verdict}`);
  L(`D2 prepended do : blocks=${d2PrependedBlocks} hiddenDefs=${d2HiddenDefs.length} hiddenMacros=${d2HiddenMacros.length} total=${d2Total} (>100?) → ${d2Verdict}`);
  L(`D3 included do  : blocks=${includedDoBlockCount} bareCallMisses=${d3.length} (feeds vh0yh)`);
  L(`oracle report → ${OUT_ORACLE}`);
  L("");
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
let hierarchyView: MapHierarchyView;

function fmtPct(n: number): string {
  return (n * 100).toFixed(2) + "%";
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.error(`[forensics] root=${ROOT} gemfile=${gemfileContent ? "loaded" : "MISSING"}`);
  const files = discoverRubyFiles(ROOT);
  console.error(`[forensics] discovered ${files.length} ruby files (post test/generated/gitignore filter)`);

  // PASS-1: walk + populate symbol table + run-global maps.
  const extractions: FileExtraction[] = [];
  let parseFailures = 0;
  for (const relPath of files) {
    try {
      const code = readFileSync(join(ROOT, relPath), "utf8");
      const parser = new Parser();
      parser.setLanguage(rbConfig.loadParser());
      const nativeTree = parser.parse(code);
      const materializedRoot = materializeTree(nativeTree.rootNode, code);
      const materializedTree = { rootNode: materializedRoot };
      const chunks = collectSymbols(
        materializedTree,
        walker.nameOf,
        rbConfig.scopeSeparator,
        rbConfig.disambiguateOverloads ?? false,
        composer,
      );
      const extraction = walker.walk({
        tree: materializedTree,
        code,
        relPath,
        language: rbConfig.language,
        chunks,
        gemfileContent,
      });
      ingestPass1(extraction, materializedRoot);
      if (ORACLE_ENABLED) scanOracleAst(materializedRoot, relPath);
      extractions.push(extraction);
    } catch (err) {
      parseFailures += 1;
      if (process.env.DEBUG === "true") console.error(`[forensics] skip ${relPath}: ${(err as Error).message}`);
    }
  }
  console.error(
    `[forensics] pass-1 done: ${extractions.length} extractions, ${symbolTable.size()} symbols, ${parseFailures} parse failures`,
  );

  // BARRIER (provider.ts:898).
  hierarchyView = new MapHierarchyView(buildHierarchySnapshot(runInheritanceRows));
  includedBy = buildIncludedBy(runAncestors, runPrependedAncestors);
  // DEFECT 2 discovery (always built for the count; threaded into ctx only when enabled).
  runSelfDispatchTemplates = foldSelfDispatchTemplates(
    discoverSelfDispatchTemplates(runSelfDispatchMethods, buildSelfDispatchProbe(symbolTable, hierarchyView)),
  );
  runSelfInstantiatingClassMethods = collectSelfInstantiatingClassMethods(runSelfDispatchMethods);

  // PASS-2: resolve.
  for (const extraction of extractions) resolvePass2(extraction);

  // metrics (provider.ts:1161-1174).
  const internalAttempted = Math.max(1, callsAttempted - callsExternalSkipped - callsUnresolvable - callsNoInProjectDef);
  const resolveSuccessRate = callsAttempted === 0 ? 0 : callsResolved / internalAttempted;
  const missWithInProjectDef = Math.max(
    0,
    callsAttempted - callsResolved - callsExternalSkipped - callsUnresolvable - callsNoInProjectDef,
  );
  const recallDenominator = callsResolved + missWithInProjectDef;
  const inProjectEdgeRecall = recallDenominator === 0 ? 0 : callsResolved / recallDenominator;

  // ---- report ----
  const L = (s: string) => console.log(s);
  L("");
  L("═══════════════════════════════════════════════════════════════════");
  L("  TAXDOME RUBY CODEGRAPH — RECALL FORENSICS");
  L("═══════════════════════════════════════════════════════════════════");
  L(`files (ruby):            ${files.length}`);
  L(`extractions:             ${extractions.length}`);
  L(`symbols in table:        ${symbolTable.size()}`);
  L(`realDef short-names:     ${realDefShortNames.size}`);
  L(
    `selfDispatch:            ${SELF_DISPATCH_ENABLED ? "ON " : "off"}  templates=${Object.keys(runSelfDispatchTemplates).length}  (self-hook methods scanned=${runSelfDispatchMethods.length})`,
  );
  L(`distinct edge targets:   ${resolvedTargets.size}   <-- DEFECT-2 target-coverage signal`);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, `targets-${SELF_DISPATCH_ENABLED ? "on" : "off"}.json`),
    JSON.stringify([...resolvedTargets].sort(), null, 0),
  );
  writeFileSync(join(OUT_DIR, "self-dispatch-templates.json"), JSON.stringify(runSelfDispatchTemplates, null, 2));
  L("");
  L(`callsAttempted:          ${callsAttempted}`);
  L(`callsResolved:           ${callsResolved}`);
  L(`callsExternalSkipped:    ${callsExternalSkipped}`);
  L(`callsUnresolvable:       ${callsUnresolvable}`);
  L(`callsNoInProjectDef:     ${callsNoInProjectDef}`);
  L(`missWithInProjectDef:    ${missWithInProjectDef}   <-- RECALL HOLE`);
  L("");
  L(`resolveSuccessRate:      ${fmtPct(resolveSuccessRate)}`);
  L(`inProjectEdgeRecall:     ${fmtPct(inProjectEdgeRecall)}`);
  L("");
  L("─── byReceiverKind ────────────────────────────────────────────────");
  L("kind          attempted  resolved   rate     ext-skip  no-def   recallHole");
  for (const kind of RECEIVER_KINDS) {
    const t = kindTally[kind];
    const hole = t.attempted - t.resolved - t.externalSkipped - t.unresolvable - t.noInProjectDef;
    const rate = t.attempted === 0 ? 0 : t.resolved / t.attempted;
    L(
      `${kind.padEnd(12)}  ${String(t.attempted).padStart(8)}  ${String(t.resolved).padStart(8)}  ${fmtPct(rate).padStart(7)}  ${String(t.externalSkipped).padStart(8)}  ${String(t.noInProjectDef).padStart(6)}  ${String(hole).padStart(9)}`,
    );
  }
  L("");

  // ---- taxonomy over bareCall recall holes ----
  const bareHoles = misses.filter((m) => m.receiverKind === "bareCall");
  const catCounts: Record<string, MissRecord[]> = {};
  for (const m of bareHoles) (catCounts[m.category] ??= []).push(m);
  L("─── bareCall recall-hole taxonomy ─────────────────────────────────");
  L(`total bareCall recall holes: ${bareHoles.length}`);
  const CATS = ["concernScope", "macroDeclared", "helperModule", "trueCollision", "singleDefOther", "unknown"];
  for (const cat of CATS) {
    const arr = catCounts[cat] ?? [];
    L(`  ${cat.padEnd(16)} ${String(arr.length).padStart(6)}`);
  }
  L("");
  for (const cat of CATS) {
    const arr = catCounts[cat] ?? [];
    if (arr.length === 0) continue;
    L(`  ── ${cat} (${arr.length}) — top members ──`);
    const byMember: Record<string, MissRecord[]> = {};
    for (const m of arr) (byMember[m.member] ??= []).push(m);
    const ranked = Object.entries(byMember).sort((a, b) => b[1].length - a[1].length);
    for (const [member, ms] of ranked.slice(0, 8)) {
      const ex = ms[0];
      L(`     ${member} (x${ms.length})  e.g. ${ex.relPath}:${ex.line}  [defs:${ex.defCount} -> ${ex.defPaths[0] ?? "-"}]`);
    }
    L("");
  }

  // ---- cross-cut: framework concentration of ALL recall holes ----
  L("─── recall holes by CALLER framework (all receiverKinds) ──────────");
  const fw: Record<string, number> = {};
  for (const m of misses) fw[m.callerFramework] = (fw[m.callerFramework] ?? 0) + 1;
  for (const [k, n] of Object.entries(fw).sort((a, b) => b[1] - a[1])) L(`  ${String(n).padStart(6)}  ${k}`);
  L("");

  // ---- cross-cut: core/stdlib homonym share ----
  const coreHomonym = misses.filter((m) => CORE_HOMONYMS.has(m.member));
  const migrationHoles = misses.filter((m) => m.callerFramework === "migration-schema");
  const dslCallerHoles = misses.filter((m) =>
    ["dry-validation(contracts)", "chewy(index)", "AMS(serializer)", "csv-exporter(DSL)", "graphql"].includes(
      m.callerFramework,
    ),
  );
  L("─── actionable cross-cuts over recall holes ───────────────────────");
  L(`  core/Enumerable/AR homonyms:   ${coreHomonym.length}  (untyped-receiver core calls w/ project homonym)`);
  L(`  migration-schema (db/migrate): ${migrationHoles.length}  (t.datetime/t.integer... — arguably exclude db/migrate)`);
  L(`  external-DSL caller context:   ${dslCallerHoles.length}  (dry/chewy/AMS/exporter/graphql homonyms)`);
  L(
    `  => explained-by-homonym share: ${(((coreHomonym.length + dslCallerHoles.length + migrationHoles.length) / Math.max(1, misses.length)) * 100).toFixed(1)}% of all recall holes`,
  );
  L("");

  // whole-miss member frequency across ALL receiverKinds (for pattern spotting).
  const allByMember: Record<string, number> = {};
  for (const m of misses) allByMember[m.member] = (allByMember[m.member] ?? 0) + 1;
  L("─── top 25 miss members (all receiverKinds) ───────────────────────");
  for (const [member, n] of Object.entries(allByMember).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    L(`  ${String(n).padStart(6)}  ${member}`);
  }
  L("");

  // taxdome-flavoured dir buckets over ALL misses (enterprise idiom spotting).
  const dirBuckets: Record<string, number> = {
    services: 0,
    forms: 0,
    operations: 0,
    queries: 0,
    serializers: 0,
    policies: 0,
    graphql: 0,
    decorators: 0,
    presenters: 0,
    interactors: 0,
    concerns: 0,
    helpers: 0,
    jobs: 0,
    controllers: 0,
    models: 0,
    other: 0,
  };
  for (const m of misses) {
    const p = (m.defPaths[0] ?? m.relPath).toLowerCase();
    let matched = false;
    for (const key of Object.keys(dirBuckets)) {
      if (key === "other") continue;
      if (p.includes(`/${key}/`) || p.includes(`/${key.replace(/s$/, "")}/`)) {
        dirBuckets[key] += 1;
        matched = true;
        break;
      }
    }
    if (!matched) dirBuckets.other += 1;
  }
  L("─── recall-hole DEFINITION-SITE dir buckets (enterprise idioms) ────");
  for (const [k, n] of Object.entries(dirBuckets).sort((a, b) => b[1] - a[1])) {
    if (n > 0) L(`  ${String(n).padStart(6)}  ${k}`);
  }
  L("");

  // ---- dump misses ----
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    meta: {
      root: ROOT,
      generatedAt: new Date().toISOString(),
      files: files.length,
      symbols: symbolTable.size(),
      callsAttempted,
      callsResolved,
      callsExternalSkipped,
      callsUnresolvable,
      callsNoInProjectDef,
      missWithInProjectDef,
      resolveSuccessRate,
      inProjectEdgeRecall,
      rubyOnly: true,
      note: "Ruby-only symbol table; cross-language short-name collisions may shift cg_run_stats cross-check slightly.",
    },
    byReceiverKind: Object.fromEntries(
      RECEIVER_KINDS.map((k) => {
        const t = kindTally[k];
        return [k, { ...t, recallHole: t.attempted - t.resolved - t.externalSkipped - t.unresolvable - t.noInProjectDef }];
      }),
    ),
    bareCallTaxonomy: Object.fromEntries(CATS.map((c) => [c, (catCounts[c] ?? []).length])),
    misses,
  };
  writeFileSync(OUT_MISSES, JSON.stringify(payload, null, 2));
  L(`misses dumped: ${misses.length} -> ${OUT_MISSES}`);
  if (ORACLE_ENABLED) runOracle(Date.now() - t0, files.length);
  L(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

let includedBy: Record<string, string[]> = {};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
