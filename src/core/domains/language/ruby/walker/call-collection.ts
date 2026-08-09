/**
 * The Ruby call-site walk.
 *
 * {@link collectRubyCalls} is a single recursive pass that carries two pieces of
 * context — the enclosing method name (for `super`) and the set of names bound
 * as locals in that method (so a variable read is not mistaken for a bare call)
 * — and offers every node to a row of emit helpers. Each helper no-ops unless
 * the node matches its shape, which is what keeps the walk itself readable:
 * alias-keyword redirects, registry constant literals, bare identifiers, bare
 * DSL macros, bare `super`, the dynamic-send unwrap, the literal call edge, and
 * the block-pass `&:sym` edge.
 *
 * Emit ORDER inside the walk is observable — it fixes the order of `calls[]` on
 * every chunk — so the helpers are called in the same sequence the former
 * inline blocks were written in.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { CallRef } from "../../../../contracts/types/codegraph.js";
import { FULL_RUBY_CATALOGUE, type RubyDslCatalogue } from "../dsl/index.js";
import { readScopeResolution } from "./ast-utils.js";
import { collectMethodLocalBindings, isBareIdentifierCallSite } from "./bare-call-detection.js";
import { emitDslEdges } from "./dsl-edge-emitters.js";
import { computeArgCount, computeCallKwargs, computeCallPassesBlock } from "./method-signatures.js";
import { emitRegistryConstantRefs, exprToRubyDispatchRef } from "./registry-dispatch.js";

/**
 * Sentinel receiver value emitted by the walker for synthetic CallRefs
 * representing the Ruby `super` keyword (bd tea-rags-mcp-brp1). The token
 * begins with `<` — invalid in real Ruby identifiers — so the resolver
 * can branch on it unambiguously without colliding with any actual
 * receiver text. Mirrors the `zeitwerk:` prefix discipline: a single
 * exported constant is the contract between walker and resolver.
 */
export const SUPER_RECEIVER_SENTINEL = "<super>";

/**
 * Methods that are dynamic-dispatch wrappers — when the first argument
 * is a LITERAL symbol or string, the call is statically resolvable as
 * if it were a direct method call. `Object#send`, `Object#public_send`,
 * and the historical `__send__` alias all share the same shape.
 */
const RUBY_DYNAMIC_DISPATCH = new Set(["send", "public_send", "__send__"]);

/**
 * `alias new old` keyword form (bd tea-rags-mcp-y2z5). The new alias method
 * delegates to the old one — emit a synthetic CallRef from the alias chunk to
 * the old method so the call graph traces the redirect. Receiver is null
 * because both methods live on the same class; the resolver's bare-call
 * same-class fallback uses callerScope (= the enclosing class) to pin the
 * target. No-ops for any non-`alias` node.
 */
function emitAliasKeywordEdge(node: AstNode, out: CallRef[], catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE): void {
  if (node.type !== "alias" || catalogue.entries.alias?.redirectTarget !== "alias-keyword-old") return;
  const idents = node.children.filter((c) => c.type === "identifier");
  const oldName = idents[1]?.text;
  if (oldName) {
    out.push({ callText: node.text, receiver: null, member: oldName, startLine: node.startPosition.row + 1 });
  }
}

/**
 * Bare-identifier method calls (bd tea-rags-mcp-hbie). Ruby allows `foo` as
 * shorthand for `foo()` when `foo` is a method, so the walker emits a CallRef
 * for `identifier` nodes in a call-position role. Gated on: a call-position
 * parent (not a binding-introducing field — `isBareIdentifierCallSite`), the
 * name NOT being a local binding of the enclosing method, and being inside a
 * method body (`enclosingMethod !== null`). The resolver's existing safeguards
 * (jsa0 + lttd + t5iw + pl7k) filter residual ambiguity at edge-resolution time.
 */
function emitBareIdentifierCall(
  node: AstNode,
  enclosingMethod: string | null,
  localBindings: Set<string>,
  out: CallRef[],
): void {
  if (
    node.type === "identifier" &&
    enclosingMethod !== null &&
    isBareIdentifierCallSite(node) &&
    !localBindings.has(node.text)
  ) {
    out.push({ callText: node.text, receiver: null, member: node.text, startLine: node.startPosition.row + 1 });
  }
}

