/**
 * Ruby walker half of interprocedural parameter typing, Increment 1
 * (bd tea-rags-mcp-bvalc).
 *
 * The blocker for typing a method's parameters from its call sites has always
 * been the fixpoint: call sites resolve in pass 2, but parameter types would
 * have to be known in pass 1 for that resolution to improve. Increment 1 dodges
 * it entirely by restricting to call sites whose CALLEE IS SYNTACTICALLY KNOWN —
 * `Const.new(args)` names `Const#initialize` and a constant-receiver factory verb
 * names `Const.<verb>`, whatever the rest of the program does. Those argument
 * types can therefore be harvested during pass 1 and folded at the barrier,
 * before a single call is resolved.
 *
 * This module contributes three pure collectors; the fold, the agreement rule
 * and the consumption live trajectory-side in `call-arg-param-types.ts`:
 *
 *   - {@link positionalParamNames} — the leading run of plain required params,
 *     so the barrier can turn an argument POSITION into a parameter NAME;
 *   - {@link collectKnownTargetCallArgs} — per-position argument types at the
 *     known-target call sites of one chunk;
 *   - {@link collectRubyClassFieldParamLinks} — `@ivar = <param>` verbatim
 *     copies, the unresolved half of an ivar's type.
 *
 * Every collector is SILENT where it cannot be exact. An argument whose shape
 * is not conservatively typeable is a `null` slot, never an approximation; a
 * parameter list stops at the first optional/splat, past which a call site's
 * argument index no longer pins one parameter.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import {
  resolveLocalBinding,
  type ClassFieldParamLink,
  type KnownTargetCallArgs,
  type LocalBinding,
} from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";
import { FULL_RUBY_CATALOGUE, type RubyDslCatalogue } from "../dsl/index.js";
import { forEachClassScope, lexicalScopeFqName, readScopeResolution } from "./ast-utils.js";
import { constInstanceType } from "./type-sources/ast-inference.js";
import { YARD_CONST } from "./type-sources/yard.js";

/** The two tree-sitter spellings of a Ruby method call. */
function isCallNode(node: AstNode): boolean {
  return node.type === "call" || node.type === "method_call";
}

/** A call node's `argument_list`, under either the field or the child spelling. */
function argumentListOf(callNode: AstNode): AstNode | null {
  return callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list") ?? null;
}

/**
 * The LEADING run of plain required positional parameter names of a `method` /
 * `singleton_method` node, in declaration order.
 *
 * Stops at the first parameter that is not a bare `identifier` — an optional
 * (`b = 1`), splat (`*rest`), keyword (`c:`), double-splat or block parameter.
 * Past any of those a call site's Nth argument no longer corresponds to the Nth
 * parameter (an omitted optional shifts everything after it), so recording the
 * later names would license a wrong position→name mapping. Empty run ⇒ `[]`.
 */
export function positionalParamNames(methodNode: AstNode): string[] {
  const params = methodNode.childForFieldName("parameters");
  if (!params) return [];
  const names: string[] = [];
  for (const child of params.namedChildren) {
    if (child.type !== "identifier") break;
    names.push(child.text);
  }
  return names;
}

/**
 * Ruby constant-lookup candidates for `constText` written inside `scope`,
 * INNERMOST FIRST: `Firm` inside `module Billing; class Service` yields
 * `Billing::Service::Firm`, `Billing::Firm`, `Firm`. Mirrors Ruby's own
 * lexical-scope walk, so the barrier's "first candidate that is a real
 * definition" pick reproduces what the runtime would resolve.
 *
 * A leading-`::` constant (`::Firm`) is absolute — only the top-level form is a
 * candidate. An already-qualified constant (`Billing::Service`) is still walked:
 * inside `module Billing` it could name `Billing::Billing::Service` first, which
 * is exactly Ruby's rule.
 */
export function constantLookupCandidates(scope: readonly string[], constText: string): string[] {
  if (constText.startsWith("::")) return [constText.slice(2)];
  const out: string[] = [];
  for (let depth = scope.length; depth > 0; depth--) {
    out.push(lexicalScopeFqName(scope.slice(0, depth), constText));
  }
  out.push(constText);
  return out;
}

