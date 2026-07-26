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
  ChunkExtraction,
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
const OUT_DUCK = join(OUT_DIR, "duck-oracle-report.json");
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
// DUCK-TYPING DISAMBIGUATION ORACLE (2026-07-26). Same additive, env-gated
// contract as the G0 oracle above: with CODEGRAPH_DUCK_ORACLE unset the harness
// behaves byte-identically (no schema parse, no call-set collection, no extra
// report). Measures ONE hypothesis: an untyped receiver's SET of member calls
// inside its enclosing method identifies its class, because the members a class
// answers (schema columns + real defs + macro-synthesised accessors) are a
// near-signature. Nothing here touches the resolver — it is a fold over the same
// materialized AST + symbol table + miss set the harness already builds.
// ---------------------------------------------------------------------------
const DUCK_ENABLED = process.env.CODEGRAPH_DUCK_ORACLE === "1";

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
  if (DUCK_ENABLED) noteDuckDefs(defs);
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
      if (DUCK_ENABLED) noteDuckCall(call, receiverKind, extraction.relPath, chunk);
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

// ===========================================================================
// DUCK-TYPING DISAMBIGUATION ORACLE (CODEGRAPH_DUCK_ORACLE=1)
//
// Hypothesis under test: for an untyped receiver (bare identifier / @ivar), the
// SET of members called on it inside one method is a near-signature — score every
// candidate class by the IDF-weighted members it answers, and a unique winner with
// a margin IS the type. Sections mirror the task letters:
//   A schema member-sets   — db/schema.rb columns → per-table method names
//   B candidate index      — class → member set (schema ∪ defs ∪ 1-level ancestors)
//   C variable call-sets   — (file, method, receiver) → full member-call set
//   D duck scoring         — IDF sum, unique argmax + margin + coverage gate
//   E ground-truth accuracy— hide localBindings/ivarTypes type, predict, compare
//   F impact projection    — how many of the recall-hole misses the oracle covers
// ===========================================================================

const DUCK_MARGINS = [1.25, 1.5, 2.0] as const;
const DUCK_MIN_COVERAGE = 0.6;
/** Phase-1 accumulation cap: a member defined by more than this many classes is
 *  DEFERRED to the phase-2 exact rescore instead of enumerating its whole posting
 *  list per variable. It still scores — it just doesn't generate candidates. */
const DUCK_DF_ACCUMULATE_CAP = 5000;
/** Phase-2 exact rescore breadth (top-K by phase-1 score). Must be wide enough
 *  that the true runner-up is inside it — a truncated runner-up inflates the
 *  margin and fabricates confident wrong predictions. */
const DUCK_TOP_CANDIDATES = 256;
const DUCK_AR_BASE_CLASSES = new Set(["ApplicationRecord", "ActiveRecord::Base"]);
/** Receiver shapes the oracle treats as a "variable": bare identifier, @ivar, @@cvar. */
const DUCK_RECEIVER_RE = /^@{0,2}[a-z_][A-Za-z0-9_]*$/;

/**
 * Members EVERY ruby object answers (Object / Kernel / Enumerable / ActiveSupport
 * core_ext). They are a systematic trap for this mechanism, not neutral noise: an
 * AR model inherits `present?` from the framework, so its statically-derived member
 * set does NOT contain it — while a small in-project PORO that happens to `def
 * present?` DOES. The generic member therefore votes for the PORO and against the
 * model. The `strictCore` scoring variant drops them from the variable's member set
 * to measure how much of the error they cause. `CORE_HOMONYMS` (already in this
 * harness) is folded in; these are the additions it lacks.
 */
const DUCK_UNIVERSAL_MEMBERS = new Set<string>([
  ...CORE_HOMONYMS,
  "initialize", "inspect", "hash", "eql?", "equal?", "==", "!=", "<=>", "===", "=~",
  "nil?", "empty?", "size", "length", "class", "instance_of?", "is_a?", "kind_of?",
  "respond_to?", "send", "public_send", "__send__", "method", "methods", "object_id",
  "frozen?", "itself", "display", "to_proc", "to_str", "to_f", "to_d", "to_r", "to_c",
  "presence", "presence_in", "in?", "try", "try!", "deep_dup", "deep_symbolize_keys",
  "deep_stringify_keys", "symbolize_keys", "stringify_keys", "with_indifferent_access",
  "to_json", "to_xml", "to_param", "to_query", "instance_variable_get",
  "instance_variable_set", "instance_variables", "define_singleton_method", "extend",
  "clone", "hash?", "each_with_object", "each_with_index", "reverse", "slice", "values_at",
  "zip", "take", "drop", "step", "upto", "downto", "times", "round", "floor", "ceil", "abs",
]);

// ---- A. schema member-sets -------------------------------------------------

interface DuckSchemaTable {
  columns: string[];
  hasId: boolean;
  primaryKey: string | null;
}

