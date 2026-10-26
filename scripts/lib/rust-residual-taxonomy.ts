/**
 * Rust residual taxonomy (bd tea-rags-mcp-s3i8m.1): WHY a Rust call site stays
 * unresolved while an in-project definition of its member exists.
 *
 * Input is one `--residual-rows` row of `scripts/codegraph-chain-tally.ts` per
 * `missWithInProjectDef` site. Each site is re-located in its file's syntax
 * tree at the position the walker recorded (1-based line, 0-based UTF-16
 * column of the call EXPRESSION start, `rust/walker/walker.ts#collectRustCalls`)
 * and classified along two orthogonal axes:
 *
 *   A. callee / receiver mechanism, each category naming the mechanism bead
 *      that owns it (an empty list = no bead covers it yet, said out loud);
 *   B. whether the member name is a method std/core/alloc declares — a miss
 *      whose untyped receiver may well be an EXTERNAL value, i.e. a
 *      denominator question rather than a resolver gap.
 *
 * Syntax only, one file at a time: no macro expansion, no symbol table, no
 * type inference. A binding is found lexically (nearest enclosing scope first,
 * latest preceding `let` in a block), which is what the walker can see too.
 */
import type Parser from "tree-sitter";
import TreeSitterParser from "tree-sitter";

import { rustKernel } from "../../src/core/domains/language/rust/index.js";
import {
  rustStdMethodNames,
  rustTextIsStdMethodName,
} from "../../src/core/domains/language/rust/vocabulary/std-method-names.js";

const bead = (id: string): string => `tea-rags-mcp-${id}`;

/** Axis A. `beads` is the owning mechanism; empty when no bead names it yet. */
export const RUST_RESIDUAL_CATEGORIES = {
  "bare.localCallable": {
    beads: [bead("2g2og.25")],
    description: "bare call of a local closure / fn-pointer binding or callable param (callable flow)",
  },
  "bare.useImported": {
    beads: [bead("sjego"), bead("2g2og.16")],
    description: "bare call of a name a `use` brings in (unmapped import / crate alias)",
  },
  "bare.macro": { beads: [bead("2g2og.21")], description: "macro invocation (macro-adjacent)" },
  "bare.other": { beads: [], description: "bare call, no local or `use` binding in the file" },
  "path.selfModule": {
    beads: [bead("2g2og.20")],
    description: "`Self::` / `super::` / `crate::` / module-path callee",
  },
  "path.genericOrTrait": {
    beads: [bead("2g2og.17")],
    description: "associated fn on a generic param, a trait path or UFCS `<T as Tr>::f`",
  },
  "path.variantCtor": { beads: [bead("2g2og.22")], description: "enum variant / tuple-struct constructor path" },
  "path.concreteType": { beads: [], description: "associated fn on a concrete type path" },
  "binding.paramGenericOrTrait": {
    beads: [bead("f6di2"), bead("n1q1n")],
    description: "receiver is a param typed `T` / `impl Trait` / `dyn Trait` (trait dispatch, generics)",
  },
  "binding.paramConcrete": { beads: [], description: "receiver is a param with a concrete type" },
  "binding.letAnnotated": { beads: [], description: "receiver is a `let x: T` with a type annotation" },
  "binding.letCtor": { beads: [], description: "receiver is a `let x = Type::ctor(..)` / struct literal" },
  "binding.letCallResult": {
    beads: [bead("2g2og.24")],
    description: "receiver is a `let x = <method / free-fn call>` (call-result local)",
  },
  "binding.letMacro": { beads: [bead("2g2og.21")], description: "receiver is a `let x = macro!(..)`" },
  "binding.letOther": { beads: [], description: "receiver is a `let` bound from another expression" },
  "binding.pattern": {
    beads: [bead("2g2og.18")],
    description: "receiver bound by if-let / while-let / match arm / for / closure param / destructure",
  },
  "binding.notLocal": {
    beads: [bead("2g2og.22")],
    description: "receiver identifier with no local binding (static / const / global)",
  },
  "method.self": { beads: [bead("f6di2")], description: "`self.m()` (trait-provided or trait-default method)" },
  "method.selfField": { beads: [bead("2g2og.24")], description: "`self.field...m()` chain" },
  "method.localFieldChain": { beads: [bead("2g2og.24")], description: "`local.field...m()` chain" },
  "method.callChain": { beads: [bead("2g2og.24")], description: "method-call chain `a.b().c()`" },
  "method.indexed": { beads: [bead("2g2og.19")], description: "index receiver `a[i].m()`" },
  "method.wrapped": {
    beads: [bead("2g2og.18"), bead("2g2og.19")],
    description: "deref / paren / ref / try `?` / await wrapped receiver",
  },
  "method.macroResult": { beads: [bead("2g2og.21")], description: "receiver is a macro result `m!(..).f()`" },
  "method.pathValue": { beads: [bead("2g2og.22")], description: "receiver is a path value `mod::STATIC.m()`" },
  "method.otherExpr": { beads: [], description: "receiver is another expression (literal, closure, struct…)" },
  unknown: { beads: [], description: "not classified — see `reason`" },
} as const satisfies Record<string, { beads: readonly string[]; description: string }>;