/** A constant receiver's text (`Foo`, `Acme::Foo`), or null for anything else. */
function constantReceiverText(receiver: AstNode): string | null {
  const text = receiver.type === "scope_resolution" ? readScopeResolution(receiver) : receiver.text;
  return text && YARD_CONST.test(text.replace(/^::/, "")) ? text : null;
}

/**
 * The conservatively-known type of ONE argument expression, or `null`.
 *
 * Four shapes, all zero-fabrication:
 *   - `Const.new(...)` / instance-returning factory → instance of that constant;
 *   - a bare constant → the CLASS itself (`Service.new(Firm)` hands over the
 *     class object, not an instance — the distinction the resolver needs to
 *     pick `Firm.find` over `Firm#find`);
 *   - a plain identifier already bound in this chunk → that binding's type;
 *   - an `@ivar` the enclosing class types → an instance of that type.
 *
 * Anything else — a literal, a bare method result, an untyped local — is `null`.
 */
function argTypeHint(
  arg: AstNode,
  line: number,
  localBindings: Record<string, LocalBinding[]> | undefined,
  classFields: Record<string, string> | undefined,
  catalogue: RubyDslCatalogue,
): RubyTypeRef | null {
  const instantiated = constInstanceType(arg, catalogue);
  if (instantiated !== null) return { form: "instance", name: instantiated };
  if (arg.type === "constant" || arg.type === "scope_resolution") {
    const text = constantReceiverText(arg);
    if (text !== null) return { form: "class", name: text.replace(/^::/, "") };
    return null;
  }
  if (arg.type === "identifier") {
    const binding = resolveLocalBinding(localBindings, arg.text, line);
    if (binding === undefined) return null;
    return binding.typeRef ?? { form: binding.valueKind === "class" ? "class" : "instance", name: binding.type };
  }
  if (arg.type === "instance_variable") {
    const typeName = classFields?.[arg.text];
    return typeName === undefined ? null : { form: "instance", name: typeName };
  }
  return null;
}

/** What a call site inherits from the chunk that owns its line. */
export interface KnownTargetCallSite {
  /** Lexical scope of the owning chunk — the base of the constant lookup walk. */
  readonly scope: readonly string[];
  /** The owning chunk's local-variable bindings, for identifier arguments. */
  readonly localBindings?: Record<string, LocalBinding[]>;
  /** The enclosing class's field types, for `@ivar` arguments. */
  readonly classFields?: Record<string, string>;
}

/**
 * Per-position argument types at the file's known-target call sites.
 *
 * `siteContextAt` hands back the scope and type environment of the chunk that
 * OWNS a line — innermost, so a call inside a method is typed once against that
 * method's bindings rather than once per enclosing chunk. Matching the walker's
 * `assignCallsToInnermostChunks` attribution keeps one call site = one record;
 * duplicates would not change the fold's verdict (agreement is idempotent) but
 * would inflate the pass-1 record set for nothing.
 *
 * A call qualifies when its receiver is a CONSTANT and its member is an
 * instance-returning verb of the project's gem-gated catalogue (`new`, `create`,
 * `build`, the Rails finders…) — the set whose callee follows from syntax:
 * `new` constructs, so the callee is `Const#initialize`; any other verb is a
 * class method, so the callee is `Const.<verb>`. The receiver constant is
 * emitted as its Ruby lookup CANDIDATE CHAIN rather than one guessed FQ, so the
 * barrier can pick the candidate that is a real definition instead of the walker
 * fabricating one (the walker has no symbol table — see codegraph-walkers.md).
 *
 * The position list is truncated at the first argument that breaks positional
 * correspondence: a splat / double-splat (unknown expansion width) or a keyword
 * pair (every later argument belongs to the same implicit hash). A site with no
 * typeable argument emits NOTHING — it would carry no evidence, and the fold
 * treats absence and an all-`null` record identically.
 */
