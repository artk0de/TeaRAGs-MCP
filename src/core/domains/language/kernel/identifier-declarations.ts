/**
 * The identifier-declaration facet (bd tea-rags-mcp-4p3sb.2) — publishes
 * `FileExtraction.identifierDeclarations` as an extraction PASS
 * (`extraction-passes.ts`, Model A): every parameter, local and field a symbol
 * declares, with the type the syntax states when it states one.
 *
 * Which nodes declare what stays language knowledge: each language supplies an
 * {@link IdentifierDeclarationSyntax} — node-type rules, plus how to read a type
 * name off an annotation and off a constructor-shaped initializer. The neutral
 * half is shared here: one traversal, the owner join onto the chunk
 * `collectSymbols` produced, and the dedup.
 *
 * Syntactic only. A pass sees neither the native walker's type channels nor the
 * other passes' output, so a declaration typed by a binding, a field type or a
 * return type is joined at sink time from the merged `FileExtraction`, not here.
 */

import type { AstNode } from "../../../contracts/types/ast.js";
import type { FileExtraction, IdentifierDeclaration } from "../../../contracts/types/codegraph.js";
import type { WalkContext } from "../../../contracts/types/language.js";
import type { ExtractionFacetPass } from "./extraction-passes.js";

/** One declared name inside a matched node, with the nodes its type may be read from. */
export interface DeclaredIdentifierSite {
  nameNode: AstNode;
  kind: "param" | "local" | "field";
  /** Written type annotation. */
  typeNode?: AstNode | null;
  /** Initializer, for constructor typing. */
  valueNode?: AstNode | null;
}

/** Recognises one declaration node type and lists the names it declares. */
export interface IdentifierDeclarationRule {
  nodeType: string;
  collect: (node: AstNode) => readonly DeclaredIdentifierSite[];
}

/** A language's declaration syntax — the only language knowledge the pass needs. */
export interface IdentifierDeclarationSyntax {
  rules: readonly IdentifierDeclarationRule[];
  /** Type name from an annotation node's text (strip `:`, generics, pointers). */
  annotationTypeName: (typeNode: AstNode) => string | undefined;
  /** `X.new` / `new X()` / `X()` / `&X{}` / `X::new` → "X"; else undefined. */
  constructorTypeName: (valueNode: AstNode) => string | undefined;
}

/** Sigils (`@`, `@@`, `$`) and a trailing `!`/`?` allowed; destructuring patterns and literals rejected. */
const IDENTIFIER_LIKE = /^[@$]{0,2}[A-Za-z_]\w*[!?]?$/;

/**
 * The grammar field names a {@link fieldRule} may read. A closed set rather than
 * a free string so every read below stays a LITERAL `childForFieldName("…")`:
 * the materialization field-loss guard (`surveyWalkerFieldReads`) harvests field
 * names from literal call sites only, and a field read through a variable is one
 * it cannot check against a grammar's materialization losses.
 */
export type IdentifierDeclarationField = "name" | "type" | "value" | "pattern" | "left" | "right" | "property";

function readDeclarationField(node: AstNode, field: IdentifierDeclarationField): AstNode | null {
  switch (field) {
    case "name":
      return node.childForFieldName("name");
    case "type":
      return node.childForFieldName("type");
    case "value":
      return node.childForFieldName("value");
    case "pattern":
      return node.childForFieldName("pattern");
    case "left":
      return node.childForFieldName("left");
    case "right":
      return node.childForFieldName("right");
    case "property":
      return node.childForFieldName("property");
  }
}

/** Field-driven rule for the common shape: name/type/value are named fields. */
export function fieldRule(
  nodeType: string,
  kind: DeclaredIdentifierSite["kind"],
  fields: { name: IdentifierDeclarationField; type?: IdentifierDeclarationField; value?: IdentifierDeclarationField },
): IdentifierDeclarationRule {
  return {
    nodeType,
    collect: (node) => {
      const nameNode = readDeclarationField(node, fields.name);
      if (nameNode === null) return [];
      return [
        {
          nameNode,
          kind,
          typeNode: fields.type === undefined ? null : readDeclarationField(node, fields.type),
          valueNode: fields.value === undefined ? null : readDeclarationField(node, fields.value),
        },
      ];
    },
  };
}

/**
 * Innermost chunk containing `line` — smallest span, deeper scope on tie (the
 * rule `assignCallsToInnermostChunks` applies; a synthetic `Class#constructor`
 * duplicates its class's range, so equal spans are real). Linear scan: a
 * file's chunk list is small.
 */
export function innermostChunkSymbolId(line: number, chunks: WalkContext["chunks"]): string | undefined {
  let best: WalkContext["chunks"][number] | undefined;
  for (const chunk of chunks) {
    if (line < chunk.startLine || line > chunk.endLine) continue;
    if (best === undefined) {
      best = chunk;
      continue;
    }
    const span = chunk.endLine - chunk.startLine;
    const bestSpan = best.endLine - best.startLine;
    if (span < bestSpan || (span === bestSpan && chunk.scope.length > best.scope.length)) {
      best = chunk;
    }
  }
  return best?.symbolId;
}

function typeOf(
  site: DeclaredIdentifierSite,
  syntax: IdentifierDeclarationSyntax,
): Pick<IdentifierDeclaration, "typeName" | "typeSource"> {
  if (site.typeNode) {
    const typeName = syntax.annotationTypeName(site.typeNode);
    if (typeName !== undefined) return { typeName, typeSource: "annotation" };
  }
  if (site.valueNode) {
    const typeName = syntax.constructorTypeName(site.valueNode);
    if (typeName !== undefined) return { typeName, typeSource: "constructor" };
  }
  return {};
}

export function createIdentifierDeclarationFacetPass(syntax: IdentifierDeclarationSyntax): ExtractionFacetPass {
  const rulesByNodeType = new Map<string, IdentifierDeclarationRule[]>();
  for (const rule of syntax.rules) {
    const bucket = rulesByNodeType.get(rule.nodeType);
    if (bucket === undefined) rulesByNodeType.set(rule.nodeType, [rule]);
    else bucket.push(rule);
  }

  return {
    run: (root, ctx): Partial<FileExtraction> => {
      if (ctx.chunks.length === 0) return {};
      const declarations: IdentifierDeclaration[] = [];
      const seen = new Set<string>();
      // Iterative pre-order in document order: children pushed in reverse so the
      // first declaration of a name is the one kept.
      const stack: AstNode[] = [root];
      for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
        for (const rule of rulesByNodeType.get(node.type) ?? []) {
          for (const site of rule.collect(node)) {
            const name = site.nameNode.text;
            if (!IDENTIFIER_LIKE.test(name)) continue;
            const line = site.nameNode.startPosition.row + 1;
            const ownerSymbolId = innermostChunkSymbolId(line, ctx.chunks);
            if (ownerSymbolId === undefined) continue;
            const key = `${ownerSymbolId}\u0000${site.kind}\u0000${name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            declarations.push({ name, kind: site.kind, line, ownerSymbolId, ...typeOf(site, syntax) });
          }
        }
        const { children } = node;
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      }
      return declarations.length > 0 ? { identifierDeclarations: declarations } : {};
    },
  };
}