export type RustResidualCategory = keyof typeof RUST_RESIDUAL_CATEGORIES;

/** The fields of a `--residual-rows` row the classifier reads. */
export interface RustResidualSite {
  relPath: string;
  startLine: number;
  /** 0-based UTF-16 column of the call expression start; absent → any column on the line. */
  startColumn?: number;
  receiver: string | null;
  member: string;
}

export interface RustResidualClassification {
  category: RustResidualCategory;
  /** Why the site is `unknown`. */
  reason?: string;
  /** The finer shape inside the category (binding kind, wrapper node type, …). */
  detail?: string;
}

/** Axis B lives in production vocabulary — the trait fallback gates on it too (s3i8m Task 2 rule 5). */
export const RUST_STD_OVERLAP_METHOD_NAMES: ReadonlySet<string> = rustStdMethodNames;

export function memberOverlapsStd(member: string): boolean {
  return rustTextIsStdMethodName(member);
}

/** A parser over the project's own Rust grammar loader (the codegraph kernel's). */
export async function createRustResidualParser(): Promise<Parser> {
  const module = await rustKernel.loadModule();
  if (module === null) throw new Error("tree-sitter-rust grammar is not installed");
  const language = rustKernel.extractLanguage?.(module) ?? module;
  const parser = new TreeSitterParser();
  parser.setLanguage(language as Parser.Language);
  return parser;
}

type Node = Parser.SyntaxNode;

const SCOPE_STOPS = new Set(["function_item", "impl_item", "trait_item", "mod_item", "source_file"]);
const WRAPPERS = new Set([
  "parenthesized_expression",
  "unary_expression",
  "reference_expression",
  "try_expression",
  "await_expression",
]);
const PATH_SELF_ROOTS = new Set(["Self", "self", "super", "crate"]);

/** The `{ receiver, member }` the walker records for `node` (mirror of `rustCallSiteShape`). */
function callShapeOf(node: Node): { receiver: string | null; member: string } | null {
  if (node.type === "macro_invocation") {
    const macro = node.childForFieldName("macro");
    if (macro === null) return null;
    if (macro.type !== "scoped_identifier") return { receiver: null, member: macro.text };
    const name = macro.childForFieldName("name");
    return name === null ? null : { receiver: macro.childForFieldName("path")?.text ?? null, member: name.text };
  }
  const fn = calleeOf(node);
  if (fn?.type === "field_expression") {
    const value = fn.childForFieldName("value");
    const field = fn.childForFieldName("field");
    return value !== null && field !== null ? { receiver: value.text, member: field.text } : null;
  }
  if (fn?.type === "scoped_identifier") {
    const name = fn.childForFieldName("name");
    return name === null ? null : { receiver: fn.childForFieldName("path")?.text ?? null, member: name.text };
  }
  return fn?.type === "identifier" ? { receiver: null, member: fn.text } : null;
}

