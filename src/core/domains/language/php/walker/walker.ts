/**
 * PHP walker: functions, classes, methods and calls, plus `use` imports.
 *
 * A call is one of three node types:
 *   - `function_call_expression` whose `function` field is a bare `name`
 *     (`helper()`, `trim()`) or a `qualified_name` (`Foo\bar()`). The
 *     qualified text stays the member, so it is not a short-name bare call.
 *   - `member_call_expression` / `nullsafe_member_call_expression` with an
 *     `object` and a `name` (`$this->format()`, `$this?->title()`).
 *   - `scoped_call_expression` with a `scope` and a `name` (`self::make()`).
 *
 * A typed parameter and `$repo = new Greeter()` become `localBindings` on the
 * innermost chunk. Primitive types bind nothing.
 *
 * Imports are `namespace_use_declaration`. A plain `use Foo\Bar;` stores
 * `Foo\Bar`. A group `use Foo\{Bar, Baz as Alias};` stores `Foo\Bar` and
 * `Foo\Baz` — the alias is a local rename, not the imported path. A
 * `use function` clause stores the same path; the `function` keyword is not
 * part of the text.
 */

import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { AstNode, MaterializedTree } from "../../../../contracts/types/ast.js";
import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";
import type {
  CallRef,
  ChunkExtraction,
  FileExtraction,
  ImportRef,
  LocalBinding,
} from "../../../../contracts/types/codegraph.js";
import { assignCallsToInnermostChunks, symbolIdNames } from "../../kernel/index.js";
import { phpNameOf } from "./name-of.js";
import { symbolKindOf } from "./symbol-kind.js";

