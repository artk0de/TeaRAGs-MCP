/**
 * Python extraction walker. Relocated from
 * `domains/ingest/pipeline/chunker/extraction/python-walker.ts` into the native
 * Python language provider per the `domains/language` consolidation (spec §3; bd
 * tea-rags-mcp-cen6, following the ruby + typescript + javascript verticals).
 * Behaviour-preserving: the node-shape detection and `FileExtraction` emission
 * are identical to the former chunker-local walker.
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

import type {
  CallRef,
  ChunkExtraction,
  FileExtraction,
  ImportRef,
  InheritanceEdgeDecl,
  LocalBinding,
} from "../../../../contracts/types/codegraph.js";

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
  // bd tea-rags-mcp-zvsw — Decorator applications are calls. Append the
  // synthetic call edges so `get_callers(decoratorName)` returns every
  // decorated method/function.
  const decoratorCalls = collectPythonDecoratorCalls(input.tree.rootNode);
  for (const dc of decoratorCalls) calls.push(dc);
  // bd tea-rags-mcp-pic4 — Python class single-base map for super()
  // resolution. Single inheritance only (first listed base).
  const classExtends = collectPythonClassExtends(input.tree.rootNode);
  // bd tea-rags-mcp-rjuc — instance-field types declared in `__init__`
  // (`self.service = SomeService()`) recorded as CLASS-LEVEL state so the
  // resolver can pin `self.service.process()` cross-method. Mirrors the
  // TS/Java `classFieldTypes` channel.
  const classFieldTypes = collectPythonClassFieldTypes(input.tree.rootNode);
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
  const out: FileExtraction = {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks: byChunk,
    fileScope: [],
  };
  if (Object.keys(classExtends).length > 0) out.classExtends = classExtends;
  if (Object.keys(classFieldTypes).length > 0) out.classFieldTypes = classFieldTypes;
  // Unified hierarchy edges (CHA cone-unification Slice 2). Parity with the
  // Ruby/TS walkers' inheritanceEdges: where the legacy `classExtends` Record
  // keeps only the FIRST base for `super()` resolution, this emits EVERY base
  // (Python multiple inheritance) for the descendant-set the CHA cone needs.
  // All bases are kind `super` — Python's C3 MRO has no include/extend/prepend
  // distinction and the cone only needs the descendant set, not MRO order. The
  // legacy `classExtends` stays (resolver-forward path).
  const inheritanceEdges = collectPythonInheritanceEdges(input.tree.rootNode);
  if (inheritanceEdges.length > 0) out.inheritanceEdges = inheritanceEdges;
  return out;
}

/**
 * Collect class-hierarchy edges (CHA cone-unification Slice 2). For
 * `class C(A, M):` emit one `InheritanceEdgeDecl` per base —
 * `{ source: "C", ancestor: "A", kind: "super", ordinal: 0 }`,
 * `{ ancestor: "M", ordinal: 1 }`, … — preserving declaration order via
 * `ordinal`. Every base is `kind: "super"`: Python has no
 * include/extend/prepend channels (its C3 MRO is linearized at runtime), and
 * the hierarchy graph only needs the descendant set.
 *
 * `source` is qualified by enclosing class scope with the `.` separator
 * (`Outer.Inner`), matching Python's `scopeSeparator` and the codegraph
 * provider's symbol composition. `ancestor` is captured verbatim — a bare
 * identifier (`Animal`), a qualified / module base (`db.Model`,
 * `Outer.Mixin`), or a builtin (`object`). External / builtin bases are
 * emitted the same way the Ruby walker emits unresolved ancestors: as a raw
 * name; resolution drops the ones that don't pin to a file.
 *
 * Returns an empty array when no class declares any base.
 */
function collectPythonInheritanceEdges(root: Parser.SyntaxNode): InheritanceEdgeDecl[] {
  const edges: InheritanceEdgeDecl[] = [];
  const walkScope = (node: Parser.SyntaxNode, scope: string[]): void => {
    if (node.type === "class_definition") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) {
        for (const child of node.children) walkScope(child, scope);
        return;
      }
      const localName = nameNode.text;
      const fq = scope.length === 0 ? localName : `${scope.join(".")}.${localName}`;
      // Tree-sitter-python wraps the base-list in a `superclasses`
      // argument_list child. Emit EVERY base (multiple inheritance) in
      // declaration order; keyword args (`metaclass=...`) are `keyword_argument`
      // nodes, not bases, so the identifier/attribute/dotted_name filter skips
      // them.
      const supers = node.childForFieldName("superclasses");
      if (supers) {
        let ordinal = 0;
        for (const base of supers.namedChildren) {
          if (base.type !== "identifier" && base.type !== "attribute" && base.type !== "dotted_name") continue;
          const ancestor = base.text;
          if (ancestor.length === 0) continue;
          edges.push({ source: fq, ancestor, kind: "super", ordinal: ordinal++ });
        }
      }
      // Recurse — nested classes get their own source qualifier extended by
      // this class's name (`Outer` → `Outer.Inner`).
      const body = node.childForFieldName("body");
      const recurseChildren = body ? body.children : node.children;
      for (const child of recurseChildren) walkScope(child, [...scope, localName]);
      return;
    }
    for (const child of node.children) walkScope(child, scope);
  };
  walkScope(root, []);
  return edges;
}

