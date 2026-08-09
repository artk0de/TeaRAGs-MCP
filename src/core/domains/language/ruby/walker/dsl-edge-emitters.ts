/**
 * Synthetic call edges for Ruby's class-body DSL macros.
 *
 * A macro like `before_action :auth` or `get "/x", to: "posts#index"` writes no
 * call the AST can see, yet it dispatches somewhere at runtime. Each macro entry
 * in `dsl/` declares WHICH edge shape it emits via its `emits` descriptor;
 * {@link emitDslEdges} is the single dispatch that turns that descriptor into
 * CallRefs, and the helpers below it read the operands each shape needs —
 * callback symbols, delegate targets, Pundit policies, CanCanCan subjects,
 * routing specs, AMS serializer models.
 *
 * `dsl/` stays pure data; the framework conventions (`Policy` / `Controller` /
 * `Serializer` suffixes, CanCanCan's `Ability`) are interpretation and live
 * here.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { CallRef } from "../../../../contracts/types/codegraph.js";
import { RUBY_DSL, type RubyDslEmits } from "../dsl/index.js";
import { associationModelConstant, camelizeModelName } from "./association-types.js";
import { readScopeResolution } from "./ast-utils.js";

/**
 * Whether a DSL macro name is a callback registration (duzy). A
 * `before_action :auth` / `after_save :touch` callback names an instance
 * method by symbol; the walker emits a bare-receiver CallRef to it so the
 * resolver's same-class fallback pins `#auth`. Sourced from the single
 * `ruby/dsl` catalogue by `category === "callback"` — adding a callback
 * keyword there automatically enrols it here, no second list to maintain.
 * Exported as the callback-membership oracle for the `emits` parity test —
 * `emits === "self-instance"` ⟺ `isRubyCallbackMacro` (walker-emits.test.ts).
 */
export function isRubyCallbackMacro(name: string): boolean {
  return RUBY_DSL[name]?.category === "callback";
}

/**
 * Collect every leading symbol-argument name from a callback macro call
 * (duzy) — `before_action :a, :b, only: :show` → `["a", "b"]`. Stops at the
 * first non-`simple_symbol` arg (the `only:` / `if:` kwarg pair), so guard
 * conditions never become spurious method edges. Mirrors the `delegate`
 * leading-symbol scan in `extractDelegateSymbols`.
 */
function extractCallbackSymbols(callNode: AstNode): string[] {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return [];
  const out: string[] = [];
  for (const arg of args.namedChildren) {
    const direct = callbackNameFromArg(arg);
    if (direct !== null) {
      out.push(direct);
      continue;
    }
    // `before_action [:a, :b]` — an array literal names one callback per element.
    if (arg.type === "array") {
      for (const el of arg.namedChildren) {
        const name = callbackNameFromArg(el);
        if (name !== null) out.push(name);
      }
      continue;
    }
    // A guard kwarg pair (`only:` / `if:`), proc/lambda, or any other arg ends
    // the leading run of callback-method names.
    break;
  }
  return out;
}