function calleeOf(call: Node): Node | null {
  let fn = call.childForFieldName("function");
  while (fn?.type === "generic_function") fn = fn.childForFieldName("function");
  return fn;
}

/** The call node the walker recorded at the site's position, matched on member (and receiver). */
function locateCall(root: Node, site: RustResidualSite): Node | null {
  const row = site.startLine - 1;
  const candidates = root.descendantsOfType(
    ["call_expression", "macro_invocation"],
    { row, column: 0 },
    { row: row + 1, column: 0 },
  );
  for (const node of candidates) {
    if (node.startPosition.row !== row) continue;
    if (site.startColumn !== undefined && node.startPosition.column !== site.startColumn) continue;
    const shape = callShapeOf(node);
    if (shape?.member !== site.member) continue;
    if (site.receiver !== null && shape.receiver !== null && shape.receiver !== site.receiver) continue;
    return node;
  }
  return null;
}

/** Does `pattern` bind `name`, and is it the whole pattern (a direct binding)? */
function patternBinding(pattern: Node | null, name: string): "direct" | "destructure" | null {
  if (pattern === null) return null;
  const core =
    pattern.type === "mut_pattern" || pattern.type === "ref_pattern" ? pattern.namedChildren.at(-1) : pattern;
  if (core?.type === "identifier") return core.text === name ? "direct" : null;
  return bindsInside(pattern, name) ? "destructure" : null;
}

/** An identifier binding `name` anywhere in a pattern, skipping its type paths and match guards. */
function bindsInside(node: Node, name: string): boolean {
  const skipped = new Set(
    ["type", "condition"].map((field) => node.childForFieldName(field)?.id).filter((id) => id !== undefined),
  );
  for (const child of node.namedChildren) {
    if (skipped.has(child.id)) continue;
    const binds = child.type === "identifier" || child.type === "shorthand_field_identifier";
    if (binds && child.text === name) return true;
    if (bindsInside(child, name)) return true;
  }
  return false;
}

/** Generic type-parameter names visible at `node`: its fn, impl and trait. */
function genericParamsInScope(node: Node): Set<string> {
  const names = new Set<string>();
  for (let cur: Node | null = node; cur !== null; cur = cur.parent) {
    if (cur.type !== "function_item" && cur.type !== "impl_item" && cur.type !== "trait_item") continue;
    for (const param of cur.childForFieldName("type_parameters")?.namedChildren ?? []) {
      const nameNode =
        param.type === "type_identifier" ? param : (param.childForFieldName("name") ?? param.namedChildren[0]);
      if (nameNode?.type === "type_identifier") names.add(nameNode.text);
    }
  }
  return names;
}

function typeIsGenericOrTrait(type: Node | null, generics: Set<string>): boolean {
  if (type === null) return false;
  if (type.descendantsOfType(["dynamic_type", "abstract_type"]).length > 0) return true;
  let core: Node | null = type;
  while (core?.type === "reference_type" || core?.type === "pointer_type") core = core.childForFieldName("type");
  if (core?.type === "generic_type") core = core.childForFieldName("type");
  return core?.type === "type_identifier" && generics.has(core.text);
}

/** How a `let x = <value>` binds a direct identifier. */
function letValueKind(declaration: Node): string {
  if (declaration.childForFieldName("type") !== null) return "letAnnotated";
  let value = declaration.childForFieldName("value");
  while (value !== null && WRAPPERS.has(value.type)) value = value.namedChildren[0] ?? null;
  if (value === null) return "letOther";
  if (value.type === "struct_expression") return "letCtor";
  if (value.type === "macro_invocation") return "letMacro";
  if (value.type === "call_expression") {
    const fn = calleeOf(value);
    if (fn?.type === "identifier" && /^[A-Z]/.test(fn.text)) return "letCtor";
    if (fn?.type === "scoped_identifier") {
      const typeSegment = fn.childForFieldName("path")?.text.split("::").at(-1) ?? "";
      if (/^[A-Z]/.test(typeSegment)) return "letCtor";
    }
    return "letCallResult";
  }
  return "letOther";
}

