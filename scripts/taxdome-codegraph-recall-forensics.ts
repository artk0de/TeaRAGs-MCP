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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, relative } from "node:path";

import ignore, { type Ignore } from "ignore";
import Parser from "tree-sitter";

import type { AstNode } from "../src/core/contracts/types/ast.js";
import {
  resolveLocalBinding,
  resolveLocalBindingType,
  type AritySignature,
  type CallContext,
  type CallRef,
  type ChunkExtraction,
  type ClassFieldParamLink,
  type DispatchFanoutOutcome,
  type DispatchTableDef,
  type FileExtraction,
  type InheritanceEdgeRow,
  type KnownTargetCallArgs,
  type KwargSignature,
  type LocalBinding,
  type SymbolDefinition,
  type SymbolResolutionTarget,
} from "../src/core/contracts/types/codegraph.js";
import type { RubyTypeRef } from "../src/core/contracts/types/language.js";
import { BUILTIN_IGNORE_PATTERNS } from "../src/core/domains/ingest/pipeline/ignore-defaults.js";
import { collectSymbols, DefaultSymbolIdComposer, LanguageFactory } from "../src/core/domains/language/index.js";
import {
  ArityNarrower,
  BlockNarrower,
  DuckVocabularyNarrower,
  KwargNarrower,
  LiteralReceiverNarrower,
  VisibilityNarrower,
  type DispatchCandidateNarrower,
} from "../src/core/domains/language/kernel/dispatch-narrowing.js";
import { dispatchFanoutPolicyFor } from "../src/core/domains/language/kernel/fanout-policy.js";
import type { RubyDslCatalogue } from "../src/core/domains/language/ruby/dsl/index.js";
import { catalogueForGemfile } from "../src/core/domains/language/ruby/gemfile.js";
import { RUBY_DUCK_VOCAB } from "../src/core/domains/language/ruby/resolver/strategies/ruby-duck-vocabulary.js";
import { classifyRubyLiteralReceiver } from "../src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.js";
import { RUBY_RUNTIME_HOOKS } from "../src/core/domains/language/ruby/resolver/strategies/ruby-super.js";
import {
  collectAncestorChain,
  collectResolvedAncestorChain,
  firstDefinerAfter,
  isRubyPath,
  resolveConstant,
  resolveTypeInstanceMethod,
  resolveTypeStaticMethod,
} from "../src/core/domains/language/ruby/resolver/strategies/shared.js";
import {
  boundCallReturnType,
  ivarTypeName,
  returnTypeOf,
} from "../src/core/domains/language/ruby/resolver/type-propagation.js";
import { forEachClassScope, readScopeResolution } from "../src/core/domains/language/ruby/walker/ast-utils.js";
import { rbNameOf } from "../src/core/domains/language/ruby/walker/index.js";
import { constantLookupCandidates } from "../src/core/domains/language/ruby/walker/param-arg-types.js";
import {
  constInstanceType,
  RUBY_BLOCK_ITERATOR_METHODS,
} from "../src/core/domains/language/ruby/walker/type-sources/ast-inference.js";
import { buildCodegraphExclusionFilter } from "../src/core/domains/trajectory/codegraph/exclusion.js";
import { MapHierarchyView } from "../src/core/domains/trajectory/codegraph/hierarchy-view.js";
import {
  deriveClassFieldTypesFromParams,
  foldKnownTargetParamTypes,
  mergeDerivedClassFieldTypes,
  seedParamLocalBindings,
  type KnownTargetParamTypes,
} from "../src/core/domains/trajectory/codegraph/symbols/call-arg-param-types.js";
import {
  buildHierarchySnapshot,
  normalizeInheritanceEdges,
} from "../src/core/domains/trajectory/codegraph/symbols/inheritance-edges.js";
import { buildIncludedBy, CODEGRAPH_LANGUAGES } from "../src/core/domains/trajectory/codegraph/symbols/provider.js";
import {
  classifyReceiverKind,
  RECEIVER_KINDS,
  type ReceiverKind,
} from "../src/core/domains/trajectory/codegraph/symbols/receiver-kind.js";
import {
  collectSchemaColumnModels,
  synthesizeSchemaColumnDefs,
} from "../src/core/domains/trajectory/codegraph/symbols/schema-column-synthesis.js";
import {
  buildSelfDispatchProbe,
  collectSelfInstantiatingClassMethods,
  deriveServiceEntryReturnTypes,
  discoverSelfDispatchTemplates,
  extractSelfDispatchMethods,
  foldSelfDispatchTemplates,
  type SelfDispatchMethod,
} from "../src/core/domains/trajectory/codegraph/symbols/self-dispatch-discovery.js";
import { InMemoryGlobalSymbolTable } from "../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { materializeTree } from "../src/core/infra/materialize.js";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
const ROOT = process.env.TAXDOME_ROOT ?? join(homedir(), "Dev/Job/taxdome");
// Report/dump destination. Overridable so two sessions can run the harness
// concurrently without overwriting each other's `taxdome-misses.json`.
const OUT_DIR = process.env.CODEGRAPH_FORENSICS_OUT ?? "/Users/artk0re/.claude/jobs/24baee70/tmp";
const OUT_MISSES = join(OUT_DIR, "taxdome-misses.json");
const OUT_ORACLE = join(OUT_DIR, "g0-oracle-report.json");
const OUT_DUCK = join(OUT_DIR, "duck-oracle-report.json");
const OUT_FIXPOINT = join(OUT_DIR, "fixpoint-oracle-report.json");
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
// INTERPROCEDURAL FIXPOINT ORACLE (bd tea-rags-mcp-a2hrq, 2026-07-27). Third
// oracle under the SAME additive, env-gated contract as the two above: with
// CODEGRAPH_FIXPOINT_ORACLE unset nothing extra is scanned, iterated or
// reported, so the A/B recall metrics are byte-identical. Measures ONE number:
// the ADDRESSABLE CEILING of a worklist fixpoint over the type environment
// (params ← call-site args ← locals/ivars ← return types ← params). Everything
// here is a read-only SIMULATION over the same materialized AST + extractions +
// symbol table the harness already builds; the propagation rules are the REAL
// exported ones (`returnTypeOf` / `ivarTypeName` / `boundCallReturnType` /
// `resolveLocalBinding`) and the agreement fold is the REAL `bvalc` fold, so the
// simulation cannot drift from production semantics.
// ---------------------------------------------------------------------------
const FIXPOINT_ENABLED = process.env.CODEGRAPH_FIXPOINT_ORACLE === "1";

// ---------------------------------------------------------------------------
// TYPE-FACT QUALITY ORACLE (bd tea-rags-mcp-yt3im + tea-rags-mcp-h4hxh,
// 2026-07-27). Fourth oracle under the SAME additive, env-gated contract: with
// CODEGRAPH_TYPEFACT_ORACLE unset nothing extra is accumulated or reported and
// the A/B recall metrics are byte-identical. It measures the two UPSTREAM
// type-fact defects the 1g7kz member-lookup forensics named, BEFORE either is
// implemented in src/:
//
//   (1) yt3im — a declared `@!method self.x` `@return` whose type name resolves
//       to NO project class (an annotation fiction) sits at the `Klass.member`
//       coordinate, which `declaredReturnTypeOn` reads FIRST for a class
//       receiver, while the j9xpf derive writes the CORRECT type at
//       `Klass#member` and its skip-guard only ever inspects that other form.
//       Probe: how many `.`-form facts are fictional, how many of those have a
//       derived competitor at the sibling coordinate, and how many call sites
//       each one reaches.
//
//   (2) h4hxh — `returnTypeOf` step 4 answers from the FLAT, bare-name
//       `functionReturnTypes` map even when the receiver's class IS known, so
//       one `@return` on `Ns::Helper#authorize` types every `SomePolicy.authorize`
//       receiver in the corpus. Probe: the corpus-uniqueness census of the flat
//       map's keys, and the exact set of call sites where step 4 fires with a
//       fact whose owning class is NOT in the receiver's MRO.
//
// Everything here is a fold over run-global state the harness already builds.
// ---------------------------------------------------------------------------
const TYPEFACT_ENABLED = process.env.CODEGRAPH_TYPEFACT_ORACLE === "1";
/**
 * `localCallBindings` VALUE → number of binding sites carrying it, accumulated
 * over pass-1 when the oracle is on. The value is exactly what
 * {@link boundCallReturnType} keys on — `"Klass.call"` (scope-qualified) or
 * `"fetch"` (bare) — so the count IS the reach of the corresponding type fact.
 */
const tfBindingReach = new Map<string, number>();
/** `"<relPath>|<callerSymbolId>"` → that chunk's `localCallBindings`, so the
 *  oracle can replay a MISS's receiver through the channel that typed it. */
const tfChunkCallBindings = new Map<string, Record<string, string>>();
/** Every class/module FQ this run DECLARES — the existence predicate's corpus. */
const tfDeclaredConstants = new Set<string>();

// ---------------------------------------------------------------------------
// OWNER-QUALIFIED RETURN-FACT ORACLE (bd tea-rags-mcp-rwv3o, 2026-07-28). Same
// additive, env-gated contract as every oracle above: with
// CODEGRAPH_OWNERFACT_ORACLE unset nothing extra is accumulated or reported and
// the A/B recall metrics are byte-identical.
//
// It sizes the ONE population the h4hxh close deferred: `boundCallReturnType`'s
// BARE branch (`x = fetch(…)`, receiver has no type at all), which answers from
// the flat bare-name `functionReturnTypes` map. A read-time uniqueness gate there
// measured −758 honest edges and was rejected; the proposed fix is UPSTREAM —
// owner-qualified facts (`Klass#member`) the bare branch can consult through the
// CALLER's own class + MRO before falling back to the flat map.
//
// The probe answers, per bare-branch binding site:
//   (a) how many sites the flat map serves at all, split corpus-unique vs collided;
//   (b) of the collided ones, how many have an enclosing-class MRO carrying
//       EXACTLY ONE definer of that member — the addressable set, the number the
//       design must be sized to;
//   (c) of those, how many already carry an owner-qualified return fact today
//       (`structuredReturnTypes["<owner>#<member>"]`) — the immediately actionable
//       subset — and how many of those DISAGREE with the flat map's answer (the
//       corrections the change would make);
//   (d) how many bare bindings the flat map cannot serve at all (no fact for the
//       member anywhere) — the callee-return coverage hole (bd smvyk).
// Everything is a fold over run-global state pass-1 already built.
// ---------------------------------------------------------------------------
const OWNERFACT_ENABLED = process.env.CODEGRAPH_OWNERFACT_ORACLE === "1";

// ---------------------------------------------------------------------------
// CALLEE-RETURN SHAPE ORACLE (bd tea-rags-mcp-smvyk, 2026-07-28). Same additive,
// env-gated contract. The owner-fact oracle above ends at "1 926 binding sites
// reach a callee that has NO return fact at all"; this one asks WHY, by
// classifying the BODY SHAPE of each such callee and weighting the classes by
// the site reach they carry. The point is to fund inference extensions only
// where the numbers justify them — a shape carrying 12 sites is not worth a new
// silence gate to get wrong.
// ---------------------------------------------------------------------------
const CALLEESHAPE_ENABLED = process.env.CODEGRAPH_CALLEESHAPE_ORACLE === "1";

// ---------------------------------------------------------------------------
// NULLARY-RECEIVER ORACLE (bd tea-rags-mcp-pr7fu, 2026-07-28). Same additive,
// env-gated contract. The census's largest deferred tail is 1 800 dynamic/chain
// misses whose RECEIVER is a bare zero-arg method call on self — `current_client`
// in `current_client.foo`, not a local variable and not an assignment binding, so
// no channel types it today.
//
// The probe walks the miss set, resolves each such receiver name against the
// CALLER's MRO, and reports whether a single definer exists and whether an
// owner-qualified return fact is reachable for it. Where no fact exists it
// classifies the definer's body tail with the callee-shape classifier, so the
// same run says which inference extension would unlock how many misses — the
// demand side that funds bd smvyk.
// ---------------------------------------------------------------------------
const NULLARY_ENABLED = process.env.CODEGRAPH_NULLARY_ORACLE === "1";
/** `"<relPath>|<callerSymbolId>"` → the local-variable names bound in that chunk,
 *  so a receiver that IS a local can be excluded from the nullary population. */
const nlChunkLocals = new Map<string, Set<string>>();
/** One record per pass-1 chunk that carries `localCallBindings`, with the chunk's
 *  own enclosing scope — the key the bare branch would narrow by. */
const ofChunkBindings: {
  relPath: string;
  symbolId: string;
  scope: readonly string[];
  bindings: Record<string, string>;
}[] = [];

// ---------------------------------------------------------------------------
// SUPER-MISS ORACLE (bd tea-rags-mcp-lawlq.5, 2026-07-27). Fifth oracle under
// the SAME additive, env-gated contract: with CODEGRAPH_SUPER_ORACLE unset
// nothing extra is recorded or reported, so the A/B recall metrics stay
// byte-identical. Answers ONE question per unresolved `super` call-site that has
// an in-project def: WHERE did the ancestor walk lose the definer —
//   (a) the class has no `classAncestors` entry at all (ancestry is DSL-built /
//       runtime-built and the walker emitted no heritage edge),
//   (b) the entry exists but its ancestor VALUES are raw non-FQ text the
//       resolver's chain walk never canonicalizes (the definer is reachable only
//       through `collectResolvedAncestorChain`),
//   (c) the definer IS on the raw chain the resolver walked (a pin failure, not
//       a hierarchy gap),
//   (d) the definer exists in-project but on no ancestor at all (genuinely
//       runtime-built ancestry — the floor).
// Everything is a fold over the same ctx the real resolver was just handed, and
// the chain walks are the REAL exported ones, so the categorisation cannot drift
// from production semantics.
// ---------------------------------------------------------------------------
const SUPER_ORACLE_ENABLED = process.env.CODEGRAPH_SUPER_ORACLE === "1";
/** Hard cap on worklist waves; a run that hits it is reported as NON-converged. */
const FIXPOINT_MAX_WAVES = 20;
/** `bounded` drops the wide "any resolvable target" scope back to bvalc-shaped
 *  const-receiver + bare-call sites (runtime fallback; reported either way). */
const FIXPOINT_WIDE = process.env.CODEGRAPH_FIXPOINT_SCOPE !== "bounded";

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

/**
 * The file set the codegraph actually walks. MUST mirror what
 * `CodegraphEnrichmentProvider` admits in production
 * (`symbols/provider.ts` — same `buildCodegraphExclusionFilter`, same
 * `LanguageFactory`), or the harness measures a population the consumer never
 * sees.
 *
 * The `languageFactory` argument is NOT optional here even though the engine
 * accepts `undefined`: omitting it silently drops every language's own
 * non-application-code globs (Ruby's `db/migrate/**`, `db/data/**`,
 * `db/data_schema.rb` — bd tea-rags-mcp-biwbq), so the harness would walk ~939
 * Rails migration files production excludes and report their procedural
 * `t.<column>` builder calls as recall holes. That was the entire
 * "migration-schema" bucket (bd tea-rags-mcp-2l0pr).
 */