/**
 * A DSL macro written in its ARGUMENT-LESS form parses as a bare `identifier`,
 * never a `call`, so the `emits` dispatch in the call branch never sees it (bd
 * tea-rags-mcp-adx5p.9). CanCanCan's `load_and_authorize_resource` is the
 * canonical shape — the class-body filter is almost always written with no
 * arguments at all, and it is precisely the form that reaches `Ability`.
 *
 * Routing bare identifiers through the SAME {@link emitDslEdges} adds edges only
 * for shapes that need no operands: every operand-reading shape looks up an
 * argument list first and returns early when there is none. A name bound as a
 * local variable is skipped, mirroring {@link emitBareIdentifierCall}.
 */
function emitBareMacroDslEdge(
  node: AstNode,
  localBindings: Set<string>,
  catalogue: RubyDslCatalogue,
  out: CallRef[],
): void {
  if (node.type !== "identifier" || localBindings.has(node.text) || !isBareIdentifierCallSite(node)) return;
  const emits = catalogue.entries[node.text]?.emits;
  if (emits) emitDslEdges(node, emits, node.startPosition.row + 1, out);
}

/**
 * Bare `super` (no args) parses as a leaf `super` node. The wrapped form
 * `super(...)` / `super(...) { ... }` parses as a `call` whose `method` field
 * is the `super` leaf — that case is handled in the call branch. Both shapes
 * emit identical CallRefs except for `callText` (literal source). No-ops unless
 * this is a bare `super` leaf inside a method body.
 */
function emitBareSuperEdge(node: AstNode, enclosingMethod: string | null, out: CallRef[]): void {
  if (node.type === "super" && node.parent?.type !== "call" && enclosingMethod !== null) {
    out.push({
      callText: node.text,
      receiver: SUPER_RECEIVER_SENTINEL,
      member: enclosingMethod,
      startLine: node.startPosition.row + 1,
    });
  }
}

/**
 * Dynamic-dispatch unwrap classification (bd tea-rags-mcp-8ss5 / cai0). For a
 * `send` / `public_send` call whose first arg is a literal symbol/string, push
 * the unwrapped direct-call CallRef — receiver normalised to null for a bare or
 * `self` receiver so the resolver's same-class fallback takes over — and return
 * `"unwrapped"`; the caller then DROPS the literal `send` edge and recurses (so
 * fan-out is not double-counted). A non-literal first arg returns `"dynamic"`
 * (the literal `send` edge is kept but tagged `dynamicSend`, bd cai0). A
 * non-dispatch method returns `"plain"`. The recurse-into-children + early
 * return stay in the caller so the walk control flow is unchanged.
 */
function emitDynamicSendUnwrap(
  node: AstNode,
  receiver: AstNode | null,
  receiverText: string | null,
  method: AstNode,
  startLine: number,
  out: CallRef[],
): "unwrapped" | "dynamic" | "plain" {
  if (!RUBY_DYNAMIC_DISPATCH.has(method.text)) return "plain";
  const unwrapped = extractLiteralSymbolOrString(node);
  if (unwrapped !== null) {
    const unwrappedReceiver = receiverText === null || receiver?.type === "self" ? null : receiverText;
    out.push({ callText: node.text, receiver: unwrappedReceiver, member: unwrapped, startLine });
    return "unwrapped";
  }
  return "dynamic";
}

/**
 * Emit the macro/method's own literal CallRef (the call edge the source line
 * actually writes). Tags `dynamicSend` for an unresolvable `send(var)` (bd
 * cai0) and attaches a registry-literal `dispatch` when the OUTER `.member`
 * call of a `CONST[k].new.m` chain carries a resolved `field` (bd
 * tea-rags-mcp-pq02v; the inner `.new` returns `field: null` and is skipped, no
 * double tag). Lifted verbatim from the inline call-branch tail.
 */