/**
 * Parse `db/schema.rb` into table → column names. Deliberately regex-level (this
 * is a measurement script, not production): `create_table "x", … do |t|` opens a
 * table, `t.<type> "col"` adds a column, `end` closes it. `t.index` /
 * `t.check_constraint` are NOT columns. `id: false` drops the implicit `id`;
 * `primary_key: "v"` replaces it with `v`. `t.timestamps` expands to
 * created_at/updated_at (taxdome's schema uses explicit datetime columns, so this
 * branch is defensive).
 */
function parseSchemaTables(path: string): Map<string, DuckSchemaTable> {
  const out = new Map<string, DuckSchemaTable>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  const createRe = /^\s*create_table\s+"([^"]+)"([^\n]*)\bdo\s*\|/;
  const colRe = /^\s*t\.(\w+)\s+"([^"]+)"/;
  const NON_COLUMN = new Set(["index", "check_constraint", "constraint", "exclusion_constraint", "unique_constraint"]);
  let cur: DuckSchemaTable | null = null;
  for (const line of text.split(/\r?\n/)) {
    const created = createRe.exec(line);
    if (created) {
      const opts = created[2] ?? "";
      const pk = /primary_key:\s*"([^"]+)"/.exec(opts)?.[1] ?? null;
      cur = { columns: [], hasId: pk === null && !/\bid:\s*false\b/.test(opts), primaryKey: pk };
      if (pk) cur.columns.push(pk);
      out.set(created[1]!, cur);
      continue;
    }
    if (!cur) continue;
    if (/^\s*end\s*$/.test(line)) {
      cur = null;
      continue;
    }
    if (/^\s*t\.timestamps\b/.test(line)) {
      cur.columns.push("created_at", "updated_at");
      continue;
    }
    const col = colRe.exec(line);
    if (col && !NON_COLUMN.has(col[1]!)) cur.columns.push(col[2]!);
  }
  return out;
}

/** Column → the instance methods ActiveRecord synthesises for it: reader, writer,
 *  query. (Dirty-tracking `_was`/`_changed?` are NOT included — they would triple
 *  the member set for a member family that is rare at call sites.) */
function schemaMembersOf(table: DuckSchemaTable): string[] {
  const out: string[] = [];
  const add = (c: string): void => {
    out.push(c, `${c}=`, `${c}?`);
  };
  if (table.hasId) add("id");
  for (const c of table.columns) add(c);
  return out;
}

// ---- A. explicit `self.table_name` declarations (AST, PASS-1) --------------

const duckExplicitTableName = new Map<string, string>(); // class FQ → table

/**
 * DFS with a namespace stack recording `self.table_name = "x"` per enclosing
 * class. taxdome carries 344 of these in app/models — inflection alone would
 * mis-map every one of them, so the explicit declaration always wins.
 */
