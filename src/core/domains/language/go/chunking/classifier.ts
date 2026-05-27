/**
 * Go node→chunk classifier. Emits explicit chunks for the two node shapes whose
 * default engine shaping is wrong:
 *   - `method_declaration` → `Receiver#Method` (the default extractName loses the
 *     receiver), chunkType "function".
 *   - `type_declaration` → name from the `type_spec`/`type_alias` child (the
 *     default extractName returns undefined — `type_declaration` has no direct
 *     `name` field), chunkType refined by body kind: struct → "class", interface
 *     → "interface", else "block" (func / map / slice aliases). bd iiq6.
 *
 * `function_declaration` and everything else PASS THROUGH: the default
 * extractName + buildSymbolId + getChunkType already produce the right shape, and
 * passthrough keeps the engine's min-length floor (a tiny `func f(){}` is floored
 * exactly as before — `emit` would bypass it). Mirrors the former engine
 * `language === "go"` block, which only claimed method/type via `extractGoSymbol`.
 *
 * Naming comes from the shared `goSymbolOf` (also used by the codegraph walker),
 * so chunker and codegraph agree on the symbolId by construction.
 */
import type Parser from "tree-sitter";

import type { ChunkDecision, ChunkType, LanguageChunkClassifier } from "../../../../contracts/types/chunker.js";
import { goSymbolOf } from "../naming.js";

export class GoChunkClassifier implements LanguageChunkClassifier {
  classifyNode(node: Parser.SyntaxNode): ChunkDecision {
    if (node.type !== "method_declaration" && node.type !== "type_declaration") {
      return { kind: "passthrough" };
    }
    const sym = goSymbolOf(node);
    if (!sym) return { kind: "passthrough" };

    let chunkType: ChunkType = node.type === "method_declaration" ? "function" : "block";
    if (node.type === "type_declaration") {
      const spec = node.children.find((c) => c.type === "type_spec" || c.type === "type_alias");
      const body = spec?.childForFieldName("type");
      if (body?.type === "struct_type") chunkType = "class";
      else if (body?.type === "interface_type") chunkType = "interface";
    }
    return { kind: "emit", chunks: [{ name: sym.name, symbolId: sym.symbolId, chunkType }] };
  }
}