function emitMethodCallRef(
  node: AstNode,
  receiverText: string | null,
  method: AstNode,
  dynamicSend: boolean,
  dispatchTableNames: ReadonlySet<string>,
  out: CallRef[],
  catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE,
): void {
  const startLine = node.startPosition.row + 1;
  const callRef: CallRef = { callText: node.text, receiver: receiverText, member: method.text, startLine };
  if (dynamicSend) callRef.dynamicSend = true;
  const dispatch = exprToRubyDispatchRef(node, dispatchTableNames, catalogue);
  if (dispatch?.field) callRef.dispatch = dispatch;
  // Positional argCount (bd xlnub): excludes block and keyword args. Left
  // ABSENT for a splat call, where the count is unknowable (bd jn5j0).
  const argCount = computeArgCount(node);
  if (argCount !== undefined) callRef.argCount = argCount;
  // Keyword-arg key-set + double-splat (bd d9o7o).
  const kw = computeCallKwargs(node);
  if (kw.kwargKeys !== undefined) callRef.kwargKeys = kw.kwargKeys;
  if (kw.hasKwargSplat !== undefined) callRef.hasKwargSplat = kw.hasKwargSplat;
  // Block presence (bd d9o7o) — only set when true (undefined = no block).
  if (computeCallPassesBlock(node)) callRef.passesBlock = true;
  out.push(callRef);
}

/**
 * Block-pass shorthand: `users.each(&:save)` — `&:save` desugars to
 * `{ |u| u.save }`. The block-passed method is an additional call edge with no
 * static receiver (the iterator's element type is out of scope here; the
 * resolver falls back to short-name lookup). No-ops when the call carries no
 * symbol-to-proc block argument.
 */
function emitBlockPassEdge(node: AstNode, out: CallRef[]): void {
  const blockMember = extractBlockPassMethod(node);
  if (blockMember !== null) {
    out.push({
      callText: `&:${blockMember}`,
      receiver: null,
      member: blockMember,
      startLine: node.startPosition.row + 1,
    });
  }
}

export function collectRubyCalls(
  root: AstNode,
  dispatchTableNames: ReadonlySet<string>,
  catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE,
): CallRef[] {
  const out: CallRef[] = [];

  // Recursive walk that tracks the enclosing instance / singleton method
  // name so `super` emissions can attribute to the correct member without
  // a separate scope pass. `enclosingMethod` is updated on entry into a
  // `method` / `singleton_method` node and reset to null below the def.
  // `localBindings` tracks identifier names introduced by the enclosing
  // method's scope (parameters, assignment LHS, block vars, rescue-vars,
  // for-loop vars) so bare-identifier emission can skip local-var reads
  // (bd tea-rags-mcp-hbie).
  const visit = (node: AstNode, enclosingMethod: string | null, localBindings: Set<string>): void => {
    let nextEnclosing = enclosingMethod;
    let nextBindings = localBindings;
    if (node.type === "method" || node.type === "singleton_method") {
      // tree-sitter-ruby exposes the method's bare name via the `name`
      // field for both `def foo` and `def self.foo`. Singleton methods
      // additionally carry an `object` field for `self` — we ignore it
      // because Ruby's super dispatches by the method's own name, not by
      // any explicit receiver text.
      const nameNode = node.childForFieldName("name");
      if (nameNode) nextEnclosing = nameNode.text;
      // Fresh local-binding scope per method definition. Parameters of
      // the def itself populate it; nested defs get their own fresh set.
      nextBindings = collectMethodLocalBindings(node);
    }

    // Synthetic non-call edges this node may carry, independent of the
    // call/method_call branch below. Each helper no-ops unless the node matches
    // its shape — alias-keyword redirect (y2z5), registry constant literal
    // (ki9v), bare-identifier call (hbie), bare `super` leaf (brp1). Lifted
    // verbatim from the former inline blocks; emit order is unchanged.
    emitAliasKeywordEdge(node, out, catalogue);
    emitRegistryConstantRefs(node, out);
    emitBareIdentifierCall(node, enclosingMethod, localBindings, out);
    emitBareMacroDslEdge(node, localBindings, catalogue, out);
    emitBareSuperEdge(node, enclosingMethod, out);

    if (node.type === "call" || node.type === "method_call") {
      const receiver = node.childForFieldName("receiver");
      const method = node.childForFieldName("method");
      const startLine = node.startPosition.row + 1;

      // `super(args)` / `super { block }` — tree-sitter-ruby parses this
      // as a `call` whose `method` field IS the `super` leaf (not null,
      // as one might expect from the bare-leaf form). Detect by node
      // type so the synthetic CallRef carries the enclosing method's
      // name as `member`, matching the bare-leaf path.
      if (method?.type === "super" && enclosingMethod !== null) {
        out.push({
          callText: node.text,
          receiver: SUPER_RECEIVER_SENTINEL,
          member: enclosingMethod,
          startLine,
        });
        // Continue recursion: args/block children may contain real calls
        // (e.g. `super(Float::INFINITY) { |x| do_thing(x) }`).
        for (const child of node.children) visit(child, nextEnclosing, nextBindings);
        return;
      }

      if (!method) {
        // Defensive: a `call` node with no `method` field that isn't the
        // super-wrapped shape. Recurse so nested calls in args still
        // emit; no own CallRef to push.
        for (const child of node.children) visit(child, nextEnclosing, nextBindings);
        return;
      }

      const receiverText = receiver
        ? receiver.type === "scope_resolution"
          ? readScopeResolution(receiver)
          : receiver.text
        : null;

      // Dynamic dispatch unwrap (bd tea-rags-mcp-8ss5 / cai0): `obj.send(:save)`
      // / `public_send("save")` / bare or `self.send(:save)`.
      // emitDynamicSendUnwrap pushes the unwrapped direct-call edge (receiver
      // normalised to null for bare / `self`) and classifies the call. The
      // recurse-into-args + early return for the unwrapped case stay HERE so the
      // literal `send` edge is dropped (no double fan-out for one logical call).
      const sendKind = emitDynamicSendUnwrap(node, receiver, receiverText, method, startLine, out);
      if (sendKind === "unwrapped") {
        for (const child of node.children) visit(child, nextEnclosing, nextBindings);
        return;
      }
      const dynamicSend = sendKind === "dynamic";

      // Synthetic class-body macro edges (bd tea-rags-mcp-y2z5 alias_method /
      // mx9z delegate / duzy callbacks + associations). Each class-body macro
      // family — alias_method redirect, delegate target, callback self-instance,
      // association model-constant — declares which synthetic edge shape it
      // emits via its `emits` descriptor (dsl/types.ts); emitDslEdges builds the
      // shape. This replaces four `if (receiverText === null && <predicate>)`
      // branches with one descriptor-driven dispatch (membership parity proven
      // in walker-emits.test.ts). Only the class-body form fires —
      // `obj.before_action` is a normal method call with a non-null receiver.
      // NO early return: falls through to the literal `callRef` push below, so
      // the synthetic edge(s) precede the macro's own call edge (as before).
      if (receiverText === null) {
        const emits = catalogue.entries[method.text]?.emits;
        if (emits) emitDslEdges(node, emits, startLine, out);
      }

      // The macro/method's own literal call edge, plus the block-pass `&:sym`
      // edge if present. Both lifted verbatim into emit helpers.
      emitMethodCallRef(node, receiverText, method, dynamicSend, dispatchTableNames, out, catalogue);
      emitBlockPassEdge(node, out);
    }

    for (const child of node.children) visit(child, nextEnclosing, nextBindings);
  };

  visit(root, null, new Set<string>());
  return out;
}

