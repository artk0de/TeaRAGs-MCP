/**
 * JavaScript extraction walker.
 *
 * tree-sitter-javascript shares its core node types with
 * tree-sitter-typescript for the constructs codegraph cares about
 * (import_statement, call_expression, function_declaration,
 * method_definition, class_declaration). The walker is therefore a
 * thin re-export of `extractFromTypescriptFile` — kept as its own
 * file so the LANGUAGES dispatch table reads cleanly and so future
 * JS-specific quirks (CommonJS require, dynamic imports) have a
 * dedicated home to land without polluting the TS walker.
 *
 * CommonJS support: `require('./foo')` parses as a `call_expression`
 * with function = identifier "require" and a string argument. We
 * extend the import collection here to capture those alongside ES
 * module `import` statements. ES module `import()` (dynamic import)
 * appears as `call_expression` with function = `import` keyword —
 * also handled below.
 */

import type Parser from "tree-sitter";

import type { CallRef, ChunkExtraction, FileExtraction, ImportRef } from "../../../../../contracts/types/codegraph.js";

export interface JsExtractInput {
  tree: Parser.Tree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromJavascriptFile(input: JsExtractInput): FileExtraction {
  const imports = collectJsImports(input.tree.rootNode);
  const calls = collectJsCalls(input.tree.rootNode);
  const classExtends = collectJsClassExtends(input.tree.rootNode);
  // Innermost-chunk attribution: assign each call to ONE chunk only — the
  // smallest containing range, ties broken by deeper scope length. Without
  // this guard, a call inside `class C { m() { foo() } }` lands on BOTH the
  // class chunk and the method chunk and inflates caller-edge counts by the
  // nesting depth (bd tea-rags-mcp-otjs — mirrors ruby tea-rags-mcp-8fnu).
  const callOwnership = assignCallsToInnermostChunks(calls, input.chunks);
  const byChunk: ChunkExtraction[] = input.chunks.map((c, chunkIndex) => ({
    symbolId: c.symbolId,
    scope: c.scope,
    startLine: c.startLine,
    endLine: c.endLine,
    calls: callOwnership.get(chunkIndex) ?? [],
  }));
  const out: FileExtraction = {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks: byChunk,
    fileScope: [],
  };
  if (classExtends.size > 0) {
    // Convert Map → Record so the field round-trips through the NDJSON
    // spill in the codegraph provider. Mirrors typescript-walker's
    // discipline (bd tea-rags-mcp-d29r).
    const classExtendsRecord: Record<string, string> = {};
    for (const [cls, parent] of classExtends) classExtendsRecord[cls] = parent;
    out.classExtends = classExtendsRecord;
  }
  return out;
}

/**
 * Assign each call to exactly ONE chunk — the smallest containing line
 * range. Tie-breaker: deeper scope (longer `scope[]`) wins, so a method-
 * level chunk beats its enclosing class when both happen to span the same
 * number of lines.
 *
 * Returns a Map keyed by chunk index → CallRef[]. Chunks with no calls
 * have no entry (caller defaults to `[]`).
 *
 * Calls whose startLine falls outside every chunk are dropped silently —
 * matches the previous behaviour for unreachable call sites.
 */
function assignCallsToInnermostChunks(
  calls: CallRef[],
  chunks: { startLine: number; endLine: number; scope: string[] }[],
): Map<number, CallRef[]> {
  const out = new Map<number, CallRef[]>();
  for (const call of calls) {
    let bestIdx = -1;
    let bestSpan = Number.POSITIVE_INFINITY;
    let bestDepth = -1;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (call.startLine < c.startLine || call.startLine > c.endLine) continue;
      const span = c.endLine - c.startLine;
      const depth = c.scope.length;
      if (span < bestSpan || (span === bestSpan && depth > bestDepth)) {
        bestIdx = i;
        bestSpan = span;
        bestDepth = depth;
      }
    }
    if (bestIdx === -1) continue;
    const bucket = out.get(bestIdx);
    if (bucket) bucket.push(call);
    else out.set(bestIdx, [call]);
  }
  return out;
}