/**
 * Collect per-class instance-field types from `self.<field> = <ctor>`
 * assignments, keyed `className → fieldName → typeName`. Mirrors the
 * TS/Java `classFieldTypes` channel — but Python binds fields via `self`
 * inside methods rather than via class-body field declarations.
 *
 * Fields are attributed to the ENCLOSING class: we walk each
 * `class_definition`, then scan its body's descendant `assignment` nodes
 * for `self.<field> = ...`. `__init__` is the canonical site but ANY
 * method that binds `self.<field>` contributes (tolerated, per bd rjuc).
 *
 * RHS forms recorded (constructor-only — same gate as `localBindings`):
 *   - `self.x = ClassName()`        → `{ x: "ClassName" }`
 *   - `self.x: ClassName = ...`     → `{ x: "ClassName" }`  (PEP 526)
 *   - `self.x = mod.ClassName()`    → `{ x: "mod.ClassName" }`
 *
 * Deliberately NOT recorded (no class name to attribute, no FP guess):
 *   - `self.x = []` / literals      (RHS not a call)
 *   - `service = ClassName()`       (LHS not `self.<field>`)
 *
 * Non-constructor calls like `self.x = make_thing()` ARE recorded as a
 * candidate type name — the resolver's `resolveByLocalType` applies the
 * final safety gate (the bound name must resolve to a class symbol in the
 * table) and drops the edge otherwise, so no false edge is fabricated.
 * Function-return-type inference is explicitly out of scope here.
 *
 * Returns a plain object (Record) for NDJSON round-trip — Map would
 * serialise to `{}`.
 */
function collectPythonClassFieldTypes(root: Parser.SyntaxNode): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  walk(root, (node) => {
    if (node.type !== "class_definition") return;
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const className = nameNode.text;
    const body = node.childForFieldName("body");
    if (!body) return;
    const fields: Record<string, string> = {};
    walk(body, (inner) => {
      if (inner.type !== "assignment") return;
      // LHS must be `self.<field>` — an `attribute` whose object is the
      // `self` identifier. Anything else (plain local, subscript) skips.
      const lhs = inner.childForFieldName("left");
      if (lhs?.type !== "attribute") return;
      const obj = lhs.childForFieldName("object");
      const attr = lhs.childForFieldName("attribute");
      if (obj?.type !== "identifier" || obj.text !== "self") return;
      if (!attr) return;
      const fieldName = attr.text;

      // PEP 526 annotation wins — `self.x: ClassName = ...`.
      const typeField = inner.childForFieldName("type");
      if (typeField) {
        const typeName = extractTypeName(typeField);
        if (typeName) fields[fieldName] = typeName;
        return;
      }

      // Constructor-call RHS — `self.x = ClassName(...)` /
      // `self.x = module.ClassName(...)`. Non-call RHS (literal, list,
      // lambda) is skipped — no class name to attribute.
      //
      // bd tea-rags-mcp-m46z — CapWords gate. The resolver emits a
      // best-effort EXTERNAL target `<type>#<member>` for `self.x.method()`
      // when `<type>` isn't in the symbol table (correct for real classes
      // like `ExitStack`). But a lowercase callee (`make_thing`, `some_func`)
      // is a FUNCTION, not a constructor — its return type is unknown, and
      // recording it would fabricate a phantom edge `make_thing#method`. PEP8
      // says classes are CapWords; only treat the RHS as a field type when the
      // callee's FINAL identifier starts uppercase. Lowercase → record nothing
      // so `self.x.method()` falls through to DROP. (Local-var tracking keeps
      // the generous lowercase behavior — its resolver path DROPS rather than
      // emitting an external best-effort, so no phantom can arise there.)
      const right = inner.childForFieldName("right");
      if (right?.type === "call") {
        const fnNode = right.childForFieldName("function");
        if (!fnNode) return;
        const typeName = extractConstructorTypeName(fnNode);
        if (typeName && isCapWordsConstructor(typeName)) fields[fieldName] = typeName;
      }
    });
    if (Object.keys(fields).length > 0) {
      // Merge when a class spans multiple definitions / re-walks; later
      // writes win, mirroring localBindings' last-write-wins discipline.
      out[className] = { ...(out[className] ?? {}), ...fields };
    }
  });
  return out;
}

