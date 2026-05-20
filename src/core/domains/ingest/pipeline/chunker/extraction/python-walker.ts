/**
 * Python extraction walker.
 *
 * Mirrors the typescript-walker shape — emit a `FileExtraction` whose
 * `imports[]` carries every module reference and `chunks[].calls`
 * carries each call site found within a chunk's line range. Symbol
 * extraction is left to the codegraph provider (collectSymbols walks
 * the same tree).
 *
 * Python imports look like:
 *   import foo            → "foo"
 *   import foo.bar        → "foo.bar"
 *   import foo as baz     → "foo"  (alias ignored; resolution uses module path)
 *   from foo import bar   → "foo"
 *   from foo.bar import baz, qux  → "foo.bar"
 *   from . import foo     → ".foo"          (relative; leading dots preserved)
 *   from .foo import bar  → ".foo"
 *   from ..foo.bar import baz  → "..foo.bar"
 *
 * Resolution mapping (PythonImportResolver) translates these strings
 * to file paths via Python's module-path conventions.
 */

import type Parser from "tree-sitter";

import type { CallRef, ChunkExtraction, FileExtraction, ImportRef } from "../../../../../contracts/types/codegraph.js";

export interface PythonExtractInput {
  tree: Parser.Tree;
  code: string;
  relPath: string;
  language: string;
  /** Caller-provided chunk-range index, sorted by startLine ascending. */
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromPythonFile(input: PythonExtractInput): FileExtraction {
  const imports = collectPythonImports(input.tree.rootNode);
  const calls = collectPythonCalls(input.tree.rootNode);
  const byChunk: ChunkExtraction[] = input.chunks.map((c) => ({
    symbolId: c.symbolId,
    scope: c.scope,
    startLine: c.startLine,
    endLine: c.endLine,
    calls: calls.filter((cr) => cr.startLine >= c.startLine && cr.startLine <= c.endLine),
  }));
  return {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks: byChunk,
    fileScope: [],
  };
}

function collectPythonImports(root: Parser.SyntaxNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type === "import_statement") {
      // `import a`, `import a.b`, `import a as x`, `import a, b`
      // Tree-sitter-python wraps each dotted_name (or aliased_import)
      // in `name` field of `dotted_as_name` etc. Walk children for
      // `dotted_name` / `aliased_import` nodes.
      for (const child of node.namedChildren) {
        const moduleText = pickModuleText(child);
        if (moduleText) {
          out.push({ importText: moduleText, startLine: node.startPosition.row + 1 });
        }
      }
    } else if (node.type === "import_from_statement") {
      // `from M import x` — the module is in `module_name` field.
      // Relative imports: `from .` / `from ..` — leading dots are
      // emitted as `import_prefix` nodes; preserve them so the
      // resolver can resolve relative paths.
      const startLine = node.startPosition.row + 1;
      const moduleField = node.childForFieldName("module_name");
      let prefix = "";
      for (const child of node.children) {
        if (child.type === "import_prefix") prefix = child.text;
      }
      if (moduleField) {
        out.push({ importText: prefix + (pickModuleText(moduleField) ?? ""), startLine });
      } else if (prefix) {
        // `from . import x` — no module name, just the prefix.
        out.push({ importText: prefix, startLine });
      }
    }
  });
  return out;
}

function pickModuleText(node: Parser.SyntaxNode): string | null {
  switch (node.type) {
    case "dotted_name":
      return node.text;
    case "identifier":
      return node.text;
    case "aliased_import": {
      const inner = node.childForFieldName("name");
      return inner ? pickModuleText(inner) : null;
    }
    case "relative_import": {
      // Old grammar shape — keep tolerant.
      const inner = node.childForFieldName("module_name");
      return inner ? pickModuleText(inner) : node.text;
    }
    default:
      return null;
  }
}

function collectPythonCalls(root: Parser.SyntaxNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
    if (node.type !== "call") return;
    const fn = node.childForFieldName("function");
    if (!fn) return;
    const startLine = node.startPosition.row + 1;
    if (fn.type === "attribute") {
      // `obj.method(...)` — receiver = object's leftmost identifier,
      // member = property text. For chained accesses like `a.b.c()`,
      // the receiver is `a.b` (full attribute text minus the final
      // property), which mirrors the TS walker's behaviour for
      // member_expression chains.
      const obj = fn.childForFieldName("object");
      const attr = fn.childForFieldName("attribute");
      if (!obj || !attr) return;
      out.push({ callText: node.text, receiver: obj.text, member: attr.text, startLine });
    } else {
      // Bare call like `foo(...)`.
      out.push({ callText: node.text, receiver: null, member: fn.text, startLine });
    }
  });
  return out;
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
