/**
 * Ruby `nameOf` — maps a tree-sitter node to its `NamedSymbol` descriptor(s)
 * for codegraph symbol extraction. Relocated from
 * `domains/trajectory/codegraph/symbols/provider.ts` (`rbNameOf` + the
 * `ruby*Emission` helpers) into the native Ruby language provider per the
 * `domains/language` consolidation (spec §3). Behaviour-preserving extraction:
 * the node-shape detection and symbol emission are identical to the provider's
 * former inline functions.
 *
 * Both `method` and `singleton_method` route through `classifyMethod` (in
 * `infra/symbolid`) so the chunker and codegraph agree on the separator for
 * the same physical AST node (`.claude/rules/symbolid-convention.md`).
 *
 * DSL-macro coverage is split: the SHARED method-declaring macros
 * (`attr_*`/`cattr_*`/`mattr_*`/`delegate`) come from the single `ruby/dsl`
 * catalogue via `RUBY_DSL[name].declares` — the same source the chunker-side
 * `macros.ts` reads — so chunker symbolIds match cg_symbols rows by
 * construction. Only AR associations (`has_many`/`belongs_to`/`scope`/…), which
 * the catalogue deliberately keeps GROUP-ONLY (no `declares`), are synthesised
 * locally in `AR_ASSOCIATION_MACROS`. See `rubyMacroEmission` for the lookup
 * order and `.claude/rules/symbolid-convention.md` for the lockstep contract.
 */

import type Parser from "tree-sitter";

import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import { classifyMethod, rubyInsideSingletonClass } from "../../../../infra/symbolid/index.js";
import { RUBY_DSL } from "../dsl/index.js";

function methodKindFromClassify(node: Parser.SyntaxNode): "instance" | "static" | undefined {
  const c = classifyMethod(node);
  return c === null ? undefined : c;
}

/**
 * Force every emitted symbol's `methodKind` to `static`. Used when a
 * macro/define/alias node sits inside a `class << self` (singleton_class):
 * those declare CLASS-level methods (`Foo.method`, `.` separator) per
 * .claude/rules/symbolid-convention.md, mirroring the chunker-side
 * `extractRubyMacroSymbols` singleton override.
 */
function toStaticKind(result: NamedSymbol | NamedSymbol[]): NamedSymbol | NamedSymbol[] {
  return Array.isArray(result)
    ? result.map((s) => ({ ...s, methodKind: "static" as const }))
    : { ...result, methodKind: "static" as const };
}

export function rbNameOf(node: Parser.SyntaxNode): NamedSymbol | NamedSymbol[] | null {
  // Both `method` and `singleton_method` route through classifyMethod
  // (in core/infra/symbolid) so the chunker and codegraph agree on the
  // separator for the same physical AST node. classifyMethod also walks
  // up to detect `class << self` blocks — regular `method` nodes inside
  // a singleton_class become class-level and join with `.` instead of `#`.
  if (node.type === "method" || node.type === "singleton_method") {
    const id = node.childForFieldName("name");
    if (id) {
      const kind = methodKindFromClassify(node) ?? "instance";
      // bd tea-rags-mcp-08v2 — `extend self` in a module body promotes every
      // instance method to ALSO be callable as a module-level method (`M.foo`
      // alongside `M#foo`). The chunker still emits a single symbolId per def
      // (instance form, matching the AST node's primary kind); the codegraph
      // adds the class-form alias so callers reaching `M.foo` resolve.
      // Only fires for regular `method` nodes inside a `module` body — class
      // <<<self and def self.foo already produce static-form symbols via
      // classifyMethod, and `extend self` is conventionally a module idiom
      // (`extend self` inside a class is rare and semantically different).
      if (node.type === "method" && kind === "instance" && rubyMethodInsideExtendSelfModule(node)) {
        return [
          { name: id.text, descendsInto: false, methodKind: "instance" },
          { name: id.text, descendsInto: false, methodKind: "static" },
        ];
      }
      return { name: id.text, descendsInto: false, methodKind: kind };
    }
  }
  if (node.type === "class" || node.type === "module") {
    // `class Acme::Auth` — read the scope_resolution chain so the
    // qualified class name composes correctly with the outer scope.
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    const localName = nameNode.type === "scope_resolution" ? scopeResolutionText(nameNode) : nameNode.text;
    return { name: localName, descendsInto: true };
  }
  // Ruby DSL macros — `attr_accessor :a, :b`, `has_many :products`, etc.
  // Each macro emits multiple synthetic methods at the current scope.
  // Only fires when the macro looks like a class-body declaration: a
  // `call` (or `method_call`) node with no receiver and a recognised
  // method name. Argument shape: a sequence of `simple_symbol` nodes.
  if (node.type === "call" || node.type === "method_call") {
    // Precedence: define_method → alias_method → DSL macro. Inside a
    // `class << self`, every such emission becomes static (`Foo.method`).
    const emit = rubyDefineMethodEmission(node) ?? rubyAliasMethodEmission(node) ?? rubyMacroEmission(node);
    if (emit) return rubyInsideSingletonClass(node) ? toStaticKind(emit) : emit;
  }
  // `alias new_name old_name` — Ruby keyword form is a distinct AST node
  // type (`alias`), not a `call`. Emit the new method name as an
  // instance method on the enclosing class so chunker and codegraph agree —
  // static inside a `class << self`.
  if (node.type === "alias") {
    const aliasEmit = rubyAliasKeywordEmission(node);
    if (aliasEmit) return rubyInsideSingletonClass(node) ? toStaticKind(aliasEmit) : aliasEmit;
  }
  return null;
}