/**
 * Collect `class Child(Parent):` relationships keyed by class name.
 * Python supports multi-inheritance; we record only the FIRST base
 * class — sufficient for `super()` resolution in the common single-base
 * case, which covers the vast majority of real codebases. Multi-base
 * MRO (e.g. mixin chains) is left as a follow-up.
 *
 * Returns a plain object (Record) for NDJSON round-trip — Map would
 * serialise to `{}`.
 */
function collectPythonClassExtends(root: Parser.SyntaxNode): Record<string, string> {
  const out: Record<string, string> = {};
  walk(root, (node) => {
    if (node.type !== "class_definition") return;
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const className = nameNode.text;
    // Tree-sitter-python wraps the base-list in a `superclasses`
    // argument_list child. The first argument is the primary parent.
    const supers = node.childForFieldName("superclasses");
    if (!supers) return;
    const firstBase = supers.namedChildren.find(
      (c) => c.type === "identifier" || c.type === "attribute" || c.type === "dotted_name",
    );
    if (!firstBase) return;
    const parentText = firstBase.text;
    if (parentText.length > 0 && parentText !== "object") {
      out[className] = parentText;
    }
  });
  return out;
}

/**
 * Synthesize a CallRef for each decorator application. Tree-sitter-python
 * exposes `decorated_definition` with one or more `decorator` children
 * preceding the inner `function_definition` / `class_definition`. Each
 * decorator's expression is the callee. Common shapes:
 *
 *   - `@setupmethod`        → bare identifier   → receiver=null, member="setupmethod"
 *   - `@app.route('/')`     → call on attribute → receiver="app",  member="route"
 *   - `@functools.cache`    → attribute access  → receiver="functools", member="cache"
 *
 * The decorator node wraps a `call` node OR a single `identifier` /
 * `attribute`. For the call shape we extract the function position; for
 * the bare shape we treat the decorator text as the member name.
 */
function collectPythonDecoratorCalls(root: Parser.SyntaxNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
    if (node.type !== "decorator") return;
    // `decorator` has a single named child which is the callee expression.
    const expr = node.namedChildren[0];
    if (!expr) return;
    const startLine = node.startPosition.row + 1;
    if (expr.type === "call") {
      // `@app.route('/')` — the call expression's function position is
      // an attribute / identifier; reuse the same shape extraction the
      // regular call collector uses.
      const fn = expr.childForFieldName("function");
      if (!fn) return;
      if (fn.type === "attribute") {
        const obj = fn.childForFieldName("object");
        const attr = fn.childForFieldName("attribute");
        if (!obj || !attr) return;
        out.push({ callText: node.text, receiver: obj.text, member: attr.text, startLine });
      } else if (fn.type === "identifier") {
        out.push({ callText: node.text, receiver: null, member: fn.text, startLine });
      }
      return;
    }
    if (expr.type === "identifier") {
      out.push({ callText: node.text, receiver: null, member: expr.text, startLine });
      return;
    }
    if (expr.type === "attribute") {
      const obj = expr.childForFieldName("object");
      const attr = expr.childForFieldName("attribute");
      if (!obj || !attr) return;
      out.push({ callText: node.text, receiver: obj.text, member: attr.text, startLine });
    }
  });
  return out;
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
): Record<string, LocalBinding[]> {
  const out: Record<string, LocalBinding[]> = {};
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
        if (typeName) (out[varName] ??= []).push({ line, type: typeName });
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
        if (typeName) (out[varName] ??= []).push({ line, type: typeName });
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
      if (typeName) (out[varName] ??= []).push({ line, type: typeName });
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

/**
 * PEP8 CapWords heuristic — is this callee name a class constructor (vs a
 * plain function)? Classes are CapWords (`SomeService`, `ExitStack`,
 * `mod.ApiClient`); functions are lowercase (`make_thing`, `mod.some_func`).
 * Checks the FINAL identifier segment of a possibly-qualified name so
 * `mod.ApiClient` gates on `ApiClient` and `mod.make_thing` on `make_thing`.
 * Used by `collectPythonClassFieldTypes` to avoid recording a function's
 * unknown return type as a field type (which would let the resolver fabricate
 * a phantom external edge `make_thing#method`).
 */
function isCapWordsConstructor(typeName: string): boolean {
  const finalSegment = typeName.slice(typeName.lastIndexOf(".") + 1);
  return /^[A-Z]/.test(finalSegment);
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
