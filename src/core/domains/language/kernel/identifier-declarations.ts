/**
 * The identifier-declaration facet (bd tea-rags-mcp-4p3sb.2) — publishes
 * `FileExtraction.identifierDeclarations` as an extraction PASS
 * (`extraction-passes.ts`, Model A): every parameter, local and field a symbol
 * declares, with the type the syntax states when it states one — plus each
 * function's written return type as a `return` declaration of the function
 * itself (bd tea-rags-mcp-4p3sb.21), which the query-time call-return join
 * reads to type a local bound to a call.
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
import type {
  FileExtraction,
  IdentifierBoundCallee,
  IdentifierDeclaration,
  IdentifierDeclarationKind,
  IdentifierTypeMultiplicity,
} from "../../../contracts/types/codegraph.js";
import type { WalkContext } from "../../../contracts/types/language.js";
import type { ExtractionFacetPass } from "./extraction-passes.js";
import { symbolIdNames } from "./symbol-id.js";

/**
 * One declared name inside a matched node, with the nodes its type may be read from.
 *
 * A `return` site is a function's written return type (bd tea-rags-mcp-4p3sb.21):
 * `nameNode` is the function's name, `typeNode` the annotation the naming-
 * relevant type is read from. It is kept only when typed and only when a chunk
 * of the function's own names it — see {@link returnOwnerSymbolId}.
 */
export interface DeclaredIdentifierSite {
  nameNode: AstNode;
  kind: IdentifierDeclarationKind;
  /** Written type annotation. */
  typeNode?: AstNode | null;
  /** Initializer, for constructor typing and — on a local / field — the bound callee. */
  valueNode?: AstNode | null;
  /**
   * `many` when the declaration itself collects values of its annotation — a
   * variadic / rest / splat parameter (`opts ...T`, `*args: T`, `T... rest`),
   * whose annotation names the element with no collection in sight.
   */
  typeMultiplicity?: IdentifierTypeMultiplicity;
}

/**
 * The type a syntax reads off an annotation or a constructor: the nominal name,
 * and `many` when the reading went through a collection to its element
 * (`Doc[]`, `list[Doc]`, `Vec<Doc>`, `[]Doc{}` → `Doc`, many). A wrapper of one
 * value (`Optional<Doc>`, `Box<Doc>`, a pointer) names its element as `one`.
 */
export interface IdentifierSyntacticType {
  typeName: string;
  typeMultiplicity?: IdentifierTypeMultiplicity;
}

/** `many` when either reading holds many — a collection nested in a wrapper, or a wrapper in a collection. */
export function combineTypeMultiplicity(
  outer: IdentifierTypeMultiplicity | undefined,
  inner: IdentifierTypeMultiplicity | undefined,
): IdentifierTypeMultiplicity | undefined {
  return outer === "many" || inner === "many" ? "many" : undefined;
}

/** The element's reading, marked `many` when the unwrapped head is a collection. */
export function elementOfCollection(
  element: IdentifierSyntacticType | undefined,
  headIsCollection: boolean,
): IdentifierSyntacticType | undefined {
  if (element === undefined || !headIsCollection) return element;
  return { typeName: element.typeName, typeMultiplicity: "many" };
}

/** Recognises one declaration node type and lists the names it declares. */
export interface IdentifierDeclarationRule {
  nodeType: string;
  collect: (node: AstNode) => readonly DeclaredIdentifierSite[];
}

