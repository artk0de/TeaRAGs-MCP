/**
 * Registry-literal constants and the dispatch they drive.
 *
 * A Ruby `CONST = { k => Klass }.freeze` is two facts at once, and both are
 * read off the same assignment shape here:
 *
 *   1. a hard REFERENCE to every value class, emitted as synthetic CallRefs
 *      (bd tea-rags-mcp-ki9v) so the registry chunk's fan-out reflects the
 *      coupling the literal creates;
 *   2. a DISPATCH TABLE (bd tea-rags-mcp-pq02v), so `CONST[k].new.m` resolves
 *      to `Klass#m` instead of dying at the subscript.
 *
 * {@link exprToRubyDispatchRef} is the abstract interpreter for the second —
 * it composes through subscript, instantiation, and member selection.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { CallRef, DispatchRef, DispatchTable } from "../../../../contracts/types/codegraph.js";
import { FULL_RUBY_CATALOGUE, type RubyDslCatalogue } from "../dsl/index.js";
import { readScopeResolution, walk } from "./ast-utils.js";

/**
 * Strip trailing no-arg call wrappers (`{...}.freeze`, `[...].freeze.dup`) to
 * reach the underlying collection literal. Returns the receiver chain's root,
 * which the caller checks for `array` / `hash`. Non-call inputs pass through.
 */
function unwrapTrailingCalls(node: AstNode | null): AstNode | null {
  let n = node;
  while (n?.type === "call") {
    const receiver = n.childForFieldName("receiver");
    if (!receiver) break;
    n = receiver;
  }
  return n;
}

/**
 * Emit a reference CallRef for every constant / scope_resolution used inside a
 * constant-assigned collection literal (registry pattern, bd tea-rags-mcp-ki9v).
 * Mirrors `collectRubyConstantRefs`'s outermost-only discipline for nested
 * `scope_resolution`. Descent stops at lambda / proc / block / nested def
 * bodies: a constant referenced there is dispatched at runtime, not a static
 * registry reference, and is out of scope (bd tea-rags-mcp-jw9n). Receiver and
 * member both carry the fully-qualified constant so the `constant` resolver
 * pins it to the declaring file (file-only edge when no method matches).
 */
function collectRegistryConstantValueRefs(literal: AstNode, out: CallRef[]): void {
  const walkValue = (n: AstNode): void => {
    if (
      n.type === "lambda" ||
      n.type === "block" ||
      n.type === "do_block" ||
      n.type === "method" ||
      n.type === "singleton_method"
    ) {
      return;
    }
    if (n.type === "scope_resolution") {
      if (n.parent?.type === "scope_resolution") return; // outermost only
      const qualified = readScopeResolution(n);
      if (qualified) {
        out.push({ callText: qualified, receiver: qualified, member: qualified, startLine: n.startPosition.row + 1 });
      }
      return;
    }
    if (n.type === "constant") {
      if (n.parent?.type === "scope_resolution") return; // covered by the outer chain
      out.push({ callText: n.text, receiver: n.text, member: n.text, startLine: n.startPosition.row + 1 });
      return;
    }
    for (const child of n.children) walkValue(child);
  };
  walkValue(literal);
}

/**
 * Registry constant-reference edges (bd tea-rags-mcp-ki9v). A constant
 * assignment whose RHS is a collection literal — `CONST = { k => Klass }` or
 * `CONST = [Klass, ...]`, optionally `.freeze`d — hard-references each value
 * class. Those references are `constant`/`scope_resolution` nodes, not `call`
 * nodes, so without this branch the registry chunk gets chunk fanOut=0 despite
 * coupling to every value class. Emit a synthetic reference CallRef per literal
 * constant; receiver === member === the fully-qualified constant so the
 * `constant` resolver pins it to the declaring file as a file-only edge.
 * Constants nested in a lambda / proc / block body (STI-style `-> { Klass }`
 * registries) are deliberately skipped (bd tea-rags-mcp-jw9n). No-ops for any
 * non-`assignment` node.
 */
export function emitRegistryConstantRefs(node: AstNode, out: CallRef[]): void {
  if (node.type !== "assignment") return;
  const left = node.childForFieldName("left");
  if (left && (left.type === "constant" || left.type === "scope_resolution")) {
    const literal = unwrapTrailingCalls(node.childForFieldName("right"));
    if (literal && (literal.type === "array" || literal.type === "hash")) {
      collectRegistryConstantValueRefs(literal, out);
    }
  }
}

/**
 * Normalize a Ruby hash key node to the string used in `DispatchTable.entries`
 * keys AND in `DispatchRef.key` (bd tea-rags-mcp-pq02v). String literal → inner
 * text without quotes; symbol (`:k` / `k:` hash-key sugar) → bare name. Returns
 * null for a non-literal / computed key (the entry is then dropped — m46z, never
 * guess a runtime key). Shared by the table build and the call-site key read so
 * both produce identical key strings.
 */
