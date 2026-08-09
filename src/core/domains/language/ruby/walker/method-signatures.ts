/**
 * Ruby method-signature capture and its call-site counterpart (bd xlnub Task 2,
 * bd d9o7o, bd jn5j0).
 *
 * The narrowing cascade compares a DEFINITION's declared shape against a CALL
 * SITE's observed shape, so both halves of each pair live here:
 *
 *   | definition side           | call side              |
 *   | ------------------------- | ---------------------- |
 *   | `AritySignature`          | `computeArgCount`      |
 *   | `KwargSignature`          | `computeCallKwargs`    |
 *   | `computeRubyAcceptsBlock` | `computeCallPassesBlock` |
 *
 * Keeping them together is what makes a change to one side visibly a change to
 * the contract the other side is read against. The visibility state machine and
 * the abstract-stub predicate ride along because they are recorded by the same
 * per-def pass.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { AritySignature, KwargSignature } from "../../../../contracts/types/codegraph.js";
import { attachedBlockOf, walk } from "./ast-utils.js";
import { positionalParamNames } from "./param-arg-types.js";

const VISIBILITY_KEYWORDS = new Set<string>(["private", "protected", "public"]);

/**
 * Compute the positional arity of a `method` or `singleton_method` node.
 * Counts `identifier` (required positional) and `optional_parameter` children
 * of `method_parameters`; sets `hasSplat` when a `splat_parameter` is present.
 * Kwargs (`keyword_parameter`, `hash_splat_parameter`) and block params are
 * ignored — they don't affect positional arity.
 */
function computeRubyArity(methodNode: AstNode): AritySignature {
  const params = methodNode.childForFieldName("parameters");
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
    // keyword_parameter, hash_splat_parameter, block_parameter → ignored
  }
  return { minRequired, maxPositional, hasSplat };
}

/**
 * Compute the keyword-arg signature of a `method` / `singleton_method` node
 * (bd d9o7o). A `keyword_parameter` with NO `value` child (no default) is
 * REQUIRED (`def m(b:)` → must supply `b:`); one WITH a default (`c: 1`) is
 * optional and omitted from `required`. `hasSplat` is set by a
 * `hash_splat_parameter` (`**opts`). Returns `undefined` when the method has no
 * kwargs at all — keeps the payload lean and the narrower a no-op for it.
 */
function computeRubyKwargs(methodNode: AstNode): KwargSignature | undefined {
  const params = methodNode.childForFieldName("parameters");
  if (!params) return undefined;
  const required: string[] = [];
  const optional: string[] = [];
  let hasSplat = false;
  for (const child of params.namedChildren) {
    if (child.type === "keyword_parameter") {
      const nameNode = child.childForFieldName("name") ?? child.namedChildren[0];
      if (!nameNode) continue;
      const name = nameNode.text.replace(/:$/, "");
      // A default value is the `value` field; its absence ⇒ required kwarg,
      // its presence ⇒ optional (defaulted) kwarg. Both go into the declared
      // set the extra-unknown-key narrowing checks against (bd d9o7o).
      if (child.childForFieldName("value") === null) required.push(name);
      else optional.push(name);
    } else if (child.type === "hash_splat_parameter") {
      hasSplat = true;
    }
  }
  if (required.length === 0 && optional.length === 0 && !hasSplat) return undefined;
  return { required, optional, hasSplat };
}

/**
 * Collect the call-site keyword-arg key-set (bd d9o7o). `pair` children of the
 * argument list are kwargs (`b: 2` → key `b`); a `hash_splat_argument`
 * (`**opts`) means unknown runtime keys. Positional args / blocks are ignored.
 */
export function computeCallKwargs(callNode: AstNode): { kwargKeys?: string[]; hasKwargSplat?: boolean } {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return {};
  const kwargKeys: string[] = [];
  let hasKwargSplat = false;
  for (const child of args.namedChildren) {
    if (child.type === "pair") {
      const keyNode = child.childForFieldName("key") ?? child.namedChildren[0];
      if (keyNode) kwargKeys.push(keyNode.text.replace(/:$/, "").replace(/^:/, ""));
    } else if (child.type === "hash_splat_argument") {
      hasKwargSplat = true;
    }
  }
  const out: { kwargKeys?: string[]; hasKwargSplat?: boolean } = {};
  if (kwargKeys.length > 0) out.kwargKeys = kwargKeys;
  if (hasKwargSplat) out.hasKwargSplat = true;
  return out;
}

/**
 * Whether a `method` / `singleton_method` node accepts a block (bd d9o7o):
 * TRUE if it declares a `block_parameter` (`&blk`) OR its body contains a
 * `yield`. FALSE = proven non-yielder (the BlockNarrower only drops these, and
 * only when other yielders remain). Over-detecting yield (e.g. a `yield` in a
 * nested def) is the SAFE direction — it keeps the candidate.
 */
