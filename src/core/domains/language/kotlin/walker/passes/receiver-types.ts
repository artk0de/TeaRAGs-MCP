/**
 * Local bindings and class-field types the typed-receiver pass reads.
 *
 * A parameter or a `val`/`var` inside a function lands on the innermost chunk
 * that contains it. A property or a `val`/`var` constructor parameter lands
 * on its enclosing type (`App` or `Outer.Inner`). A file-level property is
 * visible to every chunk in the file; its line is 1 so declaration order does
 * not hide it, and a later local of the same name still shadows it.
 *
 * The type is the annotation's head (`List<Repo>` stays `List`, `Repo?` is
 * `Repo`). With no annotation, a bare PascalCase call (`Repo()`) names the type.
 */

import { createIdentifierRecord } from "../../../../../contracts/identifier-record.js";
import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { ChunkExtraction, FileExtraction, LocalBinding } from "../../../../../contracts/types/codegraph.js";
import type { WalkContext } from "../../../../../contracts/types/language.js";
import type { ExtractionFacetPass } from "../../../kernel/index.js";
import { kotlinCallSiteShape } from "../call-site.js";

interface PendingBinding {
  readonly name: string;
  readonly type: string;
  readonly line: number;
  readonly fileScope: boolean;
}

export const kotlinReceiverTypesFacetPass: ExtractionFacetPass = {
  run(root: AstNode, ctx: WalkContext) {
    const locals: PendingBinding[] = [];
    const fields = new Map<string, Map<string, string>>();
    collect(root, [], locals, fields);
    return channels(locals, fields, ctx);
  },
};

function collect(
  node: AstNode,
  typeScope: readonly string[],
  locals: PendingBinding[],
  fields: Map<string, Map<string, string>>,
): void {
  const declared = typeName(node);
  const nextScope = declared === undefined ? typeScope : [...typeScope, declared];
  if (node.type === "parameter" && inside(node, "function_value_parameters")) {
    const binding = namedType(node);
    if (binding) locals.push({ ...binding, fileScope: false });
  } else if (node.type === "class_parameter" && isPropertyParameter(node) && nextScope.length > 0) {
    const binding = namedType(node);
    if (binding) putField(fields, nextScope.join("."), binding.name, binding.type);
  } else if (node.type === "property_declaration") {
    const binding = propertyBinding(node);
    if (binding) {
      if (insideFunction(node)) locals.push({ ...binding, fileScope: false });
      else if (nextScope.length > 0) putField(fields, nextScope.join("."), binding.name, binding.type);
      else locals.push({ ...binding, fileScope: true });
    }
  }
  for (const child of node.namedChildren) collect(child, nextScope, locals, fields);
}

function channels(
  locals: readonly PendingBinding[],
  fields: Map<string, Map<string, string>>,
  ctx: WalkContext,
): Partial<FileExtraction> {
  const out: Partial<FileExtraction> = {};
  const bySymbol = new Map<string, Record<string, LocalBinding[]>>();
  for (const binding of locals) {
    const owners = binding.fileScope ? ctx.chunks : chunksAt(ctx.chunks, binding.line);
    const owner = binding.fileScope ? null : innermost(owners);
    const targets = binding.fileScope ? ctx.chunks : owner ? [owner] : [];
    for (const chunk of targets) {
      const record = bySymbol.get(chunk.symbolId) ?? createIdentifierRecord<LocalBinding[]>();
      const list = record[binding.name] ?? [];
      list.push({ line: binding.fileScope ? 1 : binding.line, type: binding.type });
      record[binding.name] = list;
      bySymbol.set(chunk.symbolId, record);
    }
  }
  const chunkRecords: ChunkExtraction[] = [];
  for (const chunk of ctx.chunks) {
    const localBindings = bySymbol.get(chunk.symbolId);
    if (localBindings === undefined) continue;
    for (const list of Object.values(localBindings)) list.sort((a, b) => a.line - b.line);
    chunkRecords.push({
      symbolId: chunk.symbolId,
      scope: chunk.scope,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      calls: [],
      localBindings,
    });
  }
  if (chunkRecords.length > 0) out.chunks = chunkRecords;
  if (fields.size > 0) {
    const classFieldTypes = createIdentifierRecord<Record<string, string>>();
    for (const [owner, members] of fields) {
      const record = createIdentifierRecord<string>();
      for (const [name, type] of members) record[name] = type;
      classFieldTypes[owner] = record;
    }
    out.classFieldTypes = classFieldTypes;
  }
  return out;
}