function collectJsImports(root: Parser.SyntaxNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type === "import_statement") {
      const src = node.children.find((c) => c.type === "string");
      if (!src) return;
      const text = src.text.replace(/^["']|["']$/g, "");
      out.push({ importText: text, startLine: node.startPosition.row + 1 });
      return;
    }
    // CommonJS `require('./foo')` + dynamic `import('./foo')`. Both are
    // call_expression nodes with a string argument. The function child
    // distinguishes them — `require` (identifier) or `import` (keyword).
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (!fn) return;
      const fnName = fn.type === "identifier" || fn.type === "import" ? fn.text : null;
      if (fnName !== "require" && fnName !== "import") return;
      const args = node.childForFieldName("arguments");
      if (!args) return;
      const stringArg = args.namedChildren.find((c) => c.type === "string");
      if (!stringArg) return;
      const text = stringArg.text.replace(/^["']|["']$/g, "");
      out.push({ importText: text, startLine: node.startPosition.row + 1 });
    }
  });
  return out;
}

function collectJsCalls(root: Parser.SyntaxNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
    // `new ClassName(args)` (bd tea-rags-mcp-i252). Same shape as the TS
    // walker — `new_expression` with `constructor` field. JS parser
    // shares this node type with tree-sitter-typescript.
    if (node.type === "new_expression") {
      const ctorNode = node.childForFieldName("constructor");
      if (!ctorNode) return;
      out.push({
        callText: node.text,
        receiver: ctorNode.text,
        member: "constructor",
        startLine: node.startPosition.row + 1,
      });
      return;
    }
    if (node.type !== "call_expression") return;
    const callee = node.childForFieldName("function");
    if (!callee) return;
    const startLine = node.startPosition.row + 1;
    if (callee.type === "member_expression") {
      const obj = callee.childForFieldName("object");
      const prop = callee.childForFieldName("property");
      if (!obj || !prop) return;
      out.push({ callText: node.text, receiver: obj.text, member: prop.text, startLine });
    } else if (callee.type === "super") {
      // Bare `super(arg)` in a constructor (bd tea-rags-mcp-3a84). The
      // tree-sitter grammar emits `super` as the callee node type (no
      // member access). Without this branch, the walker emitted
      // `{ receiver: null, member: "super" }` which the resolver then
      // tried to look up by short-name (always fails). Re-shape to the
      // super-method form so js-resolver's `super` branch routes the
      // call to the PARENT class's constructor via classExtends.
      // Mirrors typescript-walker's identical branch.
      out.push({ callText: node.text, receiver: "super", member: "constructor", startLine });
    } else if (callee.type === "identifier") {
      // Skip require/import — these are tracked as imports, not calls.
      if (callee.text === "require" || callee.text === "import") return;
      out.push({ callText: node.text, receiver: null, member: callee.text, startLine });
    }
  });
  return out;
}

/**
 * Collect `class Child extends Parent` relationships: `className → parent`.
 * JS mirror of typescript-walker's `collectClassExtends`. The
 * tree-sitter-javascript grammar shares the class_declaration /
 * class_heritage / extends_clause shape with tree-sitter-typescript, but
 * lacks the abstract_class_declaration node type and `implements`
 * clauses (JS has no static types).
 *
 * Tree-sitter-javascript shape for `class B extends A {}`:
 *
 *   class_declaration
 *     identifier "B"
 *     class_heritage
 *       "extends"
 *       identifier "A"            // OR member_expression "A.B.C"
 *     class_body
 *
 * Note: unlike TS, JS class_heritage does NOT wrap the parent in an
 * `extends_clause` sub-node — the `extends` keyword and the parent
 * reference are direct children of class_heritage. The walker reads the
 * first identifier / member_expression child as the parent reference.
 *
 * Bug `tea-rags-mcp-d29r` (JS port): without this map, the JS resolver's
 * super branch has no way to find the parent class and self-loops to
 * the enclosing class's own method.
 */
function collectJsClassExtends(root: Parser.SyntaxNode): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  walk(root, (node) => {
    if (node.type !== "class_declaration") return;
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const className = nameNode.text;
    const heritage = node.children.find((c) => c.type === "class_heritage");
    if (!heritage) return;
    // First identifier / member_expression child of class_heritage is the
    // parent class reference (the `extends` keyword sits at index 0).
    // Qualified parents like `extends A.B.C` arrive as a member_expression
    // whose `.text` is the full chain — keep intact for resolver lookup.
    const parentNode = heritage.children.find((c) => c.type === "identifier" || c.type === "member_expression");
    if (!parentNode) return;
    const parentText = parentNode.text;
    if (parentText.length > 0) result.set(className, parentText);
  });
  return result;
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
