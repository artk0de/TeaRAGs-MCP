import type Parser from "tree-sitter";

import type { AstNode } from "../../../contracts/types/ast.js";
import type { NamedSymbol } from "../../../contracts/types/codegraph.js";
import type { CollectedSymbolRange, SymbolIdComposer } from "../../../contracts/types/language.js";

/**
 * Compose the next fully-qualified id by appending `child.name` to `composed`
 * with the correct separator:
 *   - Top-level (`composed === ""`) → just the name.
 *   - `methodKind: "instance"` → `composed#child.name` (any language).
 *   - `methodKind: "static"`   → `composed.child.name` (any language).
 *   - Otherwise → `composed{scopeSeparator}child.name` (language-local).
 *
 * Behaviour-preserving delegation to the injected `SymbolIdComposer` — the one
 * cross-language symbolId mapper (spec §1a). The `{ methodKind, scopeSeparator,
 * absolute }` mapping is exactly the `compose` contract; this wrapper only
 * unpacks `NamedSymbol` into the option fields.
 */
function joinSymbol(composer: SymbolIdComposer, composed: string, child: NamedSymbol, scopeSeparator: string): string {
  return composer.compose(composed, child.name, {
    methodKind: child.methodKind,
    scopeSeparator,
    absolute: child.absolute,
  });
}

/**
 * Walk a parsed tree and collect every named symbol's fully-qualified id +
 * line range. Pure — the cross-language `composer` is passed in so the function
 * carries no provider state (yl9tv: relocated from
 * `CodegraphEnrichmentProvider#collectSymbols` so the chunker worker can produce
 * a complete `FileExtraction` from the SAME parse it chunks with).
 */
export function collectSymbols(
  tree: Parser.Tree,
  nameOf: (node: AstNode) => NamedSymbol | NamedSymbol[] | null,
  separator: string,
  disambiguateOverloads: boolean,
  composer: SymbolIdComposer,
): CollectedSymbolRange[] {
  const out: CollectedSymbolRange[] = [];
  const walk = (node: AstNode, scope: string[], composed: string): void => {
    const result = nameOf(node);
    // Stable nested-scope tracking lets each named declaration carry
    // a unique fully-qualified id even when same-name declarations
    // are nested in different parents (e.g. four `worker()` helpers
    // inside different outer functions). The string `composed` is
    // the fqName we've built so far; we extend it per-named symbol
    // with the right separator (`#` for instance methods nested
    // under a class; the language's `scopeSeparator` otherwise).
    //
    // Array return form (Ruby DSL macros): emit each synthetic symbol
    // at the current scope but do NOT descend through them — the
    // call node itself has no useful interior for walking.
    if (Array.isArray(result)) {
      for (const ns of result) {
        out.push({
          symbolId: joinSymbol(composer, composed, ns, separator),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          scope,
        });
      }
      // Continue walking children at the SAME scope (descendsInto is
      // structurally false for array members — the call node is a leaf
      // for symbol purposes; its children are argument expressions
      // already covered by other nodes' nameOf).
      for (const child of node.children) walk(child, scope, composed);
      return;
    }
    const named = result;
    const childScope = named ? [...scope, named.name] : scope;
    const childComposed = named ? joinSymbol(composer, composed, named, separator) : composed;
    if (named) {
      out.push({
        symbolId: childComposed,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        scope,
      });
    }
    // Snapshot length BEFORE walking children so we can detect whether
    // the child walk emitted an explicit `<class>#constructor` symbol.
    // Used only when `syntheticConstructorIfMissing` is set (TS/JS
    // class_declaration — bd tea-rags-mcp-vw1u).
    const beforeChildren = out.length;
    for (const child of node.children) walk(child, childScope, childComposed);
    if (named?.syntheticConstructorIfMissing) {
      const expectedCtor = `${childComposed}#constructor`;
      let hasExplicit = false;
      for (let i = beforeChildren; i < out.length; i++) {
        if (out[i].symbolId === expectedCtor) {
          hasExplicit = true;
          break;
        }
      }
      if (!hasExplicit) {
        out.push({
          symbolId: expectedCtor,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          scope: childScope,
        });
      }
    }
  };
  walk(tree.rootNode, [], "");
  // Default behaviour: dedup by symbolId (keep first occurrence). Used
  // by TS get/set accessor pairs (semantically one property), Python
  // `@functools.singledispatch` stubs (bd tea-rags-mcp-d4ab — keep
  // the first def, drop the impl-stub collision), etc.
  //
  // bd tea-rags-mcp-a466 — `disambiguateOverloads` opts a language IN
  // to overload-aware suffixing: keep the FIRST occurrence's symbolId
  // verbatim, append `~N` (1-based — second becomes `~2`) to each
  // duplicate. Java needs this because `find_symbol("StringUtils.upperCase")`
  // otherwise collapses multi-overload public APIs into a single
  // merged chunk and `get_callers`/`get_callees` can't disambiguate
  // which overload was called. Mirrors the chunker convention so
  // cg_symbols + Qdrant payload agree on the same physical AST node.
  if (disambiguateOverloads) {
    const occurrences = new Map<string, number>();
    return out.map((s) => {
      const seen = occurrences.get(s.symbolId) ?? 0;
      const next = seen + 1;
      occurrences.set(s.symbolId, next);
      if (next === 1) return s;
      return { ...s, symbolId: `${s.symbolId}~${next}` };
    });
  }
  const seen = new Set<string>();
  return out.filter((s) => {
    if (seen.has(s.symbolId)) return false;
    seen.add(s.symbolId);
    return true;
  });
}