/**
 * The nearest lexical binding of `name` visible at `from`, walking outwards to
 * the enclosing fn (closures are transparent, items are not). `kind` is a
 * `binding.*` suffix; `detail` names the binding construct.
 */
function findLocalBinding(from: Node, name: string): { kind: string; detail: string } | null {
  for (let cur = from, { parent } = from; parent !== null; cur = parent, { parent } = parent) {
    switch (parent.type) {
      case "block": {
        const siblings = parent.namedChildren;
        const index = siblings.findIndex((child) => child.id === cur.id);
        for (let i = index - 1; i >= 0; i--) {
          const statement = siblings[i];
          if (statement.type !== "let_declaration") continue;
          const binding = patternBinding(statement.childForFieldName("pattern"), name);
          if (binding === "direct") return { kind: letValueKind(statement), detail: "let" };
          if (binding === "destructure") return { kind: "pattern", detail: "destructure" };
        }
        break;
      }
      case "if_expression":
      case "while_expression": {
        const condition = parent.childForFieldName("condition");
        if (condition === null || condition.id === cur.id) break;
        const lets = condition.type === "let_condition" ? [condition] : condition.descendantsOfType("let_condition");
        if (lets.some((l) => patternBinding(l.childForFieldName("pattern"), name) !== null)) {
          return { kind: "pattern", detail: parent.type === "if_expression" ? "ifLet" : "whileLet" };
        }
        break;
      }
      case "match_arm": {
        // Only the arm's PATTERN binds; its body merely mentions outer names.
        const pattern = parent.childForFieldName("pattern");
        if (pattern !== null && pattern.id !== cur.id && bindsInside(pattern, name)) {
          return { kind: "pattern", detail: "matchArm" };
        }
        break;
      }
      case "for_expression":
        if (
          parent.childForFieldName("body")?.id === cur.id &&
          patternBinding(parent.childForFieldName("pattern"), name) !== null
        ) {
          return { kind: "pattern", detail: "for" };
        }
        break;
      case "closure_expression":
        for (const param of parent.childForFieldName("parameters")?.namedChildren ?? []) {
          const pattern = param.type === "parameter" ? param.childForFieldName("pattern") : param;
          if (patternBinding(pattern, name) !== null) return { kind: "pattern", detail: "closureParam" };
        }
        break;
      case "function_item": {
        for (const param of parent.childForFieldName("parameters")?.namedChildren ?? []) {
          if (param.type !== "parameter") continue;
          const binding = patternBinding(param.childForFieldName("pattern"), name);
          if (binding === "destructure") return { kind: "pattern", detail: "paramDestructure" };
          if (binding === "direct") {
            const generic = typeIsGenericOrTrait(param.childForFieldName("type"), genericParamsInScope(parent));
            return { kind: generic ? "paramGenericOrTrait" : "paramConcrete", detail: "param" };
          }
        }
        return null;
      }
      default:
        if (SCOPE_STOPS.has(parent.type)) return null;
    }
  }
  return null;
}

function useImportedNames(root: Node): Set<string> {
  const names = new Set<string>();
  for (const declaration of root.descendantsOfType("use_declaration")) {
    for (const identifier of declaration.descendantsOfType("identifier")) names.add(identifier.text);
  }
  return names;
}

function traitNames(root: Node): Set<string> {
  return new Set(root.descendantsOfType("trait_item").map((t) => t.childForFieldName("name")?.text ?? ""));
}