/**
 * Pull the literal symbol or string text out of the first positional
 * argument of a `call` node. Returns the stripped name (`:save` → `save`,
 * `"save"` → `save`) or `null` when the argument is a variable,
 * expression, or absent.
 */
function extractLiteralSymbolOrString(callNode: AstNode): string | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  const firstArg = args.namedChildren[0];
  if (!firstArg) return null;
  if (firstArg.type === "simple_symbol") {
    return firstArg.text.startsWith(":") ? firstArg.text.slice(1) : firstArg.text;
  }
  if (firstArg.type === "string" || firstArg.type === "string_literal") {
    const inner = firstArg.namedChildren.find((c) => c.type === "string_content");
    return inner ? inner.text : firstArg.text.replace(/^["']|["']$/g, "");
  }
  return null;
}

/**
 * Detect `&:method_name` block argument and return the bare method
 * name. tree-sitter-ruby exposes block-pass args as a `block_argument`
 * node whose only child is the proc value — for symbol-to-proc that's
 * a `simple_symbol`. Returns `null` for any other block shape
 * (`&proc_var`, `&Method.method(:foo)`, full `do ... end` block).
 */
function extractBlockPassMethod(callNode: AstNode): string | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  for (const arg of args.namedChildren) {
    if (arg.type !== "block_argument") continue;
    const child = arg.namedChildren[0];
    if (!child) continue;
    if (child.type === "simple_symbol") {
      return child.text.startsWith(":") ? child.text.slice(1) : child.text;
    }
  }
  return null;
}