function rubyDispatchKeyText(node: AstNode | null): string | null {
  if (!node) return null;
  if (node.type === "string") {
    const inner = node.namedChildren.find((c) => c.type === "string_content");
    return inner ? inner.text : node.text.replace(/^['"`]|['"`]$/g, "");
  }
  if (node.type === "simple_symbol") return node.text.replace(/^:/, "");
  if (node.type === "hash_key_symbol") return node.text; // `k:` sugar → bare `k`
  return null;
}

/**
 * Extract a class FQ-name from a registry VALUE node (bd tea-rags-mcp-pq02v).
 * `scope_resolution` → full `A::B::C` via readScopeResolution; bare `constant` →
 * its text. Anything else (lambda, call, nested literal) → null (dropped).
 */
function rubyDispatchValueConstant(node: AstNode | null): string | null {
  if (!node) return null;
  if (node.type === "scope_resolution") return readScopeResolution(node) || null;
  if (node.type === "constant") return node.text;
  return null;
}

/**
 * Build the per-constant dispatch tables for registry-literal dispatch
 * (bd tea-rags-mcp-pq02v). Mirrors the TS `collectDispatchTables` shape but for
 * Ruby `CONST = <hash|array>.freeze` assignments. Entry values are class
 * FQ-names (see DispatchTable doc overload). A hash key uses its literal text; an
 * array element uses its positional index. Tables with zero constant-valued
 * entries are omitted. Shares the assignment/literal detection with
 * `collectRegistryConstantValueRefs` (which keeps emitting the chunk-ref edges).
 */
export function collectRubyDispatchTables(root: AstNode): Record<string, DispatchTable> {
  const out: Record<string, DispatchTable> = {};
  walk(root, (node) => {
    if (node.type !== "assignment") return;
    const left = node.childForFieldName("left");
    if (!left || (left.type !== "constant" && left.type !== "scope_resolution")) return;
    const name = left.type === "scope_resolution" ? readScopeResolution(left) : left.text;
    const literal = unwrapTrailingCalls(node.childForFieldName("right"));
    if (!literal) return;
    const entries: Record<string, string> = {};
    if (literal.type === "hash") {
      for (const pair of literal.namedChildren) {
        if (pair.type !== "pair") continue;
        const key = rubyDispatchKeyText(pair.childForFieldName("key"));
        const value = rubyDispatchValueConstant(pair.childForFieldName("value"));
        if (key !== null && value !== null) entries[key] = value;
      }
    } else if (literal.type === "array") {
      let i = 0;
      for (const el of literal.namedChildren) {
        const value = rubyDispatchValueConstant(el);
        if (value !== null) entries[String(i)] = value;
        i++;
      }
    } else {
      return;
    }
    if (Object.keys(entries).length > 0) out[name] = { entries };
  });
  return out;
}

/**
 * Abstract-interpret a Ruby callee chain to its dispatch reference
 * (bd tea-rags-mcp-pq02v). Composes through `element_reference` (the table
 * subscript), the `.new` instantiation (pass-through), and the outer `.member`
 * call (the dispatched method). Returns null when the chain is not rooted at a
 * known dispatch-table constant.
 *
 *   CONST            → (not a ref on its own)
 *   CONST[k]         → { table: CONST, field: null, key: staticKeyOf, viaInstance: false }
 *   CONST[k].new     → same ref, field stays null, viaInstance flips true
 *   CONST[k].new.m   → { table: CONST, field: "m", key, viaInstance: true }
 *   CONST[k].m       → { table: CONST, field: "m", key, viaInstance: false }
 *   CONST[k].create!.m → { table: CONST, field: "m", key, viaInstance: true }
 *
 * `viaInstance` records whether an instantiator hop happened, which decides the
 * symbolId form the resolver looks up: `Class#m` after `.new`, `Class.m` for a
 * direct class-method call (bd tea-rags-mcp-exmwr).
 *
 * `.new` is a PURE pass-through: it names no in-project member, so its own node
 * carries no field and emits no edge. The other instantiators — the catalogue's
 * `instanceReturning` facet, i.e. the AR/factory verbs whose return IS an
 * instance of the receiver class (`create!`, `build`, `find!`, …) — are real
 * members that a value class MAY define, so their node keeps its field (the
 * class-form edge) while the NEXT hop continues the chain as an instance member
 * (bd tea-rags-mcp-va9ng). One hop: a member of an already-instance ref ends the
 * chain, exactly as before.
 */
export function exprToRubyDispatchRef(
  node: AstNode,
  tableNames: ReadonlySet<string>,
  catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE,
): DispatchRef | null {
  if (node.type === "element_reference") {
    const obj = node.childForFieldName("object") ?? node.namedChildren[0];
    if (!obj) return null;
    const objName =
      obj.type === "scope_resolution" ? readScopeResolution(obj) : obj.type === "constant" ? obj.text : null;
    if (objName === null || !tableNames.has(objName)) return null;
    // The subscript index is the named child after the object.
    const index = node.namedChildren[1] ?? null;
    return { table: objName, field: null, key: rubyDispatchKeyText(index), viaInstance: false };
  }
  if (node.type === "call" || node.type === "method_call") {
    const receiver = node.childForFieldName("receiver");
    const method = node.childForFieldName("method");
    if (!receiver || !method) return null;
    const inner = exprToRubyDispatchRef(receiver, tableNames, catalogue);
    if (!inner) return null;
    // `.new` on a table-bound chain is a pass-through (instantiation, no edge)
    // that rebinds the receiver from the CLASS to one of its instances.
    if (method.text === "new" && inner.field === null) return { ...inner, viaInstance: true };
    // Outer `.member` on an entry-ref (field still null) → select the member,
    // carrying the receiver form the chain has reached so far.
    if (inner.field === null) {
      return { table: inner.table, field: method.text, key: inner.key, viaInstance: inner.viaInstance };
    }
    // Post-factory hop: the inner ref selected a CLASS member that is an
    // instantiator by framework convention, so this hop lands on an instance.
    if (inner.viaInstance !== true && catalogue.instanceReturning.has(inner.field)) {
      return { table: inner.table, field: method.text, key: inner.key, viaInstance: true };
    }
  }
  return null;
}