function classifyPathCall(call: Node, callee: Node, member: string): RustResidualClassification {
  if (/^[A-Z]/.test(member)) return { category: "path.variantCtor" };
  const path = callee.childForFieldName("path");
  if (path === null) return { category: "path.selfModule", detail: "global" };
  if (path.type === "bracketed_type" || path.type === "generic_type" || path.text.startsWith("<")) {
    return { category: "path.genericOrTrait", detail: "ufcs" };
  }
  const segments = path.text.split("::").map((s) => s.replace(/<.*$/s, ""));
  if (PATH_SELF_ROOTS.has(segments[0])) return { category: "path.selfModule", detail: segments[0] };
  const generics = genericParamsInScope(call);
  if (segments.some((s) => generics.has(s))) return { category: "path.genericOrTrait", detail: "genericParam" };
  const last = segments.at(-1) ?? "";
  if (traitNames(call.tree.rootNode).has(last)) return { category: "path.genericOrTrait", detail: "traitPath" };
  if (/^[a-z_]/.test(last)) return { category: "path.selfModule", detail: "module" };
  return { category: "path.concreteType" };
}

function classifyReceiver(call: Node, value: Node): RustResidualClassification {
  switch (value.type) {
    case "self":
      return { category: "method.self" };
    case "identifier": {
      const binding = findLocalBinding(call, value.text);
      if (binding === null) return { category: "binding.notLocal" };
      return { category: `binding.${binding.kind}` as RustResidualCategory, detail: binding.detail };
    }
    case "field_expression": {
      let root = value;
      while (root.type === "field_expression") root = root.childForFieldName("value") ?? root;
      if (root.type === "self") return { category: "method.selfField" };
      if (root.type === "identifier") return { category: "method.localFieldChain" };
      return { ...classifyReceiver(call, root), detail: `fieldOf:${root.type}` };
    }
    case "call_expression":
      return { category: "method.callChain" };
    case "index_expression":
      return { category: "method.indexed" };
    case "macro_invocation":
      return { category: "method.macroResult" };
    case "scoped_identifier":
      return { category: "method.pathValue" };
    default:
      if (WRAPPERS.has(value.type)) return { category: "method.wrapped", detail: value.type };
      return { category: "method.otherExpr", detail: value.type };
  }
}