/**
 * `alias_method :new_name, :old_name` — declares `new_name` as an alias
 * for `old_name` on the enclosing class. Only the new name is emitted as
 * a synthetic instance method; the call from the alias to its target
 * lives in the call graph via the walker's synthetic CallRef
 * (bd tea-rags-mcp-y2z5).
 */
function rubyAliasMethodEmission(node: Parser.SyntaxNode): NamedSymbol | null {
  if (node.childForFieldName("receiver")) return null;
  const methodField = node.childForFieldName("method");
  const methodNode = methodField ?? node.children.find((c) => c.type === "identifier");
  if (methodNode?.text !== "alias_method") return null;
  const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  const firstArg = args.namedChildren[0];
  if (firstArg?.type !== "simple_symbol") return null;
  const name = firstArg.text.startsWith(":") ? firstArg.text.slice(1) : firstArg.text;
  if (name.length === 0) return null;
  return { name, descendsInto: false, methodKind: "instance" };
}

/**
 * `alias new_name old_name` (keyword form) — separate AST node type
 * `alias` whose first identifier child is the new method name.
 */
function rubyAliasKeywordEmission(node: Parser.SyntaxNode): NamedSymbol | null {
  const idents = node.children.filter((c) => c.type === "identifier");
  const newName = idents[0]?.text;
  if (!newName) return null;
  return { name: newName, descendsInto: false, methodKind: "instance" };
}

/**
 * `define_method(:foo) { ... }` — declares an instance method at
 * runtime. When the first argument is a literal symbol or string, the
 * method name is statically known and we treat the call as a regular
 * method declaration on the enclosing class scope. Dynamic args
 * (`define_method(verb) { ... }` where verb is a variable) remain
 * unrepresentable.
 */