/** Method name a callback positional arg names: `:sym` or `"str"`; `null` otherwise. */
function callbackNameFromArg(arg: AstNode): string | null {
  if (arg.type === "simple_symbol") {
    const base = arg.text.startsWith(":") ? arg.text.slice(1) : arg.text;
    return base.length > 0 ? base : null;
  }
  if (arg.type === "string" || arg.type === "string_literal") {
    const inner = arg.namedChildren.find((c) => c.type === "string_content");
    const text = inner ? inner.text : arg.text.replace(/^["']|["']$/g, "");
    return text.length > 0 ? text : null;
  }
  return null;
}

/**
 * Emit the synthetic class-body macro edge(s) for a `receiverText === null`
 * class-body macro call, selected by the macro entry's declarative `emits`
 * descriptor (dsl/types.ts). Replaces the four former per-category `if`
 * branches in {@link collectRubyCalls} — each arm is lifted VERBATIM from the
 * branch it supersedes (reusing the same `extract*` / `associationModelConstant`
 * helpers), so the pushed `{receiver, member}` shapes, the per-shape skip
 * guards, and the push order are byte-identical. `node` is the `call` /
 * `method_call` AST node; `out` accumulates the file's CallRefs.
 *
 * Membership parity (proven in walker-emits.test.ts): a macro entry carries
 *   - `"alias-redirect"`     iff `redirectTarget === "second-symbol"` (alias_method)
 *   - `"delegate-target"`    iff the keyword is `delegate`
 *   - `"self-instance"`      iff `category === "callback"` (isRubyCallbackMacro)
 *   - `"model-constant-ref"` iff the keyword is in RUBY_ASSOCIATION_MACROS
 * so routing dispatch through `emits` fires for the exact same name set as the
 * four predicates did.
 *
 * EVERY arm returns. A shape contributes its own edges and never a neighbour's,
 * so the arms can be reordered or appended to freely — an omitted `return` would
 * make the last arm's correctness depend on it staying last, which is a trap for
 * whoever adds the tenth shape. Pinned by the exact-edge-set cases in
 * walker-emits.test.ts.
 */
export function emitDslEdges(node: AstNode, emits: RubyDslEmits, startLine: number, out: CallRef[]): void {
  switch (emits) {
    // `alias_method :new, :old` — old name → {receiver:null, member:old} (bd tea-rags-mcp-y2z5).
    case "alias-redirect": {
      const oldName = extractSecondLiteralSymbol(node);
      if (oldName !== null) {
        out.push({ callText: node.text, receiver: null, member: oldName, startLine });
      }
      return;
    }
    // `delegate :a, :b, to: :recv` — per delegated sym → {receiver:to, member:sym} (bd tea-rags-mcp-mx9z).
    case "delegate-target": {
      const recv = extractDelegateTarget(node);
      if (recv !== null) {
        for (const sym of extractDelegateSymbols(node)) {
          out.push({ callText: node.text, receiver: recv, member: sym, startLine });
        }
      }
      return;
    }
    // `attributes :id, :name` (AMS serializer) — each attribute is READ off the
    // serialized resource; identical bare-receiver shape to a callback self-send,
    // so it resolves onto the serializer's custom attribute method when one is
    // defined. A PASS-THROUGH attribute (no such method) reaches the MODEL
    // instead, which the serializer names by convention (adx5p.9).
    case "serialized-attribute": {
      const model = serializedModelConstant(node);
      for (const sym of extractCallbackSymbols(node)) {
        out.push({ callText: node.text, receiver: null, member: sym, startLine });
        if (model !== null && !enclosingClassDefines(node, sym)) {
          out.push({ callText: node.text, receiver: model, member: sym, startLine });
        }
      }
      return;
    }
    // `before_action :auth` callbacks — per leading symbol → {receiver:null, member:sym} (duzy).
    case "self-instance": {
      for (const sym of extractCallbackSymbols(node)) {
        out.push({ callText: node.text, receiver: null, member: sym, startLine });
      }
      return;
    }
    // `authorize :relay, :update?` — Pundit policy dispatch → {receiver:<Record>Policy, member:<query>?} (n2kpz).
    case "policy-dispatch": {
      const target = punditPolicyTarget(node);
      if (target !== null) {
        out.push({ callText: node.text, receiver: target.policy, member: target.method, startLine });
      }
      return;
    }
    // `get "x", to: "posts#index"` — routed action → {receiver:<Ns::>Controller, member:action} (n2kpz).
    case "route-action": {
      const target = routeActionTarget(node);
      if (target !== null) {
        out.push({ callText: node.text, receiver: target.controller, member: target.action, startLine });
      }
      return;
    }
    // `authorize! :update, @post` — CanCanCan check → {receiver:Ability, member:initialize} (adx5p.9).
    case "ability-dispatch": {
      out.push({ callText: node.text, receiver: CANCAN_ABILITY_CLASS, member: "initialize", startLine });
      return;
    }
    // `can :read, Post` — CanCanCan rule subject → {receiver:C, member:C} (adx5p.9).
    case "ability-subject-ref": {
      const subject = abilitySubjectConstant(node);
      if (subject !== null) {
        out.push({ callText: node.text, receiver: subject, member: subject, startLine });
      }
      return;
    }
    // `has_many :posts` associations — model constant → {receiver:C, member:C} (duzy).
    case "model-constant-ref": {
      const model = associationModelConstant(node);
      if (model !== null) {
        out.push({ callText: node.text, receiver: model, member: model, startLine });
      }
    }
  }
}

/**
 * Pull the SECOND positional argument's literal symbol text out of a
 * call node. Used by `alias_method :new, :old` to recover the old method
 * name (the alias target) so the walker can synthesise a CallRef from
 * the new alias to the old method (bd tea-rags-mcp-y2z5).
 */
function extractSecondLiteralSymbol(callNode: AstNode): string | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  const secondArg = args.namedChildren[1];
  if (secondArg?.type !== "simple_symbol") return null;
  return secondArg.text.startsWith(":") ? secondArg.text.slice(1) : secondArg.text;
}

/**
 * Pundit `authorize(record, query?)` → the `<Policy>#<method>` its runtime
 * dispatch targets (bd tea-rags-mcp-n2kpz). The policy constant comes from the
 * FIRST arg — a symbol `:relay` → `RelayPolicy`, an array `[:admin, :status]` →
 * `Admin::StatusPolicy` (leading symbols are the namespace, the last is the
 * record). The method comes from the SECOND (query) symbol, normalised to end
 * in `?` (`:update` / `:update?` → `update?`). Returns null for the `@ivar`
 * record form (needs receiver-type inference) or an implicit query (needs the
 * enclosing action name) — both deferred; a null emits no edge.
 */
function punditPolicyTarget(callNode: AstNode): { policy: string; method: string } | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  const first = args.namedChildren[0];
  if (!first) return null;
  const stripColon = (t: string): string => (t.startsWith(":") ? t.slice(1) : t);
  let policy: string;
  if (first.type === "simple_symbol") {
    policy = `${camelizeModelName(stripColon(first.text))}Policy`;
  } else if (first.type === "array") {
    const syms = first.namedChildren.filter((c) => c.type === "simple_symbol").map((c) => stripColon(c.text));
    if (syms.length === 0) return null;
    const record = syms[syms.length - 1];
    const namespace = syms.slice(0, -1).map(camelizeModelName);
    policy = [...namespace, `${camelizeModelName(record)}Policy`].join("::");
  } else {
    return null; // @ivar / expression record — receiver-type inference deferred
  }
  const second = args.namedChildren[1];
  if (second?.type !== "simple_symbol") return null; // implicit query (action name) deferred
  const method = stripColon(second.text);
  return { policy, method: method.endsWith("?") ? method : `${method}?` };
}