export function collectKnownTargetCallArgs(
  root: AstNode,
  siteContextAt: (line: number) => KnownTargetCallSite,
  catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE,
): KnownTargetCallArgs[] {
  const out: KnownTargetCallArgs[] = [];
  const visit = (node: AstNode): void => {
    if (isCallNode(node)) {
      const receiver = node.childForFieldName("receiver");
      const method = node.childForFieldName("method");
      const args = argumentListOf(node);
      const constText = receiver ? constantReceiverText(receiver) : null;
      if (constText !== null && method && args && catalogue.instanceReturning.has(method.text)) {
        const line = node.startPosition.row + 1;
        const site = siteContextAt(line);
        const argTypes: (RubyTypeRef | null)[] = [];
        let known = false;
        for (const arg of args.namedChildren) {
          if (arg.type === "block" || arg.type === "do_block" || arg.type === "block_argument") break;
          if (arg.type === "splat_argument" || arg.type === "hash_splat_argument" || arg.type === "pair") break;
          const hint = argTypeHint(arg, line, site.localBindings, site.classFields, catalogue);
          if (hint !== null) known = true;
          argTypes.push(hint);
        }
        if (known) {
          const member = method.text === "new" ? "#initialize" : `.${method.text}`;
          out.push({
            targets: constantLookupCandidates(site.scope, constText).map((fq) => `${fq}${member}`),
            argTypes,
          });
        }
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

/**
 * Per-class `@ivar → (method, param)` links for fields assigned VERBATIM from a
 * parameter of the enclosing INSTANCE method — the census shape behind two
 * thirds of Ruby's ivar recall hole (`@firm = firm` in `initialize`). The walker
 * knows WHICH parameter the field copies; only the barrier's interprocedural
 * fold can know that parameter's type.
 *
 * Deliberate silences:
 *   - `def self.m` is skipped — a `@x` there is a class-level ivar, a different
 *     storage slot from the instance `@x` the resolver looks up;
 *   - the RHS identifier must be a PARAMETER of that method, not any local, so
 *     `@thing = tmp` after `tmp = compute` links nothing;
 *   - an `@ivar` fed by two DIFFERENT `(method, param)` coordinates is dropped,
 *     not last-write-wins: two origins mean two candidate types, and Increment 1
 *     never picks between them. The same coordinate assigned twice is not a
 *     conflict.
 */
export function collectRubyClassFieldParamLinks(root: AstNode): Record<string, Record<string, ClassFieldParamLink>> {
  const out: Record<string, Record<string, ClassFieldParamLink>> = {};
  forEachClassScope(root, (classNode, fq) => {
    const links = new Map<string, ClassFieldParamLink>();
    const poisoned = new Set<string>();
    const visitMethod = (methodNode: AstNode): void => {
      const name = methodNode.childForFieldName("name")?.text;
      if (name === undefined) return;
      const params = new Set(positionalParamNames(methodNode));
      // Optional / splat / keyword params still BIND a name even though their
      // position is unusable, so `@x = opt` is a legitimate link; only the
      // position→name mapping needed the leading-run restriction.
      const allParams = methodNode.childForFieldName("parameters");
      for (const p of allParams?.namedChildren ?? []) {
        const bound = p.type === "identifier" ? p : p.childForFieldName("name");
        if (bound?.type === "identifier") params.add(bound.text);
      }
      const visitBody = (n: AstNode): void => {
        if (n.type === "class" || n.type === "module" || n.type === "singleton_method") return;
        if (n.type === "assignment") {
          const lhs = n.childForFieldName("left");
          const rhs = n.childForFieldName("right");
          if (lhs?.type === "instance_variable" && rhs?.type === "identifier" && params.has(rhs.text)) {
            const existing = links.get(lhs.text);
            if (existing === undefined) links.set(lhs.text, { method: name, param: rhs.text });
            else if (existing.method !== name || existing.param !== rhs.text) poisoned.add(lhs.text);
          }
        }
        for (const child of n.children) visitBody(child);
      };
      const body = methodNode.childForFieldName("body");
      for (const child of (body ?? methodNode).children) visitBody(child);
    };
    const visitClassBody = (n: AstNode): void => {
      if (n.type === "class" || n.type === "module") return;
      if (n.type === "singleton_method") return; // class-level ivar slot
      if (n.type === "method") {
        visitMethod(n);
        return;
      }
      for (const child of n.children) visitClassBody(child);
    };
    const classBody = classNode.childForFieldName("body");
    for (const child of (classBody ?? classNode).children) visitClassBody(child);
    for (const ivar of poisoned) links.delete(ivar);
    if (links.size > 0) out[fq] = { ...out[fq], ...Object.fromEntries(links) };
  });
  return out;
}
