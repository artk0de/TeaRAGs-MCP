/**
 * Go symbolId convention — the SINGLE source of truth for how a Go AST node
 * maps to its `Receiver#Method` / `type Foo` / `func` identifier. Consumed by
 * BOTH the chunker (`go/chunking/classifier.ts:GoChunkClassifier`) and the
 * codegraph walker (`go/walker/name-of.ts:goNameOf`). Keeping ONE source makes
 * the chunker↔codegraph lockstep `.claude/rules/symbolid-convention.md` mandates
 * true by construction — formerly duplicated in `chunker/hooks/go/symbol-resolver.ts`
 * (extractGoSymbol) and inline in `goNameOf`. bd tea-rags-mcp-n7x5 / j2b7 / aah9.
 */
import type { AstNode } from "../../../contracts/types/ast.js";
import { INSTANCE_METHOD_SEPARATOR } from "../../../infra/symbolid/index.js";

export interface GoSymbol {
  name: string;
  /** Same string as `name` for Go (top-level / receiver-composed). */
  symbolId: string;
  /** `method_declaration` (receiver-bound) → true; function/type → false. */
  instanceMethod: boolean;
}

/**
 * Resolve `{ name, symbolId, instanceMethod }` for a Go method / function / type
 * node. Returns `null` for any other node (callers fall back to default name
 * extraction). Covers:
 *   - `method_declaration` → `Receiver#Method` (pointer `*R` → `R`, generic
 *     `R[T]` → `R`), instanceMethod true.
 *   - `function_declaration` → bare name, instanceMethod false.
 *   - `type_declaration` → the `type_spec` OR `type_alias` name (struct /
 *     interface / func / map / slice / `type Foo = Bar`), instanceMethod false.
 */
export function goSymbolOf(node: AstNode): GoSymbol | null {
  if (node.type === "method_declaration") {
    const id = node.childForFieldName("name");
    if (!id) return null;
    const receiver = extractGoReceiverType(node);
    if (!receiver) {
      return { name: id.text, symbolId: id.text, instanceMethod: true };
    }
    const composed = `${receiver}${INSTANCE_METHOD_SEPARATOR}${id.text}`;
    return { name: composed, symbolId: composed, instanceMethod: true };
  }
  if (node.type === "function_declaration") {
    const id = node.childForFieldName("name");
    if (!id) return null;
    return { name: id.text, symbolId: id.text, instanceMethod: false };
  }
  if (node.type === "type_declaration") {
    // `type_spec` (`type Foo Bar` / struct / interface / func / map / slice) and
    // `type_alias` (`type Foo = Bar`) both carry the identifier on their `name`
    // field. Matching BOTH converges the chunker and codegraph: the former
    // chunker `extractGoSymbol` already emitted aliases, but `goNameOf` matched
    // only `type_spec` — so a Go alias produced a chunker symbolId with NO
    // codegraph row (a ghost-row mismatch `.claude/rules/symbolid-convention.md`
    // warns against). Sharing this clause fixes that latent lockstep gap.
    const spec = node.children.find((c) => c.type === "type_spec" || c.type === "type_alias");
    const id = spec?.childForFieldName("name");
    if (!id) return null;
    return { name: id.text, symbolId: id.text, instanceMethod: false };
  }
  return null;
}

/**
 * Extract the receiver type name from a Go `method_declaration`, stripping
 * pointer (`*R` → `R`) and dropping generic type-parameter lists. Returns null
 * if unparseable (tree-sitter-go is error-tolerant).
 */
function extractGoReceiverType(method: AstNode): string | null {
  const receiver = method.childForFieldName("receiver");
  if (!receiver) return null;
  const param = receiver.children.find((c) => c.type === "parameter_declaration");
  if (!param) return null;
  const typeNode = param.childForFieldName("type");
  if (!typeNode) return null;
  const ident =
    typeNode.type === "pointer_type" ? typeNode.children.find((c) => c.type === "type_identifier") : typeNode;
  if (!ident) return null;
  if (ident.type === "generic_type") {
    const base = ident.childForFieldName("type");
    return base?.text ?? null;
  }
  return ident.text;
}