/** The class-name suffix an AMS serializer carries (`UserSerializer` → `User`). */
const SERIALIZER_SUFFIX = "Serializer";

/** The nearest enclosing `class` node of `node`, or `null` at top level. */
function enclosingClassNode(node: AstNode): AstNode | null {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "class") return p;
    if (p.type === "module") return null; // a module body is not a serializer class
  }
  return null;
}

/**
 * The MODEL an AMS serializer serializes (bd tea-rags-mcp-adx5p.9). AMS resolves
 * a resource's serializer as `<Model>Serializer`, so the inverse — the enclosing
 * class name minus its `Serializer` suffix — names the model the pass-through
 * attributes are read off. The same convention-inference precedent as Pundit's
 * `<Record>Policy`, and like it the constant is emitted BARE (last segment only):
 * `Api::V1::UserSerializer` serializes `User`, and the resolver's constant pass
 * owns the scope walk.
 *
 * `null` when there is no enclosing class or its name carries no suffix — the
 * class is then not a serializer this convention can speak for.
 */
function serializedModelConstant(node: AstNode): string | null {
  const classNode = enclosingClassNode(node);
  const nameNode = classNode?.childForFieldName("name");
  if (!nameNode) return null;
  const fq = nameNode.type === "scope_resolution" ? readScopeResolution(nameNode) : nameNode.text;
  const local = fq.split("::").pop() ?? "";
  if (!local.endsWith(SERIALIZER_SUFFIX) || local.length === SERIALIZER_SUFFIX.length) return null;
  return local.slice(0, -SERIALIZER_SUFFIX.length);
}

/**
 * Does the class enclosing `node` define `def <name>` in its OWN body (bd
 * tea-rags-mcp-adx5p.9)? An AMS serializer that defines an attribute method
 * serves the attribute from THERE, never from the model — so the model read must
 * not be emitted for it. Nested classes are not descended into: their defs
 * belong to them.
 */
function enclosingClassDefines(node: AstNode, name: string): boolean {
  const classNode = enclosingClassNode(node);
  const body = classNode?.childForFieldName("body");
  if (!body) return false;
  let found = false;
  const scan = (n: AstNode): void => {
    if (found || n.type === "class" || n.type === "module") return;
    if (n.type === "method" && n.childForFieldName("name")?.text === name) {
      found = true;
      return;
    }
    for (const child of n.children) scan(child);
  };
  for (const child of body.children) scan(child);
  return found;
}

/**
 * The class CanCanCan's `current_ability` builds (bd tea-rags-mcp-adx5p.9). The
 * gem's own `ControllerAdditions#current_ability` is literally
 * `@current_ability ||= ::Ability.new(current_user)`, so every permission check
 * in an app that has not overridden that method reaches THIS constant. A
 * convention string owned by the interpreter, exactly like Pundit's `Policy`
 * suffix and routing's `Controller` suffix — `dsl/` stays pure data.
 */