function computeRubyAcceptsBlock(methodNode: AstNode): boolean {
  const params = methodNode.childForFieldName("parameters");
  if (params?.namedChildren.some((c) => c.type === "block_parameter")) return true;
  const body = methodNode.childForFieldName("body");
  if (!body) return false;
  let yields = false;
  walk(body, (n) => {
    if (n.type === "yield") yields = true;
  });
  return yields;
}

/** The two spellings of Ruby's built-in `NotImplementedError` an abstract stub
 *  may raise. A namespaced look-alike (`Legacy::NotImplementedError`) is a
 *  DIFFERENT class and deliberately absent — see `computeRubyIsAbstractStub`. */
const NOT_IMPLEMENTED_ERROR_NAMES = new Set<string>(["NotImplementedError", "::NotImplementedError"]);

/**
 * Whether a `method` / `singleton_method` node is an ABSTRACT STUB — a
 * declaration carrying no implementation (bd tea-rags-mcp-bcdfe). The single
 * detection site: the codegraph self-dispatch probe READS the resulting flag off
 * the symbol table, it never re-derives it.
 *
 * Exactly three body shapes qualify (spec "Generalized predicate" clause 3):
 *   - EMPTY — `def m; end`, with or without params (tree-sitter drops the `body`
 *     field entirely; comments are extras, so a comment-only body is empty too);
 *   - a SINGLE-statement `raise NotImplementedError` — bare constant,
 *     `::NotImplementedError`, with a message, or `NotImplementedError.new(…)`;
 *   - a SINGLE-statement `super` — bare, `super()`, or `super(args)`.
 *
 * Conservative by construction: anything else (a guard clause before the raise,
 * two statements, a different error class, a real expression, an endless method
 * with a value) is a REAL body. Over-marking is the dangerous direction — it
 * turns a genuine base method into a dispatch hook and fabricates edges (spec
 * "Risks" → abstract-stub detection must be conservative).
 */
function computeRubyIsAbstractStub(methodNode: AstNode): boolean {
  const body = methodNode.childForFieldName("body");
  if (!body) return true; // `def m; end` / comment-only — no body field at all
  // A block body is a `body_statement` wrapper; an endless method (`def m = x`)
  // exposes its single expression directly.
  const statements = body.type === "body_statement" ? body.namedChildren : [body];
  if (statements.length === 0) return true;
  if (statements.length > 1) return false; // real body — more than a declaration
  const only = statements[0];
  if (only.type === "super") return true; // bare `super`
  if (only.type !== "call" && only.type !== "method_call") return false;
  const methodField = only.childForFieldName("method") ?? only.children.find((c) => c.type === "identifier");
  if (!methodField) return false;
  if (methodField.type === "super") return true; // `super()` / `super(args)`
  if (only.childForFieldName("receiver")) return false; // `x.raise` is not Kernel#raise
  if (methodField.text !== "raise") return false;
  return raisesNotImplementedError(only);
}

/**
 * Whether a `raise …` call node names Ruby's `NotImplementedError` as the error
 * it raises: `raise NotImplementedError` / `raise ::NotImplementedError` /
 * `raise NotImplementedError, "msg"` / `raise NotImplementedError.new(…)`. A bare
 * `raise` (re-raise — no arguments) and any other error class are excluded.
 */
function raisesNotImplementedError(raiseCall: AstNode): boolean {
  const args = raiseCall.childForFieldName("arguments") ?? raiseCall.children.find((c) => c.type === "argument_list");
  const first = args?.namedChildren[0];
  if (!first) return false;
  if (first.type === "constant" || first.type === "scope_resolution") {
    return NOT_IMPLEMENTED_ERROR_NAMES.has(first.text);
  }
  // `NotImplementedError.new("msg")` — a constructed error instance.
  if (first.type !== "call" && first.type !== "method_call") return false;
  const receiver = first.childForFieldName("receiver");
  if (!receiver) return false;
  if (first.childForFieldName("method")?.text !== "new") return false;
  return NOT_IMPLEMENTED_ERROR_NAMES.has(receiver.text);
}

/** Whether a call passes a block (`{ … }` / `do … end`) (bd d9o7o). The block
 *  is a `block` / `do_block` node, either a direct child of the call or inside
 *  its argument list. */
export function computeCallPassesBlock(callNode: AstNode): boolean {
  if (callNode.children.some((c) => c.type === "block" || c.type === "do_block")) return true;
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  return args ? args.namedChildren.some((c) => c.type === "block" || c.type === "do_block") : false;
}