function rubyDefineMethodEmission(node: Parser.SyntaxNode): NamedSymbol | null {
  if (node.childForFieldName("receiver")) return null;
  const methodField = node.childForFieldName("method");
  const methodNode = methodField ?? node.children.find((c) => c.type === "identifier");
  if (methodNode?.text !== "define_method") return null;
  const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  const firstArg = args.namedChildren[0];
  if (!firstArg) return null;
  let name: string | null = null;
  if (firstArg.type === "simple_symbol") {
    name = firstArg.text.startsWith(":") ? firstArg.text.slice(1) : firstArg.text;
  } else if (firstArg.type === "string" || firstArg.type === "string_literal") {
    const inner = firstArg.namedChildren.find((c) => c.type === "string_content");
    name = inner ? inner.text : firstArg.text.replace(/^["']|["']$/g, "");
  }
  if (!name || name.length === 0) return null;
  return { name, descendsInto: false, methodKind: "instance" };
}

/**
 * AR-association macros the CODEGRAPH synthesises but the shared ruby/dsl
 * catalogue deliberately keeps GROUP-ONLY (no `declares`) — associations would
 * inflate the chunker's accessor count without changing chunk semantics
 * (catalogue Non-Goal). The codegraph needs them for symbol resolution, so they
 * live here. The SHARED method-declaring macros (attr_, cattr_, mattr_ accessor
 * families and delegate) come from the catalogue via `RUBY_DSL[name].declares`
 * — see rubyMacroEmission.
 *
 * Out of scope (intentional, both layers):
 *   - method_missing — pure runtime dispatch, unrepresentable
 *   - dynamically constructed names: `define_method("foo_#{x}")` etc.
 *   - included do blocks (ActiveSupport::Concern) — needs mixin merge
 *     pass (bd: see Concern follow-up)
 */
const AR_ASSOCIATION_MACROS: Record<string, (base: string) => { name: string; kind: "instance" | "static" }[]> = {
  has_many: (b) => [
    { name: b, kind: "instance" },
    { name: `${b}=`, kind: "instance" },
  ],
  has_one: (b) => [
    { name: b, kind: "instance" },
    { name: `${b}=`, kind: "instance" },
  ],
  // Legacy AR many-to-many — same accessor shape as has_many.
  has_and_belongs_to_many: (b) => [
    { name: b, kind: "instance" },
    { name: `${b}=`, kind: "instance" },
  ],
  belongs_to: (b) => [
    { name: b, kind: "instance" },
    { name: `${b}=`, kind: "instance" },
    { name: `${b}_id`, kind: "instance" },
    { name: `${b}_id=`, kind: "instance" },
  ],
  // AR `scope :active, -> { ... }` — adds a class method named after the
  // first symbol argument. Only the first arg matters; the lambda is
  // body, not an accessor target. Kept local (catalogue keeps `scope`
  // group-only) so the first-arg-only special-case below still applies.
  scope: (b) => [{ name: b, kind: "static" }],
};

function rubyMacroEmission(node: Parser.SyntaxNode): NamedSymbol[] | null {
  // Macro calls in class body have no receiver field — they're direct
  // method invocations like `attr_accessor :x` rather than `obj.attr_accessor`.
  if (node.childForFieldName("receiver")) return null;
  const methodField = node.childForFieldName("method");
  // For tree-sitter-ruby `call` nodes the function position may also
  // appear as the first identifier child when no `method` field is
  // populated (parser-version variance — fall back tolerantly).
  const methodNode = methodField ?? node.children.find((c) => c.type === "identifier");
  if (!methodNode) return null;
  const macroName = methodNode.text;
  // AR associations are synthesised locally; the SHARED method-declaring
  // macros (attr_*/cattr_*/mattr_*/delegate) come from the single ruby/dsl
  // catalogue — the same source the chunker reads — so both layers stay in
  // lockstep by construction.
  const builder = AR_ASSOCIATION_MACROS[macroName] ?? RUBY_DSL[macroName]?.declares;
  if (!builder) return null;
  // Argument list — `argument_list` field or the `arguments` field on
  // newer grammars.
  const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  const symbolBases: string[] = [];
  for (const arg of args.namedChildren) {
    if (arg.type !== "simple_symbol") continue;
    // `:product_ids` → strip leading `:`.
    const base = arg.text.startsWith(":") ? arg.text.slice(1) : arg.text;
    if (base.length > 0) symbolBases.push(base);
  }
  if (symbolBases.length === 0) return null;
  // For `scope :active, -> { ... }` only the first argument is the name;
  // for accessor macros every symbol argument generates its own method
  // set. Picking the first argument for `scope` is enforced by the
  // builder consuming `b` once.
  if (macroName === "scope") {
    const first = symbolBases[0];
    return builder(first).map((m) => ({ name: m.name, descendsInto: false, methodKind: m.kind }));
  }
  const out: NamedSymbol[] = [];
  for (const base of symbolBases) {
    for (const m of builder(base)) out.push({ name: m.name, descendsInto: false, methodKind: m.kind });
  }
  return out;
}

function rubyMethodInsideExtendSelfModule(methodNode: Parser.SyntaxNode): boolean {
  let p: Parser.SyntaxNode | null = methodNode.parent;
  while (p) {
    if (p.type === "class") return false;
    if (p.type === "module") {
      const body = p.childForFieldName("body");
      const stmts = body ? body.children : p.children;
      for (const stmt of stmts) {
        if (stmt.type !== "call" && stmt.type !== "method_call") continue;
        if (stmt.childForFieldName("receiver")) continue;
        const methodField = stmt.childForFieldName("method") ?? stmt.children.find((c) => c.type === "identifier");
        if (methodField?.text !== "extend") continue;
        const args = stmt.childForFieldName("arguments") ?? stmt.children.find((c) => c.type === "argument_list");
        if (!args) continue;
        const firstArg = args.namedChildren[0];
        if (firstArg?.type === "self") return true;
      }
      return false;
    }
    p = p.parent;
  }
  return false;
}

function scopeResolutionText(node: Parser.SyntaxNode): string {
  // Mirror ruby-walker's readScopeResolution; kept local to avoid an
  // export from the walker just for nameOf.
  const name = node.childForFieldName("name");
  const scope = node.childForFieldName("scope");
  if (!name) return "";
  const left =
    scope?.type === "scope_resolution" ? scopeResolutionText(scope) : scope?.type === "constant" ? scope.text : "";
  return left ? `${left}::${name.text}` : name.text;
}