function typeName(node: AstNode): string | undefined {
  if (node.type !== "class_declaration" && node.type !== "object_declaration" && node.type !== "companion_object") {
    return undefined;
  }
  const id = node.childForFieldName("name");
  return id && id.text.length > 0 ? id.text : undefined;
}

function isPropertyParameter(node: AstNode): boolean {
  return node.children.some((child) => !child.isNamed && (child.type === "val" || child.type === "var"));
}

function inside(node: AstNode, type: string): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === type) return true;
  }
  return false;
}

function insideFunction(node: AstNode): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (
      current.type === "function_body" ||
      current.type === "lambda_literal" ||
      current.type === "anonymous_function"
    ) {
      return true;
    }
    if (current.type === "class_body" || current.type === "enum_class_body" || current.type === "companion_object") {
      return false;
    }
  }
  return false;
}

function namedType(typeHost: AstNode): { name: string; type: string; line: number } | null {
  const nameNode = typeHost.namedChildren.find((child) => child.type === "identifier");
  const typeNode = typeHost.namedChildren.find((child) => child.type === "user_type" || child.type === "nullable_type");
  const type = typeNode ? simpleTypeName(typeNode) : undefined;
  if (!nameNode || nameNode.text.length === 0 || !type) return null;
  return { name: nameNode.text, type, line: nameNode.startPosition.row + 1 };
}

function propertyBinding(node: AstNode): { name: string; type: string; line: number } | null {
  const variable = node.namedChildren.find((child) => child.type === "variable_declaration");
  if (!variable) return null;
  const nameNode = variable.namedChildren.find((child) => child.type === "identifier");
  if (!nameNode || nameNode.text.length === 0) return null;
  const typeNode = variable.namedChildren.find((child) => child.type === "user_type" || child.type === "nullable_type");
  const annotated = typeNode ? simpleTypeName(typeNode) : undefined;
  const valueNode = node.namedChildren.find((child) => child.startIndex > variable.endIndex);
  const constructed = valueNode ? constructorTypeName(valueNode) : undefined;
  const type = annotated ?? constructed;
  if (!type) return null;
  return { name: nameNode.text, type, line: nameNode.startPosition.row + 1 };
}

function simpleTypeName(node: AstNode): string | undefined {
  const inner = node.type === "nullable_type" ? node.namedChildren[0] : node;
  if (!inner) return undefined;
  if (inner.type === "identifier") return inner.text.length > 0 ? inner.text : undefined;
  if (inner.type !== "user_type") return undefined;
  const ids = inner.namedChildren.filter((child) => child.type === "identifier" && child.text.length > 0);
  return ids.at(-1)?.text;
}

function constructorTypeName(valueNode: AstNode): string | undefined {
  const shape = kotlinCallSiteShape(valueNode);
  if (!shape) return undefined;
  if (shape.receiver !== null || !/^[A-Z]/.test(shape.member)) return undefined;
  return shape.member;
}

function chunksAt(chunks: WalkContext["chunks"], line: number): WalkContext["chunks"] {
  return chunks.filter((chunk) => line >= chunk.startLine && line <= chunk.endLine);
}

function innermost(chunks: WalkContext["chunks"]): WalkContext["chunks"][number] | undefined {
  let best: WalkContext["chunks"][number] | undefined;
  let span = Number.POSITIVE_INFINITY;
  for (const chunk of chunks) {
    const next = chunk.endLine - chunk.startLine;
    if (next < span) {
      best = chunk;
      span = next;
    }
  }
  return best;
}

function putField(fields: Map<string, Map<string, string>>, owner: string, name: string, type: string): void {
  const members = fields.get(owner) ?? new Map<string, string>();
  members.set(name, type);
  fields.set(owner, members);
}