/** Node types that open a fresh method-definition body with its OWN visibility
 *  state: a class, a module, and a singleton class (`class << self`). Each gets
 *  its own recursive pass with a `"public"` default — Ruby scopes visibility
 *  per body, so a `private` in the enclosing class does not reach into
 *  `class << self` and vice versa (bd tea-rags-mcp-jn5j0). */
const DEF_BODY_NODE_TYPES: ReadonlySet<string> = new Set(["class", "module", "singleton_class"]);

/**
 * Walk the AST and collect arity + visibility for every `method` /
 * `singleton_method` definition in the file.
 *
 * The map is keyed by the method node's 1-based start line so the caller
 * can look up by `ChunkExtraction.startLine` — the chunker assigns the
 * same line to the method chunk it creates for that node.
 *
 * Visibility state machine per body (source order):
 *   - bare `private`/`protected`/`public` → switches default for subsequent defs
 *   - `private def foo` (inline form) → marks that specific method only
 *   - `private :foo, :bar` (symbol form) → marks those methods by name
 * Default is `"public"` at the start of each body.
 *
 * Four body shapes carry defs, and all four are traversed (bd
 * tea-rags-mcp-jn5j0 — the first three used to be blind spots holding 17.6 % of
 * taxdome's positional-param defs, which therefore reached the narrowing
 * cascade with no arity, no kwargs and no visibility at all):
 *   - a plain `class` / `module` body;
 *   - a `singleton_class` body (`class << self`), whose defs the chunker emits
 *     as CLASS-level symbols (`A.build`) — the same `.`-form `def self.build`
 *     produces, so the per-line keys line up without any special casing;
 *   - a block attached to a class-body call (`included do … end`);
 *   - file scope, for a `def` with no enclosing class or module.
 */
export function collectRubyMethodSignatures(root: AstNode): Map<
  number,
  {
    arity: AritySignature;
    paramNames: string[];
    visibility: "public" | "private" | "protected";
    kwargs?: KwargSignature;
    acceptsBlock: boolean;
    isAbstractStub: boolean;
  }