const CANCAN_ABILITY_CLASS = "Ability";

/**
 * The SUBJECT class of a CanCanCan rule — the first constant argument of
 * `can :read, Post` / `cannot :destroy, Admin::Post` (bd tea-rags-mcp-adx5p.9).
 * The action comes first and is a symbol (or an array of symbols), so the scan
 * takes the first `constant` / `scope_resolution` argument wherever it sits.
 * Returns `null` for a symbol subject (`can :manage, :all`), a hash-only rule,
 * or an expression — nothing static to point at, so no edge is emitted.
 */
function abilitySubjectConstant(callNode: AstNode): string | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  for (const arg of args.namedChildren) {
    if (arg.type === "constant") return arg.text;
    if (arg.type === "scope_resolution") return readScopeResolution(arg);
  }
  return null;
}

/** Literal text of a `string` / `string_literal` node with the quotes stripped. */
function stringLiteralText(node: AstNode): string {
  const inner = node.namedChildren.find((c) => c.type === "string_content");
  return inner ? inner.text : node.text.replace(/^["']|["']$/g, "");
}

/**
 * Rails routing `get "/x", to: "posts#index"` / `root "home#index"` → the
 * `<Controller>#<action>` the route dispatches to (bd tea-rags-mcp-n2kpz). The
 * target is the `"c#a"` spec: from the `to:` pair, or the first string arg for
 * `root`. The controller path self-encodes the namespace as `/` segments
 * (`admin/settings#show` → `Admin::SettingsController#show`), so each segment is
 * camelized and joined with `::` before the `Controller` suffix. Returns null
 * when there is no `"c#a"` string (a `to:`-less route, or a `to:` pointing at a
 * rack app / lambda) — nothing to emit.
 */
function routeActionTarget(callNode: AstNode): { controller: string; action: string } | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  let spec: string | null = null;
  for (const arg of args.namedChildren) {
    if (arg.type === "pair" && arg.childForFieldName("key")?.text === "to") {
      const value = arg.childForFieldName("value");
      if (value && (value.type === "string" || value.type === "string_literal")) spec = stringLiteralText(value);
    }
  }
  if (spec === null) {
    const first = args.namedChildren[0];
    if (first && (first.type === "string" || first.type === "string_literal")) spec = stringLiteralText(first);
  }
  if (!spec?.includes("#")) return null;
  const hash = spec.indexOf("#");
  const ctrlPath = spec.slice(0, hash);
  const action = spec.slice(hash + 1);
  if (ctrlPath.length === 0 || action.length === 0) return null;
  const controller = `${ctrlPath.split("/").map(camelizeModelName).join("::")}Controller`;
  return { controller, action };
}

/**
 * Collect the leading delegated symbol names from a `delegate :a, :b, to: :recv`
 * call — every `simple_symbol` argument UNTIL the first non-symbol (the `to:`
 * pair, other kwargs like `allow_nil:` / `prefix:`). Mirrors the delegate loop
 * in `macro-expansion.ts` so the synthesised CallRefs line up 1:1 with the
 * codegraph's synthesised forwarder method symbols (bd tea-rags-mcp-mx9z).
 */
function extractDelegateSymbols(callNode: AstNode): string[] {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return [];
  const out: string[] = [];
  for (const arg of args.namedChildren) {
    if (arg.type !== "simple_symbol") break;
    const base = arg.text.startsWith(":") ? arg.text.slice(1) : arg.text;
    if (base.length > 0) out.push(base);
  }
  return out;
}

/**
 * Pull the `to:` receiver text from a `delegate ..., to: <value>` call. The
 * value is the right side of the `to:` pair: a symbol literal (`:client` →
 * `client`, leading `:` stripped) for a method/attr target, or a constant
 * (`SomeConst`, returned verbatim) the resolver's constant strategy pins.
 * Returns `null` when no `to:` pair is present or its value is neither a
 * symbol nor a constant (e.g. a runtime expression) — no edge can be
 * synthesised syntactically (bd tea-rags-mcp-mx9z).
 */
function extractDelegateTarget(callNode: AstNode): string | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  for (const arg of args.namedChildren) {
    if (arg.type !== "pair") continue;
    const key = arg.childForFieldName("key");
    if (key?.text !== "to") continue;
    const value = arg.childForFieldName("value");
    if (!value) return null;
    if (value.type === "simple_symbol") {
      return value.text.startsWith(":") ? value.text.slice(1) : value.text;
    }
    if (value.type === "constant") return value.text;
    if (value.type === "scope_resolution") return readScopeResolution(value);
    return null;
  }
  return null;
}
