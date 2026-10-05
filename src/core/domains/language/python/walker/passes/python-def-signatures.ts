/**
 * Python def signatures and their call-site counterpart (E4.1.2, bd
 * tea-rags-mcp-w205u).
 *
 * The narrowing cascade compares a DEFINITION's declared shape against a CALL
 * SITE's observed shape, so both halves live here, the way Ruby's
 * `walker/method-signatures.ts` keeps them together:
 *
 *   | definition side              | call side          |
 *   | ---------------------------- | ------------------ |
 *   | `AritySignature`             | `argCount`         |
 *   | `KwargSignature`             | `kwargKeys` / `hasKwargSplat` |
 *
 * **Why the Python emission rule is not Ruby's.** Ruby's keyword parameters are
 * a separate declaration axis: a positional parameter cannot be passed by name.
 * Python's can — `f(timeout=3)` against `def f(timeout)` is a legal call — so a
 * naive port would file `timeout` as positional-only, `KwargNarrower`'s
 * extra-unknown-key rule would see an undeclared key, and the right candidate
 * would be dropped. The fix needs no kernel change:
 *
 *   - `arity.minRequired`   — positional params with NO default, `self` / `cls`
 *                             dropped for a method (the call site never passes
 *                             the receiver);
 *   - `arity.maxPositional` — all positional params, same drop;
 *   - `arity.hasSplat`      — the def declares `*args`;
 *   - `kwargs.required`     — KEYWORD-ONLY params with no default. Only those
 *                             MUST be named at the call site; a positional one
 *                             may be filled either way, so listing it here
 *                             would drop live candidates;
 *   - `kwargs.optional`     — every NAMEABLE param: positional-or-keyword names
 *                             in declaration order, then keyword-only names
 *                             carrying defaults. A positional-ONLY param (left
 *                             of `/`) is absent — it cannot be named;
 *   - `kwargs.hasSplat`     — the def declares `**kwargs`.
 *
 * `visibility` is filled for ONE shape only (bd tea-rags-mcp-jwjyr.1): a method
 * — a def directly in a class body — named `__name` but not a `__dunder__`.
 * The interpreter name-mangles it to `_Class__name`, so that spelling reaches it
 * only from inside a class of the same name → `private`, and the dispatch
 * cascade reads it under the enclosing-class access rule
 * (`EnclosingClassPrivateAccess`), never Ruby's explicit-receiver one.
 * `_name` stays unrecorded: it is a convention the runtime ignores, and treating
 * it as `private` would drop legitimate candidates. A module-level `__name`
 * is not mangled and stays unrecorded too.
 *
 * Python does NOT fill `acceptsBlock` here: there is no block argument.
 * `BlockNarrower` keeps every candidate on absent evidence, so it is inert for
 * Python rather than wrong. `paramNames` is filled by its own facet pass
 * (`python-param-arg-types.ts`) from {@link pythonPositionalParamNames}.
 *
 * A `@property` getter is NOT marked in any way: an attribute read is not a
 * call site, so the walker emits no `CallRef` for it and nothing ever narrows
 * against its signature. Were it reached as `obj.p()`, the ordinary arity it
 * carries (0 after `self`) is the correct answer anyway.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { AritySignature, KwargSignature } from "../../../../../contracts/types/codegraph.js";
import { walkPythonScopes } from "./python-def-scope-walk.js";

export interface PythonDefSignature {
  readonly arity: AritySignature;
  readonly kwargs?: KwargSignature;
  /** `"private"` for a name-mangled method, absent otherwise (see the docblock). */
  readonly visibility?: "private";
}

/** A `__name` the interpreter mangles: two leading underscores, not a dunder. */
function isNameMangled(name: string): boolean {
  return name.startsWith("__") && !name.endsWith("__");
}

/** Parameter node types that declare one ordinary (nameable) parameter. */
const PLAIN_PARAM_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "typed_parameter",
  "default_parameter",
  "typed_default_parameter",
]);

/** Parameter node types that carry a DEFAULT value, so they are not required. */
const DEFAULTED_PARAM_TYPES: ReadonlySet<string> = new Set(["default_parameter", "typed_default_parameter"]);

