/**
 * Rust symbol kinds (tea-rags-mcp-vi0wx) — the declaration kind of a Rust item,
 * stamped on its chunk as `ChunkExtraction.symbolKind`:
 *
 *   | node                                        | kind       |
 *   | ------------------------------------------- | ---------- |
 *   | `struct_item`, `union_item`                 | class      |
 *   | `enum_item`                                 | enum       |
 *   | `trait_item`                                | interface  |
 *   | `mod_item`                                  | module     |
 *   | `function_item` in an `impl` / `trait` body | method     |
 *   | any other `function_item`                   | function   |
 *   | `const_item`, `static_item`                 | constant   |
 *   | `type_item`                                 | type_alias |
 *   | `macro_definition` (`macro_rules!`)         | macro      |
 *
 * An `impl_item` declares nothing (it implements a type declared elsewhere), so
 * it reads undefined. A `macro_rules!` is tagged `macro` so it lives in the
 * macro namespace: no callee role admits it, and a macro invocation lands only
 * on it (bd tea-rags-mcp-s3i8m.2).
 *
 * `rustNameOf` names no `const` / `static` / `type` item, so the walker never
 * tags one today. Adding those symbols would move the chunk set: a top-level
 * `const X: T = make();` would claim the `make()` call site no chunk owns now,
 * and the global short-name fallback has no callable gate, so a `static` named
 * like a call member would become a resolution target.
 *
 * The context is the item type owning the `declaration_list` a node sits in —
 * Rust's kind depends on the owner, not on nesting depth (a `fn` nested in a
 * `mod` or in another `fn` is still a function).
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";

export interface RustSymbolKindContext {
  /** Node type of the item whose `declaration_list` body holds the node (`impl_item`, `trait_item`, `mod_item`). */
  readonly ownerItem?: string;
}

const METHOD_OWNERS: ReadonlySet<string> = new Set(["impl_item", "trait_item"]);

export function symbolKindOf(nodeType: string, context: RustSymbolKindContext = {}): SymbolDefinitionKind | undefined {
  switch (nodeType) {
    case "struct_item":
    case "union_item":
      return "class";
    case "enum_item":
      return "enum";
    case "trait_item":
      return "interface";
    case "mod_item":
      return "module";
    case "function_item":
    case "function_signature_item":
      return context.ownerItem !== undefined && METHOD_OWNERS.has(context.ownerItem) ? "method" : "function";
    case "const_item":
    case "static_item":
      return "constant";
    case "type_item":
      return "type_alias";
    case "macro_definition":
      return "macro";
    default:
      return undefined;
  }
}

/** The item type owning the `declaration_list` `node` sits in, if any. */
export function rustOwnerItemOf(node: AstNode): string | undefined {
  return node.parent?.type === "declaration_list" ? node.parent.parent?.type : undefined;
}