/** Axis A for one residual site, read from the syntax tree of its file. */
export function classifyRustResidualSite(root: Node, site: RustResidualSite): RustResidualClassification {
  const call = locateCall(root, site);
  if (call === null) return { category: "unknown", reason: "callNotLocated" };
  if (call.type === "macro_invocation") return { category: "bare.macro" };
  const callee = calleeOf(call);
  if (callee === null) return { category: "unknown", reason: "callee:none" };
  switch (callee.type) {
    case "identifier": {
      const binding = findLocalBinding(call, site.member);
      if (binding !== null) return { category: "bare.localCallable", detail: binding.detail };
      if (useImportedNames(root).has(site.member)) return { category: "bare.useImported" };
      return { category: "bare.other" };
    }
    case "scoped_identifier":
      return classifyPathCall(call, callee, site.member);
    case "field_expression": {
      const value = callee.childForFieldName("value");
      return value === null ? { category: "unknown", reason: "receiverMissing" } : classifyReceiver(call, value);
    }
    default:
      return { category: "unknown", reason: `callee:${callee.type}` };
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface RustResidualClassifiedSite extends RustResidualClassification {
  site: RustResidualSite;
  /** The trimmed source line at `site.startLine` ("" when the file was unreadable). */
  sourceLine: string;
}

export interface RustResidualSample {
  relPath: string;
  line: number;
  column: number | null;
  receiver: string | null;
  member: string;
  detail?: string;
  reason?: string;
  stdOverlap: boolean;
  sourceLine: string;
}

export interface RustResidualCategoryRow {
  category: RustResidualCategory;
  description: string;
  beads: readonly string[];
  count: number;
  share: number;
  stdOverlap: number;
  samples: RustResidualSample[];
}

export interface RustResidualTaxonomyReport {
  corpus: string;
  total: number;
  stdOverlap: number;
  categories: RustResidualCategoryRow[];
  /** `unknown` rows by reason. */
  unknownReasons: Record<string, number>;
}

const siteOrder = (a: RustResidualClassifiedSite, b: RustResidualClassifiedSite): number =>
  a.site.relPath.localeCompare(b.site.relPath) ||
  a.site.startLine - b.site.startLine ||
  (a.site.startColumn ?? 0) - (b.site.startColumn ?? 0);

/** Every `floor(n / limit)`-th row of the sorted population — spread, not the first files. */
function strideSample<T>(sorted: readonly T[], limit: number): T[] {
  if (limit <= 0) return [];
  const stride = Math.max(1, Math.floor(sorted.length / limit));
  const out: T[] = [];
  for (let i = 0; i < sorted.length && out.length < limit; i += stride) out.push(sorted[i]);
  return out;
}

export function buildRustResidualTaxonomyReport(
  corpus: string,
  classified: readonly RustResidualClassifiedSite[],
  samplesPerCategory: number,
): RustResidualTaxonomyReport {
  const byCategory = new Map<RustResidualCategory, RustResidualClassifiedSite[]>();
  const unknownReasons: Record<string, number> = {};
  for (const row of classified) {
    const bucket = byCategory.get(row.category) ?? [];
    bucket.push(row);
    byCategory.set(row.category, bucket);
    if (row.category === "unknown") {
      const reason = row.reason ?? "unspecified";
      unknownReasons[reason] = (unknownReasons[reason] ?? 0) + 1;
    }
  }
  const total = classified.length;
  const categories = [...byCategory.entries()].map(([category, rows]): RustResidualCategoryRow => {
    const sorted = [...rows].sort(siteOrder);
    return {
      category,
      description: RUST_RESIDUAL_CATEGORIES[category].description,
      beads: RUST_RESIDUAL_CATEGORIES[category].beads,
      count: rows.length,
      share: total === 0 ? 0 : rows.length / total,
      stdOverlap: rows.filter((r) => memberOverlapsStd(r.site.member)).length,
      samples: strideSample(sorted, samplesPerCategory).map((r) => ({
        relPath: r.site.relPath,
        line: r.site.startLine,
        column: r.site.startColumn ?? null,
        receiver: r.site.receiver,
        member: r.site.member,
        ...(r.detail === undefined ? {} : { detail: r.detail }),
        ...(r.reason === undefined ? {} : { reason: r.reason }),
        stdOverlap: memberOverlapsStd(r.site.member),
        sourceLine: r.sourceLine,
      })),
    };
  });
  categories.sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  return {
    corpus,
    total,
    stdOverlap: classified.filter((r) => memberOverlapsStd(r.site.member)).length,
    categories,
    unknownReasons,
  };
}

/** The compact stdout table: one line per category, largest first. */
export function formatRustResidualTaxonomyTable(report: RustResidualTaxonomyReport): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `RUST RESIDUAL TAXONOMY · ${report.corpus} · ${report.total} missWithInProjectDef sites` +
      ` · std-overlap ${report.stdOverlap} (${pct(report.total === 0 ? 0 : report.stdOverlap / report.total)})`,
    `  ${"category".padEnd(28)} ${"count".padStart(7)} ${"share".padStart(7)} ${"stdOvl".padStart(7)}  beads`,
  ];
  for (const row of report.categories) {
    lines.push(
      `  ${row.category.padEnd(28)} ${String(row.count).padStart(7)} ${pct(row.share).padStart(7)}` +
        ` ${String(row.stdOverlap).padStart(7)}  ${row.beads.length === 0 ? "(unmapped)" : row.beads.join(", ")}`,
    );
  }
  const reasons = Object.entries(report.unknownReasons);
  if (reasons.length > 0) lines.push(`  unknown reasons: ${reasons.map(([r, n]) => `${r} ${n}`).join(" · ")}`);
  return lines.join("\n");
}