/** The bare name of a parameter node — the `name` field where the grammar emits
 *  one (`b=1`, `b: str = 'x'`), the first named child otherwise (`a: int`), the
 *  node's own text for a plain `identifier`. */
function paramName(node: AstNode): string {
  if (node.type === "identifier") return node.text;
  return node.childForFieldName("name")?.text ?? node.namedChildren[0]?.text ?? node.text;
}

/**
 * Is this `function_definition` a METHOD — declared directly in a class body?
 * Only there does Python bind the first parameter implicitly, and only there may
 * `self` / `cls` be dropped. Asked of the AST rather than of the scope walk's
 * `classChain`, which a def nested inside a method also inherits: `def inner(self)`
 * inside a method takes its `self` explicitly and must keep it.
 */
export function isPythonMethodDef(node: AstNode): boolean {
  const outer = node.parent?.type === "decorated_definition" ? node.parent : node;
  return outer.parent?.type === "block" && outer.parent.parent?.type === "class_definition";
}

/**
 * Read the declared shape of one `function_definition`.
 *
 * `dropReceiver` drops a LEADING parameter spelled exactly `self` or `cls` — the
 * implicit receiver a call site never passes. It is false for a `@staticmethod`,
 * which binds nothing implicitly and therefore keeps every parameter even when
 * one is spelled `self`.
 */
function pythonDefSignature(defNode: AstNode, dropReceiver: boolean): PythonDefSignature {
  const params = defNode.childForFieldName("parameters");
  if (params === null) return { arity: { minRequired: 0, maxPositional: 0, hasSplat: false } };

  let minRequired = 0;
  let maxPositional = 0;
  let hasSplat = false;
  const required: string[] = [];
  // Nameable params in declaration order: the positional-or-keyword run first,
  // then the keyword-only names carrying defaults.
  let nameable: string[] = [];
  const keywordDefaults: string[] = [];
  let hasKwargSplat = false;
  // `*args` and a bare `*` both open the keyword-only region.
  let keywordOnly = false;
  let seenAnyParam = false;

  for (const child of params.namedChildren) {
    if (child.type === "list_splat_pattern") {
      hasSplat = true;
      keywordOnly = true;
      continue;
    }
    if (child.type === "keyword_separator") {
      keywordOnly = true;
      continue;
    }
    if (child.type === "positional_separator") {
      // Everything declared left of `/` is positional-ONLY and can never be
      // passed by name, so it leaves the nameable set. It still counts toward
      // arity — the slot exists, it just has no callable spelling.
      nameable = [];
      continue;
    }
    if (child.type === "dictionary_splat_pattern") {
      hasKwargSplat = true;
      continue;
    }
    if (!PLAIN_PARAM_TYPES.has(child.type)) continue;
    const name = paramName(child);
    const defaulted = DEFAULTED_PARAM_TYPES.has(child.type);
    if (!seenAnyParam) {
      seenAnyParam = true;
      if (dropReceiver && !keywordOnly && (name === "self" || name === "cls")) continue;
    }
    if (keywordOnly) {
      if (defaulted) keywordDefaults.push(name);
      else required.push(name);
      continue;
    }
    maxPositional += 1;
    if (!defaulted) minRequired += 1;
    nameable.push(name);
  }

  const arity: AritySignature = { minRequired, maxPositional, hasSplat };
  if (required.length === 0 && keywordDefaults.length === 0 && nameable.length === 0 && !hasKwargSplat) {
    return { arity };
  }
  return { arity, kwargs: { required, optional: [...nameable, ...keywordDefaults], hasSplat: hasKwargSplat } };
}

/**
 * The LEADING run of required positional parameter names of one
 * `function_definition`, in declaration order — what maps a call site's
 * argument POSITION to a parameter NAME at the parameter-typing barrier (bd
 * tea-rags-mcp-m99j1.1.17).
 *
 * `dropReceiver` drops the implicit `self` / `cls` exactly as
 * {@link pythonDefSignature} does. The run stops at the first parameter that
 * is not a plain required positional — a default, a splat, the keyword-only
 * `*` — because past it a call site's Nth argument no longer pins the Nth
 * parameter. The positional-only `/` marker breaks nothing: the slots left of
 * it are still positional.
 */