function scanTableNameDecls(node: AstNode, ns: string[]): void {
  for (const child of node.children) {
    if (child.type === "class" || child.type === "module") {
      const nameNode = child.childForFieldName("name");
      const raw = nameNode?.text ?? "";
      const segs = raw.replace(/^::/, "").split("::").filter((s) => s.length > 0);
      scanTableNameDecls(child, segs.length > 0 ? [...ns, ...segs] : ns);
      continue;
    }
    if (child.type === "assignment") {
      const lhs = child.childForFieldName("left");
      const rhs = child.childForFieldName("right");
      if (lhs && rhs && lhs.text.replace(/\s+/g, "") === "self.table_name" && ns.length > 0) {
        const lit = /^[:'"]([A-Za-z0-9_.]+)['"]?$/.exec(rhs.text.trim());
        if (lit) duckExplicitTableName.set(ns.join("::"), lit[1]!);
      }
    }
    scanTableNameDecls(child, ns);
  }
}

// ---- B. class → own member names (PASS-1, from the same defs the table gets) --

const duckClassOwnMembers = new Map<string, Set<string>>();

/** Split `Acme::Firm#save` / `Acme::Firm.find` into owner + member. Class/module
 *  chunks (no `#`/`.`) contribute no member — they only name a candidate. */
function noteDuckDefs(defs: SymbolDefinition[]): void {
  for (const d of defs) {
    const fq = d.fqName;
    const cut = Math.max(fq.lastIndexOf("#"), fq.lastIndexOf("."));
    if (cut <= 0) {
      if (!duckClassOwnMembers.has(fq)) duckClassOwnMembers.set(fq, new Set());
      continue;
    }
    const owner = fq.slice(0, cut);
    const member = fq.slice(cut + 1).replace(/~\d+$/, "");
    if (member.length === 0) continue;
    let set = duckClassOwnMembers.get(owner);
    if (!set) {
      set = new Set();
      duckClassOwnMembers.set(owner, set);
    }
    set.add(member);
  }
}

// ---- C. variable call-sets (PASS-2) ---------------------------------------

interface DuckVarCallSet {
  relPath: string;
  callerSymbolId: string;
  receiver: string;
  receiverKind: ReceiverKind;
  line: number;
  members: Set<string>;
  /** Statically-known type (ground truth), or null when the variable is untyped. */
  gtType: string | null;
  gtSource: string | null;
}

const duckVarSets = new Map<string, DuckVarCallSet>();

function duckKey(relPath: string, callerSymbolId: string, receiver: string): string {
  return `${relPath}|${callerSymbolId}|${receiver}`;
}

/**
 * Record one call against its receiver variable. The FULL member set is kept —
 * resolved, missed and external-looking alike — because the narrowing power comes
 * from the whole set, not from the miss subset (the miss-only intersection was
 * measured to collapse to empty).
 */
function noteDuckCall(call: CallRef, receiverKind: ReceiverKind, relPath: string, chunk: ChunkExtraction): void {
  const r = call.receiver;
  if (r === null || !DUCK_RECEIVER_RE.test(r)) return;
  const key = duckKey(relPath, chunk.symbolId, r);
  let group = duckVarSets.get(key);
  if (!group) {
    let gtType: string | null = null;
    let gtSource: string | null = null;
    if (r.startsWith("@")) {
      const t = runIvarTypes[chunk.scope.join("::")]?.[r];
      if (t !== undefined) {
        gtType = t;
        gtSource = "ivarTypes";
      }
    } else {
      const bindings = chunk.localBindings?.[r];
      if (bindings && bindings.length > 0) {
        const types = new Set(bindings.map((b) => b.type));
        if (types.size === 1) {
          gtType = [...types][0] ?? null;
          gtSource = "localBindings";
        } else {
          // Reassigned to a different type inside the method — "the" type is not
          // well-defined, so it is neither ground truth nor a patient.
          gtSource = "localBindings-multitype";
        }
      }
    }
    group = {
      relPath,
      callerSymbolId: chunk.symbolId,
      receiver: r,
      receiverKind,
      line: call.startLine,
      members: new Set(),
      gtType,
      gtSource,
    };
    duckVarSets.set(key, group);
  }
  group.members.add(call.member);
}

// ---- B. candidate member index (post-barrier) ------------------------------

interface DuckIndex {
  classes: string[];
  classMembers: Set<string>[];
  isArModel: boolean[];
  /** member → candidate class indices that answer it. */
  postings: Map<string, number[]>;
  idf: Map<string, number>;
  byLastSegment: Map<string, number[]>;
  mapping: {
    schemaTables: number;
    explicitTableName: number;
    tablesMappedExplicit: number;
    tablesMappedInflection: number;
    tablesAmbiguous: number;
    tablesUnmapped: number;
    unmappedSample: string[];
    arModels: number;
    arModelsWithTable: number;
  };
}

function duckLastSegment(fq: string): string {
  const i = fq.lastIndexOf("::");
  return i === -1 ? fq : fq.slice(i + 2);
}

/** Naive Rails singularize — enough for schema table names (measurement script). */
function duckSingularize(word: string): string {
  const IRREGULAR: Record<string, string> = {
    people: "person",
    children: "child",
    men: "man",
    women: "woman",
    data: "datum",
    statuses: "status",
    taxes: "tax",
    indices: "index",
    matrices: "matrix",
  };
  const known = IRREGULAR[word];
  if (known) return known;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(?:xes|ses|shes|ches|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function duckCamelize(snake: string): string {
  return snake
    .split("_")
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/** Transitive superclass walk over the run-global `classExtends`, asking whether
 *  the chain reaches ApplicationRecord / ActiveRecord::Base. */
function duckIsArModel(fq: string): boolean {
  let cur: string | undefined = fq;
  for (let i = 0; i < 12 && cur !== undefined; i += 1) {
    const parent: string | undefined = runExtends[cur];
    if (parent === undefined) return false;
    if (DUCK_AR_BASE_CLASSES.has(parent)) return true;
    cur = parent;
  }
  return false;
}

function buildDuckIndex(): DuckIndex {
  const schema = parseSchemaTables(join(ROOT, "db/schema.rb"));

  // Candidate universe: every namespace that owns ≥1 def in the symbol table.
  const classes = [...duckClassOwnMembers.keys()];
  const classIndex = new Map<string, number>();
  classes.forEach((c, i) => classIndex.set(c, i));
  const isArModel = classes.map((c) => duckIsArModel(c));

  // table → owning class. Explicit `self.table_name` first; inflection only for
  // tables no declaration claims.
  const byLastSegment = new Map<string, number[]>();
  classes.forEach((c, i) => {
    const seg = duckLastSegment(c);
    const arr = byLastSegment.get(seg);
    if (arr) arr.push(i);
    else byLastSegment.set(seg, [i]);
  });

  const tableOfClass = new Map<number, string>();
  let tablesMappedExplicit = 0;
  const claimedTables = new Set<string>();
  for (const [cls, table] of duckExplicitTableName) {
    const idx = classIndex.get(cls);
    if (idx === undefined) continue;
    tableOfClass.set(idx, table);
    if (schema.has(table) && !claimedTables.has(table)) {
      claimedTables.add(table);
      tablesMappedExplicit += 1;
    }
  }

  let tablesMappedInflection = 0;
  let tablesAmbiguous = 0;
  const unmapped: string[] = [];
  for (const table of schema.keys()) {
    if (claimedTables.has(table)) continue;
    const guess = duckCamelize(duckSingularize(table));
    const hits = (byLastSegment.get(guess) ?? []).filter((i) => isArModel[i] && !tableOfClass.has(i));
    if (hits.length === 1) {
      tableOfClass.set(hits[0]!, table);
      tablesMappedInflection += 1;
    } else if (hits.length > 1) {
      // Ambiguous (same demodulized name in two namespaces) — assign none rather
      // than fabricate columns on the wrong model.
      tablesAmbiguous += 1;
    } else {
      unmapped.push(table);
    }
  }

  // Member sets: own defs (real + macro-synthesised) ∪ schema columns (AR models)
  // ∪ ONE level of included-module / superclass members. One level only: the
  // full MRO closure would smear every ApplicationRecord concern over all 400
  // models and destroy the discriminative power the mechanism depends on.
  const classMembers: Set<string>[] = classes.map((c, i) => {
    const set = new Set(duckClassOwnMembers.get(c) ?? []);
    for (const anc of runAncestors[c] ?? []) for (const m of duckClassOwnMembers.get(anc) ?? []) set.add(m);
    const sup = runExtends[c];
    if (sup !== undefined) for (const m of duckClassOwnMembers.get(sup) ?? []) set.add(m);
    const table = tableOfClass.get(i);
    if (table !== undefined) {
      const t = schema.get(table);
      if (t) for (const m of schemaMembersOf(t)) set.add(m);
    }
    return set;
  });

  const postings = new Map<string, number[]>();
  for (let i = 0; i < classes.length; i += 1) {
    for (const m of classMembers[i]!) {
      const arr = postings.get(m);
      if (arr) arr.push(i);
      else postings.set(m, [i]);
    }
  }
  const total = Math.max(1, classes.length);
  const idf = new Map<string, number>();
  for (const [m, arr] of postings) idf.set(m, Math.log(total / arr.length));

  let arModelsWithTable = 0;
  for (let i = 0; i < classes.length; i += 1) if (isArModel[i] && tableOfClass.has(i)) arModelsWithTable += 1;

  return {
    classes,
    classMembers,
    isArModel,
    postings,
    idf,
    byLastSegment,
    mapping: {
      schemaTables: schema.size,
      explicitTableName: duckExplicitTableName.size,
      tablesMappedExplicit,
      tablesMappedInflection,
      tablesAmbiguous,
      tablesUnmapped: unmapped.length,
      unmappedSample: unmapped.slice(0, 15),
      arModels: isArModel.filter(Boolean).length,
      arModelsWithTable,
    },
  };
}

// ---- D. duck scoring -------------------------------------------------------

interface DuckPrediction {
  classIdx: number;
  score: number;
  runnerUpScore: number;
  margin: number;
  coverage: number;
  scorableMembers: number;
  /** Classes that scored > 0 in phase 1. `1` ⇒ the margin is unopposed, not earned. */
  candidatePool: number;
}

/**
 * score(C) = Σ_{m ∈ V, m scorable} idf(m)·[m ∈ members(C)]. Members no candidate
 * class defines (core/stdlib/gem calls) are IGNORED — they carry no signal and
 * must not veto a candidate. Returns the argmax + the runner-up so the caller can
 * apply a margin; the FIRING rule (unique argmax, margin, coverage) lives in
 * `duckFires` so margin sensitivity is one parameter.
 */
function duckPredict(members: Set<string>, idx: DuckIndex, exclude?: ReadonlySet<string>): DuckPrediction | null {
  const scorable: string[] = [];
  for (const m of members) if (idx.postings.has(m) && !(exclude?.has(m) ?? false)) scorable.push(m);
  if (scorable.length === 0) return null;

  // Phase 1 — accumulate EXACT partial scores over every member within the DF cap
  // (rarest first). Ultra-common members are deferred to phase 2 so a single
  // `to_s` does not enumerate half the corpus; if every member is ultra-common the
  // rarest one still accumulates, so the variable is never silently dropped.
  scorable.sort((a, b) => (idx.postings.get(a)?.length ?? 0) - (idx.postings.get(b)?.length ?? 0));
  const seedScores = new Map<number, number>();
  let accumulated = 0;
  for (const m of scorable) {
    const posting = idx.postings.get(m)!;
    if (posting.length > DUCK_DF_ACCUMULATE_CAP && accumulated > 0) break;
    const w = idx.idf.get(m) ?? 0;
    for (const c of posting) seedScores.set(c, (seedScores.get(c) ?? 0) + w);
    accumulated += 1;
  }
  if (seedScores.size === 0) return null;

  const ranked = [...seedScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, DUCK_TOP_CANDIDATES)
    .map(([c]) => c);

  let best = -1;
  let bestScore = 0;
  let bestHits = 0;
  let secondScore = 0;
  for (const c of ranked) {
    const memberSet = idx.classMembers[c]!;
    let score = 0;
    let hits = 0;
    for (const m of scorable) {
      if (!memberSet.has(m)) continue;
      score += idx.idf.get(m) ?? 0;
      hits += 1;
    }
    if (score > bestScore) {
      secondScore = bestScore;
      best = c;
      bestScore = score;
      bestHits = hits;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  if (best === -1 || bestScore <= 0) return null;
  return {
    classIdx: best,
    score: bestScore,
    runnerUpScore: secondScore,
    margin: secondScore <= 0 ? Number.POSITIVE_INFINITY : bestScore / secondScore,
    coverage: bestHits / scorable.length,
    scorableMembers: scorable.length,
    candidatePool: seedScores.size,
  };
}

function duckFires(p: DuckPrediction | null, margin: number): boolean {
  return p !== null && p.margin >= margin && p.coverage >= DUCK_MIN_COVERAGE;
}

// ---- E/F. report -----------------------------------------------------------

function duckTop<T>(items: T[], key: (t: T) => string, n = 10): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

interface DuckGtBucket {
  predicted: number;
  correctStrict: number;
  correctLastSeg: number;
  wrong: number;
  silent: number;
}

interface DuckImpactBucket {
  misses: number;
  byReceiverKind: Record<string, number>;
  predictedArModel: number;
  predictedOther: number;
  blockParamSlice: number;
  nonBlockParamSlice: number;
  variables: number;
  /** Sub-slice where the SET actually did the work (see `duckIsNarrowing`). */
  missesNarrowing: number;
  variablesNarrowing: number;
}

/**
 * "Genuine narrowing": ≥2 members voted AND ≥2 candidate classes were in play. The
 * complement is a variable whose single member is answered by exactly one class —
 * a win the hypothesis does not need (it is plain unique-name lookup, not
 * duck-typing), so it must be reported apart or the mechanism looks stronger than
 * the idea being tested actually is.
 */
function duckIsNarrowing(p: DuckPrediction): boolean {
  return p.scorableMembers >= 2 && p.candidatePool >= 2;
}

interface DuckVariantResult {
  groundTruth: Record<
    string,
    { all: DuckGtBucket; resolvable: DuckGtBucket; multiMember: DuckGtBucket; narrowing: DuckGtBucket }
  >;
  gtMultiMemberPool: number;
  confusionTop: { name: string; count: number }[];
  confusionExamples: Record<string, unknown>[];
  impact: Record<string, DuckImpactBucket>;
  patientFiringCoverage: Record<string, { allPatients: number; blockParamLike: number; nonBlockParam: number }>;
  topPredictedClasses: { name: string; count: number }[];
  diagnostics: { groundTruth: Record<string, number>; patients: Record<string, number> };
}

const duckEmptyGt = (): DuckGtBucket => ({
  predicted: 0,
  correctStrict: 0,
  correctLastSeg: 0,
  wrong: 0,
  silent: 0,
});

const duckEmptyImpact = (): DuckImpactBucket => ({
  misses: 0,
  byReceiverKind: {},
  predictedArModel: 0,
  predictedOther: 0,
  blockParamSlice: 0,
  nonBlockParamSlice: 0,
  variables: 0,
  missesNarrowing: 0,
  variablesNarrowing: 0,
});

const duckIsBlockParamLike = (recv: string | null): boolean =>
  recv !== null && !recv.startsWith("@") && recv.length <= 2;

/**
 * Run E (ground-truth accuracy) + F (impact projection) for one scoring variant.
 * `exclude` is the member-name veto list — `undefined` is the spec-literal scoring
 * (every member votes), `DUCK_UNIVERSAL_MEMBERS` is the `strictCore` sensitivity
 * run that drops framework-universal members.
 */
function evaluateDuckVariant(
  idx: DuckIndex,
  gtGroups: DuckVarCallSet[],
  gtResolvable: DuckVarCallSet[],
  patients: DuckVarCallSet[],
  missesOnPatients: MissRecord[],
  patientByKey: Map<string, DuckVarCallSet>,
  isGtResolvable: (g: DuckVarCallSet) => boolean,
  exclude: ReadonlySet<string> | undefined,
): DuckVariantResult {
  const predOf = new Map<DuckVarCallSet, DuckPrediction | null>();
  for (const g of gtGroups) predOf.set(g, duckPredict(g.members, idx, exclude));
  for (const g of patients) if (!predOf.has(g)) predOf.set(g, duckPredict(g.members, idx, exclude));

  // ---- E. ground-truth accuracy ----
  const groundTruth: DuckVariantResult["groundTruth"] = {};
  const confusion = new Map<string, number>();
  const confusionExamples: Record<string, unknown>[] = [];

  for (const margin of DUCK_MARGINS) {
    const all = duckEmptyGt();
    const resolvable = duckEmptyGt();
    const multi = duckEmptyGt();
    const narrowing = duckEmptyGt();
    for (const g of gtGroups) {
      const p = predOf.get(g) ?? null;
      const fires = duckFires(p, margin);
      const isResolvable = isGtResolvable(g);
      const bump = (b: DuckGtBucket, ok: boolean, okLast: boolean): void => {
        if (!fires) {
          b.silent += 1;
          return;
        }
        b.predicted += 1;
        if (ok) b.correctStrict += 1;
        if (okLast) b.correctLastSeg += 1;
        else b.wrong += 1;
      };
      let ok = false;
      let okLast = false;
      if (fires && p) {
        const predicted = idx.classes[p.classIdx]!;
        const gt = g.gtType!.replace(/^::/, "");
        ok = predicted === gt;
        okLast = ok || duckLastSegment(predicted) === duckLastSegment(gt);
        if (!okLast && margin === 1.5) {
          const k = `${gt} → ${predicted}`;
          confusion.set(k, (confusion.get(k) ?? 0) + 1);
          if (confusionExamples.length < 12)
            confusionExamples.push({
              at: `${g.relPath}:${g.line}`,
              receiver: g.receiver,
              groundTruth: gt,
              gtSource: g.gtSource,
              predicted,
              score: +p.score.toFixed(2),
              runnerUp: +p.runnerUpScore.toFixed(2),
              coverage: +p.coverage.toFixed(2),
              candidatePool: p.candidatePool,
              members: [...g.members].slice(0, 12),
            });
        }
      }
      bump(all, ok, okLast);
      if (isResolvable) bump(resolvable, ok, okLast);
      if (isResolvable && g.members.size >= 2) bump(multi, ok, okLast);
      if (isResolvable && fires && p && duckIsNarrowing(p)) bump(narrowing, ok, okLast);
    }
    groundTruth[String(margin)] = { all, resolvable, multiMember: multi, narrowing };
  }

  // ---- F. impact projection over the recall holes ----
  const impact: Record<string, DuckImpactBucket> = {};
  for (const margin of DUCK_MARGINS) {
    const b = duckEmptyImpact();
    const firedVars = new Set<DuckVarCallSet>();
    const narrowingVars = new Set<DuckVarCallSet>();
    for (const m of missesOnPatients) {
      const g = patientByKey.get(duckKey(m.relPath, m.callerSymbolId, m.receiver!))!;
      const p = predOf.get(g) ?? null;
      if (!duckFires(p, margin)) continue;
      b.misses += 1;
      firedVars.add(g);
      if (duckIsNarrowing(p!)) {
        b.missesNarrowing += 1;
        narrowingVars.add(g);
      }
      b.byReceiverKind[m.receiverKind] = (b.byReceiverKind[m.receiverKind] ?? 0) + 1;
      if (idx.isArModel[p!.classIdx]) b.predictedArModel += 1;
      else b.predictedOther += 1;
      if (duckIsBlockParamLike(m.receiver)) b.blockParamSlice += 1;
      else b.nonBlockParamSlice += 1;
    }
    b.variables = firedVars.size;
    b.variablesNarrowing = narrowingVars.size;
    impact[String(margin)] = b;
  }

  const patientBlockParam = patients.filter((g) => duckIsBlockParamLike(g.receiver));
  const patientNonBlockParam = patients.filter((g) => !duckIsBlockParamLike(g.receiver));
  const coverageAt = (margin: number, pool: DuckVarCallSet[]): number =>
    pool.filter((g) => duckFires(predOf.get(g) ?? null, margin)).length;

  const shape = (pool: DuckVarCallSet[]): Record<string, number> => {
    const fired = pool.map((g) => predOf.get(g) ?? null).filter((p): p is DuckPrediction => duckFires(p, 1.5));
    const sizes = fired.map((p) => idx.classMembers[p.classIdx]!.size).sort((a, b) => a - b);
    const varSizes = fired.map((p) => p.scorableMembers).sort((a, b) => a - b);
    return {
      fired: fired.length,
      unopposedMargin: fired.filter((p) => !Number.isFinite(p.margin)).length,
      singleCandidatePool: fired.filter((p) => p.candidatePool <= 1).length,
      winnerMemberSetP50: sizes[Math.floor(sizes.length / 2)] ?? 0,
      winnerMemberSetP90: sizes[Math.floor(sizes.length * 0.9)] ?? 0,
      varScorableMembersP50: varSizes[Math.floor(varSizes.length / 2)] ?? 0,
    };
  };

  return {
    groundTruth,
    gtMultiMemberPool: gtResolvable.filter((g) => g.members.size >= 2).length,
    confusionTop: [...confusion.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count })),
    confusionExamples,
    impact,
    patientFiringCoverage: Object.fromEntries(
      DUCK_MARGINS.map((m) => [
        String(m),
        {
          allPatients: coverageAt(m, patients),
          blockParamLike: coverageAt(m, patientBlockParam),
          nonBlockParam: coverageAt(m, patientNonBlockParam),
        },
      ]),
    ),
    topPredictedClasses: duckTop(
      patients.filter((g) => duckFires(predOf.get(g) ?? null, 1.5)),
      (g) => idx.classes[predOf.get(g)!.classIdx]!,
      15,
    ),
    diagnostics: { groundTruth: shape(gtResolvable), patients: shape(patients) },
  };
}

function runDuckOracle(): void {
  const L = (s: string): void => console.log(s);
  const t0 = Date.now();
  const idx = buildDuckIndex();

  const groups = [...duckVarSets.values()];
  const gtGroups = groups.filter((g) => g.gtType !== null);
  const patients = groups.filter((g) => g.gtType === null && g.gtSource === null);

  const classKnown = (typeName: string): number | null => {
    const norm = typeName.replace(/^::/, "");
    const exact = idx.classes.indexOf(norm);
    if (exact !== -1) return exact;
    const hits = idx.byLastSegment.get(duckLastSegment(norm)) ?? [];
    return hits.length > 0 ? hits[0]! : null;
  };
  const resolvableSet = new Set(gtGroups.filter((g) => classKnown(g.gtType!) !== null));
  const gtResolvable = [...resolvableSet];

  const patientByKey = new Map<string, DuckVarCallSet>();
  for (const g of patients) patientByKey.set(duckKey(g.relPath, g.callerSymbolId, g.receiver), g);
  const missesOnPatients = misses.filter((m) =>
    m.receiver !== null ? patientByKey.has(duckKey(m.relPath, m.callerSymbolId, m.receiver)) : false,
  );

  const spec = evaluateDuckVariant(
    idx,
    gtGroups,
    gtResolvable,
    patients,
    missesOnPatients,
    patientByKey,
    (g) => resolvableSet.has(g),
    undefined,
  );
  const strictCore = evaluateDuckVariant(
    idx,
    gtGroups,
    gtResolvable,
    patients,
    missesOnPatients,
    patientByKey,
    (g) => resolvableSet.has(g),
    DUCK_UNIVERSAL_MEMBERS,
  );

  const memberSetSizeHist: Record<string, number> = {};
  for (const g of patients) {
    const k = g.members.size >= 6 ? "6+" : String(g.members.size);
    memberSetSizeHist[k] = (memberSetSizeHist[k] ?? 0) + 1;
  }
  const gtSourceHist: Record<string, number> = {};
  for (const g of groups) gtSourceHist[g.gtSource ?? "untyped"] = (gtSourceHist[g.gtSource ?? "untyped"] ?? 0) + 1;

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      root: ROOT,
      elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
      totalMisses: misses.length,
      candidateClasses: idx.classes.length,
      minCoverage: DUCK_MIN_COVERAGE,
      margins: DUCK_MARGINS,
      dfAccumulateCap: DUCK_DF_ACCUMULATE_CAP,
      topCandidates: DUCK_TOP_CANDIDATES,
      note:
        "Measurement only — no resolver/production change. Member sets = schema columns ∪ symbol-table defs (real + macro-synthesised) ∪ ONE level of included-module/superclass members. Two scoring variants: `spec` (every member votes, as specified) and `strictCore` (framework-universal members dropped).",
    },
    mapping: idx.mapping,
    population: {
      variableCallSets: groups.length,
      groundTruthTyped: gtGroups.length,
      groundTruthResolvableToCandidate: gtResolvable.length,
      groundTruthResolvableMultiMember: spec.gtMultiMemberPool,
      patientsUntyped: patients.length,
      gtSourceHistogram: gtSourceHist,
      patientMemberSetSizeHistogram: memberSetSizeHist,
      patientBlockParamLike: patients.filter((g) => duckIsBlockParamLike(g.receiver)).length,
      patientNonBlockParam: patients.filter((g) => !duckIsBlockParamLike(g.receiver)).length,
      missesOnPatientVariables: missesOnPatients.length,
      // How much ground truth the ivar channel could have supplied at all: if the
      // walker recorded no ivar type facts for this corpus, every GT sample comes
      // from localBindings and @ivar-receiver precision stays UNVALIDATED.
      ivarTypeFactClasses: Object.keys(runIvarTypes).length,
      ivarTypeFactEntries: Object.values(runIvarTypes).reduce((n, m) => n + Object.keys(m).length, 0),
      patientIvarReceivers: patients.filter((g) => g.receiver.startsWith("@")).length,
    },
    variants: { spec, strictCore },
  };
  writeFileSync(OUT_DUCK, JSON.stringify(report, null, 2));

  const pct = (a: number, b: number): string => (b === 0 ? "n/a" : `${((a / b) * 100).toFixed(1)}%`);
  L("");
  L("═══════════════════════════════════════════════════════════════════");
  L("  DUCK-TYPING DISAMBIGUATION ORACLE");
  L("═══════════════════════════════════════════════════════════════════");
  L(
    `schema tables=${idx.mapping.schemaTables}  explicit self.table_name=${idx.mapping.explicitTableName}  ` +
      `mapped(explicit)=${idx.mapping.tablesMappedExplicit} mapped(inflection)=${idx.mapping.tablesMappedInflection} ` +
      `ambiguous=${idx.mapping.tablesAmbiguous} unmapped=${idx.mapping.tablesUnmapped}`,
  );
  L(
    `candidate classes=${idx.classes.length}  AR models=${idx.mapping.arModels}  AR models with a table=${idx.mapping.arModelsWithTable}`,
  );
  L(
    `variable call-sets=${groups.length}  GT-typed=${gtGroups.length} (candidate-resolvable ${gtResolvable.length}, of them ≥2 members ${spec.gtMultiMemberPool})  patients=${patients.length}  misses on patients=${missesOnPatients.length}/${misses.length}`,
  );

  for (const [variantName, v] of [
    ["spec (every member votes)", spec],
    ["strictCore (framework-universal members dropped)", strictCore],
  ] as [string, DuckVariantResult][]) {
    L("");
    L(`══ VARIANT: ${variantName} ══`);
    L("─── E. ground-truth accuracy (type hidden, predicted from the call-set) ───");
    L("margin   pool                 pred   ok(FQ)  ok(lastSeg)  precision  coverage");
    for (const margin of DUCK_MARGINS) {
      const rows: [string, DuckGtBucket, number][] = [
        ["all-GT", v.groundTruth[String(margin)]!.all, gtGroups.length],
        ["GT→known class", v.groundTruth[String(margin)]!.resolvable, gtResolvable.length],
        ["GT known, ≥2 members", v.groundTruth[String(margin)]!.multiMember, v.gtMultiMemberPool],
        ["GT known, NARROWING", v.groundTruth[String(margin)]!.narrowing, gtResolvable.length],
      ];
      for (const [label, b, poolSize] of rows) {
        L(
          `${String(margin).padEnd(7)}  ${label.padEnd(20)} ${String(b.predicted).padStart(5)}  ` +
            `${String(b.correctStrict).padStart(6)}  ${String(b.correctLastSeg).padStart(11)}  ` +
            `${pct(b.correctLastSeg, b.predicted).padStart(9)}  ${pct(b.predicted, poolSize).padStart(8)}`,
        );
      }
    }
    L("");
    L("─── F. impact projection over the recall holes ────────────────────");
    L("margin   misses  vars   AR-model  other   blockParam(e/t)  non-blockParam   narrowingMisses/vars");
    for (const margin of DUCK_MARGINS) {
      const b = v.impact[String(margin)]!;
      L(
        `${String(margin).padEnd(7)}  ${String(b.misses).padStart(6)}  ${String(b.variables).padStart(5)}  ` +
          `${String(b.predictedArModel).padStart(8)}  ${String(b.predictedOther).padStart(5)}  ` +
          `${String(b.blockParamSlice).padStart(15)}  ${String(b.nonBlockParamSlice).padStart(14)}   ` +
          `${String(b.missesNarrowing).padStart(9)}/${b.variablesNarrowing}`,
      );
    }
    L(
      `  receiverKind @1.5: ${Object.entries(v.impact["1.5"]!.byReceiverKind)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k}=${n}`)
        .join("  ")}`,
    );
    L(
      `  diagnostics @1.5 (GT pool): fired=${v.diagnostics.groundTruth.fired} unopposed=${v.diagnostics.groundTruth.unopposedMargin} ` +
        `winnerMemberSet p50=${v.diagnostics.groundTruth.winnerMemberSetP50} p90=${v.diagnostics.groundTruth.winnerMemberSetP90} ` +
        `varScorableMembers p50=${v.diagnostics.groundTruth.varScorableMembersP50}`,
    );
    L("  top confusions @1.5 (GT → predicted):");
    for (const { name, count } of v.confusionTop) L(`    ${String(count).padStart(5)}  ${name}`);
  }
  L("");
  L(`duck oracle report → ${OUT_DUCK}`);
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
      if (DUCK_ENABLED && code.includes("table_name")) scanTableNameDecls(materializedRoot, []);
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
  if (DUCK_ENABLED) runDuckOracle();
  L(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

let includedBy: Record<string, string[]> = {};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
