/**
 * Chunk-anchored declarations and the remaining file channels: the per-chunk
 * signature / symbol-kind stamp (`collectSwiftChunkDeclarations`), the `super`
 * channel (`collectSwiftClassExtends`), and the `imports` channel
 * (`collectSwiftImports` — a Swift import names a MODULE, never a symbol).
 */

import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { AstNode } from "../../../../contracts/types/ast.js";
import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";
import type { ImportRef } from "../../../../contracts/types/codegraph.js";
import { symbolIdNames } from "../../kernel/index.js";
import { swiftCallableSignature, type SwiftCallableSignature } from "./calls.js";
import { swiftNameOf } from "./name-of.js";
import { composedIdNames, SWIFT_TYPE_DECLARATION_KEYWORDS, swiftTypeDeclarationKind, walk } from "./shared.js";
import { symbolKindOf } from "./symbol-kind.js";

/** Per chunk index: the callable signature and the declaration kind of the node the chunk IS. */
export interface SwiftChunkDeclarations {
  readonly signatures: Map<number, SwiftCallableSignature>;
  readonly symbolKinds: Map<number, SymbolDefinitionKind>;
}

/**
 * chunk index → the argument-label signature of the `func` / `init` that chunk
 * IS, matched the way {@link collectSwiftStructuredReturnTypes} matches a
 * declaration to its chunk: same start line, final id segment naming it.
 *
 * The same walk stamps each chunk's symbol kind (tea-rags-mcp-vi0wx): every node
 * `swiftNameOf` names is joined to its chunk on (start line, id names the
 * node's name), and `symbolKindOf` reads its kind — so the kind costs no extra
 * traversal of the file.
 */
export function collectSwiftChunkDeclarations(
  root: AstNode,
  chunks: readonly { symbolId: string; startLine: number }[],
): SwiftChunkDeclarations {
  const indicesByLine = new Map<number, number[]>();
  chunks.forEach((chunk, index) => {
    const at = indicesByLine.get(chunk.startLine);
    if (at) at.push(index);
    else indicesByLine.set(chunk.startLine, [index]);
  });
  const out = new Map<number, SwiftCallableSignature>();
  const symbolKinds = new Map<number, SymbolDefinitionKind>();
  walk(root, (node) => {
    const named = swiftNameOf(node);
    if (named !== null) {
      const kind = symbolKindOf(node.type, {
        atTopLevel: !hasEnclosingSwiftTypeDeclaration(node),
        typeKeyword: swiftTypeDeclarationKind(node),
      });
      const index =
        kind === undefined
          ? undefined
          : indicesByLine
              .get(node.startPosition.row + 1)
              ?.find((i) => !symbolKinds.has(i) && symbolIdNames(chunks[i].symbolId, named.name));
      if (index !== undefined && kind !== undefined) symbolKinds.set(index, kind);
    }
    if (
      node.type !== "function_declaration" &&
      node.type !== "protocol_function_declaration" &&
      node.type !== "init_declaration"
    ) {
      return;
    }
    const name = node.type === "init_declaration" ? "init" : node.childForFieldName("name")?.text;
    if (name === undefined) return;
    const index = indicesByLine.get(node.startPosition.row + 1)?.find((i) => composedIdNames(chunks[i].symbolId, name));
    if (index !== undefined && !out.has(index)) out.set(index, swiftCallableSignature(node));
  });
  return { signatures: out, symbolKinds };
}

/** Whether a type, extension or protocol declaration encloses `node` — a `func` there is a method. */
function hasEnclosingSwiftTypeDeclaration(node: AstNode): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "class_declaration" || current.type === "protocol_declaration") return true;
  }
  return false;
}

/**
 * `className → superclass`, for the `super` pass alone.
 *
 * Two narrowings make this sound, and dropping either one fabricates a
 * hierarchy. Only a `class` is recorded, because the other three keywords share
 * its node type while having no superclass — `enum Status: Int` names a RAW
 * VALUE type, and reading it as a base would send `super` into `Int`. And only
 * the FIRST `inheritance_specifier` is taken: the clause lists a superclass and
 * protocols identically, marking neither, and Swift's requirement that the
 * superclass come first is the whole of what distinguishes them.
 *
 * The known limit is a class that conforms to protocols WITHOUT subclassing
 * (`class Handler: Codable`): its first specifier is a protocol and is recorded
 * as if it were a base. That costs nothing today, because `super` is not
 * expressible in such a class — there is no superclass to call — so the entry
 * is unreachable rather than wrong-in-use. A future consumer that reads this
 * channel for anything but `super` must revisit it.
 */
export function collectSwiftClassExtends(root: AstNode): Record<string, string> {
  const out: Record<string, string> = createIdentifierRecord();
  walk(root, (node) => {
    if (node.type !== "class_declaration") return;
    if (swiftDeclarationKeyword(node) !== "class") return;
    const name = node.childForFieldName("name")?.text;
    if (!name) return;
    const base = swiftFirstInheritedTypeName(node);
    if (base !== null && base !== name) out[name] = base;
  });
  return out;
}

/**
 * Which keyword a `class_declaration` was spelled with, read off the ANONYMOUS
 * children — modifiers (`public final`) arrive as a named node, so the keyword
 * is not at a fixed index and is matched by value rather than by position.
 */
function swiftDeclarationKeyword(node: AstNode): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null && !child.isNamed && SWIFT_TYPE_DECLARATION_KEYWORDS.has(child.type)) return child.type;
  }
  return null;
}

/** The first inherited type's NAME, with any generic argument list dropped (`Base<T>` → `Base`). */
function swiftFirstInheritedTypeName(node: AstNode): string | null {
  for (const child of node.namedChildren) {
    if (child.type !== "inheritance_specifier") continue;
    const text = child.text.trim();
    const name = (text.split("<")[0] ?? text).trim();
    return name.length > 0 ? name : null;
  }
  return null;
}

/**
 * One `ImportRef` per `import_declaration`, carrying the MODULE path.
 *
 * The path lives in the declaration's `identifier` child (`Foundation`,
 * `Foundation.Data`), which is what separates it from the optional kind
 * keyword a declaration import carries (`import struct Foundation.Data`). A
 * grammar that stops emitting that child falls back to stripping the leading
 * `import` plus kind keyword from the node text.
 */
export function collectSwiftImports(root: AstNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type !== "import_declaration") return;
    const path = node.children.find((c) => c.type === "identifier");
    const text = (path?.text ?? stripImportKeywords(node.text)).trim();
    if (text.length === 0) return;
    out.push({ importText: text, startLine: node.startPosition.row + 1 });
  });
  return out;
}

/** `import struct Foundation.Data` → `Foundation.Data`. Fallback only — see `collectSwiftImports`. */
function stripImportKeywords(text: string): string {
  return text.replace(/^import\s+(?:typealias|struct|class|enum|protocol|let|var|func)?\s*/, "");
}