function discoverRubyFiles(root: string, languageFactory: LanguageFactory): string[] {
  const scannerFilter = buildScannerFilter(root);
  const codegraphFilter = buildCodegraphExclusionFilter({ excludeTests: true, customPatterns: [] }, languageFactory);
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
const { walker } = ruby;
const { resolver } = ruby;
const rbConfig = CODEGRAPH_LANGUAGES[RUBY_EXT];

const gemfileContent =
  process.env.FORCE_FULL_CATALOGUE === "1"
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
/** class FQ → explicit `self.table_name` (bd tea-rags-mcp-8l5fo, mirrors provider.ts). */
const runSchemaTables: Record<string, string> = {};
// bd tea-rags-mcp-1g7kz — the schema pre-pass's INPUT and OUTPUT, captured at the
// barrier so the typed-receiver member-lookup forensics can tell "this member is a
// column of a table nobody mapped onto this model" apart from "not a column at all".
// Measurement-only: nothing reads these on the resolve path.
const runSchemaColumnsByTable = new Map<string, Set<string>>();
const runSchemaMappedModels = new Set<string>();
let runSchemaModelNameForTable: ((table: string) => string) | undefined;
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
// Interprocedural param typing, Increment 1 (bd tea-rags-mcp-bvalc). Env-gated
// A/B like self-dispatch: pass-1 accumulation and the barrier fold ALWAYS run
// (so the derived counts are reported), but the products only reach ctx when
// CODEGRAPH_CTOR_PARAM_TYPES !== "0" — "0" reproduces the pre-bvalc baseline.
const CTOR_PARAM_TYPES_ENABLED = process.env.CODEGRAPH_CTOR_PARAM_TYPES !== "0";
const runKnownTargetCallArgs = new Map<string, KnownTargetCallArgs>();
const runParamNames: Record<string, readonly string[]> = {};
const runClassFieldParamLinks: Record<string, Record<string, ClassFieldParamLink>> = {};
const runTypedClassFields = new Set<string>();
let runParamTypes: KnownTargetParamTypes = {};
let runDerivedClassFieldTypes: Record<string, Record<string, string>> = {};

// Macro-provenance: union of short-names declared by REAL `method` /
// `singleton_method` AST nodes across all ruby files. A miss member NOT in this
// set but present in the symbol table is macro/DSL-synthesised (attr_*,
// associations, route helpers, delegate, enum, aasm, …).
const realDefShortNames = new Set<string>();

function collectRealDefNames(root: AstNode): void {
  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
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
  if (extraction.classAncestors) {
    for (const [k, v] of Object.entries(extraction.classAncestors)) runAncestors[k] = v;
  }
  if (extraction.compactDeclaredClasses) for (const fq of extraction.compactDeclaredClasses) runCompactClasses.add(fq);
  if (extraction.classPrependedAncestors) {
    for (const [k, v] of Object.entries(extraction.classPrependedAncestors)) runPrependedAncestors[k] = v;
  }
  if (extraction.classExtends) for (const [k, v] of Object.entries(extraction.classExtends)) runExtends[k] = v;
  if (extraction.classSchemaTables) {
    for (const [k, v] of Object.entries(extraction.classSchemaTables)) runSchemaTables[k] = v;
  }
  if (extraction.functionReturnTypes) {
    for (const [k, v] of Object.entries(extraction.functionReturnTypes)) runReturnTypes[k] = v;
  }
  if (extraction.ivarTypes) for (const [k, v] of Object.entries(extraction.ivarTypes)) runIvarTypes[k] = v;
  if (extraction.structuredReturnTypes) {
    for (const [k, v] of Object.entries(extraction.structuredReturnTypes)) runStructuredReturnTypes[k] = v;
  }
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
  if (extraction.callbackParams) {
    for (const [symbolId, indices] of Object.entries(extraction.callbackParams)) runCallbackParams[symbolId] = indices;
  }
  runSelfDispatchMethods.push(...extractSelfDispatchMethods(extraction.chunks));
  if (OWNERFACT_ENABLED || CALLEESHAPE_ENABLED || NULLARY_ENABLED) {
    for (const chunk of extraction.chunks) {
      if (NULLARY_ENABLED) {
        const names = new Set(Object.keys(chunk.localBindings ?? {}));
        for (const name of Object.keys(chunk.localCallBindings ?? {})) names.add(name);
        nlChunkLocals.set(`${extraction.relPath}|${chunk.symbolId}`, names);
      }
      if (chunk.localCallBindings === undefined) continue;
      ofChunkBindings.push({
        relPath: extraction.relPath,
        symbolId: chunk.symbolId,
        scope: chunk.scope,
        bindings: chunk.localCallBindings,
      });
    }
  }
  if (TYPEFACT_ENABLED) {
    for (const chunk of extraction.chunks) {
      if (chunk.scope.length > 0) tfDeclaredConstants.add(chunk.scope.join("::"));
      if (!chunk.symbolId.includes("#") && !chunk.symbolId.includes(".")) tfDeclaredConstants.add(chunk.symbolId);
      if (chunk.localCallBindings === undefined) continue;
      tfChunkCallBindings.set(`${extraction.relPath}|${chunk.symbolId}`, chunk.localCallBindings);
      for (const binding of Object.values(chunk.localCallBindings)) {
        tfBindingReach.set(binding, (tfBindingReach.get(binding) ?? 0) + 1);
      }
    }
  }
  // bd tea-rags-mcp-bvalc — interprocedural param typing accumulators.
  for (const record of extraction.knownTargetCallArgs ?? []) {
    runKnownTargetCallArgs.set(`${record.targets.join("|")} ${JSON.stringify(record.argTypes)}`, record);
  }
  for (const c of extraction.chunks) if (c.paramNames !== undefined) runParamNames[c.symbolId] = c.paramNames;
  for (const [fqClass, fields] of Object.entries(extraction.classFieldParamLinks ?? {})) {
    runClassFieldParamLinks[fqClass] = { ...runClassFieldParamLinks[fqClass], ...fields };
  }
  for (const [fqClass, fields] of Object.entries(extraction.classFieldTypes ?? {})) {
    for (const ivar of Object.keys(fields)) runTypedClassFields.add(`${fqClass}|${ivar}`);
  }
  collectRealDefNames(materializedRoot);
}

// ---------------------------------------------------------------------------
// Tally state (mirrors runStats + per-kind kindTally + languageKindTally).
// ---------------------------------------------------------------------------
type KindTally = {
  attempted: number;
  resolved: number;
  unresolvable: number;
  externalSkipped: number;
  noInProjectDef: number;
  coreAmbiguous: number;
};
const emptyKind = (): KindTally => ({
  attempted: 0,
  resolved: 0,
  unresolvable: 0,
  externalSkipped: 0,
  noInProjectDef: 0,
  coreAmbiguous: 0,
});
const kindTally: Record<ReceiverKind, KindTally> = Object.fromEntries(
  RECEIVER_KINDS.map((k) => [k, emptyKind()]),
) as Record<ReceiverKind, KindTally>;
let callsAttempted = 0;
let callsResolved = 0;
let callsUnresolvable = 0;
let callsExternalSkipped = 0;
let callsNoInProjectDef = 0;
// bd tea-rags-mcp-83cl7 — core-homonym misses carved out of the recall hole.
let callsCoreAmbiguous = 0;
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
  "each",
  "map",
  "select",
  "reject",
  "reduce",
  "inject",
  "to_s",
  "to_a",
  "to_h",
  "to_sym",
  "to_i",
  "first",
  "last",
  "merge",
  "merge!",
  "join",
  "fetch",
  "include?",
  "includes",
  "key?",
  "keys",
  "values",
  "count",
  "sum",
  "min",
  "max",
  "sort",
  "sort_by",
  "group_by",
  "flatten",
  "compact",
  "uniq",
  "find",
  "detect",
  "any?",
  "all?",
  "none?",
  "present?",
  "blank?",
  "dig",
  "push",
  "pop",
  "freeze",
  "dup",
  "then",
  "tap",
  "pluck",
  "where",
  "order",
  "as_json",
  "call",
  "new",
  "match?",
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

  // bd tea-rags-mcp-bvalc — derived ivar types ride the file's own channel.
  const classFieldTypesForResolver = CTOR_PARAM_TYPES_ENABLED
    ? mergeDerivedClassFieldTypes(extraction.classFieldTypes, runDerivedClassFieldTypes)
    : extraction.classFieldTypes;

  for (const chunk of extraction.chunks) {
    // bd tea-rags-mcp-bvalc — derived param types seeded at the def line.
    const localBindings = CTOR_PARAM_TYPES_ENABLED
      ? seedParamLocalBindings(chunk.localBindings, runParamTypes[chunk.symbolId], chunk.startLine)
      : chunk.localBindings;
    for (const call of chunk.calls) {
      callsAttempted += 1;
      const receiverKind = classifyReceiverKind(call, localBindings);
      kindTally[receiverKind].attempted += 1;
      if (DUCK_ENABLED) noteDuckCall(call, receiverKind, extraction.relPath, chunk);
      const ctx: CallContext = {
        callerFile: extraction.relPath,
        callerScope: chunk.scope,
        callerSymbolId: chunk.symbolId,
        imports: extraction.imports,
        symbolTable,
        classFieldTypes: classFieldTypesForResolver,
        associationTypes: extraction.associationTypes,
        localBindings,
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
      // The fan-out outcome, kept for the signature-gap oracle: an EMPTY outcome
      // cannot be told apart from "narrowed to zero" after the fact, so the
      // oracle only simulates where the outcome proves narrowing ran (jn5j0).
      let dispatchOutcome: DispatchFanoutOutcome | undefined;
      const noteDispatch = (out: DispatchFanoutOutcome | undefined): boolean => {
        if (SIGGAP_ORACLE_ENABLED && out !== undefined) dispatchOutcome = out;
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

      let outcome: LcOutcome;
      if (resolved) {
        callsResolved += 1;
        kindTally[receiverKind].resolved += 1;
        outcome = "resolved";
        if (SUPER_ORACLE_ENABLED && receiverKind === "super") {
          // Precision probe: `super` can never dispatch to the calling method
          // itself, so a target equal to `callerSymbolId` is a false edge. The
          // super bucket is ~170 calls, so the extra resolve is free.
          const t = resolver.resolve(call, ctx);
          if (t?.targetSymbolId !== undefined && t.targetSymbolId === chunk.symbolId) {
            superSelfEdges.push(`${extraction.relPath}:${call.startLine} ${chunk.symbolId}`);
          }
        }
      } else if (call.dynamicSend === true) {
        callsUnresolvable += 1;
        kindTally[receiverKind].unresolvable += 1;
        outcome = "dynamicSend";
      } else if (resolver.targetsExternalImport?.(call, ctx) ?? false) {
        callsExternalSkipped += 1;
        kindTally[receiverKind].externalSkipped += 1;
        outcome = "externalSkipped";
      } else if (symbolTable.lookupByShortName(call.member).length === 0) {
        callsNoInProjectDef += 1;
        kindTally[receiverKind].noInProjectDef += 1;
        outcome = "noInProjectDef";
      } else if (resolver.targetsCoreAmbiguousMember?.(call, ctx) ?? false) {
        // bd tea-rags-mcp-83cl7 — CORE HOMONYM: a core/runtime member on an
        // UNTYPED receiver whose in-project def of the same short name is a
        // coincidence. Mirrors provider.ts `resolveExtraction` branch-for-branch.
        callsCoreAmbiguous += 1;
        kindTally[receiverKind].coreAmbiguous += 1;
        outcome = "coreAmbiguous";
      } else {
        // THE RECALL HOLE: unresolved, non-dynamic, non-external, has in-project def.
        recordMiss(call, receiverKind, extraction.relPath, chunk.scope, chunk.symbolId);
        outcome = "miss";
        if (SUPER_ORACLE_ENABLED && receiverKind === "super") {
          noteSuperMiss(call, ctx, extraction.relPath, chunk);
        }
      }
      if (LOCAL_CENSUS_ENABLED) {
        noteLocalCensusCall(call, receiverKind, extraction.relPath, chunk, localBindings, outcome);
      }
      if (SIGGAP_ORACLE_ENABLED) {
        noteSigGapCall(call, ctx, dispatchOutcome, outcome, extraction.relPath);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Miss categorisation (gap taxonomy).
// ---------------------------------------------------------------------------
function isConcernDef(d: SymbolDefinition): boolean {
  if (d.relPath.includes("/concerns/")) return true;
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
  const helper = defs.filter((d) => d.relPath.includes("/helpers/")).length;
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
  "each",
  "each_with_index",
  "each_with_object",
  "map",
  "map!",
  "flat_map",
  "collect",
  "collect_concat",
  "select",
  "select!",
  "filter",
  "filter_map",
  "reject",
  "reject!",
  "detect",
  "find",
  "find_all",
  "each_pair",
  "reduce",
  "inject",
  "sort_by",
  "min_by",
  "max_by",
  "group_by",
  "partition",
  "chunk_while",
  "slice_when",
  "each_slice",
  "each_cons",
  "take_while",
  "drop_while",
  "find_each",
  "find_in_batches",
  "in_batches",
  "count",
  "sum",
  "any?",
  "all?",
  "none?",
  "one?",
  "index_by",
]);

/**
 * ActiveRecord query-interface / relation-returning methods. A `coll.map(&:m)`
 * whose receiver TAIL is one of these is typed by G1's query-interface return-type
 * source (epic G1 = "AR association + query-interface return types"), so it is
 * G1-typable, NOT VTA-remainder. Crediting these to G1 keeps the VTA remainder
 * honest — the direction that never inflates the VTA gate.
 */
const QUERY_INTERFACE_TAILS = new Set<string>([
  "all",
  "where",
  "order",
  "reorder",
  "includes",
  "joins",
  "left_joins",
  "left_outer_joins",
  "preload",
  "eager_load",
  "references",
  "distinct",
  "limit",
  "offset",
  "group",
  "having",
  "select",
  "none",
  "unscoped",
  "except",
  "only",
  "not",
  "or",
  "and",
  "merge",
  "extending",
  "readonly",
  "from",
  "reselect",
  "rewhere",
  "regroup",
  "excluding",
  "ids",
  "pluck",
  "to_a",
]);

/** Class-body declaration macros counted as "hidden" when they sit inside a
 *  non-transparent `prepended do` block (D2). Bare-receiver form only. */
const CONCERN_BODY_MACROS = new Set<string>([
  "has_many",
  "has_one",
  "belongs_to",
  "has_and_belongs_to_many",
  "has_one_attached",
  "has_many_attached",
  "validates",
  "validate",
  "validates_with",
  "validates_each",
  "before_save",
  "after_save",
  "before_create",
  "after_create",
  "before_update",
  "after_update",
  "before_destroy",
  "after_destroy",
  "before_validation",
  "after_validation",
  "after_commit",
  "after_rollback",
  "before_action",
  "after_action",
  "around_action",
  "skip_before_action",
  "scope",
  "default_scope",
  "enum",
  "attribute",
  "attr_accessor",
  "attr_reader",
  "attr_writer",
  "delegate",
  "delegate_missing_to",
  "cattr_accessor",
  "mattr_accessor",
  "class_attribute",
  "serialize",
  "store",
  "store_accessor",
  "accepts_nested_attributes_for",
  "alias_method",
  "alias_attribute",
  "composed_of",
  "aasm",
  "state_machine",
  "acts_as_list",
  "acts_as_tree",
  "helper_method",
  "rescue_from",
  "after_initialize",
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
const includedDoRanges = new Map<string, [number, number][]>();
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
  const params =
    block.childForFieldName("parameters") ?? block.namedChildren.find((c) => c.type === "block_parameters");
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
    const n = stack.pop();
    if (n === undefined) break;
    if (isCallNode(n)) {
      const recv = n.childForFieldName("receiver");
      const method = n.childForFieldName("method");
      if (recv?.type === "identifier" && params.has(recv.text) && method) {
        const key = `${relPath}:${n.startIndex}:A`;
        if (!seenSite.has(key)) {
          seenSite.add(key);
          bucketA.push({
            member: method.text,
            receiverTail: recv.text,
            relPath,
            line: n.startPosition.row + 1,
            startIndex: n.startIndex,
          });
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
    const n = stack.pop();
    if (n === undefined) break;
    if (n.type === "method" || n.type === "singleton_method") {
      const nm = n.childForFieldName("name")?.text ?? "?";
      d2HiddenDefs.push({
        member: nm,
        receiverTail: null,
        relPath,
        line: n.startPosition.row + 1,
        startIndex: n.startIndex,
      });
      continue; // don't descend into the def body
    }
    if (isCallNode(n) && !n.childForFieldName("receiver")) {
      const m = n.childForFieldName("method")?.text;
      if (m && CONCERN_BODY_MACROS.has(m)) {
        d2HiddenMacros.push({
          member: m,
          receiverTail: null,
          relPath,
          line: n.startPosition.row + 1,
          startIndex: n.startIndex,
        });
      }
    }
    for (const c of n.children) stack.push(c);
  }
}

/** Legacy Concern surface: `def self.included(base); base.extend(X); end` (D1). */
function scanLegacyExtendHook(hook: AstNode, fileRoot: AstNode): void {
  const params = hook.childForFieldName("parameters");
  const paramName = params?.namedChildren.find((c) => c.type === "identifier")?.text ?? params?.namedChildren[0]?.text;
  const body = hook.childForFieldName("body");
  if (!body) return;
  const extendedConsts: string[] = [];
  const bstack: AstNode[] = [body];
  while (bstack.length > 0) {
    const n = bstack.pop();
    if (n === undefined) break;
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
  const last = moduleConst.split("::").pop() ?? moduleConst;
  const stack: AstNode[] = [fileRoot];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) break;
    if (n.type === "module" || n.type === "class") {
      const nm = n.childForFieldName("name");
      const nmText = nm?.type === "scope_resolution" ? (nm.childForFieldName("name")?.text ?? nm.text) : nm?.text;
      if (nmText === last) {
        const dstack: AstNode[] = [n];
        while (dstack.length > 0) {
          const d = dstack.pop();
          if (d === undefined) break;
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
    const node = stack.pop();
    if (node === undefined) break;

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

function topN(
  sites: { member: string; relPath: string }[],
  key: "member" | "relPath",
  n = 10,
): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const s of sites) m.set(s[key], (m.get(s[key]) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

// Compute + emit the oracle report. Reads `misses` / `symbolTable` / `kindTally`
// populated by the standard PASS-2. `member has in-project def` is the oracle
// (would resolve if the element/receiver type were known perfectly).
function runOracle(elapsedMs: number, files: number): void {
  const L = (s: string) => {
    console.log(s);
  };
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
          return [...m.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([name, count]) => ({ name, count }));
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
  L(
    `bucket A (iterator block-param):  sites=${bucketA.length}  oracleEdges=${aResolvable.length}  currMiss=${aMiss.length}`,
  );
  L(
    `bucket B (&:sym symbol-to-proc):  sites=${bucketB.length}  oracleEdges=${bResolvable.length}  g1Typable=${bG1.length}  vtaRemainder=${bRemainder.length}  (remMiss=${bRemainderMiss.length})`,
  );
  L(
    `bucket C (index obj[k].m):        sites=${cSites.length}  edges=${cSites.length}  (index attempted=${kindTally.index.attempted} resolved=${kindTally.index.resolved})`,
  );
  L("");
  L(`VTA gate = A + B_remainder + C  (threshold ${VTA_THRESHOLD})`);
  L(
    `  upper bound   : ${aResolvable.length} + ${bRemainder.length} + ${cSites.length} = ${vtaUpperBound}  → VTA-${verdict}`,
  );
  L(
    `  new-recall    : ${aMiss.length} + ${bRemainderMiss.length} + ${cSites.length} = ${vtaNewRecall}  (B &:sym already emits bareCall short-name edges — see report)`,
  );
  L("");
  L(
    `D1 legacy-extend: hooks=${d1HookCount} addressableMembers=${legacyExtendMembers.size} unresolvedEntries=${d1Entries.length} (>500?) → ${d1Verdict}`,
  );
  L(
    `D2 prepended do : blocks=${d2PrependedBlocks} hiddenDefs=${d2HiddenDefs.length} hiddenMacros=${d2HiddenMacros.length} total=${d2Total} (>100?) → ${d2Verdict}`,
  );
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
  "initialize",
  "inspect",
  "hash",
  "eql?",
  "equal?",
  "==",
  "!=",
  "<=>",
  "===",
  "=~",
  "nil?",
  "empty?",
  "size",
  "length",
  "class",
  "instance_of?",
  "is_a?",
  "kind_of?",
  "respond_to?",
  "send",
  "public_send",
  "__send__",
  "method",
  "methods",
  "object_id",
  "frozen?",
  "itself",
  "display",
  "to_proc",
  "to_str",
  "to_f",
  "to_d",
  "to_r",
  "to_c",
  "presence",
  "presence_in",
  "in?",
  "try",
  "try!",
  "deep_dup",
  "deep_symbolize_keys",
  "deep_stringify_keys",
  "symbolize_keys",
  "stringify_keys",
  "with_indifferent_access",
  "to_json",
  "to_xml",
  "to_param",
  "to_query",
  "instance_variable_get",
  "instance_variable_set",
  "instance_variables",
  "define_singleton_method",
  "extend",
  "clone",
  "hash?",
  "each_with_object",
  "each_with_index",
  "reverse",
  "slice",
  "values_at",
  "zip",
  "take",
  "drop",
  "step",
  "upto",
  "downto",
  "times",
  "round",
  "floor",
  "ceil",
  "abs",
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
      out.set(created[1], cur);
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
    if (col && !NON_COLUMN.has(col[1])) cur.columns.push(col[2]);
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
      const segs = raw
        .replace(/^::/, "")
        .split("::")
        .filter((s) => s.length > 0);
      scanTableNameDecls(child, segs.length > 0 ? [...ns, ...segs] : ns);
      continue;
    }
    if (child.type === "assignment") {
      const lhs = child.childForFieldName("left");
      const rhs = child.childForFieldName("right");
      if (lhs && rhs && lhs.text.replace(/\s+/g, "") === "self.table_name" && ns.length > 0) {
        const lit = /^[:'"]([A-Za-z0-9_.]+)['"]?$/.exec(rhs.text.trim());
        if (lit) duckExplicitTableName.set(ns.join("::"), lit[1]);
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
      tableOfClass.set(hits[0], table);
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
    for (const m of classMembers[i]) {
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
    const posting = idx.postings.get(m);
    if (posting === undefined) continue;
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
    const memberSet = idx.classMembers[c];
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
        const predicted = idx.classes[p.classIdx];
        const gt = (g.gtType ?? "").replace(/^::/, "");
        ok = predicted === gt;
        okLast = ok || duckLastSegment(predicted) === duckLastSegment(gt);
        if (!okLast && margin === 1.5) {
          const k = `${gt} → ${predicted}`;
          confusion.set(k, (confusion.get(k) ?? 0) + 1);
          if (confusionExamples.length < 12) {
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
      const g = m.receiver === null ? undefined : patientByKey.get(duckKey(m.relPath, m.callerSymbolId, m.receiver));
      if (g === undefined) continue;
      const p = predOf.get(g) ?? null;
      if (p === null || !duckFires(p, margin)) continue;
      b.misses += 1;
      firedVars.add(g);
      if (duckIsNarrowing(p)) {
        b.missesNarrowing += 1;
        narrowingVars.add(g);
      }
      b.byReceiverKind[m.receiverKind] = (b.byReceiverKind[m.receiverKind] ?? 0) + 1;
      if (idx.isArModel[p.classIdx]) b.predictedArModel += 1;
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
    const sizes = fired.map((p) => idx.classMembers[p.classIdx].size).sort((a, b) => a - b);
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
      (g) => {
        const p = predOf.get(g);
        return p === undefined ? "" : idx.classes[p.classIdx];
      },
      15,
    ),
    diagnostics: { groundTruth: shape(gtResolvable), patients: shape(patients) },
  };
}

function runDuckOracle(): void {
  const L = (s: string): void => {
    console.log(s);
  };
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
    return hits.length > 0 ? hits[0] : null;
  };
  const resolvableSet = new Set(gtGroups.filter((g) => g.gtType !== undefined && classKnown(g.gtType) !== null));
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
      note: "Measurement only — no resolver/production change. Member sets = schema columns ∪ symbol-table defs (real + macro-synthesised) ∪ ONE level of included-module/superclass members. Two scoring variants: `spec` (every member votes, as specified) and `strictCore` (framework-universal members dropped).",
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
        ["all-GT", v.groundTruth[String(margin)].all, gtGroups.length],
        ["GT→known class", v.groundTruth[String(margin)].resolvable, gtResolvable.length],
        ["GT known, ≥2 members", v.groundTruth[String(margin)].multiMember, v.gtMultiMemberPool],
        ["GT known, NARROWING", v.groundTruth[String(margin)].narrowing, gtResolvable.length],
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
      const b = v.impact[String(margin)];
      L(
        `${String(margin).padEnd(7)}  ${String(b.misses).padStart(6)}  ${String(b.variables).padStart(5)}  ` +
          `${String(b.predictedArModel).padStart(8)}  ${String(b.predictedOther).padStart(5)}  ` +
          `${String(b.blockParamSlice).padStart(15)}  ${String(b.nonBlockParamSlice).padStart(14)}   ` +
          `${String(b.missesNarrowing).padStart(9)}/${b.variablesNarrowing}`,
      );
    }
    L(
      `  receiverKind @1.5: ${Object.entries(v.impact["1.5"].byReceiverKind)
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

// ===========================================================================
// INTERPROCEDURAL FIXPOINT ORACLE (CODEGRAPH_FIXPOINT_ORACLE=1)
//
// bvalc (Increment 1) typed parameters from call sites whose callee is known
// from SYNTAX ALONE, which dodges the fixpoint but is input-starved: 88% of the
// arguments at syntactically-known callees are themselves untyped. That is the
// signature of a propagation CYCLE. This oracle simulates the cycle's fixpoint
// read-only and measures its addressable ceiling:
//
//   A scan       — argument/receiver EXPRESSION shapes per call site + method
//                  body tails (one extra DFS over the already-materialized AST)
//   B waves      — ARG (re-evaluate hints under the current environment) →
//                  BIND (real bvalc fold binds params; real ivar derivation;
//                  params reach locals at the def line) → RETURN (body tails)
//   C convergence— repeat until the environment stops changing; hard cap 20
//                  waves + state-hash cycle guard
//   D scoring    — re-run the REAL resolver over every extraction with the
//                  converged environment and diff the miss multiset against the
//                  baseline pass. ADDRESSABLE = a baseline miss that resolves.
//   E residual   — the misses that survive, classified by WHY they are not
//                  typeable, so the ceiling is stated with its complement.
// ===========================================================================

/** Bare / `::`-qualified constant text. */
const FX_CONST_RE = /^(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*$/;

/**
 * The conservatively-typeable SHAPES of an expression. Deliberately a shape,
 * not a type: the whole point of the fixpoint is that the same expression is
 * re-evaluated every wave against a bigger environment, so the shape must
 * survive to wave N while the type is recomputed.
 */
type FxExpr =
  | { readonly k: "const"; readonly name: string }
  | { readonly k: "instConst"; readonly name: string }
  | { readonly k: "ident"; readonly name: string }
  | { readonly k: "ivar"; readonly name: string }
  | { readonly k: "call"; readonly recv: FxExpr | null; readonly member: string }
  | { readonly k: "opaque" };

const FX_OPAQUE: FxExpr = { k: "opaque" };

/** One call site whose arguments could ever carry a type hint. */
interface FxSite {
  relPath: string;
  /** Owning chunk symbolId — the local-binding / param environment of the site. */
  chunkId: string;
  /** Owning chunk lexical scope: constant-lookup base AND enclosing-class key. */
  scope: readonly string[];
  line: number;
  /** `null` ⇒ bare (implicit-self) call. */
  recv: FxExpr | null;
  member: string;
  args: FxExpr[];
  /**
   * Keyword arguments by NAME. bvalc's substrate is positional — argument INDEX
   * → parameter NAME — so a `Service.new(firm: firm)` contributes nothing to it.
   * Ruby service objects are overwhelmingly kwarg-shaped, so the oracle measures
   * BOTH: the positional-only fixpoint (what Increment 1's substrate can carry
   * today) and the kwarg-extended one (what Increment 2 would have to build).
   */
  kwargs: { name: string; expr: FxExpr }[];
  /** Positional argument list was closed early by a keyword pair. */
  kwargTruncated: boolean;
  /** Memoized constant-receiver candidate chain (scope walk is wave-invariant). */
  constTargets?: string[];
}

/** A method's tail expression — Ruby's implicit return value. */
interface FxTail {
  methodId: string;
  relPath: string;
  scope: readonly string[];
  line: number;
  expr: FxExpr;
}

/** Per-chunk slices of the walker environment the propagation rules read. */
interface FxChunkEnv {
  relPath: string;
  scope: readonly string[];
  localBindings?: Record<string, LocalBinding[]>;
  localCallBindings?: Record<string, string>;
}

const fxSites: FxSite[] = [];
const fxTails: FxTail[] = [];
const fxChunks = new Map<string, FxChunkEnv>();
/** Declared kwarg names per method chunk — the name-based existence gate. */
const runKwargNames: Record<string, string[]> = {};
/**
 * bd 1g7kz — bare constant name → the FQ class/module coordinates this run
 * DECLARES. `resolveConstant` answers "can I reach this name from here"; this
 * answers the different question the member-lookup forensics needs: "does the
 * project declare this name at all, and under what namespace" — which separates
 * a type fact naming a real but unqualified class from one naming a fiction.
 */
const fxClassFqByBareName = new Map<string, Set<string>>();
const fxFileClassFields = new Map<string, Record<string, Record<string, string>>>();
const fxFileAssoc = new Map<string, Record<string, Record<string, string>>>();
/** Sites dropped at scan time because no argument had a typeable shape. */
let fxSilentSites = 0;
/** Sites whose argument list was cut short by a keyword pair. */
let fxKwargSites = 0;
let fxCatalogueCache: RubyDslCatalogue | undefined;

function fxCatalogue(): RubyDslCatalogue {
  fxCatalogueCache ??= catalogueForGemfile(gemfileContent);
  return fxCatalogueCache;
}

/** Structural shape of one expression node; `opaque` where nothing is knowable. */
function fxExprOf(node: AstNode, depth: number): FxExpr {
  if (depth > 5) return FX_OPAQUE;
  if (node.type === "call" || node.type === "method_call") {
    const instantiated = constInstanceType(node, fxCatalogue());
    if (instantiated !== null) return { k: "instConst", name: instantiated };
    const method = node.childForFieldName("method")?.text;
    if (method === undefined) return FX_OPAQUE;
    const receiverNode = node.childForFieldName("receiver");
    if (receiverNode === null) return { k: "call", recv: null, member: method };
    const recv = fxExprOf(receiverNode, depth + 1);
    return recv.k === "opaque" ? FX_OPAQUE : { k: "call", recv, member: method };
  }
  if (node.type === "constant" || node.type === "scope_resolution") {
    const text = node.type === "scope_resolution" ? readScopeResolution(node) : node.text;
    return FX_CONST_RE.test(text) ? { k: "const", name: text.replace(/^::/, "") } : FX_OPAQUE;
  }
  if (node.type === "identifier") return { k: "ident", name: node.text };
  if (node.type === "instance_variable") return { k: "ivar", name: node.text };
  return FX_OPAQUE;
}

/** `firm: x` / `:firm => x` key name; anything dynamic or string-keyed → null. */
function fxPairKey(pair: AstNode): string | null {
  const key = pair.childForFieldName("key") ?? pair.namedChildren[0] ?? null;
  if (key === null) return null;
  if (key.type === "hash_key_symbol") return key.text;
  if (key.type === "simple_symbol") return key.text.replace(/^:/, "");
  return null;
}

/** Line → innermost owning chunk. Ascending startLine, later (inner) wins. */
function fxLineOwners(extraction: FileExtraction): (ChunkExtraction | undefined)[] {
  let maxLine = 0;
  for (const c of extraction.chunks) if ((c.endLine ?? 0) > maxLine) maxLine = c.endLine ?? 0;
  const owners = new Array<ChunkExtraction | undefined>(maxLine + 2);
  const sorted = [...extraction.chunks].sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
  for (const c of sorted) {
    if (c.startLine === undefined || c.endLine === undefined) continue;
    for (let l = c.startLine; l <= c.endLine && l < owners.length; l++) owners[l] = c;
  }
  return owners;
}

/** Last non-comment statement of a method body — Ruby's implicit return. */
function fxTailNode(methodNode: AstNode): AstNode | null {
  const body = methodNode.childForFieldName("body");
  if (!body) return null;
  for (let i = body.namedChildren.length - 1; i >= 0; i--) {
    const n = body.namedChildren[i];
    if (n.type === "comment") continue;
    return n;
  }
  return null;
}

/** ONE extra DFS per file over the AST the harness already materialized. */
function scanFixpointAst(root: AstNode, relPath: string, extraction: FileExtraction): void {
  if (extraction.classFieldTypes) fxFileClassFields.set(relPath, extraction.classFieldTypes);
  if (extraction.associationTypes) fxFileAssoc.set(relPath, extraction.associationTypes);
  for (const chunk of extraction.chunks) {
    // A class / module / top-level coordinate carries no member separator.
    if (!chunk.symbolId.includes("#") && !chunk.symbolId.includes(".")) {
      const bare = fxBareConst(chunk.symbolId);
      const bucket = fxClassFqByBareName.get(bare);
      if (bucket) bucket.add(chunk.symbolId);
      else fxClassFqByBareName.set(bare, new Set([chunk.symbolId]));
    }
    if (chunk.kwargs !== undefined) {
      const declared = [...chunk.kwargs.required, ...(chunk.kwargs.optional ?? [])];
      if (declared.length > 0) runKwargNames[chunk.symbolId] = declared;
    }
    if (chunk.localBindings === undefined && chunk.localCallBindings === undefined) continue;
    fxChunks.set(chunk.symbolId, {
      relPath,
      scope: chunk.scope,
      localBindings: chunk.localBindings,
      localCallBindings: chunk.localCallBindings,
    });
  }
  const owners = fxLineOwners(extraction);
  const ownerAt = (line: number): ChunkExtraction | undefined => (line < owners.length ? owners[line] : undefined);

  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;

    if (node.type === "call" || node.type === "method_call") {
      const method = node.childForFieldName("method");
      const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list") ?? null;
      if (method && args) {
        const line = node.startPosition.row + 1;
        const receiverNode = node.childForFieldName("receiver");
        const recv = receiverNode ? fxExprOf(receiverNode, 0) : null;
        if (recv?.k !== "opaque") {
          const argExprs: FxExpr[] = [];
          const kwargExprs: { name: string; expr: FxExpr }[] = [];
          let kwargTruncated = false;
          let typeable = false;
          for (const arg of args.namedChildren) {
            if (arg.type === "block" || arg.type === "do_block" || arg.type === "block_argument") break;
            if (arg.type === "splat_argument" || arg.type === "hash_splat_argument") break;
            if (arg.type === "pair") {
              // Positional correspondence ends here (bvalc truncation), but the
              // pair itself carries a NAME → value binding the kwarg-extended
              // variant can use without any positional reasoning.
              kwargTruncated = true;
              const key = fxPairKey(arg);
              const value = arg.childForFieldName("value") ?? arg.namedChildren[1] ?? null;
              if (key !== null && value !== null) {
                const shape = fxExprOf(value, 0);
                if (shape.k !== "opaque") {
                  typeable = true;
                  kwargExprs.push({ name: key, expr: shape });
                }
              }
              continue;
            }
            if (kwargTruncated) continue; // a positional after a pair is not positional
            const shape = fxExprOf(arg, 0);
            if (shape.k !== "opaque") typeable = true;
            argExprs.push(shape);
          }
          if (kwargTruncated) fxKwargSites += 1;
          if (typeable) {
            const owner = ownerAt(line);
            fxSites.push({
              relPath,
              chunkId: owner?.symbolId ?? "",
              scope: owner?.scope ?? extraction.fileScope,
              line,
              recv,
              member: method.text,
              args: argExprs,
              kwargs: kwargExprs,
              kwargTruncated,
            });
          } else if (argExprs.length > 0 || kwargTruncated) {
            fxSilentSites += 1;
          }
        }
      }
    }

    if (node.type === "method" || node.type === "singleton_method") {
      const line = node.startPosition.row + 1;
      const owner = ownerAt(line);
      if (owner?.startLine === line) {
        const tail = fxTailNode(node);
        if (tail !== null) {
          const shape = fxExprOf(tail, 0);
          if (shape.k !== "opaque") {
            fxTails.push({
              methodId: owner.symbolId,
              relPath,
              scope: owner.scope,
              line: tail.startPosition.row + 1,
              expr: shape,
            });
          }
        }
      }
    }

    for (const c of node.children) stack.push(c);
  }
}

// ---------------------------------------------------------------------------
// B. Wave machinery
// ---------------------------------------------------------------------------

interface FxEnv {
  paramTypes: KnownTargetParamTypes;
  ivarTypes: Record<string, Record<string, string>>;
  returnTypes: Record<string, RubyTypeRef>;
}

interface FxWaveStat {
  wave: number;
  paramsTyped: number;
  calleesTyped: number;
  ivarsTyped: number;
  returnsTyped: number;
  contributingSites: number;
  ms: number;
}

/** One call site's keyword-argument hints, keyed by NAME rather than position. */
interface FxKwargRecord {
  readonly targets: readonly string[];
  readonly kwargTypes: readonly { readonly name: string; readonly type: RubyTypeRef }[];
}

/**
 * Name-keyed mirror of `foldKnownTargetParamTypes`, for keyword arguments.
 *
 * Same agreement rule, stated once more because the real fold is POSITIONAL
 * (`argTypes[i]` → `paramNames[i]`) and a keyword argument has no position: a
 * single uncontradicted witness binds, absent evidence neither votes nor vetoes,
 * ANY structural disagreement is silence for that name. `runKwargNames` is the
 * existence gate the positional fold gets from `runParamNames` — a `def
 * initialize(firm:, user:)` declares NO positional params, so it is invisible to
 * the real fold and reachable only here.
 */
function fxFoldKwargParamTypes(records: readonly FxKwargRecord[]): KnownTargetParamTypes {
  const byTarget = new Map<string, Map<string, RubyTypeRef | null>>(); // null ⇒ conflicted
  for (const record of records) {
    const target = record.targets.find((c) => runKwargNames[c] !== undefined);
    if (target === undefined) continue;
    const declared = runKwargNames[target];
    let names = byTarget.get(target);
    if (names === undefined) {
      names = new Map<string, RubyTypeRef | null>();
      byTarget.set(target, names);
    }
    for (const hint of record.kwargTypes) {
      if (!declared.includes(hint.name)) continue; // not a parameter of this callee
      const seen = names.get(hint.name);
      if (seen === undefined) names.set(hint.name, hint.type);
      else if (seen !== null && fxTypeKey(seen) !== fxTypeKey(hint.type)) names.set(hint.name, null);
    }
  }
  const out: KnownTargetParamTypes = {};
  for (const [target, names] of byTarget) {
    const params: Record<string, RubyTypeRef> = {};
    for (const [name, type] of names) if (type !== null) params[name] = type;
    if (Object.keys(params).length > 0) out[target] = params;
  }
  return out;
}

/** Union of two per-callee param maps (positional names and kwarg names are disjoint). */
function fxMergeParamTypes(a: KnownTargetParamTypes, b: KnownTargetParamTypes): KnownTargetParamTypes {
  const out: KnownTargetParamTypes = { ...a };
  for (const [target, params] of Object.entries(b)) out[target] = { ...out[target], ...params };
  return out;
}

/** Transitive ancestor closure over `runAncestors`, cycle-guarded, depth-capped. */
const fxAncestorClosure = new Map<string, string[]>();
function fxAncestorsOf(klass: string): string[] {
  const cached = fxAncestorClosure.get(klass);
  if (cached !== undefined) return cached;
  const out: string[] = [];
  const seen = new Set<string>([klass]);
  let frontier = [...(runAncestors[klass] ?? [])];
  for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const a of frontier) {
      if (seen.has(a)) continue;
      seen.add(a);
      out.push(a);
      next.push(...(runAncestors[a] ?? []));
    }
    frontier = next;
  }
  fxAncestorClosure.set(klass, out);
  return out;
}

/** `derived` wins on a shared coordinate; both are derivations of one fold. */
function fxMergeClassFields(
  base: Record<string, Record<string, string>>,
  derived: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = { ...base };
  for (const [klass, fields] of Object.entries(derived)) out[klass] = { ...out[klass], ...fields };
  return out;
}

/**
 * A CallContext carrying the fixpoint environment, for the propagation rules
 * only (`returnTypeOf` / `ivarTypeName` / `boundCallReturnType`). Per-file maps
 * stay per-file — a run-global merge of `classFieldTypes` would type ivars the
 * production resolver never sees and inflate the ceiling.
 */
function fxCtx(
  relPath: string,
  chunkId: string,
  scope: readonly string[],
  fieldsByFile: Map<string, Record<string, Record<string, string>>>,
  mergedReturns: Record<string, RubyTypeRef>,
): CallContext {
  const chunk = fxChunks.get(chunkId);
  return {
    callerFile: relPath,
    callerScope: [...scope],
    callerSymbolId: chunkId,
    imports: [],
    symbolTable,
    classFieldTypes: fieldsByFile.get(relPath),
    associationTypes: fxFileAssoc.get(relPath),
    localBindings: chunk?.localBindings,
    localCallBindings: chunk?.localCallBindings,
    functionReturnTypes: runReturnTypes,
    ivarTypes: runIvarTypes,
    structuredReturnTypes: mergedReturns,
    classAncestors: runAncestors,
    compactDeclaredClasses: runCompactClasses,
    gemfileContent,
    classPrependedAncestors: runPrependedAncestors,
    includedBy,
    classExtends: runExtends,
    dispatchTables: runDispatchTables,
    callbackParams: runCallbackParams,
    hierarchy: hierarchyView,
    instantiatedTypes: runInstantiatedTypes,
  };
}

/** The environment's answer for one expression shape, or `undefined`. */
function fxTypeOf(
  expr: FxExpr,
  chunkId: string,
  line: number,
  klass: string,
  ctx: CallContext,
  env: FxEnv,
  depth: number,
): RubyTypeRef | undefined {
  if (depth > 4) return undefined;
  switch (expr.k) {
    case "const":
      return { form: "class", name: expr.name };
    case "instConst":
      return { form: "instance", name: expr.name };
    case "ident": {
      const binding = resolveLocalBinding(ctx.localBindings, expr.name, line);
      if (binding !== undefined) {
        return binding.typeRef ?? { form: binding.valueKind === "class" ? "class" : "instance", name: binding.type };
      }
      const derived = env.paramTypes[chunkId]?.[expr.name];
      if (derived !== undefined) return derived;
      return boundCallReturnType(expr.name, ctx);
    }
    case "ivar": {
      const name = ivarTypeName(expr.name, ctx);
      return name === undefined ? undefined : { form: "instance", name };
    }
    case "call": {
      if (expr.recv === null) {
        if (klass === "") return undefined;
        return returnTypeOf({ form: "instance", name: klass }, expr.member, ctx);
      }
      const recvType = fxTypeOf(expr.recv, chunkId, line, klass, ctx, env, depth + 1);
      if (recvType === undefined) return undefined;
      return returnTypeOf(recvType, expr.member, ctx);
    }
    case "opaque":
    default:
      return undefined;
  }
}

/** Callee coordinate candidates for a site, in Ruby lookup order. */
function fxTargetsOf(site: FxSite, ctx: CallContext, env: FxEnv): string[] {
  const { member } = site;
  if (site.recv === null) {
    const klass = site.scope.join("::");
    if (klass === "") return [];
    const out: string[] = [];
    for (const c of [klass, ...fxAncestorsOf(klass)]) {
      out.push(`${c}#${member}`);
      out.push(`${c}.${member}`);
    }
    return out;
  }
  if (site.recv.k === "const") {
    if (site.constTargets === undefined) {
      const suffix = member === "new" ? "#initialize" : `.${member}`;
      const out: string[] = [];
      for (const fq of constantLookupCandidates(site.scope, site.recv.name)) {
        out.push(`${fq}${suffix}`);
        for (const anc of fxAncestorsOf(fq)) out.push(`${anc}${suffix}`);
      }
      site.constTargets = out;
    }
    return site.constTargets;
  }
  if (!FIXPOINT_WIDE) return [];
  const recvType = fxTypeOf(site.recv, site.chunkId, site.line, site.scope.join("::"), ctx, env, 0);
  if (recvType === undefined || (recvType.form !== "instance" && recvType.form !== "class")) return [];
  const suffix = recvType.form === "class" ? (member === "new" ? "#initialize" : `.${member}`) : `#${member}`;
  const out = [`${recvType.name}${suffix}`];
  for (const anc of fxAncestorsOf(recvType.name)) out.push(`${anc}${suffix}`);
  return out;
}

/** Cheap order-independent digest of the environment, for convergence/cycles. */
function fxDigest(env: FxEnv): string {
  let params = 0;
  let paramMix = 0;
  for (const [target, fields] of Object.entries(env.paramTypes)) {
    for (const [name, type] of Object.entries(fields)) {
      params += 1;
      paramMix = (paramMix + fxStrHash(`${target}|${name}|${fxTypeKey(type)}`)) >>> 0;
    }
  }
  let ivars = 0;
  let ivarMix = 0;
  for (const [klass, fields] of Object.entries(env.ivarTypes)) {
    for (const [ivar, type] of Object.entries(fields)) {
      ivars += 1;
      ivarMix = (ivarMix + fxStrHash(`${klass}|${ivar}|${type}`)) >>> 0;
    }
  }
  let returns = 0;
  let returnMix = 0;
  for (const [key, type] of Object.entries(env.returnTypes)) {
    returns += 1;
    returnMix = (returnMix + fxStrHash(`${key}|${fxTypeKey(type)}`)) >>> 0;
  }
  return `${params}:${paramMix}|${ivars}:${ivarMix}|${returns}:${returnMix}`;
}

function fxStrHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

function fxTypeKey(t: RubyTypeRef): string {
  if (t.form === "container") return `c(${fxTypeKey(t.element)})`;
  if (t.form === "union") return `u(${t.members.map(fxTypeKey).join(",")})`;
  return `${t.form}:${t.name}`;
}

/** Per-(callee, position) evidence, for the never-typeable cause classes. */
interface FxPositionDiag {
  sites: number;
  known: number;
  conflicted: boolean;
}
const fxDiag = new Map<string, Map<number, FxPositionDiag>>();
const fxKwargDiag = new Map<string, Map<string, FxPositionDiag>>();

/** Mirror of the folds' bookkeeping, for diagnostics ONLY (never binds). */
function fxRecordDiag(records: KnownTargetCallArgs[], kwargRecords: FxKwargRecord[]): void {
  fxDiag.clear();
  fxKwargDiag.clear();
  for (const record of records) {
    const target = record.targets.find((c) => runParamNames[c] !== undefined);
    if (target === undefined) continue;
    const names = runParamNames[target];
    let positions = fxDiag.get(target);
    if (positions === undefined) {
      positions = new Map<number, FxPositionDiag>();
      fxDiag.set(target, positions);
    }
    for (let i = 0; i < record.argTypes.length && i < names.length; i++) {
      const slot = positions.get(i) ?? { sites: 0, known: 0, conflicted: false };
      slot.sites += 1;
      if (record.argTypes[i] !== null) slot.known += 1;
      positions.set(i, slot);
    }
  }
  for (const record of kwargRecords) {
    const target = record.targets.find((c) => runKwargNames[c] !== undefined);
    if (target === undefined) continue;
    let names = fxKwargDiag.get(target);
    if (names === undefined) {
      names = new Map<string, FxPositionDiag>();
      fxKwargDiag.set(target, names);
    }
    for (const hint of record.kwargTypes) {
      if (!runKwargNames[target].includes(hint.name)) continue;
      const slot = names.get(hint.name) ?? { sites: 0, known: 0, conflicted: false };
      slot.sites += 1;
      slot.known += 1;
      names.set(hint.name, slot);
    }
  }
  // Conflicted = a coordinate with ≥1 known hint the fold refused to bind. Read
  // off the fold's own product, so diagnostics and binding can never disagree.
  for (const [target, positions] of fxDiag) {
    const names = runParamNames[target] ?? [];
    for (const [index, slot] of positions) {
      const name = names[index];
      if (name === undefined) continue;
      slot.conflicted = slot.known > 0 && fxFinalParamTypes[target]?.[name] === undefined;
    }
  }
  for (const [target, names] of fxKwargDiag) {
    for (const [name, slot] of names) {
      slot.conflicted = slot.known > 0 && fxFinalParamTypes[target]?.[name] === undefined;
    }
  }
}
let fxFinalParamTypes: KnownTargetParamTypes = {};

/** Run the worklist to convergence (or the cap). Returns per-wave growth. */
function fxRunWaves(useKwargs: boolean): { env: FxEnv; waves: FxWaveStat[]; converged: boolean; cycle: boolean } {
  const env: FxEnv = { paramTypes: {}, ivarTypes: {}, returnTypes: {} };
  const waves: FxWaveStat[] = [];
  const seen = new Map<string, number>();
  let converged = false;
  let cycle = false;
  let previous = fxDigest(env);
  let lastRecords: KnownTargetCallArgs[] = [];
  let lastKwargRecords: FxKwargRecord[] = [];

  for (let wave = 1; wave <= FIXPOINT_MAX_WAVES; wave++) {
    const started = Date.now();

    // Per-wave materialization of the two maps every ctx reads.
    const mergedReturns: Record<string, RubyTypeRef> = { ...runStructuredReturnTypes, ...env.returnTypes };
    const fieldsByFile = new Map<string, Record<string, Record<string, string>>>();
    for (const relPath of fxFileClassFields.keys()) {
      fieldsByFile.set(relPath, fxMergeClassFields(fxFileClassFields.get(relPath) ?? {}, env.ivarTypes));
    }
    for (const relPath of fxFileAssoc.keys()) {
      if (!fieldsByFile.has(relPath)) fieldsByFile.set(relPath, fxMergeClassFields({}, env.ivarTypes));
    }

    const ctxCache = new Map<string, CallContext>();
    const ctxFor = (relPath: string, chunkId: string, scope: readonly string[]): CallContext => {
      const key = `${relPath} ${chunkId}`;
      let ctx = ctxCache.get(key);
      if (ctx === undefined) {
        ctx = fxCtx(relPath, chunkId, scope, fieldsByFile, mergedReturns);
        ctxCache.set(key, ctx);
      }
      return ctx;
    };

    // ── ARG WAVE ──────────────────────────────────────────────────────────
    const records: KnownTargetCallArgs[] = [];
    const kwargRecords: FxKwargRecord[] = [];
    let contributing = 0;
    for (const site of fxSites) {
      const ctx = ctxFor(site.relPath, site.chunkId, site.scope);
      const targets = fxTargetsOf(site, ctx, env);
      if (targets.length === 0) continue;
      const klass = site.scope.join("::");
      const argTypes: (RubyTypeRef | null)[] = [];
      let positionalKnown = false;
      for (const arg of site.args) {
        const type = fxTypeOf(arg, site.chunkId, site.line, klass, ctx, env, 0) ?? null;
        if (type !== null) positionalKnown = true;
        argTypes.push(type);
      }
      const kwargTypes: { name: string; type: RubyTypeRef }[] = [];
      if (useKwargs) {
        for (const kwarg of site.kwargs) {
          const type = fxTypeOf(kwarg.expr, site.chunkId, site.line, klass, ctx, env, 0);
          if (type !== undefined) kwargTypes.push({ name: kwarg.name, type });
        }
      }
      if (!positionalKnown && kwargTypes.length === 0) continue;
      contributing += 1;
      if (positionalKnown) records.push({ targets, argTypes });
      if (kwargTypes.length > 0) kwargRecords.push({ targets, kwargTypes });
    }

    // ── BIND WAVE (the REAL bvalc fold + the REAL ivar derivation) ────────
    const positionalParams = foldKnownTargetParamTypes(records, runParamNames);
    env.paramTypes = useKwargs
      ? fxMergeParamTypes(positionalParams, fxFoldKwargParamTypes(kwargRecords))
      : positionalParams;
    env.ivarTypes = deriveClassFieldTypesFromParams(runClassFieldParamLinks, env.paramTypes, runTypedClassFields);
    lastRecords = records;
    lastKwargRecords = kwargRecords;

    // ── RETURN WAVE (body tails, re-evaluated under the just-bound env) ───
    const tailReturns: Record<string, RubyTypeRef> = {};
    const tailReturnsMerged: Record<string, RubyTypeRef> = { ...runStructuredReturnTypes, ...env.returnTypes };
    const tailFields = new Map<string, Record<string, Record<string, string>>>();
    for (const relPath of fxFileClassFields.keys()) {
      tailFields.set(relPath, fxMergeClassFields(fxFileClassFields.get(relPath) ?? {}, env.ivarTypes));
    }
    for (const tail of fxTails) {
      if (runStructuredReturnTypes[tail.methodId] !== undefined) continue; // declared wins
      const ctx = fxCtx(tail.relPath, tail.methodId, tail.scope, tailFields, tailReturnsMerged);
      const type = fxTypeOf(tail.expr, tail.methodId, tail.line, tail.scope.join("::"), ctx, env, 0);
      if (type !== undefined && (type.form === "instance" || type.form === "container")) {
        tailReturns[tail.methodId] = type;
      }
    }
    env.returnTypes = tailReturns;

    const digest = fxDigest(env);
    waves.push({
      wave,
      paramsTyped: Object.values(env.paramTypes).reduce((n, p) => n + Object.keys(p).length, 0),
      calleesTyped: Object.keys(env.paramTypes).length,
      ivarsTyped: Object.values(env.ivarTypes).reduce((n, f) => n + Object.keys(f).length, 0),
      returnsTyped: Object.keys(env.returnTypes).length,
      contributingSites: contributing,
      ms: Date.now() - started,
    });
    console.error(
      `[fixpoint${useKwargs ? "+kw" : ""}] wave ${wave}: params=${waves[waves.length - 1].paramsTyped} ` +
        `callees=${waves[waves.length - 1].calleesTyped} ivars=${waves[waves.length - 1].ivarsTyped} ` +
        `returns=${waves[waves.length - 1].returnsTyped} sites=${contributing} ` +
        `(${((Date.now() - started) / 1000).toFixed(1)}s)`,
    );

    if (digest === previous) {
      converged = true;
      break;
    }
    if (seen.has(digest)) {
      cycle = true;
      break;
    }
    seen.set(digest, wave);
    previous = digest;
  }

  fxFinalParamTypes = env.paramTypes;
  fxRecordDiag(lastRecords, lastKwargRecords);
  return { env, waves, converged, cycle };
}

// ---------------------------------------------------------------------------
// D. Scoring — re-resolve everything with the converged environment
// ---------------------------------------------------------------------------

function fxMissKey(relPath: string, line: number, member: string, receiver: string | null, caller: string): string {
  return `${relPath}|${line}|${member}|${receiver ?? "~"}|${caller}`;
}

interface FxPassResult {
  kindTally: Record<ReceiverKind, KindTally>;
  attempted: number;
  resolved: number;
  externalSkipped: number;
  unresolvable: number;
  noInProjectDef: number;
  coreAmbiguous: number;
  hole: number;
  missKeys: Map<string, number>;
}

/**
 * Faithful re-run of PASS-2 with the fixpoint environment substituted into the
 * three channels the mechanism would actually use in production (seeded param
 * locals, derived ivar field types, derived return types). Deliberately a
 * SEPARATE loop from `resolvePass2` rather than a parameterization of it: the
 * default-off path must stay byte-identical, and a shared mutable tally is
 * exactly how that guarantee gets lost.
 */
function fxResolvePass(extractions: FileExtraction[], env: FxEnv): FxPassResult {
  if (resolver === undefined) throw new Error("ruby resolver missing");
  const mergedReturns: Record<string, RubyTypeRef> = { ...runStructuredReturnTypes, ...env.returnTypes };
  const derivedFields = fxMergeClassFields(runDerivedClassFieldTypes, env.ivarTypes);
  const result: FxPassResult = {
    kindTally: Object.fromEntries(RECEIVER_KINDS.map((k) => [k, emptyKind()])) as Record<ReceiverKind, KindTally>,
    attempted: 0,
    resolved: 0,
    externalSkipped: 0,
    unresolvable: 0,
    noInProjectDef: 0,
    coreAmbiguous: 0,
    hole: 0,
    missKeys: new Map<string, number>(),
  };

  for (const extraction of extractions) {
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
    const classFieldTypesForResolver = mergeDerivedClassFieldTypes(extraction.classFieldTypes, derivedFields);

    for (const chunk of extraction.chunks) {
      const seededParams = { ...runParamTypes[chunk.symbolId], ...env.paramTypes[chunk.symbolId] };
      const localBindings = seedParamLocalBindings(
        chunk.localBindings,
        Object.keys(seededParams).length > 0 ? seededParams : undefined,
        chunk.startLine,
      );
      for (const call of chunk.calls) {
        result.attempted += 1;
        const receiverKind = classifyReceiverKind(call, localBindings);
        result.kindTally[receiverKind].attempted += 1;
        const ctx: CallContext = {
          callerFile: extraction.relPath,
          callerScope: chunk.scope,
          callerSymbolId: chunk.symbolId,
          imports: extraction.imports,
          symbolTable,
          classFieldTypes: classFieldTypesForResolver,
          associationTypes: extraction.associationTypes,
          localBindings,
          localCallBindings: chunk.localCallBindings,
          functionReturnTypes: returnTypesForResolver,
          ivarTypes: ivarTypesForResolver,
          structuredReturnTypes: mergedReturns,
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
          return edges.length > 0;
        };
        if (call.dispatch) {
          if (noteDispatch(resolver.resolveDispatch?.(call, ctx))) resolved = true;
        } else if (call.dispatchArgs && call.dispatchArgs.length > 0) {
          if (resolver.resolve(call, ctx)) resolved = true;
          if (noteDispatch(resolver.resolveDispatch?.(call, ctx))) resolved = true;
        } else if (noteDispatch(resolver.resolveDispatch?.(call, ctx))) {
          resolved = true;
        } else if (resolver.resolve(call, ctx)) {
          resolved = true;
        }

        if (resolved) {
          result.resolved += 1;
          result.kindTally[receiverKind].resolved += 1;
        } else if (call.dynamicSend === true) {
          result.unresolvable += 1;
          result.kindTally[receiverKind].unresolvable += 1;
        } else if (resolver.targetsExternalImport?.(call, ctx) ?? false) {
          result.externalSkipped += 1;
          result.kindTally[receiverKind].externalSkipped += 1;
        } else if (symbolTable.lookupByShortName(call.member).length === 0) {
          result.noInProjectDef += 1;
          result.kindTally[receiverKind].noInProjectDef += 1;
        } else if (resolver.targetsCoreAmbiguousMember?.(call, ctx) ?? false) {
          result.coreAmbiguous += 1;
          result.kindTally[receiverKind].coreAmbiguous += 1;
        } else {
          result.hole += 1;
          const key = fxMissKey(extraction.relPath, call.startLine, call.member, call.receiver, chunk.symbolId);
          result.missKeys.set(key, (result.missKeys.get(key) ?? 0) + 1);
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// E. Residual cause classification + report
// ---------------------------------------------------------------------------

const FX_CAUSE = {
  bare: "no-receiver (bareCall / implicit self)",
  index: "index or hash access receiver (params[:x])",
  ivarNoLink: "ivar: no @x = <param> link",
  ivarParamUntyped: "ivar: link exists, source param untyped",
  ivarLinkUnusable: "ivar: link exists, param typed but not instance-form",
  chain: "chain: an intermediate hop is untyped",
  posNoSite: "positional param: callee has no observed call site",
  posAllNull: "positional param: every observed hint is null (literal / hash / external)",
  posDisagree: "positional param: hints disagree (fold stays silent)",
  kwNoSite: "kwarg param: callee has no observed kwarg call site",
  kwDisagree: "kwarg param: hints disagree (fold stays silent)",
  untypedLocal: "untyped local (assigned from an untypeable expression)",
  memberNotFound: "receiver typed but member not found on that type",
  // bd tea-rags-mcp-1g7kz — the honest split of what USED to be reported wholly as
  // `memberNotFound`. "The environment produced a type" and "that type names a
  // class the project declares" are different claims, and only the second one
  // makes a member LOOKUP possible at all: when the type name resolves to no
  // project file and carries no ancestors, the MRO walk never runs, so calling the
  // failure "member not found" points the reader at a lookup seam that was never
  // reached. This bucket names the real seam — the type FACT.
  receiverTypeUnresolvable: "receiver typed, but the TYPE NAME resolves to no project class",
} as const;
type FxCause = (typeof FX_CAUSE)[keyof typeof FX_CAUSE];

function fxClassifyResidual(miss: MissRecord, env: FxEnv, typedReceiver: boolean, typeResolvable: boolean): FxCause {
  if (miss.receiverKind === "bareCall" || miss.receiver === null) return FX_CAUSE.bare;
  if (typedReceiver) return typeResolvable ? FX_CAUSE.memberNotFound : FX_CAUSE.receiverTypeUnresolvable;
  if (miss.receiver.includes("[")) return FX_CAUSE.index;
  if (miss.receiver.startsWith("@") && !miss.receiver.includes(".")) {
    const klass = miss.enclosingScope.split(" > ").join("::");
    const link = runClassFieldParamLinks[klass]?.[miss.receiver];
    if (link === undefined) return FX_CAUSE.ivarNoLink;
    return env.paramTypes[`${klass}#${link.method}`]?.[link.param] === undefined
      ? FX_CAUSE.ivarParamUntyped
      : FX_CAUSE.ivarLinkUnusable;
  }
  if (miss.receiver.includes(".")) return FX_CAUSE.chain;
  const position = runParamNames[miss.callerSymbolId]?.indexOf(miss.receiver) ?? -1;
  if (position >= 0) {
    const slot = fxDiag.get(miss.callerSymbolId)?.get(position);
    if (slot === undefined) return FX_CAUSE.posNoSite;
    if (slot.known === 0) return FX_CAUSE.posAllNull;
    return slot.conflicted ? FX_CAUSE.posDisagree : FX_CAUSE.posAllNull;
  }
  if (runKwargNames[miss.callerSymbolId]?.includes(miss.receiver) === true) {
    const slot = fxKwargDiag.get(miss.callerSymbolId)?.get(miss.receiver);
    if (slot === undefined) return FX_CAUSE.kwNoSite;
    return slot.conflicted ? FX_CAUSE.kwDisagree : FX_CAUSE.kwNoSite;
  }
  return FX_CAUSE.untypedLocal;
}

// ---------------------------------------------------------------------------
// E2. TYPED-RECEIVER MEMBER-LOOKUP FORENSICS (bd tea-rags-mcp-1g7kz)
//
// `FX_CAUSE.memberNotFound` is the ONE residual bucket where the type side is
// already done: the environment answers with a class for the receiver and the
// member lookup still fails. That makes it a precision lead rather than a typing
// lead — and precision leads need a NAMED seam, not a count. This section dumps
// every such miss and classifies it by the reason the lookup missed, probing the
// REAL lookup (`resolveTypeInstanceMethod` / `resolveTypeStaticMethod` /
// `resolveConstant`) rather than re-implementing the MRO walk, so a class here
// points at a production seam and not at a harness approximation.
//
// Measurement-only, and only under the fixpoint gate — nothing here runs on the
// default path.
// ---------------------------------------------------------------------------

/** Where the environment's answer for the receiver expression came from. */
const FX_TYPE_CHANNEL = {
  localBinding: "walker local binding",
  fixpointParam: "fixpoint-derived param type (NOT a production channel)",
  boundCallReturn: "localCallBindings return type",
  ivarField: "ivar field type",
} as const;
type FxTypeChannel = (typeof FX_TYPE_CHANNEL)[keyof typeof FX_TYPE_CHANNEL];

/** Why the member lookup missed on a receiver the environment DID type. */
const FX_LOOKUP = {
  channelGap: "(f) MRO DOES pin it — no production channel fed the type in",
  formMismatch: "(a) found under the OTHER symbolId form (class vs instance)",
  typeNameUnqualified: "(e) type name IS declared in-project, but only under a namespace the fact never qualified",
  typeNameAmbiguous: "(e) type name declared in N>1 places — resolveConstant refuses to guess",
  typeNotAProjectConstant: "(e) type name declared NOWHERE in project — the fact is a fiction",
  scopeTailMismatch: "(c) member IS in the type's own file, under a different scope tail",
  ancestorFileUnresolved: "(a) member sits on a named ancestor whose file the walk cannot pin",
  extendChannel: "(a) reachable only through `extend` — resolveTypeMethodInternal never walks it",
  concernClassMethods: "(a) def lives in a `ClassMethods` concern module (extend-by-included)",
  schemaColumnUnmapped: "(d) column of a schema table the model mapping missed",
  macroSynthesized: "(b) macro/DSL-declared member absent from declares",
  absentOnType: "(e/f) member defined only on unrelated classes",
  nonNominalType: "(f) environment answers union / container — no single class to look in",
} as const;
type FxLookupClass = (typeof FX_LOOKUP)[keyof typeof FX_LOOKUP];

/** One residual miss whose receiver the environment typed. */
interface FxMemberLookupMiss {
  readonly miss: MissRecord;
  readonly type: RubyTypeRef;
  readonly channel: FxTypeChannel;
}

/** The environment's answer for a receiver shape, WITH its provenance. */
function fxTypedReceiverOf(
  shape: FxExpr,
  chunkId: string,
  line: number,
  ctx: CallContext,
  env: FxEnv,
): { type: RubyTypeRef; channel: FxTypeChannel } | undefined {
  if (shape.k === "ivar") {
    const name = ivarTypeName(shape.name, ctx);
    return name === undefined ? undefined : { type: { form: "instance", name }, channel: FX_TYPE_CHANNEL.ivarField };
  }
  if (shape.k !== "ident") return undefined;
  const binding = resolveLocalBinding(ctx.localBindings, shape.name, line);
  if (binding !== undefined) {
    return {
      type: binding.typeRef ?? { form: binding.valueKind === "class" ? "class" : "instance", name: binding.type },
      channel: FX_TYPE_CHANNEL.localBinding,
    };
  }
  const derived = env.paramTypes[chunkId]?.[shape.name];
  if (derived !== undefined) return { type: derived, channel: FX_TYPE_CHANNEL.fixpointParam };
  const bound = boundCallReturnType(shape.name, ctx);
  if (bound !== undefined) return { type: bound, channel: FX_TYPE_CHANNEL.boundCallReturn };
  return undefined;
}

/**
 * Can a member lookup even START on this receiver type? Mirrors the exact gate
 * `resolveTypeMethodInternal` opens with: without a declaring file AND without an
 * ancestors entry there is nothing to walk, so the miss is a type-fact failure,
 * not a lookup failure.
 */
function fxReceiverTypeResolvable(type: RubyTypeRef, ctx: CallContext): boolean {
  if (type.form !== "class" && type.form !== "instance") return false;
  return resolveConstant(type.name, ctx) !== null || runAncestors[type.name] !== undefined;
}

/** Printable label for any `RubyTypeRef` form (union / container carry no name). */
function fxTypeLabel(type: RubyTypeRef): string {
  return type.form === "class" || type.form === "instance" ? `${type.form} ${type.name}` : `<${type.form}>`;
}

/** Bare last `::` segment of a constant path. */
function fxBareConst(name: string): string {
  const at = name.lastIndexOf("::");
  return at === -1 ? name : name.slice(at + 2);
}

const fxSourceCache = new Map<string, string[]>();

/** Lines of a project file, read once. `[]` when unreadable. */
function fxSourceLines(relPath: string): string[] {
  const cached = fxSourceCache.get(relPath);
  if (cached !== undefined) return cached;
  let lines: string[];
  try {
    lines = readFileSync(join(ROOT, relPath), "utf8").split("\n");
  } catch {
    lines = [];
  }
  fxSourceCache.set(relPath, lines);
  return lines;
}

/**
 * The DSL verb that most plausibly SYNTHESIZES `member` in `relPath` — the
 * leading token of the first line naming the member as a symbol / hash key /
 * string. Names the macro instead of saying "some macro", which is the whole
 * point of class (b): a grammar can only be written against a named verb.
 */
function fxMacroWitness(relPath: string, member: string): string | null {
  const escaped = member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mention = new RegExp(`(?::${escaped}\\b|\\b${escaped}:|["']${escaped}["'])`);
  for (const line of fxSourceLines(relPath)) {
    if (!mention.test(line)) continue;
    const verb = /^\s*([a-z_][\w]*)/.exec(line);
    if (verb === null || verb[1] === "def" || verb[1] === "end") continue;
    return `${verb[1]}  «${line.trim().slice(0, 90)}»`;
  }
  return null;
}

/**
 * A schema table whose inflected model name is this type's own name and whose
 * accessors include the member — i.e. the column EXISTS in db/schema.rb and the
 * pre-pass declined to attach it (unmapped / ambiguous / model not collected).
 */
function fxUnmappedSchemaColumn(typeName: string, member: string): string | null {
  if (runSchemaModelNameForTable === undefined) return null;
  if (runSchemaMappedModels.has(typeName)) return null;
  const own = fxBareConst(typeName);
  for (const [table, columns] of runSchemaColumnsByTable) {
    if (!columns.has(member)) continue;
    if (runSchemaModelNameForTable(table) === own) return table;
  }
  return null;
}

/** Scope tail the resolver's own-file candidate filter compares against. */
function fxScopeTail(def: SymbolDefinition): string {
  return def.scope[def.scope.length - 1] ?? "";
}

/**
 * Classify ONE typed-receiver member-lookup miss. Ordered most-specific first;
 * every branch names a single production seam so the report is directly a work
 * list rather than a taxonomy.
 */
function fxClassifyMemberLookup(record: FxMemberLookupMiss, ctx: CallContext): { cls: FxLookupClass; detail: string } {
  const { member } = record.miss;
  if (record.type.form !== "class" && record.type.form !== "instance") {
    return { cls: FX_LOOKUP.nonNominalType, detail: `${record.type.form} (${record.channel})` };
  }
  const typeName = record.type.name;
  const wantInstance = record.type.form !== "class";
  const primary = wantInstance
    ? resolveTypeInstanceMethod(typeName, member, ctx, "strict")
    : resolveTypeStaticMethod(typeName, member, ctx, "strict");
  if (primary !== null && primary.targetSymbolId !== null) {
    return { cls: FX_LOOKUP.channelGap, detail: `${primary.targetSymbolId} (${record.channel})` };
  }

  const alternate = wantInstance
    ? resolveTypeStaticMethod(typeName, member, ctx, "strict")
    : resolveTypeInstanceMethod(typeName, member, ctx, "strict");
  if (alternate !== null && alternate.targetSymbolId !== null) {
    return {
      cls: FX_LOOKUP.formMismatch,
      detail: `env says ${record.type.form}, def is ${wantInstance ? "class" : "instance"}-form: ${alternate.targetSymbolId}`,
    };
  }

  const typeFile = resolveConstant(typeName, ctx);
  if (typeFile === null && runAncestors[typeName] === undefined) {
    // Trace the FACT, not just the failure: for a `localCallBindings` receiver the
    // binding text IS the structuredReturnTypes coordinate the type came from, so
    // the report names the annotation that has to change.
    const binding = ctx.localCallBindings?.[record.miss.receiver ?? ""];
    const provenance = binding === undefined ? record.channel : `${record.channel} via ${binding}`;
    const declared = fxClassFqByBareName.get(fxBareConst(typeName));
    if (declared !== undefined && declared.size > 0) {
      const cls = declared.size === 1 ? FX_LOOKUP.typeNameUnqualified : FX_LOOKUP.typeNameAmbiguous;
      return { cls, detail: `${typeName} → ${[...declared].slice(0, 3).join(" | ")}  [${provenance}]` };
    }
    return { cls: FX_LOOKUP.typeNotAProjectConstant, detail: `${typeName}  [${provenance}]` };
  }

  const defs = symbolTable.lookupByShortName(member, { includeSchemaColumns: true });

  if (typeFile !== null) {
    const sameFile = defs.filter((d) => d.relPath === typeFile);
    if (sameFile.length > 0) {
      return {
        cls: FX_LOOKUP.scopeTailMismatch,
        detail: `type=${typeName} tails=[${[...new Set(sameFile.map(fxScopeTail))].slice(0, 3).join(", ")}]`,
      };
    }
  }

  const classMethodsDef = defs.find((d) => fxScopeTail(d) === "ClassMethods");
  const extended = runExtends[typeName];
  if (extended !== undefined) {
    const viaExtend = defs.find((d) => fxScopeTail(d) === extended || fxScopeTail(d) === fxBareConst(extended));
    if (viaExtend !== undefined) {
      return { cls: FX_LOOKUP.extendChannel, detail: `${typeName} extends ${extended} → ${viaExtend.symbolId}` };
    }
  }

  const ancestors = fxAncestorsOf(typeName);
  const ancestorNames = new Set<string>(ancestors);
  const ancestorBare = new Set(ancestors.map(fxBareConst));
  const onAncestor = defs.find((d) => ancestorNames.has(fxScopeTail(d)) || ancestorBare.has(fxScopeTail(d)));
  if (onAncestor !== undefined) {
    const ancestor = ancestors.find((a) => a === fxScopeTail(onAncestor) || fxBareConst(a) === fxScopeTail(onAncestor));
    const ancestorFile = ancestor === undefined ? null : resolveConstant(ancestor, ctx);
    return {
      cls: FX_LOOKUP.ancestorFileUnresolved,
      detail: `${typeName} → ${ancestor ?? "?"}: def@${onAncestor.relPath}, resolveConstant=${ancestorFile ?? "null"}`,
    };
  }

  if (classMethodsDef !== undefined) {
    return { cls: FX_LOOKUP.concernClassMethods, detail: `${typeName}.${member} → ${classMethodsDef.symbolId}` };
  }

  const table = fxUnmappedSchemaColumn(typeName, member);
  if (table !== null) return { cls: FX_LOOKUP.schemaColumnUnmapped, detail: `${typeName} ← table ${table}` };

  if (!realDefShortNames.has(member)) {
    const witness = typeFile === null ? null : fxMacroWitness(typeFile, member);
    return {
      cls: FX_LOOKUP.macroSynthesized,
      detail: witness ?? `no witness in ${typeFile ?? "?"} — declared elsewhere`,
    };
  }

  return {
    cls: FX_LOOKUP.absentOnType,
    detail: `${typeName} (${record.channel}); defs@${[...new Set(defs.map((d) => d.relPath))].slice(0, 2).join(", ")}`,
  };
}

/** Classify + print + return the JSON slice for the member-lookup residual. */
function fxReportMemberLookup(
  records: readonly FxMemberLookupMiss[],
  fieldsByFile: Map<string, Record<string, Record<string, string>>>,
  mergedReturns: Record<string, RubyTypeRef>,
): Record<string, unknown> {
  const L = (s: string) => {
    console.log(s);
  };
  const byClass = new Map<FxLookupClass, FxMemberLookupMiss[]>();
  const detailsByClass = new Map<FxLookupClass, Map<string, number>>();
  const byChannel: Record<string, number> = {};
  const byMember = new Map<string, number>();
  const byType = new Map<string, number>();
  const samples: Record<string, { member: string; type: string; at: string; caller: string; detail: string }[]> = {};

  for (const record of records) {
    const ctx = fxCtx(
      record.miss.relPath,
      record.miss.callerSymbolId,
      record.miss.enclosingScope === "" ? [] : record.miss.enclosingScope.split(" > "),
      fieldsByFile,
      mergedReturns,
    );
    const { cls, detail } = fxClassifyMemberLookup(record, ctx);
    const bucket = byClass.get(cls);
    if (bucket) bucket.push(record);
    else byClass.set(cls, [record]);
    const details = detailsByClass.get(cls) ?? new Map<string, number>();
    details.set(detail, (details.get(detail) ?? 0) + 1);
    detailsByClass.set(cls, details);
    byChannel[record.channel] = (byChannel[record.channel] ?? 0) + 1;
    byMember.set(record.miss.member, (byMember.get(record.miss.member) ?? 0) + 1);
    byType.set(fxTypeLabel(record.type), (byType.get(fxTypeLabel(record.type)) ?? 0) + 1);
    (samples[cls] ??= []).push({
      member: record.miss.member,
      type: fxTypeLabel(record.type),
      at: `${record.miss.relPath}:${record.miss.line}`,
      caller: record.miss.callerSymbolId,
      detail,
    });
  }

  const ranked = [...byClass.entries()].sort((a, b) => b[1].length - a[1].length);
  L("");
  L("─── typed-receiver MEMBER-LOOKUP residual (bd 1g7kz) ──────────────");
  L(`total: ${records.length}`);
  L("");
  L("  by TYPING CHANNEL (production channels vs fixpoint-only):");
  for (const [channel, n] of Object.entries(byChannel).sort((a, b) => b[1] - a[1])) {
    L(`  ${String(n).padStart(6)}  ${channel}`);
  }
  L("");
  L("  by CAUSE CLASS:");
  for (const [cls, group] of ranked) L(`  ${String(group.length).padStart(6)}  ${cls}`);
  L("");
  for (const [cls, group] of ranked) {
    L(`  ── ${cls} (${group.length}) ──`);
    const details = [...(detailsByClass.get(cls) ?? new Map<string, number>()).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    for (const [detail, n] of details) L(`     x${String(n).padStart(4)}  ${detail}`);
    for (const sample of (samples[cls] ?? []).slice(0, 3)) {
      L(`       e.g. ${sample.type}.${sample.member}  @ ${sample.at}`);
    }
    L("");
  }
  L("  top members / receiver types:");
  const topMembers = [...byMember.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const topTypes = [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [name, n] of topMembers) L(`  ${String(n).padStart(6)}  member ${name}`);
  for (const [name, n] of topTypes) L(`  ${String(n).padStart(6)}  type   ${name}`);
  L("");

  return {
    total: records.length,
    byChannel,
    byClass: Object.fromEntries(ranked.map(([cls, group]) => [cls, group.length])),
    detailsByClass: Object.fromEntries(
      ranked.map(([cls]) => [
        cls,
        Object.fromEntries(
          [...(detailsByClass.get(cls) ?? new Map<string, number>()).entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20),
        ),
      ]),
    ),
    topMembers: topMembers.map(([member, count]) => ({ member, count })),
    topTypes: topTypes.map(([type, count]) => ({ type, count })),
    samples: Object.fromEntries(ranked.map(([cls]) => [cls, (samples[cls] ?? []).slice(0, 12)])),
  };
}

/**
 * One full variant: waves to convergence, converged re-resolve, miss diff,
 * residual causes, printed section. `useKwargs` selects the substrate — OFF is
 * the fixpoint Increment 1's positional machinery could carry as-is, ON is the
 * fixpoint that also binds keyword arguments by NAME (which Increment 2 would
 * have to build, because Ruby service objects are kwarg-shaped).
 */
function fxRunVariant(extractions: FileExtraction[], useKwargs: boolean): Record<string, unknown> {
  const t0 = Date.now();
  const L = (s: string) => {
    console.log(s);
  };
  const label = useKwargs ? "positional + KEYWORD arguments" : "positional arguments only (bvalc substrate)";

  const { env, waves, converged, cycle } = fxRunWaves(useKwargs);
  const waveMs = Date.now() - t0;

  const scoreStart = Date.now();
  const pass = fxResolvePass(extractions, env);
  const scoreMs = Date.now() - scoreStart;

  // ── multiset diff vs the baseline miss set ────────────────────────────────
  const remaining = new Map(pass.missKeys);
  const addressableByKind: Record<string, number> = {};
  const residualByKind: Record<string, number> = {};
  const addressableMembers = new Map<string, number>();
  const residualCause: Record<string, number> = {};
  const residualCauseByKind: Record<string, Record<string, number>> = {};
  const addressableSamples: { member: string; receiver: string | null; kind: string; at: string }[] = [];
  /** bd 1g7kz — every residual whose receiver the environment DID type. */
  const memberLookupMisses: FxMemberLookupMiss[] = [];

  const mergedReturns: Record<string, RubyTypeRef> = { ...runStructuredReturnTypes, ...env.returnTypes };
  const fieldsByFile = new Map<string, Record<string, Record<string, string>>>();
  for (const relPath of fxFileClassFields.keys()) {
    fieldsByFile.set(relPath, fxMergeClassFields(fxFileClassFields.get(relPath) ?? {}, env.ivarTypes));
  }

  for (const miss of misses) {
    const key = fxMissKey(miss.relPath, miss.line, miss.member, miss.receiver, miss.callerSymbolId);
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      residualByKind[miss.receiverKind] = (residualByKind[miss.receiverKind] ?? 0) + 1;
      // Did the environment type the receiver even though the member missed?
      // Same shapes and same channel precedence as `fxTypeOf`, but keeping the
      // ANSWER and its provenance so the member-lookup forensics (bd 1g7kz) can
      // classify the failure instead of only counting it.
      let typedReceiver = false;
      let typeResolvable = false;
      if (miss.receiver !== null && miss.receiverKind !== "bareCall") {
        const ctx = fxCtx(
          miss.relPath,
          miss.callerSymbolId,
          miss.enclosingScope === "" ? [] : miss.enclosingScope.split(" > "),
          fieldsByFile,
          mergedReturns,
        );
        const shape: FxExpr = miss.receiver.startsWith("@")
          ? { k: "ivar", name: miss.receiver }
          : { k: "ident", name: miss.receiver };
        if (!miss.receiver.includes(".") && !miss.receiver.includes("[")) {
          const answer = fxTypedReceiverOf(shape, miss.callerSymbolId, miss.line, ctx, env);
          typedReceiver = answer !== undefined;
          if (answer !== undefined) {
            typeResolvable = fxReceiverTypeResolvable(answer.type, ctx);
            memberLookupMisses.push({ miss, type: answer.type, channel: answer.channel });
          }
        }
      }
      const cause = fxClassifyResidual(miss, env, typedReceiver, typeResolvable);
      residualCause[cause] = (residualCause[cause] ?? 0) + 1;
      (residualCauseByKind[miss.receiverKind] ??= {})[cause] =
        ((residualCauseByKind[miss.receiverKind] ??= {})[cause] ?? 0) + 1;
    } else {
      addressableByKind[miss.receiverKind] = (addressableByKind[miss.receiverKind] ?? 0) + 1;
      addressableMembers.set(miss.member, (addressableMembers.get(miss.member) ?? 0) + 1);
      if (addressableSamples.length < 40) {
        addressableSamples.push({
          member: miss.member,
          receiver: miss.receiver,
          kind: miss.receiverKind,
          at: `${miss.relPath}:${miss.line}`,
        });
      }
    }
  }
  // Whatever is still unconsumed in `remaining` is a miss the fixpoint CREATED.
  let regressions = 0;
  for (const n of remaining.values()) regressions += n;

  const addressableTotal = Object.values(addressableByKind).reduce((a, b) => a + b, 0);
  const topMembers = [...addressableMembers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const bvalcParams = Object.values(runParamTypes).reduce((n, p) => n + Object.keys(p).length, 0);
  const bvalcIvars = Object.values(runDerivedClassFieldTypes).reduce((n, f) => n + Object.keys(f).length, 0);
  const last = waves[waves.length - 1];

  L("");
  L("═══════════════════════════════════════════════════════════════════");
  L(`  FIXPOINT ORACLE — VARIANT: ${label}`);
  L("═══════════════════════════════════════════════════════════════════");
  L(`scope:                   ${FIXPOINT_WIDE ? "WIDE (any resolvable target)" : "BOUNDED (const-receiver + bare)"}`);
  L(`call sites scanned:      ${fxSites.length}  (silent=${fxSilentSites}, kwarg-bearing=${fxKwargSites})`);
  L(`method tails scanned:    ${fxTails.length}`);
  L(
    `convergence:             ${converged ? `CONVERGED after ${waves.length} waves` : cycle ? `CYCLE detected at wave ${waves.length}` : `CAP HIT (${FIXPOINT_MAX_WAVES} waves, NOT converged)`}`,
  );
  L("");
  L("─── per-wave growth ───────────────────────────────────────────────");
  L("wave   params  callees   ivars  returns   sites      s");
  for (const w of waves) {
    L(
      `${String(w.wave).padStart(4)}  ${String(w.paramsTyped).padStart(7)}  ${String(w.calleesTyped).padStart(7)}  ` +
        `${String(w.ivarsTyped).padStart(6)}  ${String(w.returnsTyped).padStart(7)}  ${String(w.contributingSites).padStart(6)}  ${(w.ms / 1000).toFixed(1).padStart(5)}`,
    );
  }
  L("");
  L("─── converged environment vs wave-0 (bvalc) baseline ──────────────");
  L(`known-target sites:      ${runKnownTargetCallArgs.size}  ->  ${last?.contributingSites ?? 0}`);
  L(`params typed:            ${bvalcParams}  ->  ${last?.paramsTyped ?? 0}`);
  L(`callees with a typed param: ${Object.keys(runParamTypes).length}  ->  ${last?.calleesTyped ?? 0}`);
  L(`ivars derived:           ${bvalcIvars}  ->  ${last?.ivarsTyped ?? 0}`);
  L(`return types derived:    0  ->  ${last?.returnsTyped ?? 0}`);
  L("");
  L("─── ADDRESSABLE MISSES at convergence ─────────────────────────────");
  L("kind          baselineHole   addressable    residual    share");
  for (const kind of RECEIVER_KINDS) {
    const t = kindTally[kind];
    const hole = t.attempted - t.resolved - t.externalSkipped - t.unresolvable - t.noInProjectDef - t.coreAmbiguous;
    if (hole === 0) continue;
    const addressable = addressableByKind[kind] ?? 0;
    L(
      `${kind.padEnd(12)}  ${String(hole).padStart(12)}  ${String(addressable).padStart(11)}  ` +
        `${String(residualByKind[kind] ?? 0).padStart(10)}  ${((addressable / hole) * 100).toFixed(1).padStart(6)}%`,
    );
  }
  const baselineHole =
    callsAttempted -
    callsResolved -
    callsExternalSkipped -
    callsUnresolvable -
    callsNoInProjectDef -
    callsCoreAmbiguous;
  L(
    `${"TOTAL".padEnd(12)}  ${String(baselineHole).padStart(12)}  ${String(addressableTotal).padStart(11)}  ` +
      `${String(baselineHole - addressableTotal).padStart(10)}  ${((addressableTotal / Math.max(1, baselineHole)) * 100).toFixed(1).padStart(6)}%`,
  );
  L(`fixpoint-INTRODUCED misses (regressions): ${regressions}`);
  L("");
  L("─── never-typeable residual, by cause ─────────────────────────────");
  for (const [cause, n] of Object.entries(residualCause).sort((a, b) => b[1] - a[1])) {
    L(`  ${String(n).padStart(6)}  ${cause}`);
  }
  L("");
  // bd 1g7kz — only for the PRODUCTION substrate: the kwarg variant's substrate
  // does not exist, so classifying its lookup failures would name seams for a
  // codebase state nobody can ship against.
  const memberLookup = useKwargs ? undefined : fxReportMemberLookup(memberLookupMisses, fieldsByFile, mergedReturns);
  L("─── top 15 members among ADDRESSABLE misses ───────────────────────");
  for (const [member, n] of topMembers) L(`  ${String(n).padStart(6)}  ${member}`);
  L("");
  L("─── converged pass aggregate ──────────────────────────────────────");
  const convergedInternal = Math.max(
    1,
    pass.attempted - pass.externalSkipped - pass.unresolvable - pass.noInProjectDef - pass.coreAmbiguous,
  );
  L(`callsResolved:           ${callsResolved}  ->  ${pass.resolved}`);
  L(`missWithInProjectDef:    ${baselineHole}  ->  ${pass.hole}`);
  L(`resolveSuccessRate:      ${fmtPct(resolveSuccessRateBaseline)}  ->  ${fmtPct(pass.resolved / convergedInternal)}`);
  L("");
  L(
    `waves: ${(waveMs / 1000).toFixed(1)}s   scoring: ${(scoreMs / 1000).toFixed(1)}s   ` +
      `variant total: ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );

  return {
    variant: useKwargs ? "positional+kwargs" : "positional-only",
    converged,
    cycle,
    wavesRun: waves.length,
    waveSeconds: waveMs / 1000,
    scoringSeconds: scoreMs / 1000,
    waves,
    baselineEnvironment: {
      knownTargetSites: runKnownTargetCallArgs.size,
      paramsTyped: bvalcParams,
      calleesTyped: Object.keys(runParamTypes).length,
      ivarsDerived: bvalcIvars,
      returnsDerived: 0,
    },
    convergedEnvironment: {
      knownTargetSites: last?.contributingSites ?? 0,
      paramsTyped: last?.paramsTyped ?? 0,
      calleesTyped: last?.calleesTyped ?? 0,
      ivarsDerived: last?.ivarsTyped ?? 0,
      returnsDerived: last?.returnsTyped ?? 0,
    },
    addressable: {
      total: addressableTotal,
      baselineHole,
      regressions,
      byReceiverKind: Object.fromEntries(
        RECEIVER_KINDS.map((kind) => {
          const t = kindTally[kind];
          const hole =
            t.attempted - t.resolved - t.externalSkipped - t.unresolvable - t.noInProjectDef - t.coreAmbiguous;
          return [
            kind,
            { baselineHole: hole, addressable: addressableByKind[kind] ?? 0, residual: residualByKind[kind] ?? 0 },
          ];
        }),
      ),
      topMembers: topMembers.map(([member, count]) => ({ member, count })),
      samples: addressableSamples,
    },
    residual: { byCause: residualCause, byKindAndCause: residualCauseByKind },
    ...(memberLookup === undefined ? {} : { memberLookup }),
    convergedPass: {
      attempted: pass.attempted,
      resolved: pass.resolved,
      externalSkipped: pass.externalSkipped,
      unresolvable: pass.unresolvable,
      noInProjectDef: pass.noInProjectDef,
      coreAmbiguous: pass.coreAmbiguous,
      hole: pass.hole,
      resolveSuccessRate: pass.resolved / convergedInternal,
      byReceiverKind: pass.kindTally,
    },
  };
}

/**
 * Both variants in one run — the positional-only fixpoint is the ceiling of the
 * substrate that exists, the kwarg-extended one is the ceiling of the substrate
 * Increment 2 would have to build. Reporting one without the other would answer
 * the wrong question: the difference between them IS the funding decision.
 */
function runFixpointOracle(extractions: FileExtraction[], elapsedBeforeMs: number): void {
  const t0 = Date.now();
  console.error(
    `[fixpoint] scan: sites=${fxSites.length} tails=${fxTails.length} ` +
      `silentSites=${fxSilentSites} kwargBearing=${fxKwargSites} ` +
      `kwargDeclaringMethods=${Object.keys(runKwargNames).length} scope=${FIXPOINT_WIDE ? "wide" : "bounded"}`,
  );
  const positionalOnly = fxRunVariant(extractions, false);
  const withKwargs = fxRunVariant(extractions, true);

  console.log("─── VARIANT COMPARISON ────────────────────────────────────────────");
  for (const v of [positionalOnly, withKwargs]) {
    const a = v.addressable as { total: number; baselineHole: number };
    const e = v.convergedEnvironment as { paramsTyped: number; ivarsDerived: number };
    console.log(
      `  ${String(v.variant).padEnd(18)} params=${String(e.paramsTyped).padStart(6)} ` +
        `ivars=${String(e.ivarsDerived).padStart(5)} addressable=${String(a.total).padStart(6)} ` +
        `(${((a.total / Math.max(1, a.baselineHole)) * 100).toFixed(1)}% of the ${a.baselineHole} hole)  ` +
        `waves=${String(v.wavesRun)}`,
    );
  }
  console.log("");

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    OUT_FIXPOINT,
    JSON.stringify(
      {
        meta: {
          bead: "tea-rags-mcp-a2hrq",
          root: ROOT,
          generatedAt: new Date().toISOString(),
          scope: FIXPOINT_WIDE ? "wide" : "bounded",
          maxWaves: FIXPOINT_MAX_WAVES,
          scanSites: fxSites.length,
          scanTails: fxTails.length,
          silentSites: fxSilentSites,
          kwargBearingSites: fxKwargSites,
          kwargDeclaringMethods: Object.keys(runKwargNames).length,
          classFieldParamLinks: Object.values(runClassFieldParamLinks).reduce((n, f) => n + Object.keys(f).length, 0),
          harnessBeforeOracleSeconds: elapsedBeforeMs / 1000,
          oracleSeconds: (Date.now() - t0) / 1000,
        },
        baselinePass: {
          callsAttempted,
          callsResolved,
          missWithInProjectDef:
            callsAttempted -
            callsResolved -
            callsExternalSkipped -
            callsUnresolvable -
            callsNoInProjectDef -
            callsCoreAmbiguous,
          resolveSuccessRate: resolveSuccessRateBaseline,
          byReceiverKind: Object.fromEntries(
            RECEIVER_KINDS.map((kind) => {
              const t = kindTally[kind];
              return [
                kind,
                {
                  ...t,
                  recallHole:
                    t.attempted - t.resolved - t.externalSkipped - t.unresolvable - t.noInProjectDef - t.coreAmbiguous,
                },
              ];
            }),
          ),
        },
        variants: { positionalOnly, withKwargs },
      },
      null,
      2,
    ),
  );
  console.log(`fixpoint oracle report → ${OUT_FIXPOINT}`);
  console.log("");
}

// ===========================================================================
// UNTYPED-LOCAL CENSUS (CODEGRAPH_LOCAL_CENSUS=1, bd tea-rags-mcp-02saq)
//
// The fixpoint oracle's residual named one bucket larger than everything the
// fixpoint itself could address: misses whose receiver is a LOCAL the walker
// records NO binding for. "Untyped local" is not a shape, though — it is the
// ABSENCE of one, and a walker-side widening has to know which syntactic forms
// carry the mass before it widens into any of them. This section sub-censuses
// the bucket by the form that INTRODUCED the local (`rescue Const => e`,
// destructuring target, block parameter, `params[:x]` read, …) and, where the
// form carries a constant, probes the symbol table for whether the miss would
// then resolve — so the implementation order is decided by measured mass and
// measured addressability, not intuition.
//
// Same additive, env-gated contract as the three oracles above: with
// CODEGRAPH_LOCAL_CENSUS unset nothing extra is scanned or reported and the A/B
// recall metrics are byte-identical.
// ===========================================================================
// The def-param oracle (bd tea-rags-mcp-jawn8) consumes the census records as
// its numerator, so its flag implies this scan.
const LOCAL_CENSUS_ENABLED =
  process.env.CODEGRAPH_LOCAL_CENSUS === "1" || process.env.CODEGRAPH_DEFPARAM_ORACLE === "1";
const OUT_LOCAL_CENSUS = join(OUT_DIR, "untyped-local-census.json");

/** The syntactic forms that introduce a local binding. Value = report label. */
const LC_SHAPE = {
  rescueConstSingle: "rescue Const => e             (ONE constant class)",
  rescueConstMulti: "rescue A, B => e              (constant union)",
  rescueBare: "rescue => e                   (no class list)",
  multiAssignPaired: "a, b = x, y                   (paired RHS list)",
  multiAssignSplit: "a, b = <expr>                 (destructured single RHS)",
  multiAssignSplat: "a, *rest = …                  (splat target)",
  blockParamIterator: "block param of a KNOWN iterator (VTA-OUT)",
  blockParamOther: "block param of a non-iterator block",
  blockParamDestructured: "destructured block param |(a, b)|",
  patternAsConst: "pattern match `in Const => v`",
  patternOther: "pattern-match binding (no constant)",
  forVar: "for v in coll",
  defParamOptional: "def param: optional (x = default)",
  defParamKeyword: "def param: keyword (x:)",
  defParamSplat: "def param: splat (*a / **kw)",
  defParamBlock: "def param: block (&blk)",
  defParamPositional: "def param: positional past the leading required run",
  assignIndex: "x = h[:k] / params[:k]        (index read)",
  assignCallBare: "x = bare_call(...)            (no receiver)",
  assignCallRecv: "x = recv.call(...)            (receiver-ful)",
  assignIdent: "x = y                         (bare identifier RHS)",
  assignCopyTypedSource: "x = y   where y IS typed here (propagation gap)",
  assignCopyUntypedSource: "x = y   where y is itself untyped",
  assignBareIdentCall: "x = paren_less_call           (identifier that is no local)",
  assignIvar: "x = @ivar",
  assignLiteral: "x = <literal>",
  assignConditional: "x = if / case / ternary / begin",
  assignYield: "x = yield",
  assignOther: "x = <other expression>",
  opAssign: "x ||= / += / &&= …",
  introAfterUse: "introduced only AFTER the call line (flow order)",
  noIntro: "no introduction found in the owning chunk",
} as const;
type LcShape = (typeof LC_SHAPE)[keyof typeof LC_SHAPE];

/** One recorded introduction of a local name inside one chunk. */
interface LcIntro {
  readonly shape: LcShape;
  readonly line: number;
  /** Constant the form carries when it carries one (`rescue Foo => e` → `Foo`). */
  readonly typeHint?: string;
  /** Free-form provenance for the report (iterator verb, RHS node type, …). */
  readonly note?: string;
}

/** chunkSymbolId → localName → introductions (push order = source order). */
const lcIntros = new Map<string, Map<string, LcIntro[]>>();

/** A bare local identifier: no `.`, no `[`, no `@`, no `::`. */
const LC_LOCAL_RE = /^[a-z_][A-Za-z0-9_]*$/;

function lcRecordIntro(chunkId: string | undefined, name: string, intro: LcIntro): void {
  if (chunkId === undefined || chunkId === "") return;
  let byName = lcIntros.get(chunkId);
  if (byName === undefined) {
    byName = new Map<string, LcIntro[]>();
    lcIntros.set(chunkId, byName);
  }
  const list = byName.get(name);
  if (list === undefined) byName.set(name, [intro]);
  else list.push(intro);
}

/** Constant text of a node, or null when it is not a plain/`::`-qualified constant. */
function lcConstText(node: AstNode): string | null {
  const text =
    node.type === "scope_resolution" ? readScopeResolution(node) : node.type === "constant" ? node.text : null;
  return text !== null && FX_CONST_RE.test(text) ? text.replace(/^::/, "") : null;
}

const LC_LITERAL_TYPES = new Set([
  "string",
  "integer",
  "float",
  "rational",
  "complex",
  "array",
  "hash",
  "symbol",
  "simple_symbol",
  "hash_key_symbol",
  "delimited_symbol",
  "true",
  "false",
  "nil",
  "regex",
  "string_array",
  "symbol_array",
  "character",
  "heredoc_beginning",
  "subshell",
  "lambda",
  "unary",
]);
const LC_CONDITIONAL_TYPES = new Set([
  "conditional",
  "if",
  "unless",
  "case",
  "case_match",
  "begin",
  "while",
  "until",
  "parenthesized_statements",
]);

/** Shape of a single-target assignment, read off the RHS node. */
function lcAssignShape(rhs: AstNode | null): { shape: LcShape; note?: string } {
  if (rhs === null) return { shape: LC_SHAPE.assignOther };
  if (rhs.type === "element_reference") {
    const base = rhs.childForFieldName("object");
    return { shape: LC_SHAPE.assignIndex, note: base?.text.slice(0, 24) };
  }
  if (rhs.type === "call" || rhs.type === "method_call") {
    const receiver = rhs.childForFieldName("receiver");
    const method = rhs.childForFieldName("method")?.text;
    return receiver === null
      ? { shape: LC_SHAPE.assignCallBare, note: method }
      : { shape: LC_SHAPE.assignCallRecv, note: method };
  }
  if (rhs.type === "identifier") return { shape: LC_SHAPE.assignIdent, note: rhs.text };
  if (rhs.type === "instance_variable" || rhs.type === "class_variable") {
    return { shape: LC_SHAPE.assignIvar, note: rhs.text };
  }
  if (rhs.type === "yield") return { shape: LC_SHAPE.assignYield };
  if (LC_LITERAL_TYPES.has(rhs.type)) return { shape: LC_SHAPE.assignLiteral, note: rhs.type };
  if (LC_CONDITIONAL_TYPES.has(rhs.type)) return { shape: LC_SHAPE.assignConditional, note: rhs.type };
  return { shape: LC_SHAPE.assignOther, note: rhs.type };
}

/** `method_parameters` child → the shape its flavour maps to, plus bound name. */
function lcDefParamShape(node: AstNode): { shape: LcShape; name: string } | null {
  if (node.type === "identifier") return { shape: LC_SHAPE.defParamPositional, name: node.text };
  const name = node.childForFieldName("name");
  if (name?.type !== "identifier") return null;
  if (node.type === "optional_parameter") return { shape: LC_SHAPE.defParamOptional, name: name.text };
  if (node.type === "keyword_parameter") return { shape: LC_SHAPE.defParamKeyword, name: name.text };
  if (node.type === "splat_parameter" || node.type === "hash_splat_parameter") {
    return { shape: LC_SHAPE.defParamSplat, name: name.text };
  }
  if (node.type === "block_parameter") return { shape: LC_SHAPE.defParamBlock, name: name.text };
  return null;
}

/** Every bound name under a `destructured_parameter`, flattened. */
function lcDestructuredNames(node: AstNode, out: string[]): void {
  for (const child of node.namedChildren) {
    if (child.type === "identifier") out.push(child.text);
    else if (child.type === "destructured_parameter") lcDestructuredNames(child, out);
  }
}

/** ONE extra DFS per file, attributing each local introduction to its chunk. */
function scanLocalCensusAst(root: AstNode, extraction: FileExtraction): void {
  const owners = fxLineOwners(extraction);
  const ownerIdAt = (line: number): string | undefined => (line < owners.length ? owners[line]?.symbolId : undefined);
  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    const line = node.startPosition.row + 1;
    const chunkId = ownerIdAt(line);

    if (node.type === "rescue") {
      const varNode = node.children.find((c) => c.type === "exception_variable");
      const bound = varNode?.namedChildren[0];
      if (bound?.type === "identifier") {
        const exceptions = node.children.find((c) => c.type === "exceptions");
        const declared = exceptions?.namedChildren ?? [];
        const consts = declared.map(lcConstText).filter((c): c is string => c !== null);
        const allConst = declared.length > 0 && consts.length === declared.length;
        const shape = !allConst
          ? LC_SHAPE.rescueBare
          : consts.length === 1
            ? LC_SHAPE.rescueConstSingle
            : LC_SHAPE.rescueConstMulti;
        lcRecordIntro(chunkId, bound.text, {
          shape,
          line: bound.startPosition.row + 1,
          ...(shape === LC_SHAPE.rescueConstSingle ? { typeHint: consts[0] } : {}),
          ...(consts.length > 0 ? { note: consts.join(",") } : {}),
        });
      }
    } else if (node.type === "assignment") {
      const lhs = node.childForFieldName("left");
      const rhs = node.childForFieldName("right");
      if (lhs?.type === "identifier") {
        const { shape, note } = lcAssignShape(rhs);
        lcRecordIntro(chunkId, lhs.text, { shape, line, ...(note !== undefined ? { note } : {}) });
      } else if (lhs?.type === "left_assignment_list") {
        const paired = rhs?.type === "right_assignment_list";
        for (const target of lhs.namedChildren) {
          if (target.type === "identifier") {
            lcRecordIntro(chunkId, target.text, {
              shape: paired ? LC_SHAPE.multiAssignPaired : LC_SHAPE.multiAssignSplit,
              line,
              ...(rhs !== null ? { note: rhs.type } : {}),
            });
          } else if (target.type === "rest_assignment") {
            const inner = target.namedChildren.find((c) => c.type === "identifier");
            if (inner) lcRecordIntro(chunkId, inner.text, { shape: LC_SHAPE.multiAssignSplat, line });
          }
        }
      }
    } else if (node.type === "operator_assignment") {
      const lhs = node.childForFieldName("left");
      if (lhs?.type === "identifier") {
        lcRecordIntro(chunkId, lhs.text, {
          shape: LC_SHAPE.opAssign,
          line,
          note: node.children.find((c) => c.text.endsWith("="))?.text,
        });
      }
    } else if (node.type === "for") {
      const pattern = node.childForFieldName("pattern");
      if (pattern?.type === "identifier") lcRecordIntro(chunkId, pattern.text, { shape: LC_SHAPE.forVar, line });
    } else if (node.type === "as_pattern") {
      const bound = node.childForFieldName("name");
      const value = node.childForFieldName("value");
      if (bound?.type === "identifier") {
        const konst = value === null ? null : lcConstText(value);
        lcRecordIntro(chunkId, bound.text, {
          shape: konst !== null ? LC_SHAPE.patternAsConst : LC_SHAPE.patternOther,
          line,
          ...(konst !== null ? { typeHint: konst } : {}),
        });
      }
    } else if (node.type === "in_clause") {
      const pattern = node.childForFieldName("pattern");
      if (pattern !== null) {
        const sub: AstNode[] = [pattern];
        while (sub.length > 0) {
          const p = sub.pop();
          if (p === undefined) break;
          if (p.type === "identifier" && p.parent?.type !== "as_pattern") {
            lcRecordIntro(chunkId, p.text, { shape: LC_SHAPE.patternOther, line: p.startPosition.row + 1 });
          }
          for (const c of p.namedChildren) sub.push(c);
        }
      }
    } else if (node.type === "block" || node.type === "do_block") {
      const params = node.childForFieldName("parameters");
      if (params !== null) {
        const { parent } = node;
        const method = parent?.childForFieldName("method")?.text;
        const iterator = method !== undefined && RUBY_BLOCK_ITERATOR_METHODS.has(method);
        const pline = params.startPosition.row + 1;
        for (const param of params.namedChildren) {
          if (param.type === "identifier") {
            lcRecordIntro(chunkId, param.text, {
              shape: iterator ? LC_SHAPE.blockParamIterator : LC_SHAPE.blockParamOther,
              line: pline,
              ...(method !== undefined ? { note: method } : {}),
            });
          } else if (param.type === "destructured_parameter") {
            const names: string[] = [];
            lcDestructuredNames(param, names);
            for (const name of names) {
              lcRecordIntro(chunkId, name, { shape: LC_SHAPE.blockParamDestructured, line: pline });
            }
          } else {
            const flavour = lcDefParamShape(param);
            if (flavour !== null) {
              lcRecordIntro(chunkId, flavour.name, {
                shape: LC_SHAPE.blockParamOther,
                line: pline,
                note: param.type,
              });
            }
          }
        }
      }
    } else if (node.type === "method" || node.type === "singleton_method") {
      const params = node.childForFieldName("parameters");
      if (params !== null) {
        for (const param of params.namedChildren) {
          const flavour = lcDefParamShape(param);
          if (flavour !== null) {
            lcRecordIntro(chunkId, flavour.name, { shape: flavour.shape, line, note: param.type });
          }
        }
      }
    }

    for (const c of node.children) stack.push(c);
  }
}

/** Which bucket the baseline pass put a call in — the census needs ALL of them,
 *  not only misses: binding a local that today resolves (or is carved out as a
 *  core homonym on an UNTYPED receiver) can LOSE ground, and the exposure has to
 *  be counted before the widening is written, not after it regresses. */
type LcOutcome = "resolved" | "dynamicSend" | "externalSkipped" | "noInProjectDef" | "coreAmbiguous" | "miss";

/** One call on an unbound local, tagged with the form that introduced it. */
interface LcMissRecord {
  outcome: LcOutcome;
  shape: LcShape;
  member: string;
  receiver: string;
  kind: ReceiverKind;
  relPath: string;
  line: number;
  typeHint?: string;
  note?: string;
  /** Symbol-table probe: would `typeHint#member` (or an ancestor's) exist? */
  wouldResolve?: boolean;
  /** Is `typeHint` a class the PROJECT declares? A binding to an external class
   *  routes the unresolved call to `externalSkipped` (out of the honest
   *  denominator) via `localBindingTypedReceiverIsExternal`; a binding to an
   *  in-project class leaves it a typed member-lookup miss. */
  typeHintInProject?: boolean;
  /** The walker DID record `x = recv.meth` for this local — the gap is the
   *  callee's return type, not the binding (a different lead entirely). */
  viaLocalCallBinding?: boolean;
}
const lcRecords: LcMissRecord[] = [];

/**
 * Does the type the form carries actually DEFINE the missed member (directly or
 * through the run-global ancestor closure)? An upper-bound estimate of what a
 * binding would buy: the real resolver also consults includedBy / MRO order and
 * the external classifier, neither of which is simulated here.
 */
function lcWouldResolve(typeName: string, member: string): boolean {
  const seen = new Set<string>();
  let frontier = [typeName];
  for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const klass of frontier) {
      if (seen.has(klass)) continue;
      seen.add(klass);
      if (symbolTable.lookup(`${klass}#${member}`).length > 0) return true;
      if (symbolTable.lookup(`${klass}.${member}`).length > 0) return true;
      next.push(...(runAncestors[klass] ?? []));
    }
    frontier = next;
  }
  return false;
}

/**
 * The bucket predicate, mirroring the fixpoint classifier's `untypedLocal`
 * branch on the BASELINE environment: a plain lowercase receiver that is not a
 * declared parameter of its own method and for which the walker established NO
 * binding at (or before) the call's line. A receiver the walker DID bind is a
 * `memberNotFound` miss and belongs to the other successor lead.
 */
function noteLocalCensusCall(
  call: CallRef,
  receiverKind: ReceiverKind,
  relPath: string,
  chunk: ChunkExtraction,
  localBindings: Record<string, LocalBinding[]> | undefined,
  outcome: LcOutcome,
): void {
  const { receiver } = call;
  if (receiver === null || receiverKind === "bareCall" || receiverKind === "super") return;
  if (!LC_LOCAL_RE.test(receiver) || receiver === "self") return;
  if (chunk.paramNames?.includes(receiver) === true) return;
  if (chunk.kwargs !== undefined) {
    if (chunk.kwargs.required.includes(receiver)) return;
    if (chunk.kwargs.optional?.includes(receiver) === true) return;
  }
  if (resolveLocalBindingType(localBindings, receiver, call.startLine) !== undefined) return;

  const chunkIntros = lcIntros.get(chunk.symbolId);
  const intros = chunkIntros?.get(receiver) ?? [];
  const before = intros.filter((i) => i.line <= call.startLine);
  const chosen = before.length > 0 ? before[before.length - 1] : undefined;
  let shape = chosen !== undefined ? chosen.shape : intros.length > 0 ? LC_SHAPE.introAfterUse : LC_SHAPE.noIntro;
  // `x = y` is ambiguous in the grammar: a paren-less no-arg method call parses
  // as a bare `identifier`, exactly like a copy of a local. Split them here,
  // where the chunk's full introduction map exists — a name that is introduced
  // somewhere in this chunk is a local, anything else is a call. The copy case
  // splits again on whether the SOURCE is typed at this line: if it is, the
  // walker had the answer and failed to propagate it (a defect, not a widening).
  if (shape === LC_SHAPE.assignIdent) {
    const source = chosen?.note;
    if (source === undefined || chunkIntros?.has(source) !== true) shape = LC_SHAPE.assignBareIdentCall;
    else {
      shape =
        resolveLocalBindingType(localBindings, source, call.startLine) !== undefined
          ? LC_SHAPE.assignCopyTypedSource
          : LC_SHAPE.assignCopyUntypedSource;
    }
  }
  const typeHint = chosen?.typeHint;
  const record: LcMissRecord = {
    outcome,
    shape,
    member: call.member,
    receiver,
    kind: receiverKind,
    relPath,
    line: call.startLine,
  };
  if (chunk.localCallBindings?.[receiver] !== undefined) record.viaLocalCallBinding = true;
  if (typeHint !== undefined) {
    record.typeHint = typeHint;
    record.wouldResolve = lcWouldResolve(typeHint, call.member);
    record.typeHintInProject = symbolTable.lookup(typeHint).length > 0;
  }
  const note = chosen?.note ?? (intros.length > 0 ? intros[0].note : undefined);
  if (note !== undefined) record.note = note;
  lcRecords.push(record);
}

/** Printed census + JSON report. Runs after PASS-2, before the fixpoint oracle. */
function runLocalCensus(): void {
  const L = (s: string) => {
    console.log(s);
  };
  const missRecords = lcRecords.filter((r) => r.outcome === "miss");
  const total = missRecords.length;
  const byShape = new Map<LcShape, LcMissRecord[]>();
  for (const record of missRecords) {
    const list = byShape.get(record.shape);
    if (list === undefined) byShape.set(record.shape, [record]);
    else list.push(record);
  }
  const ranked = [...byShape.entries()].sort((a, b) => b[1].length - a[1].length);
  /** Every call on an unbound local, by shape — the EXPOSURE of a widening. */
  const exposureByShape = new Map<LcShape, LcMissRecord[]>();
  for (const record of lcRecords) {
    const list = exposureByShape.get(record.shape);
    if (list === undefined) exposureByShape.set(record.shape, [record]);
    else list.push(record);
  }

  // Corpus-wide denominator: every introduction the scan recorded, whether or
  // not any call on that local ever missed. Without it a small per-shape miss
  // count is unreadable — 40 misses on a form that occurs 50 times is a very
  // different lead from 40 misses on a form that occurs 40 000 times.
  const introCounts = new Map<LcShape, number>();
  let introTotal = 0;
  for (const byName of lcIntros.values()) {
    for (const list of byName.values()) {
      for (const intro of list) {
        introCounts.set(intro.shape, (introCounts.get(intro.shape) ?? 0) + 1);
        introTotal += 1;
      }
    }
  }

  L("");
  L("═══════════════════════════════════════════════════════════════════");
  L("  UNTYPED-LOCAL CENSUS — the walker-side widening bucket");
  L("═══════════════════════════════════════════════════════════════════");
  L(`misses whose receiver is an UNBOUND local: ${total}`);
  L(`chunks carrying recorded introductions:    ${lcIntros.size}`);
  L(`local introductions recorded (corpus):     ${introTotal}`);
  L("");
  L("─── every recorded introduction, by shape (the DENOMINATOR) ───────");
  for (const [shape, n] of [...introCounts.entries()].sort((a, b) => b[1] - a[1])) {
    L(`  ${String(n).padStart(7)}  ${shape}`);
  }
  L("");
  L(
    "shape                                             count   share   members  hint  wouldResolve  inProject  callBound",
  );
  for (const [shape, records] of ranked) {
    const members = new Set(records.map((r) => r.member)).size;
    const hinted = records.filter((r) => r.typeHint !== undefined).length;
    const resolves = records.filter((r) => r.wouldResolve === true).length;
    const inProject = records.filter((r) => r.typeHintInProject === true).length;
    const callBound = records.filter((r) => r.viaLocalCallBinding === true).length;
    L(
      `${shape.padEnd(46)}  ${String(records.length).padStart(6)}  ${((records.length / Math.max(1, total)) * 100).toFixed(1).padStart(5)}%  ` +
        `${String(members).padStart(7)}  ${String(hinted).padStart(4)}  ${String(resolves).padStart(12)}  ${String(inProject).padStart(9)}  ${String(callBound).padStart(9)}`,
    );
  }
  L("");
  L("─── EXPOSURE: every call on an unbound local of that shape ────────");
  L("(binding the local re-routes ALL of these, not only the misses — a call");
  L(" carved out as coreAmbiguous today needs an UNTYPED receiver to stay carved)");
  L("shape                                            calls  resolved   coreAmb  extSkip  noDef    miss");
  for (const [shape, records] of [...exposureByShape.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const n = (outcome: LcOutcome): number => records.filter((r) => r.outcome === outcome).length;
    L(
      `${shape.padEnd(46)}  ${String(records.length).padStart(5)}  ${String(n("resolved")).padStart(8)}  ` +
        `${String(n("coreAmbiguous")).padStart(8)}  ${String(n("externalSkipped")).padStart(7)}  ` +
        `${String(n("noInProjectDef")).padStart(5)}  ${String(n("miss")).padStart(6)}`,
    );
  }
  L("");
  L("─── by receiverKind (misses) ──────────────────────────────────────");
  const byKind: Record<string, number> = {};
  for (const record of missRecords) byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
  for (const [kind, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) L(`  ${String(n).padStart(6)}  ${kind}`);
  L("");
  for (const [shape, records] of ranked.slice(0, 8)) {
    L(`─── ${shape} (${records.length}) — top members ──`);
    const byMember = new Map<string, number>();
    for (const r of records) byMember.set(r.member, (byMember.get(r.member) ?? 0) + 1);
    for (const [member, n] of [...byMember.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      const ex = records.find((r) => r.member === member);
      L(
        `     ${member} (x${n})  e.g. ${ex?.relPath}:${ex?.line} on \`${ex?.receiver}\`${ex?.note ? ` [${ex.note}]` : ""}`,
      );
    }
    L("");
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    OUT_LOCAL_CENSUS,
    JSON.stringify(
      {
        meta: {
          bead: "tea-rags-mcp-02saq",
          root: ROOT,
          generatedAt: new Date().toISOString(),
          missesInBucket: total,
          callsOnUnboundLocals: lcRecords.length,
          introTotal,
        },
        introductionsByShape: Object.fromEntries([...introCounts.entries()].sort((a, b) => b[1] - a[1])),
        exposureByShape: Object.fromEntries(
          [...exposureByShape.entries()]
            .sort((a, b) => b[1].length - a[1].length)
            .map(([shape, records]) => [
              shape,
              {
                calls: records.length,
                resolved: records.filter((r) => r.outcome === "resolved").length,
                coreAmbiguous: records.filter((r) => r.outcome === "coreAmbiguous").length,
                externalSkipped: records.filter((r) => r.outcome === "externalSkipped").length,
                noInProjectDef: records.filter((r) => r.outcome === "noInProjectDef").length,
                miss: records.filter((r) => r.outcome === "miss").length,
              },
            ]),
        ),
        byShape: Object.fromEntries(
          ranked.map(([shape, records]) => [
            shape,
            {
              count: records.length,
              distinctMembers: new Set(records.map((r) => r.member)).size,
              withTypeHint: records.filter((r) => r.typeHint !== undefined).length,
              wouldResolve: records.filter((r) => r.wouldResolve === true).length,
              typeHintInProject: records.filter((r) => r.typeHintInProject === true).length,
              viaLocalCallBinding: records.filter((r) => r.viaLocalCallBinding === true).length,
              topMembers: [
                ...records.reduce((m, r) => m.set(r.member, (m.get(r.member) ?? 0) + 1), new Map<string, number>()),
              ]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([member, count]) => ({ member, count })),
              samples: records.slice(0, 10),
            },
          ]),
        ),
        byReceiverKind: byKind,
      },
      null,
      2,
    ),
  );
  L(`untyped-local census → ${OUT_LOCAL_CENSUS}`);
  L("");
}

// ===========================================================================
// NON-LEADING DEF-PARAM ORACLE (CODEGRAPH_DEFPARAM_ORACLE=1, bd tea-rags-mcp-jawn8)
//
// The census bucket `def param: positional past the leading required run` is a
// call whose receiver IS a declared positional parameter of its own method and
// which the walker's position→name index nevertheless does not carry. TWO
// disjoint causes hide under that one label, and only measurement separates
// them:
//
//   * SIGNATURE GAP — the method's signature never reached `ChunkExtraction`
//     at all, so `paramNames` is absent even though the parameter sits in a
//     plain LEADING required run. The position→name mapping is sound and
//     simply missing.
//   * END-PINNED — a required positional PAST an optional / splat.
//     `positionalParamNames` truncates there on purpose: an omitted optional
//     shifts every later argument, so a FRONT index no longer pins the name.
//     Ruby still pins it, from the END (`def f(a, b = 1, c)` always binds `c`
//     to the last argument), which a tail-indexed fold could reach.
//
// Widening the index is cheap on its own; it pays only if the callee's call
// sites deliver a statically typeable argument at that position AND agree on
// the type. bvalc Increment 1 is input-starved exactly there, so this oracle
// measures the addressable subset BEFORE anything is built: per
// (callee, parameter) it folds the SAME agreement rule over the SAME
// conservatively-typed argument shapes bvalc uses, then asks the symbol table
// whether the agreed type would define the missed member at all.
//
// Same additive, env-gated contract as the oracles above: with the flag unset
// nothing extra is scanned and the A/B recall metrics are byte-identical. The
// flag implies CODEGRAPH_LOCAL_CENSUS, whose per-call records are this oracle's
// numerator.
// ===========================================================================
const DEFPARAM_ORACLE_ENABLED = process.env.CODEGRAPH_DEFPARAM_ORACLE === "1";
const OUT_DEFPARAM = join(OUT_DIR, "defparam-oracle-report.json");

/** Parameter flavours, by the tree-sitter node that declares them. */
type DpParamKind = "required" | "optional" | "splat" | "hashSplat" | "keyword" | "block" | "destructured" | "other";

function dpParamKind(node: AstNode): DpParamKind {
  if (node.type === "identifier") return "required";
  if (node.type === "optional_parameter") return "optional";
  if (node.type === "splat_parameter") return "splat";
  if (node.type === "hash_splat_parameter") return "hashSplat";
  if (node.type === "keyword_parameter") return "keyword";
  if (node.type === "block_parameter") return "block";
  if (node.type === "destructured_parameter") return "destructured";
  return "other";
}

/** Does this flavour consume a POSITIONAL argument slot at the call site? */
const DP_CONSUMES_SLOT: ReadonlySet<DpParamKind> = new Set<DpParamKind>([
  "required",
  "optional",
  "splat",
  "destructured",
]);

interface DpParam {
  readonly name: string;
  readonly kind: DpParamKind;
  /** Index among the params that consume a positional slot; `null` otherwise. */
  readonly slot: number | null;
}

/** Where a def sits relative to the traversal `collectRubyMethodSignatures` does. */
const DP_DEF_FORMS = ["classBody", "singletonClass", "blockNested", "topLevel"] as const;
type DpDefForm = (typeof DP_DEF_FORMS)[number];

interface DpDef {
  readonly symbolId: string;
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly params: readonly DpParam[];
  /** How many params consume a positional slot — the END-pinning denominator. */
  readonly slots: number;
  /** `ChunkExtraction.paramNames`: the index the PRODUCTION fold actually has. */
  readonly recorded: readonly string[];
  readonly form: DpDefForm;
}

/**
 * Which traversal shape hides a def from the signature collector.
 * `collectRubyMethodSignatures` walks to the first `class`/`module` and then
 * iterates that body's DIRECT statements, so a def under a singleton class, a
 * def nested in a block (`included do … end`), and a def at file scope are all
 * invisible to it — and therefore carry no `paramNames`, no arity, and no
 * visibility. Naming the shape turns "the index is missing" into a lead.
 */
function dpDefFormOf(node: AstNode): DpDefForm {
  let sawBlock = false;
  for (let cursor = node.parent; cursor !== null; cursor = cursor.parent) {
    if (cursor.type === "singleton_class") return "singletonClass";
    if (cursor.type === "block" || cursor.type === "do_block") sawBlock = true;
    if (cursor.type === "class" || cursor.type === "module") return sawBlock ? "blockNested" : "classBody";
  }
  return sawBlock ? "blockNested" : "topLevel";
}

interface DpSite {
  readonly relPath: string;
  readonly chunkId: string;
  readonly scope: readonly string[];
  readonly line: number;
  /** `null` ⇒ bare (implicit-self) call. Receiver-ful non-constant → not scanned. */
  readonly recv: FxExpr | null;
  readonly member: string;
  readonly args: readonly FxExpr[];
  /** Positional list closed early (splat / block / keyword pair): the TAIL index
   *  of an end-pinned parameter cannot be computed from a truncated list. */
  readonly truncated: boolean;
}

/** The slice of a chunk's environment an argument hint is evaluated against. */
interface DpChunkEnv {
  readonly relPath: string;
  /** Enclosing class FQ — the key `@ivar` argument types are stored under. */
  readonly klass: string;
  readonly localBindings?: Record<string, LocalBinding[]>;
}

const dpDefs: DpDef[] = [];
const dpDefById = new Map<string, DpDef>();
const dpDefsByFile = new Map<string, DpDef[]>();
const dpSites: DpSite[] = [];
const dpChunkEnvs = new Map<string, DpChunkEnv>();
const dpFileClassFields = new Map<string, Record<string, Record<string, string>>>();
/** Defs the chunker gave no chunk of their own — unkeyable, counted for honesty. */
let dpDefsWithoutChunk = 0;

/** ONE extra DFS per file: every def's full parameter list + every const/bare site. */
function scanDefParamOracleAst(root: AstNode, relPath: string, extraction: FileExtraction): void {
  if (extraction.classFieldTypes) dpFileClassFields.set(relPath, extraction.classFieldTypes);
  for (const chunk of extraction.chunks) {
    dpChunkEnvs.set(chunk.symbolId, {
      relPath,
      klass: chunk.scope.join("::"),
      ...(chunk.localBindings !== undefined ? { localBindings: chunk.localBindings } : {}),
    });
  }
  const owners = fxLineOwners(extraction);
  const ownerAt = (line: number): ChunkExtraction | undefined => (line < owners.length ? owners[line] : undefined);

  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;

    if (node.type === "method" || node.type === "singleton_method") {
      const line = node.startPosition.row + 1;
      const owner = ownerAt(line);
      if (owner?.startLine !== line || owner.endLine === undefined) {
        dpDefsWithoutChunk += 1;
      } else {
        const params: DpParam[] = [];
        let slots = 0;
        for (const child of node.childForFieldName("parameters")?.namedChildren ?? []) {
          const kind = dpParamKind(child);
          const bound = child.type === "identifier" ? child : child.childForFieldName("name");
          const consumes = DP_CONSUMES_SLOT.has(kind);
          const slot = consumes ? slots : null;
          if (consumes) slots += 1;
          if (bound?.type === "identifier") params.push({ name: bound.text, kind, slot });
        }
        if (params.length > 0) {
          const def: DpDef = {
            symbolId: owner.symbolId,
            relPath,
            startLine: line,
            endLine: owner.endLine,
            params,
            slots,
            recorded: owner.paramNames ?? [],
            form: dpDefFormOf(node),
          };
          dpDefs.push(def);
          if (!dpDefById.has(def.symbolId)) dpDefById.set(def.symbolId, def);
          const byFile = dpDefsByFile.get(relPath);
          if (byFile === undefined) dpDefsByFile.set(relPath, [def]);
          else byFile.push(def);
        }
      }
    }

    if (node.type === "call" || node.type === "method_call") {
      const method = node.childForFieldName("method");
      const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list") ?? null;
      if (method && args) {
        const receiverNode = node.childForFieldName("receiver");
        const recv = receiverNode ? fxExprOf(receiverNode, 0) : null;
        // jawn8 stays inside bvalc's substrate: a callee known from SYNTAX
        // (constant receiver) or from the caller's own lexical class (bare
        // call). A receiver-ful non-constant call needs the receiver typed
        // first — that is the fixpoint a2hrq already measured, not this slice.
        if (recv === null || recv.k === "const") {
          const line = node.startPosition.row + 1;
          const argExprs: FxExpr[] = [];
          let truncated = false;
          for (const arg of args.namedChildren) {
            if (
              arg.type === "block" ||
              arg.type === "do_block" ||
              arg.type === "block_argument" ||
              arg.type === "splat_argument" ||
              arg.type === "hash_splat_argument" ||
              arg.type === "pair"
            ) {
              truncated = true;
              break;
            }
            argExprs.push(fxExprOf(arg, 0));
          }
          if (argExprs.length > 0) {
            const owner = ownerAt(line);
            dpSites.push({
              relPath,
              chunkId: owner?.symbolId ?? "",
              scope: owner?.scope ?? extraction.fileScope,
              line,
              recv,
              member: method.text,
              args: argExprs,
              truncated,
            });
          }
        }
      }
    }

    for (const c of node.children) stack.push(c);
  }
}

/**
 * The type of ONE argument expression under the BASELINE environment — a
 * deliberate mirror of bvalc's `argTypeHint`, not of the fixpoint's `fxTypeOf`.
 * No wave, no derived param types, no derived returns: whatever this oracle
 * reports is reachable by a mechanism built on Increment 1's substrate alone.
 */
function dpTypeOf(expr: FxExpr, site: DpSite): RubyTypeRef | undefined {
  switch (expr.k) {
    case "const":
      return { form: "class", name: expr.name };
    case "instConst":
      return { form: "instance", name: expr.name };
    case "ident": {
      const binding = resolveLocalBinding(dpChunkEnvs.get(site.chunkId)?.localBindings, expr.name, site.line);
      if (binding === undefined) return undefined;
      return binding.typeRef ?? { form: binding.valueKind === "class" ? "class" : "instance", name: binding.type };
    }
    case "ivar": {
      const env = dpChunkEnvs.get(site.chunkId);
      if (env === undefined) return undefined;
      const name = dpFileClassFields.get(env.relPath)?.[env.klass]?.[expr.name];
      return name === undefined ? undefined : { form: "instance", name };
    }
    case "call":
    case "opaque":
    default:
      return undefined;
  }
}

/** Callee coordinate candidates for a site, in Ruby lookup order. */
function dpTargetsOf(site: DpSite): string[] {
  if (site.recv === null) {
    const klass = site.scope.join("::");
    if (klass === "") return [];
    const out: string[] = [];
    for (const c of [klass, ...fxAncestorsOf(klass)]) out.push(`${c}#${site.member}`, `${c}.${site.member}`);
    return out;
  }
  if (site.recv.k !== "const") return [];
  const suffix = site.member === "new" ? "#initialize" : `.${site.member}`;
  const out: string[] = [];
  for (const fq of constantLookupCandidates(site.scope, site.recv.name)) {
    out.push(`${fq}${suffix}`);
    for (const anc of fxAncestorsOf(fq)) out.push(`${anc}${suffix}`);
  }
  return out;
}

/** Which END of the argument list pins a positional parameter, if either. */
type DpPin = "both" | "front" | "end" | "none";

function dpPinOf(def: DpDef, slot: number): DpPin {
  const positional = def.params.filter((p) => p.slot !== null);
  const front = positional.slice(0, slot).every((p) => p.kind === "required");
  const end = positional.slice(slot + 1).every((p) => p.kind === "required");
  return front && end ? "both" : front ? "front" : end ? "end" : "none";
}

/** Argument index a site would bind to this parameter, or `null` when none does. */
function dpArgIndex(def: DpDef, param: DpParam, pin: DpPin, site: DpSite): number | null {
  if (param.slot === null) return null;
  if (pin === "both" || pin === "front") return param.slot;
  if (pin !== "end" || site.truncated) return null;
  return site.args.length - (def.slots - param.slot);
}

/** Per-(callee, parameter) call-site evidence, under the bvalc agreement rule. */
interface DpEvidence {
  /** Sites that reach this parameter's argument slot at all. */
  sites: number;
  /** Of those, sites whose argument carries a conservative type. */
  hints: number;
  type?: RubyTypeRef;
  conflicted: boolean;
}

function dpFoldEvidence(): Map<string, Map<string, DpEvidence>> {
  const out = new Map<string, Map<string, DpEvidence>>();
  for (const site of dpSites) {
    const targetId = dpTargetsOf(site).find((candidate) => dpDefById.has(candidate));
    if (targetId === undefined) continue;
    const def = dpDefById.get(targetId);
    if (def === undefined) continue;
    let byParam = out.get(targetId);
    if (byParam === undefined) {
      byParam = new Map<string, DpEvidence>();
      out.set(targetId, byParam);
    }
    for (const param of def.params) {
      if (param.slot === null) continue;
      const index = dpArgIndex(def, param, dpPinOf(def, param.slot), site);
      if (index === null || index < 0 || index >= site.args.length) continue;
      let slot = byParam.get(param.name);
      if (slot === undefined) {
        slot = { sites: 0, hints: 0, conflicted: false };
        byParam.set(param.name, slot);
      }
      slot.sites += 1;
      const hint = dpTypeOf(site.args[index], site);
      if (hint === undefined) continue;
      slot.hints += 1;
      if (slot.type === undefined) slot.type = hint;
      else if (fxTypeKey(slot.type) !== fxTypeKey(hint)) slot.conflicted = true;
    }
  }
  return out;
}

/** Why a census-bucket receiver is invisible to the production position index. */
const DP_CLASS = {
  signatureGap: "signature gap    (leading run, but the def has NO recorded paramNames)",
  endPinned: "end-pinned       (required positional past an optional / splat)",
  unpinned: "unpinned         (optional / splat on BOTH sides — no index pins it)",
  alreadyIndexed: "already indexed  (recorded — should not reach the census bucket)",
  notAParam: "not a parameter  (receiver is not declared by the owning def)",
  noDef: "no owning def    (line is inside no def this scan keyed)",
} as const;
type DpClass = (typeof DP_CLASS)[keyof typeof DP_CLASS];

/** One census-bucket call, joined against the def index and the fold. */
interface DpVerdict {
  readonly outcome: LcOutcome;
  readonly cls: DpClass;
  readonly relPath: string;
  readonly line: number;
  readonly member: string;
  readonly receiver: string;
  readonly defId?: string;
  readonly pin?: DpPin;
  readonly sites?: number;
  readonly hints?: number;
  readonly agreedType?: string;
  readonly agreedForm?: string;
  readonly typeInProject?: boolean;
  readonly wouldResolve?: boolean;
}

function dpDefAt(relPath: string, line: number): DpDef | undefined {
  let best: DpDef | undefined;
  for (const def of dpDefsByFile.get(relPath) ?? []) {
    if (line < def.startLine || line > def.endLine) continue;
    if (best === undefined || def.endLine - def.startLine < best.endLine - best.startLine) best = def;
  }
  return best;
}

function dpClassify(record: LcMissRecord, evidence: Map<string, Map<string, DpEvidence>>): DpVerdict {
  const base = {
    outcome: record.outcome,
    relPath: record.relPath,
    line: record.line,
    member: record.member,
    receiver: record.receiver,
  };
  const def = dpDefAt(record.relPath, record.line);
  if (def === undefined) return { ...base, cls: DP_CLASS.noDef };
  const param = def.params.find((p) => p.name === record.receiver);
  if (param?.slot === undefined || param.slot === null) {
    return { ...base, cls: DP_CLASS.notAParam, defId: def.symbolId };
  }
  if (def.recorded.includes(param.name)) {
    return { ...base, cls: DP_CLASS.alreadyIndexed, defId: def.symbolId };
  }
  const pin = dpPinOf(def, param.slot);
  const cls = pin === "end" ? DP_CLASS.endPinned : pin === "none" ? DP_CLASS.unpinned : DP_CLASS.signatureGap;
  const slot = evidence.get(def.symbolId)?.get(param.name);
  const verdict: DpVerdict = {
    ...base,
    cls,
    defId: def.symbolId,
    pin,
    sites: slot?.sites ?? 0,
    hints: slot?.hints ?? 0,
  };
  if (slot?.type === undefined || slot.conflicted) return verdict;
  const agreed = slot.type;
  if (agreed.form !== "instance" && agreed.form !== "class") return verdict;
  return {
    ...verdict,
    agreedType: agreed.name,
    agreedForm: agreed.form,
    typeInProject: symbolTable.lookup(agreed.name).length > 0,
    wouldResolve: lcWouldResolve(agreed.name, record.member),
  };
}

/** Printed verdict + JSON report. Runs after PASS-2, alongside the census. */
function runDefParamOracle(): void {
  const L = (s: string) => {
    console.log(s);
  };
  const evidence = dpFoldEvidence();
  const bucket = lcRecords.filter((r) => r.shape === LC_SHAPE.defParamPositional);
  const verdicts = bucket.map((r) => dpClassify(r, evidence));
  const misses = verdicts.filter((v) => v.outcome === "miss");

  const tally = (rows: readonly DpVerdict[]) => ({
    calls: rows.length,
    withSites: rows.filter((v) => (v.sites ?? 0) > 0).length,
    withHint: rows.filter((v) => (v.hints ?? 0) > 0).length,
    agreed: rows.filter((v) => v.agreedType !== undefined).length,
    typeInProject: rows.filter((v) => v.typeInProject === true).length,
    addressable: rows.filter((v) => v.wouldResolve === true).length,
  });

  const classes = [...new Set(verdicts.map((v) => v.cls))].sort();
  const byClass = classes.map((cls) => ({
    cls,
    miss: tally(misses.filter((v) => v.cls === cls)),
    exposure: tally(verdicts.filter((v) => v.cls === cls)),
  }));
  const overallMiss = tally(misses);
  const overallExposure = tally(verdicts);

  L("");
  L("═══════════════════════════════════════════════════════════════════");
  L("  NON-LEADING DEF-PARAM ORACLE — addressability of the census bucket");
  L("═══════════════════════════════════════════════════════════════════");
  L(`defs indexed:                    ${dpDefs.length} (unkeyable, no own chunk: ${dpDefsWithoutChunk})`);
  L(`const / bare call sites scanned: ${dpSites.length}`);
  L(`callees the fold reached:        ${evidence.size}`);
  L(`census bucket — misses:          ${misses.length}   (all outcomes: ${verdicts.length})`);
  L("");
  L("─── SIGNATURE COVERAGE: defs with params, by traversal shape ──────");
  L("form              defs   withPositional   recorded   GAP");
  for (const form of DP_DEF_FORMS) {
    const rows = dpDefs.filter((d) => d.form === form);
    const positional = rows.filter((d) => d.slots > 0);
    const recorded = positional.filter((d) => d.recorded.length > 0);
    L(
      `${form.padEnd(16)}  ${String(rows.length).padStart(5)}  ${String(positional.length).padStart(14)}  ` +
        `${String(recorded.length).padStart(9)}  ${String(positional.length - recorded.length).padStart(5)}`,
    );
  }
  L("");
  L(
    "class                                                              calls  sites   hint  agreed  inProj  ADDRESSABLE",
  );
  for (const row of byClass) {
    L(
      `${row.cls.padEnd(64)}  ${String(row.miss.calls).padStart(5)}  ${String(row.miss.withSites).padStart(5)}  ` +
        `${String(row.miss.withHint).padStart(5)}  ${String(row.miss.agreed).padStart(6)}  ` +
        `${String(row.miss.typeInProject).padStart(6)}  ${String(row.miss.addressable).padStart(11)}`,
    );
  }
  L(
    `${"TOTAL (misses)".padEnd(64)}  ${String(overallMiss.calls).padStart(5)}  ${String(overallMiss.withSites).padStart(5)}  ` +
      `${String(overallMiss.withHint).padStart(5)}  ${String(overallMiss.agreed).padStart(6)}  ` +
      `${String(overallMiss.typeInProject).padStart(6)}  ${String(overallMiss.addressable).padStart(11)}`,
  );
  L("");
  L("─── EXPOSURE (every outcome, not only misses) ─────────────────────");
  L(
    `calls ${overallExposure.calls}  withSites ${overallExposure.withSites}  withHint ${overallExposure.withHint}  agreed ${overallExposure.agreed}  wouldResolve ${overallExposure.addressable}`,
  );
  L("");
  const wins = misses.filter((v) => v.wouldResolve === true);
  L(`─── ADDRESSABLE misses (${wins.length}) — first 15 ──`);
  for (const v of wins.slice(0, 15)) {
    L(`     ${v.relPath}:${v.line}  ${v.receiver}.${v.member}  →  ${v.agreedForm}:${v.agreedType}  [${v.defId}]`);
  }
  L("");

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    OUT_DEFPARAM,
    JSON.stringify(
      {
        meta: {
          bead: "tea-rags-mcp-jawn8",
          root: ROOT,
          generatedAt: new Date().toISOString(),
          defsIndexed: dpDefs.length,
          defsWithoutChunk: dpDefsWithoutChunk,
          sitesScanned: dpSites.length,
          calleesReached: evidence.size,
          bucketMisses: misses.length,
          bucketCalls: verdicts.length,
        },
        signatureCoverage: Object.fromEntries(
          DP_DEF_FORMS.map((form) => {
            const rows = dpDefs.filter((d) => d.form === form);
            const positional = rows.filter((d) => d.slots > 0);
            const recorded = positional.filter((d) => d.recorded.length > 0);
            return [
              form,
              {
                defs: rows.length,
                withPositional: positional.length,
                recorded: recorded.length,
                gap: positional.length - recorded.length,
              },
            ];
          }),
        ),
        overall: { miss: overallMiss, exposure: overallExposure },
        byClass,
        addressableSamples: wins.slice(0, 40),
        starvedSamples: misses.filter((v) => (v.hints ?? 0) === 0).slice(0, 20),
      },
      null,
      2,
    ),
  );
  L(`def-param oracle → ${OUT_DEFPARAM}`);
  L("");
}

// ===========================================================================
// SIGNATURE-GAP ORACLE (CODEGRAPH_SIGGAP_ORACLE=1) — bd tea-rags-mcp-jn5j0
//
// The def-param oracle above named the defect: `collectRubyMethodSignatures`
// walks to the first `class`/`module` and iterates that body's DIRECT
// statements, so every def under a `class << self`, inside a class-body block
// (`included do … end`), or at file scope carries NO arity / visibility /
// kwargs / acceptsBlock. It counted the DEFS. This oracle counts the
// CONSUMERS — the only question that decides whether closing the gap is worth
// anything.
//
// The signature fields have exactly four readers:
//   1. the untyped-dispatch narrowing cascade (`ArityNarrower`,
//      `KwargNarrower`, `VisibilityNarrower`, `BlockNarrower`) — measured here
//      by replaying the REAL narrower classes over the REAL candidate set;
//   2. `isAbstractStub` → the self-dispatch template probe;
//   3. `paramNames` → the bvalc call-arg param-type fold;
//   4. `visibility` → the same cascade (2)–(3) are reported as static exposure.
//
// Narrowing can only SHRINK a survivor set, so the reachable transitions are:
//   • m>1 → 1        unique-survivor promotion (one precise edge replaces a
//                    discounted fan-out; the call stays resolved);
//   • m>cap → ≤cap   `ambiguous` becomes edges — a RECALL GAIN;
//   • m>0 → 0        the fan-out empties — the call loses its edges and, if
//                    nothing else resolves it, converts to an HONEST hole
//                    (8ypeu-style: a fake resolved becomes a counted miss).
// Each is counted separately so the A/B's hole movement can be attributed
// instead of guessed.
//
// The simulation only runs where narrowing PROVABLY ran: the dynamic-dispatch
// component returns an empty fan-out from a dozen early gates, and an empty
// outcome cannot be told apart from "narrowed to zero" post hoc. A non-empty
// outcome (edges, or `ambiguous`) is proof that control reached
// `resolveNarrowedFanout` over `lookupByShortName(member)` filtered to ruby —
// the exact set rebuilt here. Calls with a gap candidate but an empty outcome
// are reported separately as un-simulated exposure.
//
// The recovered signature is computed INDEPENDENTLY of the fix, mirroring
// `computeRubyArity` / `computeRubyKwargs` / `computeRubyAcceptsBlock` and the
// per-body visibility state machine. That independence is the point: an oracle
// that shares code with the change it evaluates cannot disagree with it.
//
// Same additive, env-gated contract as every oracle above: with the flag unset
// nothing extra is scanned and the A/B recall metrics are byte-identical.
// ===========================================================================
const SIGGAP_ORACLE_ENABLED = process.env.CODEGRAPH_SIGGAP_ORACLE === "1";
const OUT_SIGGAP = join(OUT_DIR, "siggap-oracle-report.json");

/** Where a def sits relative to the traversal `collectRubyMethodSignatures` does. */
const SG_DEF_FORMS = ["classBody", "singletonClass", "blockNested", "topLevel"] as const;
type SgDefForm = (typeof SG_DEF_FORMS)[number];
type SgVisibility = "public" | "private" | "protected";

/** A def the production traversal never reaches, plus the signature it would
 *  carry if it did. Keyed by symbolId — the identity the symbol table uses. */
interface SgRecovered {
  readonly form: SgDefForm;
  readonly relPath: string;
  readonly startLine: number;
  readonly arity: AritySignature;
  readonly kwargs?: KwargSignature;
  readonly visibility: SgVisibility;
  readonly acceptsBlock: boolean;
  readonly paramNames: readonly string[];
  readonly isAbstractStub: boolean;
}

const sgRecovered = new Map<string, SgRecovered>();
/** Defs whose form IS reached today — the coverage denominator. */
let sgClassBodyDefs = 0;
/** Gap defs the chunker gave no chunk of their own: unkeyable either way. */
let sgDefsWithoutChunk = 0;

const SG_VISIBILITY_KEYWORDS: ReadonlySet<string> = new Set(["private", "protected", "public"]);

/** Mirror of `computeRubyArity`. */
function sgArityOf(node: AstNode): AritySignature {
  const params = node.childForFieldName("parameters");
  if (!params) return { minRequired: 0, maxPositional: 0, hasSplat: false };
  let minRequired = 0;
  let maxPositional = 0;
  let hasSplat = false;
  for (const child of params.namedChildren) {
    if (child.type === "identifier") {
      minRequired++;
      maxPositional++;
    } else if (child.type === "optional_parameter") {
      maxPositional++;
    } else if (child.type === "splat_parameter") {
      hasSplat = true;
    }
  }
  return { minRequired, maxPositional, hasSplat };
}

/** Mirror of `computeRubyKwargs`. */
function sgKwargsOf(node: AstNode): KwargSignature | undefined {
  const params = node.childForFieldName("parameters");
  if (!params) return undefined;
  const required: string[] = [];
  const optional: string[] = [];
  let hasSplat = false;
  for (const child of params.namedChildren) {
    if (child.type === "keyword_parameter") {
      const nameNode = child.childForFieldName("name") ?? child.namedChildren[0];
      if (!nameNode) continue;
      const name = nameNode.text.replace(/:$/, "");
      if (child.childForFieldName("value") === null) required.push(name);
      else optional.push(name);
    } else if (child.type === "hash_splat_parameter") {
      hasSplat = true;
    }
  }
  if (required.length === 0 && optional.length === 0 && !hasSplat) return undefined;
  return { required, optional, hasSplat };
}

/** Mirror of `computeRubyAcceptsBlock`. */
function sgAcceptsBlockOf(node: AstNode): boolean {
  const params = node.childForFieldName("parameters");
  if (params?.namedChildren.some((c) => c.type === "block_parameter")) return true;
  const body = node.childForFieldName("body");
  if (!body) return false;
  const stack: AstNode[] = [body];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) break;
    if (n.type === "yield") return true;
    for (const c of n.children) stack.push(c);
  }
  return false;
}

/** Mirror of `positionalParamNames`: the LEADING run of plain required params. */
function sgParamNamesOf(node: AstNode): string[] {
  const params = node.childForFieldName("parameters");
  if (!params) return [];
  const names: string[] = [];
  for (const child of params.namedChildren) {
    if (child.type !== "identifier") break;
    names.push(child.text);
  }
  return names;
}

/** Mirror of `computeRubyIsAbstractStub` (the three declaration-only shapes). */
function sgIsAbstractStubOf(node: AstNode): boolean {
  const body = node.childForFieldName("body");
  if (!body) return true;
  const statements = body.type === "body_statement" ? body.namedChildren : [body];
  if (statements.length === 0) return true;
  if (statements.length > 1) return false;
  const only = statements[0];
  if (only.type === "super") return true;
  if (only.type !== "call" && only.type !== "method_call") return false;
  const methodField = only.childForFieldName("method") ?? only.children.find((c) => c.type === "identifier");
  if (!methodField) return false;
  if (methodField.type === "super") return true;
  if (only.childForFieldName("receiver")) return false;
  if (methodField.text !== "raise") return false;
  const args = only.childForFieldName("arguments") ?? only.children.find((c) => c.type === "argument_list");
  const first = args?.namedChildren[0];
  if (!first) return false;
  if (first.type === "constant" || first.type === "scope_resolution") {
    return first.text === "NotImplementedError" || first.text === "::NotImplementedError";
  }
  if (first.type !== "call" && first.type !== "method_call") return false;
  const recv = first.childForFieldName("receiver");
  if (!recv) return false;
  if (first.childForFieldName("method")?.text !== "new") return false;
  return recv.text === "NotImplementedError" || recv.text === "::NotImplementedError";
}

/**
 * The visibility a def would carry, from the state machine over the statements
 * of the body that CONTAINS it — bare switch (`private`), inline form
 * (`private def m`), symbol form (`private :m`, which is position-independent
 * and therefore scanned over the whole body).
 */
function sgVisibilityOf(defNode: AstNode): SgVisibility {
  const bodyNode = defNode.parent;
  if (bodyNode === null) return "public";
  const stmts = bodyNode.namedChildren;
  const name = defNode.childForFieldName("name")?.text ?? "";
  const methodFieldOf = (n: AstNode) =>
    n.childForFieldName("method") ?? n.children.find((c) => c.type === "identifier");
  const argsOf = (n: AstNode) =>
    n.childForFieldName("arguments") ?? n.children.find((c) => c.type === "argument_list");

  let current: SgVisibility = "public";
  let symbolForm: SgVisibility | undefined;
  for (const stmt of stmts) {
    if (stmt.type === "identifier" && SG_VISIBILITY_KEYWORDS.has(stmt.text)) {
      if (stmt.startPosition.row < defNode.startPosition.row) current = stmt.text as SgVisibility;
      continue;
    }
    if (stmt.type !== "call" && stmt.type !== "method_call") continue;
    if (stmt.childForFieldName("receiver")) continue;
    const methodField = methodFieldOf(stmt);
    if (!methodField || !SG_VISIBILITY_KEYWORDS.has(methodField.text)) continue;
    const modifier = methodField.text as SgVisibility;
    const args = argsOf(stmt);
    if (!args || args.namedChildren.length === 0) {
      if (stmt.startPosition.row < defNode.startPosition.row) current = modifier;
      continue;
    }
    const firstArg = args.namedChildren[0];
    if (firstArg.type === "method" || firstArg.type === "singleton_method") {
      if (firstArg.startPosition.row === defNode.startPosition.row) symbolForm = modifier;
      continue;
    }
    for (const arg of args.namedChildren) {
      if ((arg.type === "simple_symbol" || arg.type === "symbol") && arg.text.replace(/^:/, "") === name) {
        symbolForm = modifier;
      }
    }
  }
  return symbolForm ?? current;
}

/** Which traversal shape hides a def from the signature collector. */
function sgDefFormOf(node: AstNode): SgDefForm {
  let sawBlock = false;
  for (let cursor = node.parent; cursor !== null; cursor = cursor.parent) {
    if (cursor.type === "singleton_class") return "singletonClass";
    if (cursor.type === "block" || cursor.type === "do_block") sawBlock = true;
    if (cursor.type === "class" || cursor.type === "module") return sawBlock ? "blockNested" : "classBody";
  }
  return sawBlock ? "blockNested" : "topLevel";
}

/** ONE extra DFS per file: index every def the production traversal misses. */
function scanSigGapOracleAst(root: AstNode, relPath: string, extraction: FileExtraction): void {
  const owners = fxLineOwners(extraction);
  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    for (const child of node.children) stack.push(child);
    if (node.type !== "method" && node.type !== "singleton_method") continue;
    const form = sgDefFormOf(node);
    if (form === "classBody") {
      sgClassBodyDefs += 1;
      continue;
    }
    const line = node.startPosition.row + 1;
    const owner = line < owners.length ? owners[line] : undefined;
    if (owner?.startLine !== line) {
      sgDefsWithoutChunk += 1;
      continue;
    }
    const kwargs = sgKwargsOf(node);
    sgRecovered.set(owner.symbolId, {
      form,
      relPath,
      startLine: line,
      arity: sgArityOf(node),
      ...(kwargs !== undefined ? { kwargs } : {}),
      visibility: sgVisibilityOf(node),
      acceptsBlock: sgAcceptsBlockOf(node),
      paramNames: sgParamNamesOf(node),
      isAbstractStub: sgIsAbstractStubOf(node),
    });
  }
}

/** The production cascade, instantiated once — the SAME classes, same order. */
const SG_NARROWERS: DispatchCandidateNarrower[] = [
  new DuckVocabularyNarrower(RUBY_DUCK_VOCAB),
  new LiteralReceiverNarrower(classifyRubyLiteralReceiver),
  new ArityNarrower(),
  new KwargNarrower(),
  new VisibilityNarrower(),
  new BlockNarrower(),
];

function sgSurvivors(call: CallRef, candidates: SymbolDefinition[], ctx: CallContext): SymbolDefinition[] {
  let survivors = candidates;
  for (const narrower of SG_NARROWERS) {
    survivors = narrower.narrow(call, survivors, ctx);
    if (survivors.length === 0) return survivors;
  }
  return survivors;
}

/** Edges `resolveNarrowedFanout` would emit for a survivor count (`-1` = the
 *  `ambiguous` outcome, which emits none but is NOT a recall hole today). */
function sgEdgeCount(survivors: number, cap: number): number {
  if (survivors === 0) return 0;
  if (survivors === 1) return 1;
  return survivors > cap ? -1 : survivors;
}

type SgTransition =
  | "unchanged"
  | "fanoutShrunk"
  | "promotedToUnique"
  | "emptied"
  | "ambiguousToEdges"
  | "ambiguousShrunk";

const sgTransitions: Record<SgTransition, number> = {
  unchanged: 0,
  fanoutShrunk: 0,
  promotedToUnique: 0,
  emptied: 0,
  ambiguousToEdges: 0,
  ambiguousShrunk: 0,
};
/** Sample rows for the emptied / promoted / ambiguous-lifted transitions. */
const sgSamples: {
  transition: SgTransition;
  relPath: string;
  line: number;
  member: string;
  before: number;
  after: number;
  gapDefs: string[];
}[] = [];

let sgCallsScanned = 0;
let sgCallsWithGapCandidate = 0;
let sgCallsSimulated = 0;
let sgNarrowingNotObserved = 0;
let sgEdgesBefore = 0;
let sgEdgesAfter = 0;
/** Exposure of gap candidates split by the call's ACTUAL production outcome. */
const sgExposureByOutcome = new Map<string, number>();

/** Which of the six shapes the survivor count moved through. Narrowing only
 *  ever SHRINKS, so `after <= before` always holds. */
function sgTransitionOf(before: number, after: number, edgesBefore: number, edgesAfter: number): SgTransition {
  if (after === before) return "unchanged";
  if (after === 0) return "emptied";
  if (edgesBefore === -1) return edgesAfter === -1 ? "ambiguousShrunk" : "ambiguousToEdges";
  return after === 1 ? "promotedToUnique" : "fanoutShrunk";
}

/** Copy a candidate with its recovered signature filled in — what the symbol
 *  table would hold once the traversal reaches the def. */
function sgPatched(def: SymbolDefinition): SymbolDefinition {
  const rec = sgRecovered.get(def.symbolId);
  if (rec === undefined) return def;
  return {
    ...def,
    arity: rec.arity,
    ...(rec.kwargs !== undefined ? { kwargs: rec.kwargs } : {}),
    visibility: rec.visibility,
    acceptsBlock: rec.acceptsBlock,
    ...(rec.isAbstractStub ? { isAbstractStub: true } : {}),
  };
}

function noteSigGapCall(
  call: CallRef,
  ctx: CallContext,
  dispatchOutcome: DispatchFanoutOutcome | undefined,
  outcome: string,
  relPath: string,
): void {
  const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((d) => isRubyPath(d.relPath));
  if (candidates.length === 0) return;
  sgCallsScanned += 1;
  const gapDefs = candidates.filter((d) => sgRecovered.has(d.symbolId));
  if (gapDefs.length === 0) return;
  sgCallsWithGapCandidate += 1;
  sgExposureByOutcome.set(outcome, (sgExposureByOutcome.get(outcome) ?? 0) + 1);

  // Narrowing provably ran only when the fan-out produced something.
  const ran =
    dispatchOutcome !== undefined &&
    (dispatchOutcome.kind === "ambiguous" || (dispatchOutcome.kind === "edges" && dispatchOutcome.edges.length > 0));
  if (!ran) {
    sgNarrowingNotObserved += 1;
    return;
  }
  sgCallsSimulated += 1;

  const { cap } = dispatchFanoutPolicyFor(ctx.symbolTable);
  const before = sgSurvivors(call, candidates, ctx).length;
  const after = sgSurvivors(call, candidates.map(sgPatched), ctx).length;
  const edgesBefore = sgEdgeCount(before, cap);
  const edgesAfter = sgEdgeCount(after, cap);
  sgEdgesBefore += Math.max(0, edgesBefore);
  sgEdgesAfter += Math.max(0, edgesAfter);

  const transition = sgTransitionOf(before, after, edgesBefore, edgesAfter);
  sgTransitions[transition] += 1;

  if (transition !== "unchanged" && transition !== "fanoutShrunk" && sgSamples.length < 60) {
    sgSamples.push({
      transition,
      relPath,
      line: call.startLine,
      member: call.member,
      before,
      after,
      gapDefs: gapDefs.slice(0, 3).map((d) => d.symbolId),
    });
  }
}

function runSigGapOracle(): void {
  const L = (s: string) => {
    console.log(s);
  };
  const rows = [...sgRecovered.values()];
  const byForm = SG_DEF_FORMS.filter((f) => f !== "classBody").map((form) => {
    const forRows = rows.filter((r) => r.form === form);
    return {
      form,
      defs: forRows.length,
      withPositional: forRows.filter((r) => r.arity.maxPositional > 0 || r.arity.hasSplat).length,
      withKwargs: forRows.filter((r) => r.kwargs !== undefined).length,
      private: forRows.filter((r) => r.visibility === "private").length,
      abstractStub: forRows.filter((r) => r.isAbstractStub).length,
      withParamNames: forRows.filter((r) => r.paramNames.length > 0).length,
    };
  });

  L("");
  L("═══════════════════════════════════════════════════════════════════");
  L("  SIGNATURE-GAP ORACLE (jn5j0) — consumer impact of the walker gap");
  L("═══════════════════════════════════════════════════════════════════");
  L(`defs REACHED today (classBody):        ${sgClassBodyDefs}`);
  L(`defs MISSED, chunk-keyable:            ${rows.length}`);
  L(`defs MISSED, no chunk of their own:    ${sgDefsWithoutChunk}   (unfixable by traversal alone)`);
  L("");
  L("form              defs   positional   kwargs   private   stub   paramNames");
  for (const r of byForm) {
    L(
      `${r.form.padEnd(16)}  ${String(r.defs).padStart(4)}  ${String(r.withPositional).padStart(11)}  ` +
        `${String(r.withKwargs).padStart(7)}  ${String(r.private).padStart(8)}  ${String(r.abstractStub).padStart(5)}  ` +
        `${String(r.withParamNames).padStart(11)}`,
    );
  }
  L("");
  L("─── CONSUMER 1: untyped-dispatch narrowing ────────────────────────");
  L(`calls with a ruby short-name candidate set: ${sgCallsScanned}`);
  L(`  … of which contain a GAP def:             ${sgCallsWithGapCandidate}`);
  L(`  … narrowing provably ran (simulated):     ${sgCallsSimulated}`);
  L(`  … empty fan-out, gate vs narrow unknown:  ${sgNarrowingNotObserved}`);
  L("");
  L("exposure by the call's ACTUAL production outcome:");
  for (const [k, v] of [...sgExposureByOutcome.entries()].sort((a, b) => b[1] - a[1])) {
    L(`  ${k.padEnd(20)} ${String(v).padStart(7)}`);
  }
  L("");
  L("simulated transition (recovered signatures fed to the REAL cascade):");
  for (const [k, v] of Object.entries(sgTransitions)) L(`  ${k.padEnd(20)} ${String(v).padStart(7)}`);
  L(`edges emitted: before ${sgEdgesBefore}  after ${sgEdgesAfter}  (Δ ${sgEdgesAfter - sgEdgesBefore})`);
  L("");
  L(`─── transitions that MOVE the recall tally (${sgSamples.length} sampled) ──`);
  for (const s of sgSamples.slice(0, 20)) {
    L(`  ${s.transition.padEnd(18)} ${s.relPath}:${s.line} .${s.member}  ${s.before}→${s.after}  [${s.gapDefs[0]}]`);
  }
  L("");

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    OUT_SIGGAP,
    JSON.stringify(
      {
        meta: {
          bead: "tea-rags-mcp-jn5j0",
          root: ROOT,
          generatedAt: new Date().toISOString(),
          defsReachedToday: sgClassBodyDefs,
          defsMissedKeyable: rows.length,
          defsMissedWithoutChunk: sgDefsWithoutChunk,
        },
        byForm,
        narrowing: {
          callsScanned: sgCallsScanned,
          callsWithGapCandidate: sgCallsWithGapCandidate,
          callsSimulated: sgCallsSimulated,
          narrowingNotObserved: sgNarrowingNotObserved,
          exposureByOutcome: Object.fromEntries(sgExposureByOutcome),
          transitions: sgTransitions,
          edgesBefore: sgEdgesBefore,
          edgesAfter: sgEdgesAfter,
        },
        samples: sgSamples,
      },
      null,
      2,
    ),
  );
  L(`signature-gap oracle → ${OUT_SIGGAP}`);
  L("");
}

// ===========================================================================
// SUPER-MISS ORACLE (CODEGRAPH_SUPER_ORACLE=1)
//
// Per unresolved `super` call-site that HAS an in-project def, reconstruct what
// the resolver's ancestor walk actually saw and where the definer went missing.
// The two chain walks are the REAL exported ones — `collectAncestorChain` is
// literally the traversal `resolveInstanceMethodInClassChain` expresses over
// `ctx.classAncestors`, `collectResolvedAncestorChain` is the same traversal
// with each hop FQ-canonicalized (lawlq.3.4) — so "canonical chain reaches the
// definer, raw chain does not" is a measurement of the production gap, not of a
// harness re-implementation.
// ===========================================================================
const OUT_SUPER = join(OUT_DIR, "super-oracle-report.json");

/** Cause classes for an unresolved `super`, ordered most-specific first. */
const SUPER_CAT = {
  runtimeHook: "runtimeHook           Ruby runtime hook (file-only edge suppressed by design)",
  hostedNestedModule: "hostedNestedModule    nested module (ClassMethods-shape) whose HOST is included",
  moduleWithIncluders: "moduleWithIncluders   module IS included in-project, consensus walk still failed",
  orphanScope: "orphanScope           no heritage edge AND nobody includes it (runtime/external)",
  canonicalizationGap: "canonicalizationGap   definer reachable ONLY via the FQ-canonicalized chain",
  pinFailure: "pinFailure            definer IS on the raw chain the resolver walked",
  definerOffChain: "definerOffChain       in-project definer exists, on no ancestor (runtime ancestry)",
  noOwnerDef: "noOwnerDef            short-name defs exist but none is owned by a class",
} as const;
type SuperCat = keyof typeof SUPER_CAT;

/** Why the `resolveViaIncludingClasses` consensus produced nothing. */
const SUPER_CONSENSUS = {
  notApplicable: "not a module-scope miss / no includers",
  notInIncluderMro: "module absent from EVERY includer's MRO",
  noDefinerAfter: "module in MRO but nothing after it defines the member",
  disagreement: "includers disagree on the definer (GUARD drop)",
  wouldResolve: "consensus DOES agree — the walk should have resolved",
} as const;
type SuperConsensus = keyof typeof SUPER_CONSENSUS;

interface SuperDefiner {
  /** Ancestor FQ whose file/owner declares `member`. */
  readonly klass: string;
  /** `true` when a def's OWNER fq is exactly this class (not just same file). */
  readonly ownerMatch: boolean;
  /** Candidate count in that class's file — >1 is what strict mode drops on. */
  readonly candidates: number;
}

interface SuperMissRecord {
  readonly relPath: string;
  readonly line: number;
  readonly enclosingClass: string;
  readonly enclosingMethod: string;
  readonly member: string;
  readonly category: SuperCat;
  /** `ctx.classAncestors[enclosingClass]` — exactly what the walk iterated. */
  readonly ancestorsSeen: readonly string[];
  readonly prependedSeen: readonly string[];
  readonly superclass: string | null;
  readonly rawChain: readonly string[];
  readonly canonicalChain: readonly string[];
  readonly definersRaw: readonly SuperDefiner[];
  readonly definersCanonical: readonly SuperDefiner[];
  /** Heritage channel connecting the enclosing class to the first definer. */
  readonly channel: "super" | "include" | "extend" | "prepend" | "implements" | "none";
  /** Owners of every in-project def of `member`, capped for report size. */
  readonly definerOwnersAnywhere: readonly string[];
  /** Classes that `include`/`prepend` the enclosing module in-project. */
  readonly includedByCount: number;
  /** Enclosing namespace one level up (`Foo::ClassMethods` → `Foo`). */
  readonly hostModule: string;
  readonly hostIncludedByCount: number;
  readonly consensus: SuperConsensus;
  /**
   * `includedBy` is keyed by the RAW ancestor text the include SITE wrote
   * (`include Trackable`), while a module's own key is its FQ
   * (`Acme::Concerns::Trackable`). These three fields measure that key mismatch:
   * how many classes mix in the module under its LAST SEGMENT, whether that
   * segment is an unambiguous alias for this module, and what the consensus walk
   * would answer if it were keyed by the segment instead.
   */
  readonly includedByShortCount: number;
  readonly shortKeyUnambiguous: boolean;
  readonly consensusShort: SuperConsensus;
}

const superMisses: SuperMissRecord[] = [];
/** Resolved `super` sites whose target IS the calling method — always false. */
const superSelfEdges: string[] = [];

/** Owner FQ of a def (`A::B#m` → `A::B`); empty for top-level functions. */
function ownerOfFq(fqName: string): string {
  const cut = Math.max(fqName.lastIndexOf("#"), fqName.lastIndexOf("."));
  return cut === -1 ? "" : fqName.slice(0, cut);
}

/**
 * Measurement-only mirror of the (non-exported) `canonicalizeAncestorFq` in
 * `resolver/strategies/shared.ts`: same isKnown predicate, same compact-class
 * skip, same innermost-nesting-wins prefix walk. Duplicated here rather than
 * exported because it is a harness-side classifier, not a resolution step.
 */
function canonFqForOracle(raw: string, nesting: string, ctx: CallContext): string {
  const isKnown = (name: string): boolean =>
    ctx.classAncestors?.[name] !== undefined || ctx.symbolTable.lookup(name).length === 1;
  if (isKnown(raw)) return raw;
  if (ctx.compactDeclaredClasses?.has(nesting)) return raw;
  const segs = nesting.split("::");
  for (let i = segs.length - 1; i >= 1; i--) {
    const candidate = `${segs.slice(0, i).join("::")}::${raw}`;
    if (isKnown(candidate)) return candidate;
  }
  return raw;
}

/** Ancestors of `chain` that declare `member` (file-scoped, as the walk does). */
function superDefinersIn(chain: readonly string[], member: string, ctx: CallContext): SuperDefiner[] {
  const defs = symbolTable.lookupByShortName(member, { includeSchemaColumns: true });
  if (defs.length === 0) return [];
  const out: SuperDefiner[] = [];
  for (const klass of chain) {
    const file = resolveConstant(klass, ctx);
    const owned = defs.filter((d) => ownerOfFq(d.fqName) === klass || (file !== null && d.relPath === file));
    if (owned.length === 0) continue;
    out.push({
      klass,
      ownerMatch: owned.some((d) => ownerOfFq(d.fqName) === klass),
      candidates: file === null ? owned.length : defs.filter((d) => d.relPath === file).length,
    });
  }
  return out;
}

/** Heritage channel from `enclosingClass` to `definer` (direct edge kind). */
function superChannelTo(enclosingClass: string, definer: string, ctx: CallContext): SuperMissRecord["channel"] {
  for (const edge of hierarchyView.getAncestors(enclosingClass)) {
    const fq = canonFqForOracle(edge.ancestorFqName, enclosingClass, ctx);
    if (fq === definer) return edge.kind;
    if (collectResolvedAncestorChain(fq, ctx).includes(definer)) return edge.kind;
  }
  return "none";
}

function noteSuperMiss(call: CallRef, ctx: CallContext, relPath: string, chunk: ChunkExtraction): void {
  const enclosingClass = ctx.callerScope.join("::");
  const ancestorsSeen = ctx.classAncestors?.[enclosingClass] ?? [];
  const prependedSeen = ctx.classPrependedAncestors?.[enclosingClass] ?? [];
  const rawChain = collectAncestorChain(enclosingClass, ctx);
  const canonicalChain = collectResolvedAncestorChain(enclosingClass, ctx);
  const definersRaw = superDefinersIn(rawChain, call.member, ctx);
  const definersCanonical = superDefinersIn(canonicalChain, call.member, ctx);
  const owners = [
    ...new Set(
      symbolTable
        .lookupByShortName(call.member, { includeSchemaColumns: true })
        .map((d) => ownerOfFq(d.fqName))
        .filter((o) => o.length > 0),
    ),
  ];

  const includers = ctx.includedBy?.[enclosingClass] ?? [];
  const segs = enclosingClass.split("::");
  const hostModule = segs.length > 1 ? segs.slice(0, -1).join("::") : "";
  const hostIncluders = hostModule === "" ? [] : (ctx.includedBy?.[hostModule] ?? []);
  const consensus = superConsensusVerdict(enclosingClass, call.member, includers, ctx);
  // `include Trackable` inside `module Acme` keys includedBy by "Trackable" while
  // this module's own key is "Acme::Trackable" — measure what the consensus walk
  // would answer under the segment key, and whether that key is unambiguous.
  const shortKey = segs[segs.length - 1];
  const shortIncluders = shortKey === enclosingClass ? [] : (ctx.includedBy?.[shortKey] ?? []);
  const shortKeyUnambiguous =
    shortIncluders.length > 0 &&
    Object.keys(ctx.classAncestors ?? {}).filter((k) => k === shortKey || k.endsWith(`::${shortKey}`)).length === 1 &&
    symbolTable.lookup(shortKey).length === 0;
  const consensusShort =
    shortIncluders.length === 0 ? "notApplicable" : superConsensusVerdict(shortKey, call.member, shortIncluders, ctx);

  const noHeritage = ancestorsSeen.length === 0 && prependedSeen.length === 0;
  const category: SuperCat = RUBY_RUNTIME_HOOKS.has(call.member)
    ? "runtimeHook"
    : noHeritage && includers.length > 0
      ? "moduleWithIncluders"
      : noHeritage && hostIncluders.length > 0
        ? "hostedNestedModule"
        : noHeritage
          ? "orphanScope"
          : definersRaw.length > 0
            ? "pinFailure"
            : definersCanonical.length > 0
              ? "canonicalizationGap"
              : owners.length > 0
                ? "definerOffChain"
                : "noOwnerDef";

  const firstDefiner = definersCanonical[0]?.klass ?? definersRaw[0]?.klass;
  superMisses.push({
    relPath,
    line: call.startLine,
    enclosingClass,
    enclosingMethod: chunk.symbolId,
    member: call.member,
    category,
    ancestorsSeen,
    prependedSeen,
    superclass: ctx.classExtends?.[enclosingClass] ?? null,
    rawChain: rawChain.slice(0, 12),
    canonicalChain: canonicalChain.slice(0, 12),
    definersRaw,
    definersCanonical,
    channel: firstDefiner === undefined ? "none" : superChannelTo(enclosingClass, firstDefiner, ctx),
    definerOwnersAnywhere: owners.slice(0, 6),
    includedByCount: includers.length,
    hostModule,
    hostIncludedByCount: hostIncluders.length,
    consensus,
    includedByShortCount: shortIncluders.length,
    shortKeyUnambiguous,
    consensusShort,
  });
}

/**
 * Why `resolveViaIncludingClasses` produced nothing for a module-scope `super`.
 * Replays the REAL `firstDefinerAfter` per includer and reports the first
 * failure mode, so "the consensus path is unreachable" is told apart from "the
 * consensus path disagreed".
 */
function superConsensusVerdict(
  moduleName: string,
  member: string,
  includers: readonly string[],
  ctx: CallContext,
): SuperConsensus {
  if (includers.length === 0) return "notApplicable";
  let agreed: SymbolResolutionTarget | null = null;
  let anyInMro = false;
  for (const klass of includers) {
    const mro = [...(ctx.classPrependedAncestors?.[klass] ?? []), klass, ...collectAncestorChain(klass, ctx)];
    if (mro.includes(moduleName)) anyInMro = true;
    const t = firstDefinerAfter(moduleName, member, klass, ctx, "strict");
    if (t === null) continue;
    if (agreed === null) {
      agreed = t;
      continue;
    }
    const same =
      agreed.targetSymbolId !== null || t.targetSymbolId !== null
        ? agreed.targetSymbolId === t.targetSymbolId
        : agreed.targetRelPath === t.targetRelPath;
    if (!same) return "disagreement";
  }
  if (agreed !== null) return "wouldResolve";
  return anyInMro ? "noDefinerAfter" : "notInIncluderMro";
}

/**
 * Corpus census of the SELF-SCOPE heritage shape: `class C` (or `module C`)
 * mixing in a module NESTED INSIDE ITSELF (`prepend PerformWrapper` where the
 * module's FQ is `C::PerformWrapper`). Ruby resolves that bare constant through
 * `Module.nesting`, whose head is `C` itself — the exact hop
 * `canonicalizeAncestorFq` never tries, because its prefix walk starts one level
 * OUTSIDE the nesting class. Counts the edges that are invisible today and would
 * become visible if the own-scope hop were tried first.
 */
function selfScopeHeritageCensus(): { edges: number; samples: string[] } {
  const isKnownFq = (name: string): boolean =>
    runAncestors[name] !== undefined || symbolTable.lookup(name).length === 1;
  const canonUnderCurrentRule = (raw: string, nesting: string): string | null => {
    if (isKnownFq(raw)) return raw;
    if (runCompactClasses.has(nesting)) return null;
    const segs = nesting.split("::");
    for (let i = segs.length - 1; i >= 1; i--) {
      const candidate = `${segs.slice(0, i).join("::")}::${raw}`;
      if (isKnownFq(candidate)) return candidate;
    }
    return null;
  };
  const seen = new Set<string>();
  const samples: string[] = [];
  for (const row of runInheritanceRows) {
    const raw = row.ancestorFqName;
    if (raw.includes("::")) continue; // already qualified — nothing to canonicalize
    const key = `${row.sourceFqName} ${raw} ${row.kind}`;
    if (seen.has(key)) continue;
    if (canonUnderCurrentRule(raw, row.sourceFqName) !== null) continue;
    if (!isKnownFq(`${row.sourceFqName}::${raw}`)) continue;
    seen.add(key);
    if (samples.length < 15) samples.push(`${row.sourceFqName} --${row.kind}--> ${row.sourceFqName}::${raw}`);
  }
  return { edges: seen.size, samples };
}

function runSuperOracle(): void {
  const L = (s: string) => {
    console.log(s);
  };
  const t = kindTally.super;
  const byCat = new Map<SuperCat, SuperMissRecord[]>();
  for (const m of superMisses) {
    const arr = byCat.get(m.category) ?? [];
    arr.push(m);
    byCat.set(m.category, arr);
  }
  const byChannel: Record<string, number> = {};
  for (const m of superMisses) byChannel[m.channel] = (byChannel[m.channel] ?? 0) + 1;
  const byConsensus: Record<string, number> = {};
  for (const m of superMisses) byConsensus[m.consensus] = (byConsensus[m.consensus] ?? 0) + 1;

  L("");
  L("═══════════════════════════════════════════════════════════════════");
  L("  SUPER-MISS ORACLE (bd lawlq.5)");
  L("═══════════════════════════════════════════════════════════════════");
  L(
    `super attempted=${t.attempted} resolved=${t.resolved} extSkip=${t.externalSkipped} ` +
      `noDef=${t.noInProjectDef} coreAmb=${t.coreAmbiguous} hole=${superMisses.length}`,
  );
  L("");
  L("─── cause class ───────────────────────────────────────────────────");
  for (const cat of Object.keys(SUPER_CAT) as SuperCat[]) {
    const arr = byCat.get(cat) ?? [];
    L(`  ${String(arr.length).padStart(5)}  ${SUPER_CAT[cat]}`);
  }
  L("");
  L("─── heritage channel to the definer ───────────────────────────────");
  for (const [ch, n] of Object.entries(byChannel).sort((a, b) => b[1] - a[1])) {
    L(`  ${String(n).padStart(5)}  ${ch}`);
  }
  L("");
  L("─── includer-consensus verdict ────────────────────────────────────");
  for (const [c, n] of Object.entries(byConsensus).sort((a, b) => b[1] - a[1])) {
    L(`  ${String(n).padStart(5)}  ${c.padEnd(18)} ${SUPER_CONSENSUS[c as SuperConsensus]}`);
  }
  L("");
  L("─── precision: resolved `super` pointing at the CALLER itself ─────");
  L(`  self-edges among resolved super sites: ${superSelfEdges.length}`);
  for (const s of superSelfEdges.slice(0, 10)) L(`     ${s}`);
  L("");
  const selfScope = selfScopeHeritageCensus();
  L("─── self-scope heritage census (nested module mixed into its host) ─");
  L(`  heritage edges invisible under the current canonicalization: ${selfScope.edges}`);
  for (const s of selfScope.samples) L(`     ${s}`);
  L("");
  L("─── same walk keyed by the module's LAST SEGMENT ──────────────────");
  const shortWould = superMisses.filter((m) => m.consensusShort === "wouldResolve");
  L(
    `  misses whose module is mixed in under a short key : ${superMisses.filter((m) => m.includedByShortCount > 0).length}`,
  );
  L(`  of those, segment key is unambiguous              : ${superMisses.filter((m) => m.shortKeyUnambiguous).length}`);
  L(`  consensus WOULD resolve under the segment key     : ${shortWould.length}`);
  L(`  … and the segment key is unambiguous              : ${shortWould.filter((m) => m.shortKeyUnambiguous).length}`);
  L("");
  for (const cat of Object.keys(SUPER_CAT) as SuperCat[]) {
    const arr = byCat.get(cat) ?? [];
    if (arr.length === 0) continue;
    L(`  ── ${cat} (${arr.length}) ──`);
    for (const m of arr.slice(0, 12)) {
      L(
        `     ${m.relPath}:${m.line}  ${m.enclosingClass}#${m.member}` +
          `  seen=[${m.ancestorsSeen.join(", ")}]` +
          `  inc=${m.includedByCount} host=${m.hostModule || "-"}(${m.hostIncludedByCount})` +
          `  ${m.consensus}` +
          `  definer=${m.definersCanonical[0]?.klass ?? m.definersRaw[0]?.klass ?? "-"}(${m.channel})`,
      );
    }
    L("");
  }
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    OUT_SUPER,
    JSON.stringify(
      {
        root: ROOT,
        superKindTally: t,
        holes: superMisses.length,
        byCategory: Object.fromEntries(
          (Object.keys(SUPER_CAT) as SuperCat[]).map((c) => [c, (byCat.get(c) ?? []).length]),
        ),
        byChannel,
        byConsensus,
        selfScopeHeritage: selfScope,
        superSelfEdges,
        misses: superMisses,
      },
      null,
      2,
    ),
  );
  L(`super oracle report → ${OUT_SUPER}`);
  L("");
}

// ---------------------------------------------------------------------------
// TYPE-FACT QUALITY ORACLE (CODEGRAPH_TYPEFACT_ORACLE=1)
//
// Two probes, both pure folds over run-global state, run AFTER pass-2 so the
// miss set is available. Nothing here resolves anything a second time.
// ---------------------------------------------------------------------------

/** Bare class NAME a `RubyTypeRef` denotes (container unwraps to its element). */
function tfRefName(ref: RubyTypeRef): string | undefined {
  if (ref.form === "class" || ref.form === "instance") return ref.name;
  if (ref.form === "container") return tfRefName(ref.element);
  return undefined; // union — no single name
}

/**
 * Does the project DECLARE this constant? The existence predicate the proposed
 * gate would use: a class/module chunk under that FQ, an ancestry entry, or a
 * symbol-table hit. Deliberately site-INDEPENDENT (no `resolveConstant`, which
 * asks the different question "reachable from here"), because a type FACT is
 * global — a name no file declares is a fiction wherever it is read.
 */
function tfIsProjectClass(name: string): boolean {
  return tfDeclaredConstants.has(name) || runAncestors[name] !== undefined || symbolTable.lookup(name).length > 0;
}

/** Transitive ancestor closure of `klass` over `runAncestors` (cycle-guarded). */
function tfAncestorClosure(klass: string, seen: Set<string> = new Set()): Set<string> {
  if (seen.has(klass)) return seen;
  seen.add(klass);
  for (const ancestor of runAncestors[klass] ?? []) tfAncestorClosure(ancestor, seen);
  return seen;
}

/** Split a `localCallBindings` VALUE the way `boundCallReturnType` does. */
function tfSplitBinding(binding: string): { klass: string; member: string } | null {
  const at = binding.lastIndexOf(".");
  if (at <= 0) return null; // bare form
  return { klass: binding.slice(0, at), member: binding.slice(at + 1) };
}

/** `declaredReturnTypeOn(klass, member, classReceiver=true)`, replayed. */
function tfDeclaredOn(klass: string, member: string): RubyTypeRef | undefined {
  return runStructuredReturnTypes[`${klass}.${member}`] ?? runStructuredReturnTypes[`${klass}#${member}`];
}

/** `inheritedReturnType` — DIRECT ancestors only, exactly as production walks. */
function tfInheritedOn(klass: string, member: string): RubyTypeRef | undefined {
  for (const ancestor of runAncestors[klass] ?? []) {
    const inherited = tfDeclaredOn(ancestor, member);
    if (inherited !== undefined) return inherited;
  }
  return undefined;
}

/** Which classes a `<Owner>#<member>` / `<Owner>.<member>` fact naming `type` sits on. */
function tfFactOwners(member: string, type: string): string[] {
  const owners: string[] = [];
  for (const [key, ref] of Object.entries(runStructuredReturnTypes)) {
    const at = Math.max(key.lastIndexOf("#"), key.lastIndexOf("."));
    if (at <= 0 || key.slice(at + 1) !== member) continue;
    if (tfRefName(ref) === type) owners.push(key.slice(0, at));
  }
  return owners;
}

/** Outcome of replaying `returnTypeOf` over a scope-qualified call binding. */
type TfStep = "declared" | "inherited" | "flatMap" | "silent";

function tfReplayQualified(klass: string, member: string): TfStep {
  if (tfDeclaredOn(klass, member) !== undefined) return "declared";
  if (tfInheritedOn(klass, member) !== undefined) return "inherited";
  return runReturnTypes[member] !== undefined ? "flatMap" : "silent";
}

function runTypefactOracle(declaredBeforeDerive: Record<string, RubyTypeRef>): void {
  const L = (s: string) => {
    console.log(s);
  };
  const defCounts = symbolTable.shortNameDefCounts();
  L("");
  L("═══════════════════════════════════════════════════════════════════");
  L("  TYPE-FACT QUALITY ORACLE (bd yt3im + h4hxh)");
  L("═══════════════════════════════════════════════════════════════════");

  // ── PROBE 1 (yt3im): class-form declared facts vs derived competitors ────
  const derived: Record<string, RubyTypeRef> = {};
  for (const [key, ref] of Object.entries(runStructuredReturnTypes)) {
    if (!(key in declaredBeforeDerive)) derived[key] = ref;
  }
  let classFormFacts = 0;
  let classFormExistent = 0;
  let classFormFiction = 0;
  let flipCandidates = 0;
  let flipReach = 0;
  let fictionNoCompetitor = 0;
  let fictionNoCompetitorReach = 0;
  let existentWithCompetitor = 0;
  const flipRows: { coord: string; fiction: string; derived: string; sites: number }[] = [];
  const fictionByType = new Map<string, number>();
  for (const [key, ref] of Object.entries(declaredBeforeDerive)) {
    const at = key.lastIndexOf(".");
    if (at <= 0 || key.slice(0, at).includes("#")) continue; // not a class-form coordinate
    const klass = key.slice(0, at);
    const member = key.slice(at + 1);
    classFormFacts += 1;
    const typeName = tfRefName(ref);
    const existent = typeName !== undefined && tfIsProjectClass(typeName);
    const competitor = derived[`${klass}#${member}`];
    const sites = tfBindingReach.get(`${klass}.${member}`) ?? 0;
    if (existent) {
      classFormExistent += 1;
      if (competitor !== undefined) existentWithCompetitor += 1;
      continue;
    }
    classFormFiction += 1;
    fictionByType.set(typeName ?? "<non-nominal>", (fictionByType.get(typeName ?? "<non-nominal>") ?? 0) + sites);
    if (competitor === undefined) {
      fictionNoCompetitor += 1;
      fictionNoCompetitorReach += sites;
      continue;
    }
    flipCandidates += 1;
    flipReach += sites;
    flipRows.push({
      coord: key,
      fiction: typeName ?? "<non-nominal>",
      derived: tfRefName(competitor) ?? "<non-nominal>",
      sites,
    });
  }
  L("");
  L("─── PROBE 1 (yt3im): class-form ('.') facts vs j9xpf derivations ──");
  L(`structuredReturnTypes coordinates:        ${Object.keys(runStructuredReturnTypes).length}`);
  L(`  declared before the j9xpf derive:       ${Object.keys(declaredBeforeDerive).length}`);
  L(`  written BY the derive:                  ${Object.keys(derived).length}`);
  L(`class-form ('.') declared facts:          ${classFormFacts}`);
  L(`  type IS a declared project class:       ${classFormExistent}`);
  L(`  type is declared NOWHERE (fiction):     ${classFormFiction}`);
  L("");
  L(`FLIP candidates (fiction + derived sibling): ${flipCandidates}   binding sites reached: ${flipReach}`);
  L(`fiction with NO derived sibling (left as-is): ${fictionNoCompetitor}   sites: ${fictionNoCompetitorReach}`);
  L(`existent '.' fact WITH a derived sibling (8ypeu ownership kept): ${existentWithCompetitor}`);
  L("");
  L("  top FLIP coordinates by binding-site reach:");
  for (const row of flipRows.sort((a, b) => b.sites - a.sites).slice(0, 15)) {
    L(`  ${String(row.sites).padStart(6)}  ${row.coord}:  ${row.fiction}  ->  ${row.derived}`);
  }
  L("");
  L("  fictional '.' type names by reach:");
  for (const [type, sites] of [...fictionByType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    L(`  ${String(sites).padStart(6)}  ${type}`);
  }

  // ── PROBE 2 (h4hxh): flat bare-name map census ───────────────────────────
  const flatKeys = Object.keys(runReturnTypes);
  let unique = 0;
  let collided = 0;
  let orphan = 0;
  const collisionBuckets: Record<string, number> = { "2": 0, "3": 0, "4-9": 0, "10+": 0 };
  const worst: { key: string; defs: number; type: string }[] = [];
  for (const key of flatKeys) {
    const n = defCounts.get(key) ?? 0;
    if (n === 0) orphan += 1;
    else if (n === 1) unique += 1;
    else {
      collided += 1;
      const bucket = n === 2 ? "2" : n === 3 ? "3" : n < 10 ? "4-9" : "10+";
      collisionBuckets[bucket] += 1;
      worst.push({ key, defs: n, type: runReturnTypes[key] ?? "?" });
    }
  }
  L("");
  L("─── PROBE 2 (h4hxh): flat bare-name functionReturnTypes census ────");
  L(`flat map keys:                            ${flatKeys.length}`);
  L(
    `  corpus-UNIQUE (exactly 1 def):          ${unique}  (${((unique / Math.max(1, flatKeys.length)) * 100).toFixed(1)}%)`,
  );
  L(
    `  COLLIDED (>1 def):                      ${collided}  buckets 2=${collisionBuckets["2"]} 3=${collisionBuckets["3"]} 4-9=${collisionBuckets["4-9"]} 10+=${collisionBuckets["10+"]}`,
  );
  L(`  no in-project def at all (0):           ${orphan}`);
  L("");
  L("  most-collided flat keys (defs x type):");
  for (const row of worst.sort((a, b) => b.defs - a.defs).slice(0, 15)) {
    L(`  ${String(row.defs).padStart(6)}  ${row.key} -> ${row.type}`);
  }

  // Where step 4 actually FIRES, and whether the fact belongs to the receiver.
  let qualCoords = 0;
  let qualSites = 0;
  let ownerInMro = 0;
  let ownerInMroSites = 0;
  let ownerForeign = 0;
  let ownerForeignSites = 0;
  let ownerUnknown = 0;
  let ownerUnknownSites = 0;
  let killedForeignSites = 0;
  let killedLegitSites = 0;
  let keptSites = 0;
  const poison: { binding: string; sites: number; type: string; owners: string; defs: number }[] = [];
  let bareSites = 0;
  let bareUniqueSites = 0;
  for (const [binding, sites] of tfBindingReach) {
    const split = tfSplitBinding(binding);
    if (split === null) {
      if (runReturnTypes[binding] === undefined) continue;
      bareSites += sites;
      if ((defCounts.get(binding) ?? 0) === 1) bareUniqueSites += sites;
      continue;
    }
    if (tfReplayQualified(split.klass, split.member) !== "flatMap") continue;
    const type = runReturnTypes[split.member] ?? "";
    const owners = tfFactOwners(split.member, type);
    const closure = tfAncestorClosure(split.klass);
    const legitimate = owners.some((owner) => closure.has(owner));
    qualCoords += 1;
    qualSites += sites;
    if (owners.length === 0) {
      ownerUnknown += 1;
      ownerUnknownSites += sites;
    } else if (legitimate) {
      ownerInMro += 1;
      ownerInMroSites += sites;
    } else {
      ownerForeign += 1;
      ownerForeignSites += sites;
      poison.push({
        binding,
        sites,
        type,
        owners: owners.slice(0, 2).join(","),
        defs: defCounts.get(split.member) ?? 0,
      });
    }
    if ((defCounts.get(split.member) ?? 0) === 1) keptSites += sites;
    else if (legitimate) killedLegitSites += sites;
    else killedForeignSites += sites;
  }
  L("");
  L("  step-4 firings on SCOPE-QUALIFIED bindings (`x = Const.member(…)`):");
  L(`  coordinates: ${qualCoords}   binding sites: ${qualSites}`);
  L(`    fact owner IS the receiver class or an ancestor:  ${ownerInMro} coords / ${ownerInMroSites} sites`);
  L(`    fact owner is a FOREIGN class (wrong-type poison): ${ownerForeign} coords / ${ownerForeignSites} sites`);
  L(`    fact has no scoped sibling (owner unknown):        ${ownerUnknown} coords / ${ownerUnknownSites} sites`);
  L("");
  L("  counterfactual gate «apply step 4 only when the member is corpus-unique»:");
  L(`    firings KEPT (unique member):                      ${keptSites} sites`);
  L(`    firings KILLED and demonstrably foreign (win):     ${killedForeignSites} sites`);
  L(`    firings KILLED though owner was in the MRO (LOSS): ${killedLegitSites} sites`);
  L("");
  L("  bare-branch firings (`x = fetch(…)`, no receiver type at all):");
  L(`    sites: ${bareSites}   of which the member is corpus-unique: ${bareUniqueSites}`);
  L("");
  L("  top FOREIGN-fact bindings by site reach:");
  for (const row of poison.sort((a, b) => b.sites - a.sites).slice(0, 15)) {
    L(`  ${String(row.sites).padStart(6)}  ${row.binding} -> ${row.type}  [owners: ${row.owners}; defs=${row.defs}]`);
  }

  // ── Which MISSES ride which defect ───────────────────────────────────────
  const bucket = { yt3imFiction: 0, h4hxhForeign: 0, h4hxhUnknownOwner: 0, h4hxhBare: 0, other: 0 };
  const bareCollided = { collided: 0, unique: 0 };
  let plainReceiverMisses = 0;
  let boundReceiverMisses = 0;
  for (const miss of misses) {
    const { receiver } = miss;
    if (receiver === null || receiver.includes(".") || receiver.includes("[") || receiver.startsWith("@")) continue;
    plainReceiverMisses += 1;
    const binding = tfChunkCallBindings.get(`${miss.relPath}|${miss.callerSymbolId}`)?.[receiver];
    if (binding === undefined) continue;
    boundReceiverMisses += 1;
    const split = tfSplitBinding(binding);
    if (split === null) {
      if (runReturnTypes[binding] === undefined) continue;
      bucket.h4hxhBare += 1;
      if ((defCounts.get(binding) ?? 0) === 1) bareCollided.unique += 1;
      else bareCollided.collided += 1;
      continue;
    }
    const step = tfReplayQualified(split.klass, split.member);
    if (step === "declared") {
      const fact = tfDeclaredOn(split.klass, split.member);
      const typeName = fact === undefined ? undefined : tfRefName(fact);
      if (typeName !== undefined && !tfIsProjectClass(typeName)) bucket.yt3imFiction += 1;
      else bucket.other += 1;
      continue;
    }
    if (step !== "flatMap") {
      bucket.other += 1;
      continue;
    }
    const owners = tfFactOwners(split.member, runReturnTypes[split.member] ?? "");
    const closure = tfAncestorClosure(split.klass);
    if (owners.length === 0) bucket.h4hxhUnknownOwner += 1;
    else if (owners.some((owner) => closure.has(owner))) bucket.other += 1;
    else bucket.h4hxhForeign += 1;
  }
  L("");
  L("─── RECALL MISSES attributable to each defect ─────────────────────");
  L(`  chunks with call bindings: ${tfChunkCallBindings.size}`);
  L(`  misses on a plain identifier receiver: ${plainReceiverMisses}   of those call-bound: ${boundReceiverMisses}`);
  L(`  yt3im — receiver typed by a FICTIONAL declared fact:      ${bucket.yt3imFiction}`);
  L(`  h4hxh — step 4 applied a FOREIGN class's fact:            ${bucket.h4hxhForeign}`);
  L(`  h4hxh — step 4 applied a fact with no scoped owner:       ${bucket.h4hxhUnknownOwner}`);
  L(
    `  h4hxh — bare-branch flat-map fact (collided=${bareCollided.collided} unique=${bareCollided.unique}): ${bucket.h4hxhBare}`,
  );
  L(`  receiver typed by a channel neither bug owns:             ${bucket.other}`);
  L("");
}

// ---------------------------------------------------------------------------
// OWNER-QUALIFIED RETURN-FACT ORACLE (CODEGRAPH_OWNERFACT_ORACLE=1)
//
// One fold over every pass-1 chunk's `localCallBindings`, replaying exactly the
// lookup the proposed bare-branch narrowing would perform.
// ---------------------------------------------------------------------------

/**
 * The owner-qualified return fact a BARE call to `member` inside `klass` would
 * find — the caller's own coordinate first, then its DIRECT ancestors, mirroring
 * production `declaredReturnTypeOn` + `inheritedReturnType` (instance `#` form
 * only: a bare call dispatches on self, never on the class object).
 */
function ofOwnerFact(klass: string, member: string): RubyTypeRef | undefined {
  const own = runStructuredReturnTypes[`${klass}#${member}`];
  if (own !== undefined) return own;
  for (const ancestor of runAncestors[klass] ?? []) {
    const inherited = runStructuredReturnTypes[`${ancestor}#${member}`];
    if (inherited !== undefined) return inherited;
  }
  return undefined;
}

function runOwnerfactOracle(): void {
  const L = (s: string) => {
    console.log(s);
  };
  const defCounts = symbolTable.shortNameDefCounts();
  L("");
  L("═══════════════════════════════════════════════════════════════════");
  L("  OWNER-QUALIFIED RETURN-FACT ORACLE (bd rwv3o)");
  L("═══════════════════════════════════════════════════════════════════");

  let qualifiedSites = 0;
  let bareSites = 0;
  let bareNoScope = 0;
  // Population A: the flat map ANSWERS today (this is `boundCallReturnType`'s
  // bare branch firing).
  let flatServed = 0;
  let flatUnique = 0;
  let flatCollided = 0;
  // MRO-definer census over the TRANSITIVE ancestor closure — the addressable-set
  // question ("exactly one definer in the MRO").
  const mroDefiners = { zero: 0, one: 0, many: 0 };
  const mroDefinersCollided = { zero: 0, one: 0, many: 0 };
  // Production-semantics owner fact (own coordinate + DIRECT ancestors).
  let ownerFactHit = 0;
  let ownerFactAgrees = 0;
  let ownerFactDiffers = 0;
  let ownerFactHitCollided = 0;
  let ownerFactDiffersCollided = 0;
  // Population B: the flat map is SILENT — an owner fact would be a NEW answer.
  let flatSilent = 0;
  let silentOwnerFactHit = 0;
  let silentMroDefinerOne = 0;
  let silentMroDefinerOneNoFact = 0;
  const correctionRows = new Map<string, { sites: number; flat: string; owned: string }>();
  const newAnswerRows = new Map<string, number>();
  const uncoveredCallees = new Map<string, number>();

  for (const rec of ofChunkBindings) {
    const scopeKey = rec.scope.join("::");
    for (const binding of Object.values(rec.bindings)) {
      if (binding.lastIndexOf(".") > 0) {
        qualifiedSites += 1;
        continue;
      }
      bareSites += 1;
      if (scopeKey.length === 0) {
        bareNoScope += 1;
        continue;
      }
      const member = binding;
      const flat = runReturnTypes[member];
      const collided = (defCounts.get(member) ?? 0) > 1;
      const closure = tfAncestorClosure(scopeKey);
      const definerOwners = new Set(
        symbolTable
          .lookupByShortName(member)
          .map((d) => d.scope.join("::"))
          .filter((owner) => owner.length > 0 && closure.has(owner)),
      );
      const bucket = definerOwners.size === 0 ? "zero" : definerOwners.size === 1 ? "one" : "many";
      const owned = ofOwnerFact(scopeKey, member);
      const ownedName = owned === undefined ? undefined : tfRefName(owned);
      if (flat === undefined) {
        flatSilent += 1;
        if (ownedName !== undefined) {
          silentOwnerFactHit += 1;
          newAnswerRows.set(`${scopeKey}#${member}`, (newAnswerRows.get(`${scopeKey}#${member}`) ?? 0) + 1);
        }
        if (bucket === "one") {
          silentMroDefinerOne += 1;
          if (ownedName === undefined) {
            silentMroDefinerOneNoFact += 1;
            uncoveredCallees.set(
              `${[...definerOwners][0]}#${member}`,
              (uncoveredCallees.get(`${[...definerOwners][0]}#${member}`) ?? 0) + 1,
            );
          }
        }
        continue;
      }
      flatServed += 1;
      if (collided) flatCollided += 1;
      else flatUnique += 1;
      mroDefiners[bucket] += 1;
      if (collided) mroDefinersCollided[bucket] += 1;
      if (ownedName !== undefined) {
        ownerFactHit += 1;
        if (collided) ownerFactHitCollided += 1;
        if (ownedName === flat) {
          ownerFactAgrees += 1;
        } else {
          ownerFactDiffers += 1;
          if (collided) ownerFactDiffersCollided += 1;
          const key = `${scopeKey}#${member}`;
          const row = correctionRows.get(key) ?? { sites: 0, flat, owned: ownedName };
          row.sites += 1;
          correctionRows.set(key, row);
        }
      }
    }
  }

  L("");
  L("─── bare-branch binding-site census ───────────────────────────────");
  L(`chunks carrying localCallBindings:        ${ofChunkBindings.length}`);
  L(`scope-QUALIFIED binding sites (x = C.m):  ${qualifiedSites}`);
  L(`BARE binding sites (x = m(…)):            ${bareSites}`);
  L(`  no enclosing class scope (unnarrowable): ${bareNoScope}`);
  L("");
  L("─── A. flat map ANSWERS today (the bare branch fires) ─────────────");
  L(`sites served by the flat map:             ${flatServed}`);
  L(`  member corpus-UNIQUE (1 def):           ${flatUnique}`);
  L(`  member COLLIDED (>=2 defs):             ${flatCollided}   <- the h4hxh population`);
  L("");
  L("  definers of that member inside the caller's transitive MRO:");
  L(
    `    exactly ONE definer  (addressable):   ${mroDefiners.one}   (collided-member subset: ${mroDefinersCollided.one})`,
  );
  L(`    NO definer in the MRO:                ${mroDefiners.zero}   (collided subset: ${mroDefinersCollided.zero})`);
  L(`    TWO OR MORE definers:                 ${mroDefiners.many}   (collided subset: ${mroDefinersCollided.many})`);
  L("");
  L("  owner-qualified fact reachable (own coordinate + DIRECT ancestors):");
  L(`    fact found:                           ${ownerFactHit}   (collided subset: ${ownerFactHitCollided})`);
  L(`      AGREES with the flat answer:        ${ownerFactAgrees}`);
  L(`      DIFFERS (a correction):             ${ownerFactDiffers}   (collided subset: ${ownerFactDiffersCollided})`);
  L("");
  L("  top corrections by site reach (coordinate: flat -> owner-qualified):");
  for (const [coord, row] of [...correctionRows.entries()].sort((a, b) => b[1].sites - a[1].sites).slice(0, 15)) {
    L(`  ${String(row.sites).padStart(6)}  ${coord}:  ${row.flat}  ->  ${row.owned}`);
  }
  L("");
  L("─── B. flat map SILENT (owner fact would be a NEW answer) ─────────");
  L(`sites with no flat fact at all:           ${flatSilent}`);
  L(`  owner-qualified fact IS reachable:      ${silentOwnerFactHit}   <- new receiver types`);
  L(`  exactly one MRO definer:                ${silentMroDefinerOne}`);
  L(`    ...but that callee has NO return fact: ${silentMroDefinerOneNoFact}   <- bd smvyk coverage hole`);
  L("");
  L("  top NEW-answer coordinates by site reach:");
  for (const [coord, sites] of [...newAnswerRows.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    L(`  ${String(sites).padStart(6)}  ${coord}`);
  }
  L("");
  L("  top UNCOVERED callees by site reach (bd smvyk input):");
  for (const [coord, sites] of [...uncoveredCallees.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    L(`  ${String(sites).padStart(6)}  ${coord}`);
  }
  L("");
}

// ---------------------------------------------------------------------------
// CALLEE-RETURN SHAPE ORACLE (CODEGRAPH_CALLEESHAPE_ORACLE=1)
//
// Population: every `<owner>#<member>` coordinate a bare binding site reaches
// through the caller's MRO that carries NO return fact in either channel.
// For each, the DECLARING file is re-parsed once and the def's body tail is
// classified, so the report says which inference extension would cover how many
// binding sites.
// ---------------------------------------------------------------------------

/** Receiver-passthrough tails: the value is the receiver, so its type carries. */
const CS_PASSTHROUGH_TAILS = new Set(["freeze", "dup", "tap", "presence", "itself"]);
/** Non-nominal literal tails — nothing a class name could describe. */
const CS_LITERAL_TYPES = new Set([
  "string",
  "integer",
  "float",
  "simple_symbol",
  "symbol_array",
  "array",
  "hash",
  "nil",
  "true",
  "false",
  "regex",
  "range",
  "heredoc_beginning",
  "chained_string",
  "character",
  "delimited_symbol",
]);
/** Conditional constructs whose VALUE is one of several branch tails. */
const CS_BRANCHING_TYPES = new Set(["if", "unless", "case", "case_match", "conditional", "if_modifier", "begin"]);

let csCatalogueCache: RubyDslCatalogue | undefined;
function csCatalogue(): RubyDslCatalogue {
  csCatalogueCache ??= catalogueForGemfile(gemfileContent);
  return csCatalogueCache;
}

/** The last value-producing statement of a body, `return EXPR` unwrapped. */
function csTail(body: AstNode): AstNode | null {
  const stmts = body.namedChildren.filter((n) => n.type !== "rescue" && n.type !== "ensure" && n.type !== "else");
  let last = stmts[stmts.length - 1];
  if (!last) return null;
  if (last.type === "return") {
    const arg = last.namedChildren[0];
    if (!arg) return null;
    last = arg.type === "argument_list" ? arg.namedChildren[0] : arg;
    if (!last) return null;
  }
  return last;
}

/** Every branch tail of a conditional construct (nested conditionals flattened). */
function csBranchTails(node: AstNode, out: AstNode[] = []): AstNode[] {
  if (!CS_BRANCHING_TYPES.has(node.type)) {
    out.push(node);
    return out;
  }
  if (node.type === "conditional") {
    for (const field of ["consequence", "alternative"]) {
      const branch = node.childForFieldName(field);
      if (branch) csBranchTails(branch, out);
    }
    return out;
  }
  // `if` / `unless` / `case`: each `then`/`else`/`when`/`in` body contributes its tail.
  for (const child of node.namedChildren) {
    if (child.type === "then" || child.type === "else" || child.type === "body_statement" || child.type === "begin") {
      const tail = csTail(child);
      if (tail) csBranchTails(tail, out);
    } else if (child.type === "elsif" || child.type === "when" || child.type === "in_clause") {
      for (const sub of child.namedChildren) {
        if (sub.type !== "then" && sub.type !== "body_statement") continue;
        const tail = csTail(sub);
        if (tail) csBranchTails(tail, out);
      }
    }
  }
  return out;
}

/** All plain / operator assignment events to `name` in a body (mirrors body-last-expr). */
function csAssignments(body: AstNode, name: string): { plain: AstNode[]; orAssign: AstNode[]; other: number } {
  const plain: AstNode[] = [];
  const orAssign: AstNode[] = [];
  let other = 0;
  const scan = (n: AstNode): void => {
    if (n.type === "method" || n.type === "singleton_method" || n.type === "class" || n.type === "module") return;
    const lhs = n.childForFieldName("left");
    if (n.type === "assignment" && lhs?.text === name) {
      const rhs = n.childForFieldName("right");
      if (rhs) plain.push(rhs);
      else other += 1;
    } else if (n.type === "operator_assignment" && lhs?.text === name) {
      const rhs = n.childForFieldName("right");
      if (rhs && n.text.includes("||=")) orAssign.push(rhs);
      else other += 1;
    }
    for (const child of n.children) scan(child);
  };
  for (const child of body.children) scan(child);
  return { plain, orAssign, other };
}

/** `constInstanceType`, peeling receiver-passthrough tails first. */
function csTypeOf(node: AstNode): string | null {
  const direct = constInstanceType(node, csCatalogue());
  if (direct !== null) return direct;
  if (node.type !== "call" && node.type !== "method_call") return null;
  const method = node.childForFieldName("method");
  const receiver = node.childForFieldName("receiver");
  if (!method || !receiver || !CS_PASSTHROUGH_TAILS.has(method.text)) return null;
  return csTypeOf(receiver);
}

/** The shape class of a def's return, for the shapes the current inference misses. */
function csClassify(defNode: AstNode, owner = ""): string {
  const body = defNode.childForFieldName("body");
  if (!body) return "no-body";
  const tail = csTail(body);
  if (!tail) return "empty-body";
  if (constInstanceType(tail, csCatalogue()) !== null) return "already-inferable";
  if (csTypeOf(tail) !== null) return "passthrough-tail (freeze/dup/tap/presence)";
  if (CS_BRANCHING_TYPES.has(tail.type)) {
    const branches = csBranchTails(tail);
    if (branches.length === 0) return "conditional (no branch tails)";
    const types = branches.map((b) => csTypeOf(b));
    const named = types.filter((t): t is string => t !== null);
    if (named.length === types.length && new Set(named).size === 1) return "conditional ALL BRANCHES AGREE";
    if (named.length > 0) return "conditional partly typed (divergent/untypeable)";
    return "conditional fully untypeable";
  }
  if (tail.type === "identifier" || tail.type === "instance_variable") {
    const kind = tail.type === "identifier" ? "local" : "ivar";
    const { plain, orAssign, other } = csAssignments(body, tail.text);
    if (other > 0) return `${kind} tail — non-plain assignment`;
    if (plain.length === 0 && orAssign.length === 1) {
      return csTypeOf(orAssign[0]) !== null
        ? `${kind} tail — MEMOIZED ||= TYPED`
        : `${kind} tail — memoized ||= opaque`;
    }
    if (plain.length === 1 && orAssign.length === 0) {
      return csTypeOf(plain[0]) !== null ? `${kind} tail — SINGLE ASSIGN TYPED` : `${kind} tail — single assign opaque`;
    }
    if (plain.length + orAssign.length === 0) return `${kind} tail — assigned elsewhere (param/ivar from initialize)`;
    return `${kind} tail — reassigned (${plain.length} plain, ${orAssign.length} ||=)`;
  }
  if (tail.type === "call" || tail.type === "method_call") {
    const receiver = tail.childForFieldName("receiver");
    if (receiver !== null) return "qualified call tail (opaque)";
    // A receiver-less tail dispatches on self, so a one-hop closure over the
    // owner-qualified channel would type it IFF the sibling method has a fact.
    const callee = tail.childForFieldName("method")?.text;
    const sibling = callee === undefined || owner.length === 0 ? undefined : ofOwnerFact(owner, callee);
    return sibling === undefined
      ? "bare self-call tail — sibling also opaque"
      : "bare self-call tail — SIBLING HAS A FACT (one-hop closure)";
  }
  if (CS_LITERAL_TYPES.has(tail.type)) return "literal / non-nominal";
  if (tail.type === "constant" || tail.type === "scope_resolution") return "constant reference (class object)";
  if (tail.type === "self") return "self";
  if (tail.type === "assignment" || tail.type === "operator_assignment") {
    // The VALUE of `x = e` is `e`, and of `x ||= e` it is `e` whenever x was
    // falsy — the memoized-reader idiom. Whether that is actionable depends
    // entirely on whether the RHS types, so split the bucket by RHS shape
    // rather than by the assignment operator.
    const op = tail.type === "operator_assignment" ? (tail.text.includes("||=") ? "||=" : "other-op") : "=";
    const rhs = tail.childForFieldName("right");
    if (op === "other-op") return "assignment tail — non-|| operator";
    if (!rhs) return "assignment tail — no RHS";
    if (csTypeOf(rhs) !== null) return `assignment tail (${op}) — RHS TYPED`;
    if (rhs.type === "call" || rhs.type === "method_call") {
      const recv = rhs.childForFieldName("receiver");
      const method = rhs.childForFieldName("method")?.text;
      if (recv !== null && method !== undefined) {
        const recvText = recv.type === "scope_resolution" ? readScopeResolution(recv) : recv.text;
        if (/^[A-Z]\w*(?:::[A-Z]\w*)*$/.test(recvText)) {
          const known =
            runStructuredReturnTypes[`${recvText}.${method}`] ?? runStructuredReturnTypes[`${recvText}#${method}`];
          return known !== undefined
            ? `assignment tail (${op}) — RHS is Const.m() WITH a fact (one-hop closure)`
            : `assignment tail (${op}) — RHS is Const.m() with no fact`;
        }
      }
    }
    return `assignment tail (${op}) — RHS opaque`;
  }
  return `other: ${tail.type}`;
}

function runCalleeShapeOracle(): void {
  const L = (s: string) => {
    console.log(s);
  };
  L("");
  L("═══════════════════════════════════════════════════════════════════");
  L("  CALLEE-RETURN SHAPE ORACLE (bd smvyk)");
  L("═══════════════════════════════════════════════════════════════════");

  // ── population: uncovered callee coordinates + their binding-site reach ────
  const wanted = new Map<string, number>(); // "<owner>#<member>" -> sites
  const byFile = new Map<string, Map<string, string[]>>(); // relPath -> fq -> members
  let bareSitesScoped = 0;
  let uncoveredSites = 0;
  for (const rec of ofChunkBindings) {
    const scopeKey = rec.scope.join("::");
    if (scopeKey.length === 0) continue;
    for (const binding of Object.values(rec.bindings)) {
      if (binding.lastIndexOf(".") > 0) continue;
      bareSitesScoped += 1;
      if (runReturnTypes[binding] !== undefined) continue;
      if (ofOwnerFact(scopeKey, binding) !== undefined) continue;
      const closure = tfAncestorClosure(scopeKey);
      const definers = symbolTable
        .lookupByShortName(binding)
        .filter((d) => d.scope.length > 0 && closure.has(d.scope.join("::")));
      const owners = new Set(definers.map((d) => d.scope.join("::")));
      if (owners.size !== 1) continue;
      uncoveredSites += 1;
      const owner = [...owners][0];
      const coord = `${owner}#${binding}`;
      wanted.set(coord, (wanted.get(coord) ?? 0) + 1);
      for (const def of definers) {
        const perFile = byFile.get(def.relPath) ?? new Map<string, string[]>();
        const members = perFile.get(owner) ?? [];
        if (!members.includes(binding)) members.push(binding);
        perFile.set(owner, members);
        byFile.set(def.relPath, perFile);
      }
    }
  }

  // ── classify: re-parse only the declaring files, once each ────────────────
  const shapeCoords = new Map<string, number>();
  const shapeSites = new Map<string, number>();
  const examples = new Map<string, string[]>();
  let classified = 0;
  let parseFailures = 0;
  const seenCoord = new Set<string>();
  for (const [relPath, perFile] of byFile) {
    let root: AstNode;
    try {
      const code = readFileSync(join(ROOT, relPath), "utf8");
      const parser = new Parser();
      parser.setLanguage(rbConfig.loadParser());
      root = materializeTree(parser.parse(code).rootNode, code);
    } catch {
      parseFailures += 1;
      continue;
    }
    forEachClassScope(root, (classNode, fq) => {
      const members = perFile.get(fq);
      if (members === undefined) return;
      const scan = (n: AstNode): void => {
        if (n.type === "class" || n.type === "module") return;
        if (n.type === "method" || n.type === "singleton_method") {
          const nameNode = n.childForFieldName("name");
          if (nameNode !== null && members.includes(nameNode.text)) {
            const coord = `${fq}#${nameNode.text}`;
            if (!seenCoord.has(coord)) {
              seenCoord.add(coord);
              const shape = csClassify(n, fq);
              classified += 1;
              shapeCoords.set(shape, (shapeCoords.get(shape) ?? 0) + 1);
              shapeSites.set(shape, (shapeSites.get(shape) ?? 0) + (wanted.get(coord) ?? 0));
              const list = examples.get(shape) ?? [];
              if (list.length < 4) list.push(`${coord} (${wanted.get(coord) ?? 0} sites)`);
              examples.set(shape, list);
            }
          }
          return;
        }
        for (const child of n.children) scan(child);
      };
      const body = classNode.childForFieldName("body");
      for (const child of (body ?? classNode).children) scan(child);
    });
  }

  L("");
  L("─── population ────────────────────────────────────────────────────");
  L(`bare binding sites inside a class:        ${bareSitesScoped}`);
  L(`  no fact anywhere + exactly ONE MRO definer: ${uncoveredSites} sites over ${wanted.size} coordinates`);
  L(
    `  coordinates located in source and classified: ${classified}   (files re-parsed: ${byFile.size}, failures: ${parseFailures})`,
  );
  L("");
  L("─── body-tail shape of the uncovered callee (by SITE reach) ───────");
  for (const [shape, sites] of [...shapeSites.entries()].sort((a, b) => b[1] - a[1])) {
    const coords = shapeCoords.get(shape) ?? 0;
    L(`  ${String(sites).padStart(6)} sites  ${String(coords).padStart(5)} defs   ${shape}`);
    for (const ex of examples.get(shape) ?? []) L(`                                 e.g. ${ex}`);
  }
  L("");
}

// ---------------------------------------------------------------------------
// NULLARY-RECEIVER ORACLE (CODEGRAPH_NULLARY_ORACLE=1)
//
// Walks the MISS set (not the binding set): every unresolved call whose receiver
// is — or whose chain HEAD is — a bare identifier that the chunk never bound as a
// local. In Ruby that identifier can only be a zero-arg method on self or an
// ancestor, so the caller's MRO decides what it returns.
// ---------------------------------------------------------------------------

/** A plain lowercase Ruby identifier (never a constant, ivar, index or chain). */
const NL_IDENTIFIER = /^[a-z_]\w*[?!]?$/;

/** Every distinct owner-qualified return fact for `member` on `klass`'s MRO. */
function nlFactsOnMro(klass: string, member: string): Set<string> {
  const out = new Set<string>();
  for (const owner of [klass, ...(runAncestors[klass] ?? [])]) {
    const fact = runStructuredReturnTypes[`${owner}#${member}`];
    const name = fact === undefined ? undefined : tfRefName(fact);
    if (name !== undefined) out.add(name);
  }
  return out;
}

function runNullaryOracle(): void {
  const L = (s: string) => {
    console.log(s);
  };
  L("");
  L("═══════════════════════════════════════════════════════════════════");
  L("  NULLARY-RECEIVER ORACLE (bd pr7fu)");
  L("═══════════════════════════════════════════════════════════════════");

  const byKind: Record<string, number> = {};
  const verdicts: Record<string, number> = {
    "no enclosing class scope": 0,
    "receiver is a bound local (excluded)": 0,
    "no definer on the caller's MRO": 0,
    "definer on MRO, fact UNIQUE (actionable)": 0,
    "definer on MRO, facts CONFLICT (must stay silent)": 0,
    "definer on MRO, NO return fact": 0,
  };
  // Uncovered definers, so the same run says which body shape would unlock them.
  const uncovered = new Map<string, number>(); // "<owner>#<member>" -> misses
  const byFile = new Map<string, Map<string, string[]>>();
  let population = 0;

  for (const miss of misses) {
    if (miss.receiver === null || miss.receiver.includes("[") || miss.receiver.startsWith("@")) continue;
    const head = miss.receiver.split(".")[0];
    if (head === undefined || !NL_IDENTIFIER.test(head)) continue;
    population += 1;
    byKind[miss.receiverKind] = (byKind[miss.receiverKind] ?? 0) + 1;
    if (nlChunkLocals.get(`${miss.relPath}|${miss.callerSymbolId}`)?.has(head) === true) {
      verdicts["receiver is a bound local (excluded)"] += 1;
      continue;
    }
    const scopeKey = miss.enclosingScope.split(" > ").join("::");
    if (scopeKey.length === 0) {
      verdicts["no enclosing class scope"] += 1;
      continue;
    }
    const closure = tfAncestorClosure(scopeKey);
    const definers = symbolTable
      .lookupByShortName(head)
      .filter((d) => d.scope.length > 0 && closure.has(d.scope.join("::")));
    // A bare receiver takes no arguments, so a definer requiring one cannot be it.
    const nullary = definers.filter((d) => d.arity === undefined || d.arity.minRequired === 0);
    const owners = new Set(nullary.map((d) => d.scope.join("::")));
    if (owners.size === 0) {
      verdicts["no definer on the caller's MRO"] += 1;
      continue;
    }
    const facts = nlFactsOnMro(scopeKey, head);
    if (facts.size === 1) {
      verdicts["definer on MRO, fact UNIQUE (actionable)"] += 1;
      continue;
    }
    if (facts.size > 1) {
      verdicts["definer on MRO, facts CONFLICT (must stay silent)"] += 1;
      continue;
    }
    verdicts["definer on MRO, NO return fact"] += 1;
    if (owners.size !== 1) continue;
    const owner = [...owners][0];
    const coord = `${owner}#${head}`;
    uncovered.set(coord, (uncovered.get(coord) ?? 0) + 1);
    for (const def of nullary) {
      const perFile = byFile.get(def.relPath) ?? new Map<string, string[]>();
      const members = perFile.get(owner) ?? [];
      if (!members.includes(head)) members.push(head);
      perFile.set(owner, members);
      byFile.set(def.relPath, perFile);
    }
  }

  // Classify the uncovered definers' bodies — the demand side that funds smvyk.
  const shapeMisses = new Map<string, number>();
  const shapeDefs = new Map<string, number>();
  const examples = new Map<string, string[]>();
  const seenCoord = new Set<string>();
  let parseFailures = 0;
  for (const [relPath, perFile] of byFile) {
    let root: AstNode;
    try {
      const code = readFileSync(join(ROOT, relPath), "utf8");
      const parser = new Parser();
      parser.setLanguage(rbConfig.loadParser());
      root = materializeTree(parser.parse(code).rootNode, code);
    } catch {
      parseFailures += 1;
      continue;
    }
    forEachClassScope(root, (classNode, fq) => {
      const members = perFile.get(fq);
      if (members === undefined) return;
      const scan = (n: AstNode): void => {
        if (n.type === "class" || n.type === "module") return;
        if (n.type === "method" || n.type === "singleton_method") {
          const nameNode = n.childForFieldName("name");
          if (nameNode !== null && members.includes(nameNode.text)) {
            const coord = `${fq}#${nameNode.text}`;
            if (!seenCoord.has(coord)) {
              seenCoord.add(coord);
              const shape = csClassify(n, fq);
              shapeDefs.set(shape, (shapeDefs.get(shape) ?? 0) + 1);
              shapeMisses.set(shape, (shapeMisses.get(shape) ?? 0) + (uncovered.get(coord) ?? 0));
              const list = examples.get(shape) ?? [];
              if (list.length < 4) list.push(`${coord} (${uncovered.get(coord) ?? 0} misses)`);
              examples.set(shape, list);
            }
          }
          return;
        }
        for (const child of n.children) scan(child);
      };
      const body = classNode.childForFieldName("body");
      for (const child of (body ?? classNode).children) scan(child);
    });
  }

  L("");
  L("─── population: misses on a bare-identifier receiver / chain head ──");
  L(`total recall holes:                       ${misses.length}`);
  L(`  receiver (or chain head) is a bare identifier: ${population}`);
  for (const [kind, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    L(`    ${String(n).padStart(6)}  ${kind}`);
  }
  L("");
  L("─── what the caller's MRO says about that receiver ────────────────");
  for (const [verdict, n] of Object.entries(verdicts).sort((a, b) => b[1] - a[1])) {
    L(`  ${String(n).padStart(6)}  ${verdict}`);
  }
  L("");
  L(`─── body shape of the UNCOVERED nullary definers (${uncovered.size} coords, files ${byFile.size}, fail ${parseFailures})`);
  for (const [shape, n] of [...shapeMisses.entries()].sort((a, b) => b[1] - a[1])) {
    L(`  ${String(n).padStart(6)} misses  ${String(shapeDefs.get(shape) ?? 0).padStart(5)} defs   ${shape}`);
    for (const ex of examples.get(shape) ?? []) L(`                                  e.g. ${ex}`);
  }
  L("");
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
let hierarchyView: MapHierarchyView;
/** Baseline resolveSuccessRate, published for the fixpoint oracle's delta line. */
let resolveSuccessRateBaseline = 0;

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.error(`[forensics] root=${ROOT} gemfile=${gemfileContent ? "loaded" : "MISSING"}`);
  const files = discoverRubyFiles(ROOT, factory);
  console.error(
    `[forensics] discovered ${files.length} ruby files (post test/generated/gitignore/non-app-code filter)`,
  );

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
      if (FIXPOINT_ENABLED) scanFixpointAst(materializedRoot, relPath, extraction);
      if (LOCAL_CENSUS_ENABLED) scanLocalCensusAst(materializedRoot, extraction);
      if (DEFPARAM_ORACLE_ENABLED) scanDefParamOracleAst(materializedRoot, relPath, extraction);
      if (SIGGAP_ORACLE_ENABLED) scanSigGapOracleAst(materializedRoot, relPath, extraction);
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
  // Schema-column pre-pass (bd tea-rags-mcp-8l5fo) — an UNGATED mirror of
  // `provider.applySchemaColumns`, so the measured numbers reflect production.
  // Deliberately outside the CODEGRAPH_DUCK_ORACLE section: the duck oracle has
  // its own measurement-only schema reader, this is the production path.
  // Column VALUE types are HELD BACK here and merged LAST, exactly as
  // `RunState.seal` does (bd tea-rags-mcp-2a5oo): they rank below every other
  // return fact, including the j9xpf service-entry derivations composed below.
  let schemaColumnReturnTypes: Record<string, RubyTypeRef> = {};
  {
    const schemaSource = ruby.schemaColumnAccessors;
    let snapshot: string | null = null;
    try {
      if (schemaSource) snapshot = readFileSync(join(ROOT, schemaSource.schemaRelPath), "utf8");
    } catch {
      snapshot = null;
    }
    if (schemaSource && snapshot !== null) {
      const models = collectSchemaColumnModels({
        classAncestors: runAncestors,
        declaredTables: runSchemaTables,
        modelBaseClasses: schemaSource.modelBaseClasses,
        symbolTable,
      });
      const parsedTables = schemaSource.parseSchema(snapshot);
      const { definitions, returnTypes, stats } = synthesizeSchemaColumnDefs(
        parsedTables,
        models,
        schemaSource.modelNameForTable,
      );
      symbolTable.setSchemaColumns(definitions);
      schemaColumnReturnTypes = returnTypes;
      for (const table of parsedTables) runSchemaColumnsByTable.set(table.table, new Set(table.accessors));
      for (const def of definitions) runSchemaMappedModels.add(def.symbolId.slice(0, def.symbolId.lastIndexOf("#")));
      runSchemaModelNameForTable = schemaSource.modelNameForTable;
      console.error(
        `[forensics] schema columns: tables=${stats.schemaTables} models=${stats.models} ` +
          `explicit=${stats.mappedExplicit} inflected=${stats.mappedInflection} ` +
          `ambiguous=${stats.ambiguous} unmapped=${stats.unmapped} defs=${stats.definitions}`,
      );
    }
  }
  // DEFECT 2 discovery (always built for the count; threaded into ctx only when enabled).
  const selfDispatchProbe = buildSelfDispatchProbe(symbolTable, hierarchyView);
  runSelfDispatchTemplates = foldSelfDispatchTemplates(
    discoverSelfDispatchTemplates(runSelfDispatchMethods, selfDispatchProbe),
  );
  runSelfInstantiatingClassMethods = collectSelfInstantiatingClassMethods(runSelfDispatchMethods);
  // Service-entry RETURN threading (bd tea-rags-mcp-j9xpf) — the production
  // barrier composes it right here, between the self-dispatch discovery and the
  // schema value-type merge. The harness used to skip the step entirely, so its
  // `structuredReturnTypes` was missing every derived `<Entry>#<member>` fact and
  // its measured recall understated production. Snapshot the pre-derive map and
  // keep the derive output so the type-fact oracle can compare the two.
  const declaredBeforeDerive: Record<string, RubyTypeRef> = { ...runStructuredReturnTypes };
  const entryReturnTypes = deriveServiceEntryReturnTypes(
    [...runSelfInstantiatingClassMethods, ...Object.keys(runSelfDispatchTemplates)],
    runStructuredReturnTypes,
    selfDispatchProbe.relatedConcreteTypes,
    // Existence oracle (bd tea-rags-mcp-yt3im), same predicate `RunState.seal`
    // builds: a declared fact naming a type this run declares nowhere is an
    // annotation fiction and does not outrank the derivation.
    (typeName) => symbolTable.lookup(typeName).length > 0 || runAncestors[typeName] !== undefined,
  );
  for (const [key, ref] of Object.entries(entryReturnTypes)) runStructuredReturnTypes[key] = ref;
  // 2a5oo production mirror: column VALUE types merge LAST and only where the
  // coordinate is still empty — after the j9xpf derivations, never before.
  for (const [k, v] of Object.entries(schemaColumnReturnTypes)) {
    if (!(k in runStructuredReturnTypes)) runStructuredReturnTypes[k] = v;
  }
  console.error(
    `[forensics] j9xpf service-entry returns: entries=${runSelfInstantiatingClassMethods.length + Object.keys(runSelfDispatchTemplates).length} derived=${Object.keys(entryReturnTypes).length}`,
  );
  // bd tea-rags-mcp-bvalc barrier fold — always computed for the report, threaded
  // into ctx only when enabled.
  runParamTypes = foldKnownTargetParamTypes(runKnownTargetCallArgs.values(), runParamNames);
  runDerivedClassFieldTypes = deriveClassFieldTypesFromParams(
    runClassFieldParamLinks,
    runParamTypes,
    runTypedClassFields,
  );
  console.error(
    `[forensics] ctor param types: ${CTOR_PARAM_TYPES_ENABLED ? "ON " : "off"} ` +
      `sites=${runKnownTargetCallArgs.size} callees=${Object.keys(runParamTypes).length} ` +
      `params=${Object.values(runParamTypes).reduce((n, p) => n + Object.keys(p).length, 0)} ` +
      `links=${Object.values(runClassFieldParamLinks).reduce((n, f) => n + Object.keys(f).length, 0)} ` +
      `derivedIvars=${Object.values(runDerivedClassFieldTypes).reduce((n, f) => n + Object.keys(f).length, 0)}`,
  );

  // PASS-2: resolve.
  for (const extraction of extractions) resolvePass2(extraction);

  // metrics (provider.ts:1161-1174).
  const internalAttempted = Math.max(
    1,
    callsAttempted - callsExternalSkipped - callsUnresolvable - callsNoInProjectDef - callsCoreAmbiguous,
  );
  const resolveSuccessRate = callsAttempted === 0 ? 0 : callsResolved / internalAttempted;
  resolveSuccessRateBaseline = resolveSuccessRate;
  const missWithInProjectDef = Math.max(
    0,
    callsAttempted -
      callsResolved -
      callsExternalSkipped -
      callsUnresolvable -
      callsNoInProjectDef -
      callsCoreAmbiguous,
  );
  const recallDenominator = callsResolved + missWithInProjectDef;
  const inProjectEdgeRecall = recallDenominator === 0 ? 0 : callsResolved / recallDenominator;
  // bd 83cl7 pre/post view: the new branch only carves from the residual, so the
  // pre-83cl7 hole is EXACTLY the post-hole plus the carve-out — one run reports
  // both sides of the delta without a second baseline pass.
  const missPre83cl7 = missWithInProjectDef + callsCoreAmbiguous;
  const recallPre83cl7 = callsResolved + missPre83cl7 === 0 ? 0 : callsResolved / (callsResolved + missPre83cl7);

  // ---- report ----
  const L = (s: string) => {
    console.log(s);
  };
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
  L(`callsCoreAmbiguous:      ${callsCoreAmbiguous}   <-- bd 83cl7 core-homonym carve-out`);
  L(`missWithInProjectDef:    ${missWithInProjectDef}   <-- RECALL HOLE`);
  L("");
  L(`resolveSuccessRate:      ${fmtPct(resolveSuccessRate)}`);
  L(`inProjectEdgeRecall:     ${fmtPct(inProjectEdgeRecall)}`);
  L("");
  L("─── bd 83cl7 delta (pre vs post core-homonym carve-out) ───────────");
  L(`missWithInProjectDef:    ${missPre83cl7} -> ${missWithInProjectDef}   (${missWithInProjectDef - missPre83cl7})`);
  L(
    `inProjectEdgeRecall:     ${fmtPct(recallPre83cl7)} -> ${fmtPct(inProjectEdgeRecall)}   (+${((inProjectEdgeRecall - recallPre83cl7) * 100).toFixed(2)}pp)`,
  );
  L("");
  L("─── byReceiverKind ────────────────────────────────────────────────");
  L("kind          attempted  resolved   rate     ext-skip  no-def   coreAmb   recallHole");
  for (const kind of RECEIVER_KINDS) {
    const t = kindTally[kind];
    const hole = t.attempted - t.resolved - t.externalSkipped - t.unresolvable - t.noInProjectDef - t.coreAmbiguous;
    const rate = t.attempted === 0 ? 0 : t.resolved / t.attempted;
    L(
      `${kind.padEnd(12)}  ${String(t.attempted).padStart(8)}  ${String(t.resolved).padStart(8)}  ${fmtPct(rate).padStart(7)}  ${String(t.externalSkipped).padStart(8)}  ${String(t.noInProjectDef).padStart(6)}  ${String(t.coreAmbiguous).padStart(7)}  ${String(hole).padStart(9)}`,
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
      L(
        `     ${member} (x${ms.length})  e.g. ${ex.relPath}:${ex.line}  [defs:${ex.defCount} -> ${ex.defPaths[0] ?? "-"}]`,
      );
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
  L(
    `  migration-schema (db/migrate): ${migrationHoles.length}  (t.datetime/t.integer... — arguably exclude db/migrate)`,
  );
  L(`  external-DSL caller context:   ${dslCallerHoles.length}  (dry/chewy/AMS/exporter/graphql homonyms)`);
  L(
    `  => explained-by-homonym share: ${(((coreHomonym.length + dslCallerHoles.length + migrationHoles.length) / Math.max(1, misses.length)) * 100).toFixed(1)}% of all recall holes`,
  );
  L("");

  // whole-miss member frequency across ALL receiverKinds (for pattern spotting).
  const allByMember: Record<string, number> = {};
  for (const m of misses) allByMember[m.member] = (allByMember[m.member] ?? 0) + 1;
  L("─── top 25 miss members (all receiverKinds) ───────────────────────");
  for (const [member, n] of Object.entries(allByMember)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)) {
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
      callsCoreAmbiguous,
      missWithInProjectDef,
      missPre83cl7,
      resolveSuccessRate,
      inProjectEdgeRecall,
      recallPre83cl7,
      rubyOnly: true,
      note: "Ruby-only symbol table; cross-language short-name collisions may shift cg_run_stats cross-check slightly.",
    },
    byReceiverKind: Object.fromEntries(
      RECEIVER_KINDS.map((k) => {
        const t = kindTally[k];
        return [
          k,
          {
            ...t,
            recallHole:
              t.attempted - t.resolved - t.externalSkipped - t.unresolvable - t.noInProjectDef - t.coreAmbiguous,
          },
        ];
      }),
    ),
    bareCallTaxonomy: Object.fromEntries(CATS.map((c) => [c, (catCounts[c] ?? []).length])),
    misses,
  };
  writeFileSync(OUT_MISSES, JSON.stringify(payload, null, 2));
  L(`misses dumped: ${misses.length} -> ${OUT_MISSES}`);
  if (TYPEFACT_ENABLED) runTypefactOracle(declaredBeforeDerive);
  if (OWNERFACT_ENABLED) runOwnerfactOracle();
  if (CALLEESHAPE_ENABLED) runCalleeShapeOracle();
  if (NULLARY_ENABLED) runNullaryOracle();
  if (ORACLE_ENABLED) runOracle(Date.now() - t0, files.length);
  if (SUPER_ORACLE_ENABLED) runSuperOracle();
  if (LOCAL_CENSUS_ENABLED) runLocalCensus();
  if (DEFPARAM_ORACLE_ENABLED) runDefParamOracle();
  if (SIGGAP_ORACLE_ENABLED) runSigGapOracle();
  if (DUCK_ENABLED) runDuckOracle();
  if (FIXPOINT_ENABLED) runFixpointOracle(extractions, Date.now() - t0);
  L(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

let includedBy: Record<string, string[]> = {};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
