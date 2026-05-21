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

/**
 * Env-gate for the Python local variable type inference path. When `false`,
 * walker emits `localBindings: undefined` and the resolver falls back to
 * legacy import + short-name resolution. Default `true`.
 *
 * Read once at walker-call time (per file) so flipping the env between
 * runs takes effect on the next reindex without restarting.
 */
function localTypeTrackingEnabled(): boolean {
  const raw = process.env.CODEGRAPH_PY_LOCAL_TYPE_TRACKING;
  if (raw === undefined) return true;
  return raw !== "false" && raw !== "0";
}

export function extractFromPythonFile(input: PythonExtractInput): FileExtraction {
  const imports = collectPythonImports(input.tree.rootNode);
  const calls = collectPythonCalls(input.tree.rootNode);
  const trackTypes = localTypeTrackingEnabled();
  const byChunk: ChunkExtraction[] = input.chunks.map((c) => {
    const base: ChunkExtraction = {
      symbolId: c.symbolId,
      scope: c.scope,
      startLine: c.startLine,
      endLine: c.endLine,
      calls: calls.filter((cr) => cr.startLine >= c.startLine && cr.startLine <= c.endLine),
    };
    if (trackTypes) {
      const bindings = collectLocalBindingsForChunk(input.tree.rootNode, c.startLine, c.endLine);
      if (Object.keys(bindings).length > 0) base.localBindings = bindings;
    }
    return base;
  });
  return {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks: byChunk,
    fileScope: [],
  };
}

/**
 * Collect `varName → typeName` bindings inside the given line range.
 * Sources scanned (in walker-emission order — later writes win when a
 * variable is rebound):
 *
 *   1. PEP 526 variable annotations  (`var: TypeName [= rhs]`)
 *   2. Function-parameter type hints (`def f(self, req: Req)`)
 *   3. Constructor-call assignments  (`var = TypeName(...)`)
 *   4. Qualified-constructor calls   (`var = mod.TypeName(...)`)
 *
 * Sources that are deliberately NOT inferred:
 *   - factory functions without return-type annotations (`var = make()`)
 *   - chained calls (`var = chain().method()`)
 *   - tuple / star unpacking (`a, b = ...`)
 *
 * Returns a plain object (Record) so it round-trips through the NDJSON
 * spill — `Map` would serialize to `{}` and lose every entry.
 */
function collectLocalBindingsForChunk(
  root: Parser.SyntaxNode,
  startLine: number,
  endLine: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  walk(root, (node) => {
    const line = node.startPosition.row + 1;
    if (line < startLine || line > endLine) return;

    // PEP 526 + constructor assignment.
    //
    // Tree-sitter-python shape: `assignment` has named children with
    // optional `left` (positional / unnamed), `type` (field), `right`
    // (field). When `left` (LHS) is a single `identifier` and either:
    //   - `type` field is present     → explicit annotation
    //   - `right` is a constructor call → infer from callee identifier
    if (node.type === "assignment") {
      const lhs = node.namedChild(0);
      if (lhs?.type !== "identifier") return;
      const varName = lhs.text;

      // PEP 526 — `var: ClassName = ...` or `var: ClassName`
      const typeField = node.childForFieldName("type");
      if (typeField) {
        const typeName = extractTypeName(typeField);
        if (typeName) out[varName] = typeName;
        // Annotation wins — do not also infer from RHS.
        return;
      }

      // Constructor call inference — `var = ClassName(...)` /
      // `var = module.ClassName(...)`. RHS must be a call whose
      // `function` is an `identifier` (direct) or `attribute`
      // (qualified). Anything else (function literal, lambda,
      // factory, list comprehension, etc.) is left unbound.
      const right = node.childForFieldName("right");
      if (right?.type === "call") {
        const fnNode = right.childForFieldName("function");
        if (!fnNode) return;
        const typeName = extractConstructorTypeName(fnNode);
        if (typeName) out[varName] = typeName;
      }
      return;
    }

    // Function arg type hints — only declarations enclosing this chunk
    // contribute. Tree-sitter emits `typed_parameter` for `name: Type`
    // and `typed_default_parameter` for `name: Type = default`. The
    // outer `parameters` node is wrapped under a `function_definition`;
    // we accept ANY enclosing function whose body covers the chunk —
    // the simplest correct rule is "param declared at a line at or
    // before chunk start, and its enclosing function body still
    // covers the chunk." That's exactly what the line-range filter
    // above already gives us for the `parameters` node, since the
    // grammar puts parameters on the `def` line.
    if (node.type === "typed_parameter" || node.type === "typed_default_parameter") {
      const nameNode = node.namedChild(0);
      if (!nameNode) return;
      // `typed_default_parameter` wraps the identifier in `name` field
      // in newer grammars; fall back to first named child for
      // tolerance against grammar drift.
      const varName = node.childForFieldName("name")?.text ?? (nameNode.type === "identifier" ? nameNode.text : null);
      if (!varName) return;
      const typeField = node.childForFieldName("type");
      if (!typeField) return;
      const typeName = extractTypeName(typeField);
      if (typeName) out[varName] = typeName;
    }
  });
  return out;
}

/**
 * Extract a type name from a `type` field node. Currently handles the
 * direct `identifier` shape (`HttpRequest`, `ConfirmCode`). Subscript /
 * generic (`Optional[X]`, `list[T]`) is intentionally NOT supported —
 * we'd need to choose which inner type to surface and the answer is
 * language-specific. Returns the qualified form preserving dots when
 * the annotation is an attribute (`module.ClassName`).
 */
function extractTypeName(typeField: Parser.SyntaxNode): string | null {
  // The `type` field is a wrapper whose only named child is the actual
  // type expression. Unwrap one level when present.
  const inner = typeField.namedChild(0) ?? typeField;
  if (inner.type === "identifier") return inner.text;
  if (inner.type === "attribute") return inner.text;
  return null;
}

/**
 * Pick a constructor type name from the `function` field of a `call`
 * node. Two shapes are supported:
 *   - `identifier`             → `ToggleReactionSerializer`
 *   - `attribute` (a.b / a.b.c) → preserved verbatim
 *
 * Anything else (call result, subscript, lambda) returns `null` and
 * the binding is dropped — there's no class name to attribute to.
 */
function extractConstructorTypeName(fnNode: Parser.SyntaxNode): string | null {
  if (fnNode.type === "identifier") return fnNode.text;
  if (fnNode.type === "attribute") return fnNode.text;
  return null;
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