export function pythonPositionalParamNames(defNode: AstNode, dropReceiver: boolean): string[] {
  const params = defNode.childForFieldName("parameters");
  if (params === null) return [];
  const names: string[] = [];
  let first = true;
  for (const child of params.namedChildren) {
    if (child.type === "positional_separator") continue;
    if (child.type !== "identifier" && child.type !== "typed_parameter") break;
    const name = paramName(child);
    if (first) {
      first = false;
      if (dropReceiver && (name === "self" || name === "cls")) continue;
    }
    names.push(name);
  }
  return names;
}

/** Every parameter NAME a def binds, receiver included — splats and defaults too. */
export function pythonBoundParamNames(defNode: AstNode): string[] {
  const params = defNode.childForFieldName("parameters");
  if (params === null) return [];
  const names: string[] = [];
  for (const child of params.namedChildren) {
    if (PLAIN_PARAM_TYPES.has(child.type)) names.push(paramName(child));
    else if (child.type === "list_splat_pattern" || child.type === "dictionary_splat_pattern") {
      const inner = child.namedChildren[0];
      if (inner?.type === "identifier") names.push(inner.text);
    }
  }
  return names;
}

/**
 * Every `def` in the file, keyed by its 1-based `def` line.
 *
 * That key is the chunk's `startLine`: `pyNameOf` names the `function_definition`
 * and never its `decorated_definition` wrapper, so `collectSymbols` records the
 * range from the `def` keyword even for a decorated method — the decorator lines
 * belong to no symbol. `walkPythonScopes` reports the same node, which is why
 * this reuses it rather than opening a third traversal of the tree.
 */
export function collectPythonDefSignatures(root: AstNode): Map<number, PythonDefSignature> {
  const out = new Map<number, PythonDefSignature>();
  walkPythonScopes(root, {
    onDef: (site) => {
      const isMethod = isPythonMethodDef(site.node);
      const dropReceiver = isMethod && !site.decorators.includes("staticmethod");
      const signature = pythonDefSignature(site.node, dropReceiver);
      const name = site.node.childForFieldName("name")?.text;
      out.set(
        site.line,
        isMethod && name !== undefined && isNameMangled(name) ? { ...signature, visibility: "private" } : signature,
      );
    },
  });
  return out;
}

/** Argument node types that occupy NO positional slot. Everything else — a
 *  literal, a name, a lambda, a comprehension — fills exactly one. */
const NON_POSITIONAL_ARG_TYPES: ReadonlySet<string> = new Set(["keyword_argument", "dictionary_splat"]);

/**
 * The observed shape of one `call` node.
 *
 * `argCount` is OMITTED when the argument list carries a `list_splat` (`*xs`):
 * the splat expands to an unknown number of slots at runtime, and `ArityNarrower`
 * reads a missing count as "no evidence ⇒ keep every candidate", which is the
 * only safe reading — a guessed number is FALSE evidence that drops correct
 * targets. Same rule Ruby's `computeArgCount` applies to `splat_argument`.
 */
export function pythonCallShape(callNode: AstNode): {
  argCount?: number;
  kwargKeys?: string[];
  hasKwargSplat?: boolean;
} {
  const args = callNode.childForFieldName("arguments");
  const out: { argCount?: number; kwargKeys?: string[]; hasKwargSplat?: boolean } = {};
  if (args === null) return out;
  let argCount = 0;
  let unknownCount = false;
  const kwargKeys: string[] = [];
  let hasKwargSplat = false;
  for (const child of args.namedChildren) {
    if (child.type === "list_splat") {
      unknownCount = true;
      continue;
    }
    if (child.type === "dictionary_splat") {
      hasKwargSplat = true;
      continue;
    }
    if (child.type === "keyword_argument") {
      const key = child.childForFieldName("name")?.text ?? child.namedChildren[0]?.text;
      if (key !== undefined) kwargKeys.push(key);
      continue;
    }
    if (!NON_POSITIONAL_ARG_TYPES.has(child.type)) argCount += 1;
  }
  if (!unknownCount) out.argCount = argCount;
  if (kwargKeys.length > 0) out.kwargKeys = kwargKeys;
  if (hasKwargSplat) out.hasKwargSplat = true;
  return out;
}