> {
  type VisMode = "public" | "private" | "protected";
  const out = new Map<
    number,
    {
      arity: AritySignature;
      paramNames: string[];
      visibility: VisMode;
      kwargs?: KwargSignature;
      acceptsBlock: boolean;
      isAbstractStub: boolean;
    }
  >();

  /** Record one def's signature under its 1-based start line. */
  const recordDef = (defNode: AstNode, visibility: VisMode): void => {
    out.set(defNode.startPosition.row + 1, {
      arity: computeRubyArity(defNode),
      paramNames: positionalParamNames(defNode),
      visibility,
      kwargs: computeRubyKwargs(defNode),
      acceptsBlock: computeRubyAcceptsBlock(defNode),
      isAbstractStub: computeRubyIsAbstractStub(defNode),
    });
  };

  const processClassBody = (classNode: AstNode): void => {
    const body = classNode.childForFieldName("body");
    // namedChildren skips anonymous tokens (punctuation, `end`, `;`) — all
    // type-guards below match only named node types, so behavior is identical
    // while avoiding spurious iterations over anonymous tokens.
    const stmts = body ? body.namedChildren : classNode.namedChildren;

    // Shared helpers: defined once to avoid duplicating anonymous functions
    // across pass-1 and pass-2 (duplicate arrow functions inflate the uncovered
    // function count and would push global coverage below threshold).
    const methodFieldOf = (node: AstNode) =>
      node.childForFieldName("method") ?? node.children.find((c) => c.type === "identifier");
    const argsOf = (node: AstNode) =>
      node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");

    let currentVis: VisMode = "public";
    // symbol-form overrides: method short-name → forced visibility.
    // Pass 1 populates this for ALL symbol-form declarations at THIS body level
    // before pass 2 emits any method defs. Resolves the backward `private :foo`
    // pattern where `def foo` precedes `private :foo` in source order.
    const symVis = new Map<string, VisMode>();

    // Pass 1: collect symbol-form visibility declarations at THIS body level only.
    // Nested class/module bodies are skipped — each gets its own recursive call
    // with its own symVis. Bare switches and inline-def forms are pass-2 only.
    for (const stmt of stmts) {
      if (DEF_BODY_NODE_TYPES.has(stmt.type)) continue;
      if (stmt.type === "call" || stmt.type === "method_call") {
        if (stmt.childForFieldName("receiver")) continue;
        const methodField = methodFieldOf(stmt);
        if (!methodField || !VISIBILITY_KEYWORDS.has(methodField.text)) continue;
        const modifier = methodField.text as VisMode;
        const args = argsOf(stmt);
        if (!args || args.namedChildren.length === 0) continue; // bare switch — pass 2
        const firstArg = args.namedChildren[0];
        if (firstArg.type === "method" || firstArg.type === "singleton_method") continue; // inline — pass 2
        // Symbol form: `private :foo, :bar`
        for (const arg of args.namedChildren) {
          if (arg.type === "simple_symbol" || arg.type === "symbol") {
            symVis.set(arg.text.replace(/^:/, ""), modifier);
          }
        }
      }
    }

    // Pass 2: walk in source order — recurse nested classes, apply bare switches,
    // emit inline-def forms, emit method defs (symVis now fully populated).
    for (const stmt of stmts) {
      // Nested class / module / singleton class — recurse with fresh public default
      if (DEF_BODY_NODE_TYPES.has(stmt.type)) {
        processClassBody(stmt);
        continue;
      }

      // A block attached to this statement is another body that can define
      // methods on the enclosing class (`included do … end`). Checked BEFORE
      // the visibility-call branch, which short-circuits on a receiver and
      // would otherwise skip `Helper.class_eval do … end` entirely.
      const attachedBlock = attachedBlockOf(stmt);
      if (attachedBlock) processClassBody(attachedBlock);

      // Method definition — record arity + current visibility.
      // Precedence: symVis (symbol-form) > currentVis (bare-switch).
      // Inline-modifier form never reaches this branch (it is a child of its
      // call node and emitted in the call handler below).
      if (stmt.type === "method" || stmt.type === "singleton_method") {
        const nameNode = stmt.childForFieldName("name");
        const name = nameNode?.text ?? "";
        recordDef(stmt, symVis.get(name) ?? currentVis);
        continue;
      }

      // Visibility modifier call: `private`, `private def foo`, `private :foo`
      if (stmt.type === "call" || stmt.type === "method_call") {
        if (stmt.childForFieldName("receiver")) continue; // not a bare class-body call
        const methodField = methodFieldOf(stmt);
        if (!methodField || !VISIBILITY_KEYWORDS.has(methodField.text)) continue;
        const modifier = methodField.text as VisMode;
        const args = argsOf(stmt);
        if (!args || args.namedChildren.length === 0) {
          // Bare visibility switch: `private` with no args
          currentVis = modifier;
        } else {
          const firstArg = args.namedChildren[0];
          if (firstArg.type === "method" || firstArg.type === "singleton_method") {
            // Inline form: `private def foo; end`
            recordDef(firstArg, modifier);
          }
          // Symbol form already resolved in pass 1 — nothing to do here.
        }
        continue;
      }

      // Bare `private` as identifier node (tree-sitter-ruby may produce this form)
      if (stmt.type === "identifier" && VISIBILITY_KEYWORDS.has(stmt.text)) {
        currentVis = stmt.text as VisMode;
        continue;
      }
    }
  };

  // Top-level walk: descend into nodes looking for def-body declarations.
  // When we find one, processClassBody handles it and everything nested inside
  // — so we do NOT recurse further into it from this outer walk (avoids
  // double-visit). The generic descent is what finds a class declared inside a
  // conditional or a configuration block, so it must stay.
  const walkTopLevel = (node: AstNode): void => {
    if (DEF_BODY_NODE_TYPES.has(node.type)) {
      processClassBody(node);
      return; // processClassBody recurses into nested bodies
    }
    // A def reached HERE has no enclosing class or module — file scope. Ruby
    // makes it a private method on Object, but recording it `public` is the
    // conservative direction for the narrowing cascade: `VisibilityNarrower`
    // only ever DROPS `private` candidates, and a top-level helper is a
    // legitimate dispatch target for a bare call.
    if (node.type === "method" || node.type === "singleton_method") recordDef(node, "public");
    for (const child of node.children) walkTopLevel(child);
  };

  walkTopLevel(root);
  return out;
}

/** Argument-list children that occupy NO positional slot: the two block forms
 *  (`{ … }` / `do … end`), a block-pass (`&blk`, `&:sym`), and the two keyword
 *  forms (`k: v`, `**opts`). Everything else fills exactly one slot. */
const NON_POSITIONAL_ARG_TYPES: ReadonlySet<string> = new Set([
  "block",
  "do_block",
  "block_argument",
  "pair",
  "hash_splat_argument",
]);

/**
 * Count positional arguments at a call site. No `argument_list` child → 0.
 *
 * Returns `undefined` when the list contains a `splat_argument` (`*args`): the
 * splat expands to an unknown number of positional slots at runtime, so no
 * count is knowable. `ArityNarrower` treats `undefined` as "missing evidence ⇒
 * keep every candidate", which is the only safe reading — a guessed number is
 * FALSE evidence and drops correct targets (bd tea-rags-mcp-jn5j0).
 */
export function computeArgCount(callNode: AstNode): number | undefined {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return 0;
  let count = 0;
  for (const child of args.namedChildren) {
    if (child.type === "splat_argument") return undefined;
    if (!NON_POSITIONAL_ARG_TYPES.has(child.type)) count += 1;
  }
  return count;
}