/** A language's declaration syntax — the only language knowledge the pass needs. */
export interface IdentifierDeclarationSyntax {
  rules: readonly IdentifierDeclarationRule[];
  /** Type read off an annotation node (strip `:`, generics, pointers; a collection names its element, many). */
  annotationType: (typeNode: AstNode) => IdentifierSyntacticType | undefined;
  /** `X.new` / `new X()` / `X()` / `&X{}` / `X::new` → "X"; else undefined. */
  constructorType: (valueNode: AstNode) => IdentifierSyntacticType | undefined;
  /**
   * The OUTERMOST call `valueNode` is, as the `{ member, receiver }` the
   * language's walker puts on that call's `CallRef` — read through the walker's
   * own split, so the two agree by construction. Asked for local / field
   * values only; undefined when the value is no call the walker emits.
   */
  boundCalleeOf?: (valueNode: AstNode) => IdentifierBoundCallee | undefined;
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
export type IdentifierDeclarationField =
  | "name"
  | "type"
  | "value"
  | "pattern"
  | "left"
  | "right"
  | "property"
  | "return_type";

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
    case "return_type":
      return node.childForFieldName("return_type");
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

/**
 * The owner of a `return` site: the innermost chunk containing the function's
 * name line that NAMES the function (`symbolIdNames`). The call-return join
 * reads a return row under the symbolId a call edge targets, so a function no
 * chunk of its own stands for — folded into its class's chunk, say — has no
 * owner, and the enclosing chunk must never take its return type.
 */
function returnOwnerSymbolId(line: number, name: string, chunks: WalkContext["chunks"]): string | undefined {
  return innermostChunkSymbolId(
    line,
    chunks.filter((chunk) => symbolIdNames(chunk.symbolId, name)),
  );
}

type DeclarationTypeFields = Pick<IdentifierDeclaration, "typeName" | "typeSource" | "typeMultiplicity">;

/** The declaration's type fields; `typeMultiplicity` is written only as `many` (absent means one). */
function declarationType(
  read: IdentifierSyntacticType,
  typeSource: "annotation" | "constructor",
  site: DeclaredIdentifierSite,
): DeclarationTypeFields {
  const typeMultiplicity = combineTypeMultiplicity(site.typeMultiplicity, read.typeMultiplicity);
  return typeMultiplicity === "many"
    ? { typeName: read.typeName, typeSource, typeMultiplicity }
    : { typeName: read.typeName, typeSource };
}

function typeOf(site: DeclaredIdentifierSite, syntax: IdentifierDeclarationSyntax): DeclarationTypeFields {
  if (site.typeNode) {
    const read = syntax.annotationType(site.typeNode);
    if (read !== undefined) return declarationType(read, "annotation", site);
  }
  if (site.valueNode) {
    const read = syntax.constructorType(site.valueNode);
    if (read !== undefined) return declarationType(read, "constructor", site);
  }
  return {};
}

/** A walker's `{ member, receiver }` call split (`receiver: null` for a bare call) as a bound callee. */
export function boundCalleeFromCallShape(
  shape: { readonly member: string; readonly receiver: string | null } | null | undefined,
): IdentifierBoundCallee | undefined {
  if (!shape) return undefined;
  return shape.receiver === null ? { member: shape.member } : { member: shape.member, receiver: shape.receiver };
}

/** A parameter's default is no binding the body chose, so only locals and fields carry a callee. */
function boundCalleeOf(
  site: DeclaredIdentifierSite,
  syntax: IdentifierDeclarationSyntax,
): Pick<IdentifierDeclaration, "boundCallee"> {
  if (site.kind === "param" || !site.valueNode || syntax.boundCalleeOf === undefined) return {};
  const boundCallee = syntax.boundCalleeOf(site.valueNode);
  return boundCallee === undefined ? {} : { boundCallee };
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
            const isReturn = site.kind === "return";
            const ownerSymbolId = isReturn
              ? returnOwnerSymbolId(line, name, ctx.chunks)
              : innermostChunkSymbolId(line, ctx.chunks);
            if (ownerSymbolId === undefined) continue;
            const type = typeOf(site, syntax);
            // An unannotated function declares no return: the row would say nothing.
            if (isReturn && type.typeName === undefined) continue;
            const key = `${ownerSymbolId}\u0000${site.kind}\u0000${name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            declarations.push({
              name,
              kind: site.kind,
              line,
              ownerSymbolId,
              ...type,
              ...boundCalleeOf(site, syntax),
            });
          }
        }
        const { children } = node;
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      }
      return declarations.length > 0 ? { identifierDeclarations: declarations } : {};
    },
  };
}