export interface PhpExtractInput {
  tree: MaterializedTree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromPhpFile(input: PhpExtractInput): FileExtraction {
  const imports = collectImports(input.tree.rootNode);
  const calls = collectCalls(input.tree.rootNode);
  const callOwnership = assignCallsToInnermostChunks(calls, input.chunks);
  const bindingOwnership = assignBindingsToInnermostChunks(collectLocalBindings(input.tree.rootNode), input.chunks);
  const symbolKinds = collectSymbolKinds(input.tree.rootNode);
  const chunks: ChunkExtraction[] = input.chunks.map((chunk, chunkIndex) => {
    const out: ChunkExtraction = {
      symbolId: chunk.symbolId,
      scope: chunk.scope,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      calls: callOwnership.get(chunkIndex) ?? [],
    };
    const bindings = bindingOwnership.get(chunkIndex);
    if (bindings && Object.keys(bindings).length > 0) out.localBindings = bindings;
    const symbolKind = symbolKinds
      .get(chunk.startLine)
      ?.find((reading) => symbolIdNames(chunk.symbolId, reading.name))?.kind;
    if (symbolKind !== undefined) out.symbolKind = symbolKind;
    return out;
  });
  return { relPath: input.relPath, language: input.language, imports, chunks, fileScope: [] };
}

interface SymbolKindReading {
  readonly name: string;
  readonly kind: SymbolDefinitionKind;
}

function collectSymbolKinds(root: AstNode): Map<number, SymbolKindReading[]> {
  const map = new Map<number, SymbolKindReading[]>();
  const visit = (node: AstNode): void => {
    const named = phpNameOf(node);
    const kind = symbolKindOf(node.type);
    if (named && kind) {
      const line = node.startPosition.row + 1;
      const list = map.get(line) ?? [];
      list.push({ name: named.name, kind });
      map.set(line, list);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return map;
}

function collectImports(root: AstNode): ImportRef[] {
  const imports: ImportRef[] = [];
  const visit = (node: AstNode): void => {
    if (node.type === "namespace_use_declaration") {
      const prefix = node.namedChildren.find((child) => child.type === "namespace_name");
      for (const clause of useClauses(node)) {
        const imported = importedName(clause);
        if (!imported) continue;
        imports.push({
          importText: prefix ? `${prefix.text}\\${imported}` : imported,
          startLine: clause.startPosition.row + 1,
        });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return imports;
}

/** A plain `use` lists clauses directly. A group `use Foo\{Bar}` puts them on `body`. */
function useClauses(declaration: AstNode): AstNode[] {
  const clauses: AstNode[] = [];
  const seen = new Set<AstNode>();
  const consider = (node: AstNode): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if (node.type === "namespace_use_clause") clauses.push(node);
    if (node.type === "namespace_use_group") {
      for (const child of node.namedChildren) consider(child);
    }
  };
  for (const child of declaration.namedChildren) consider(child);
  const body = declaration.childForFieldName("body");
  if (body) consider(body);
  return clauses;
}

/**
 * The imported path, not the local alias. `Qux as Alias` has two `name`
 * children; the `alias` field is the second one.
 */
function importedName(clause: AstNode): string | undefined {
  const alias = clause.childForFieldName("alias");
  const name = clause.namedChildren.find(
    (child) => (child.type === "qualified_name" || child.type === "name") && child !== alias,
  );
  return name?.text;
}

function collectCalls(root: AstNode): CallRef[] {
  const calls: CallRef[] = [];
  const visit = (node: AstNode): void => {
    const call = phpCallSite(node);
    if (call) calls.push(call);
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return calls;
}

function phpCallSite(node: AstNode): CallRef | null {
  if (node.type === "function_call_expression") {
    const fn = node.childForFieldName("function");
    if (fn?.type === "name" || fn?.type === "qualified_name" || fn?.type === "relative_name") {
      return { callText: node.text, receiver: null, member: fn.text, startLine: node.startPosition.row + 1 };
    }
  }
  if (node.type === "member_call_expression" || node.type === "nullsafe_member_call_expression") {
    const name = node.childForFieldName("name");
    const object = node.childForFieldName("object");
    if (name?.type !== "name" || !object) return null;
    return { callText: node.text, receiver: object.text, member: name.text, startLine: node.startPosition.row + 1 };
  }
  if (node.type === "scoped_call_expression") {
    const name = node.childForFieldName("name");
    const scope = node.childForFieldName("scope");
    if (name?.type !== "name" || !scope) return null;
    return { callText: node.text, receiver: scope.text, member: name.text, startLine: node.startPosition.row + 1 };
  }
  return null;
}

const PHP_NON_CONCEPT_TYPES = new Set([
  "string",
  "int",
  "float",
  "bool",
  "array",
  "object",
  "mixed",
  "void",
  "null",
  "false",
  "true",
  "iterable",
  "never",
  "callable",
  "self",
  "static",
  "parent",
]);

interface PhpLocalBinding {
  name: string;
  type: string;
  startLine: number;
}

function collectLocalBindings(root: AstNode): PhpLocalBinding[] {
  const out: PhpLocalBinding[] = [];
  const visit = (node: AstNode): void => {
    if (node.type === "simple_parameter") {
      const typeName = nominalTypeName(node.childForFieldName("type"));
      const name = node.childForFieldName("name");
      if (typeName && name) out.push({ name: name.text, type: typeName, startLine: node.startPosition.row + 1 });
    } else if (node.type === "assignment_expression") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      const typeName = left?.type === "variable_name" && right && insideCallable(node) ? constructedType(right) : null;
      if (left && typeName) out.push({ name: left.text, type: typeName, startLine: left.startPosition.row + 1 });
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return out;
}

function nominalTypeName(node: AstNode | null): string | null {
  if (!node) return null;
  const inner = node.type === "optional_type" ? (node.namedChildren[0] ?? null) : node;
  if (!inner || inner.type === "primitive_type") return null;
  const named = inner.type === "named_type" ? (inner.namedChildren[0] ?? null) : inner;
  if (!named || (named.type !== "name" && named.type !== "qualified_name")) return null;
  const short = named.text.split("\\").pop() ?? named.text;
  if (short === "" || PHP_NON_CONCEPT_TYPES.has(short)) return null;
  return named.text;
}

function constructedType(node: AstNode): string | null {
  if (node.type !== "object_creation_expression") return null;
  const name = node.namedChildren.find((child) => child.type === "name" || child.type === "qualified_name");
  return name ? nominalTypeName(name) : null;
}

function insideCallable(node: AstNode): boolean {
  let cursor: AstNode | null = node.parent;
  while (cursor) {
    if (cursor.type === "method_declaration" || cursor.type === "function_definition") return true;
    if (
      cursor.type === "class_declaration" ||
      cursor.type === "interface_declaration" ||
      cursor.type === "trait_declaration"
    ) {
      return false;
    }
    cursor = cursor.parent;
  }
  return false;
}

function assignBindingsToInnermostChunks(
  bindings: PhpLocalBinding[],
  chunks: { startLine: number; endLine: number; scope: string[] }[],
): Map<number, Record<string, LocalBinding[]>> {
  const out = new Map<number, Record<string, LocalBinding[]>>();
  for (const binding of bindings) {
    let bestIdx = -1;
    let bestSpan = Number.POSITIVE_INFINITY;
    let bestDepth = -1;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk || binding.startLine < chunk.startLine || binding.startLine > chunk.endLine) continue;
      const span = chunk.endLine - chunk.startLine;
      const depth = chunk.scope.length;
      if (span < bestSpan || (span === bestSpan && depth > bestDepth)) {
        bestIdx = i;
        bestSpan = span;
        bestDepth = depth;
      }
    }
    if (bestIdx === -1) continue;
    let bucket = out.get(bestIdx);
    if (!bucket) {
      bucket = createIdentifierRecord();
      out.set(bestIdx, bucket);
    }
    (bucket[binding.name] ??= []).push({ line: binding.startLine, type: binding.type });
  }
  return out;
}
