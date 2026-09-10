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

import type { AstNode, MaterializedTree } from "../../../../contracts/types/ast.js";
import type {
  CallRef,
  CallResultBinding,
  ChunkExtraction,
  FileExtraction,
  ImportRef,
  InheritanceEdgeDecl,
  LocalBinding,
  ModuleReexport,
} from "../../../../contracts/types/codegraph.js";
import { assignCallsToInnermostChunks } from "../../kernel/assign-calls-to-chunks.js";
import { collectPythonClassBodyFieldTypes } from "./passes/python-class-body-fields.js";

export interface PythonExtractInput {
  tree: MaterializedTree;
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
export function pythonLocalTypeTrackingEnabled(): boolean {
  const raw = process.env.CODEGRAPH_PY_LOCAL_TYPE_TRACKING;
  if (raw === undefined) return true;
  return raw !== "false" && raw !== "0";
}

export function extractFromPythonFile(input: PythonExtractInput): FileExtraction {
  const { imports, reexports } = collectPythonImports(input.tree.rootNode);
  const calls = collectPythonCalls(input.tree.rootNode);
  // bd tea-rags-mcp-zvsw — Decorator applications are calls. Append the
  // synthetic call edges so `get_callers(decoratorName)` returns every
  // decorated method/function.
  const decoratorCalls = collectPythonDecoratorCalls(input.tree.rootNode);
  for (const dc of decoratorCalls) calls.push(dc);
  // bd tea-rags-mcp-pic4 — Python class single-base map for super()
  // resolution. Single inheritance only (first listed base).
  const classExtends = collectPythonClassExtends(input.tree.rootNode);
  // bd tea-rags-mcp-y4hro — the MULTI-base, file-qualified hierarchy channel the
  // ancestor walk linearizes. `classExtends` stays exactly as it is beside it:
  // `python-self-field.ts` and `pythonTypeOwnsMembers` both read it.
  const classAncestors = collectPythonClassAncestors(input.tree.rootNode, input.relPath, imports);
  // bd tea-rags-mcp-rjuc — instance-field types declared in `__init__`
  // (`self.service = SomeService()`) recorded as CLASS-LEVEL state so the
  // resolver can pin `self.service.process()` cross-method. Mirrors the
  // TS/Java `classFieldTypes` channel.
  const classFieldTypes = collectPythonClassFieldTypes(input.tree.rootNode);
  // bd tea-rags-mcp-f0xaa — the SAME fields under the run-global class key, so a
  // subclass in another file can read what its base assigned. The short-name
  // channel above cannot answer that: it is per-file and its key is ambiguous
  // run-global.
  const classFieldTypesByClassKey = collectPythonClassFieldTypesByClassKey(input.tree.rootNode, input.relPath);
  // bd tea-rags-mcp-xpl83 — Django binds a model's manager in the CLASS BODY
  // (`objects = ObjectTypeManager()`), which no `self.<field>` collector can
  // see. The facts merge UNDERNEATH the two collectors above: a constructor
  // assignment for the same field is the narrower statement about an instance,
  // so reversing this spread order would silently retype every field a class
  // declares twice.
  const classBodyFields = collectPythonClassBodyFieldTypes(input.tree.rootNode, input.relPath, imports);
  for (const [key, fields] of Object.entries(classBodyFields.byShortName)) {
    classFieldTypes[key] = { ...fields, ...(classFieldTypes[key] ?? {}) };
  }
  for (const [key, fields] of Object.entries(classBodyFields.byClassKey)) {
    classFieldTypesByClassKey[key] = { ...fields, ...(classFieldTypesByClassKey[key] ?? {}) };
  }
  const trackTypes = pythonLocalTypeTrackingEnabled();
  // Innermost-chunk attribution: ONE owning chunk per call site — the smallest
  // containing range, ties broken by deeper scope (bd tea-rags-mcp-invuy;
  // mirrors typescript tea-rags-mcp-otjs and ruby tea-rags-mcp-8fnu). A class
  // chunk's range contains every method nested in it, so the pure-containment
  // filter this replaces emitted each call TWICE — once from the method chunk
  // under the method's scope, once from the class chunk under the class's (or,
  // for a top-level class, an EMPTY) scope. netbox measured 16,988 of 60,731
  // sites as such duplicates, and the class-chunk copies were 349 of the 351
  // residual cross-file `selfMember` misses: a nested class's copy keyed the
  // MRO on the OUTER class and DROPped, a top-level class's copy tripped
  // `selfMember`'s `callerScope.length === 0` guard and let `globalShortName`
  // fabricate 40 phantoms.
  const callOwnership = assignCallsToInnermostChunks(calls, input.chunks);
  // bd tea-rags-mcp-z68v9 — `NAME = <callee>(…)` sites, collected ONCE per file
  // and sliced per chunk below, because the scan needs whole-file scope nesting
  // to tell a function-body local from a module global.
  const callResultBindings = trackTypes
    ? collectPythonCallResultBindings(input.tree.rootNode)
    : ({} as Record<string, CallResultBinding[]>);
  const byChunk: ChunkExtraction[] = input.chunks.map((c, chunkIndex) => {
    const base: ChunkExtraction = {
      symbolId: c.symbolId,
      scope: c.scope,
      startLine: c.startLine,
      endLine: c.endLine,
      calls: callOwnership.get(chunkIndex) ?? [],
    };
    if (trackTypes) {
      const bindings = collectLocalBindingsForChunk(input.tree.rootNode, c.startLine, c.endLine);
      if (Object.keys(bindings).length > 0) base.localBindings = bindings;
      const inRange = pythonCallResultBindingsInRange(callResultBindings, c.startLine, c.endLine);
      if (inRange !== undefined) base.callResultBindings = inRange;
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
  if (Object.keys(classAncestors).length > 0) out.classAncestors = classAncestors;
  if (Object.keys(classFieldTypes).length > 0) out.classFieldTypes = classFieldTypes;
  if (Object.keys(classFieldTypesByClassKey).length > 0) out.classFieldTypesByClassKey = classFieldTypesByClassKey;
  // bd tea-rags-mcp-xpl83.3 — the names this file's `from` statements bind, so
  // the import mapper can walk past a package that re-exports rather than
  // declares. Absent when the file has none, like every other optional channel.
  if (reexports.length > 0) out.moduleReexports = reexports;
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
function collectPythonInheritanceEdges(root: AstNode): InheritanceEdgeDecl[] {
  const edges: InheritanceEdgeDecl[] = [];
  const walkScope = (node: AstNode, scope: string[]): void => {
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
          // A `subscript` is a GENERIC base: `RepositoryBase[Account]`. Its
          // `value` child is the class; the subscript is a type argument and is
          // never part of the hierarchy. Unwrapping it here mirrors
          // `collectPythonClassAncestors` (bd tea-rags-mcp-wz956) — polar
          // declares every repository base that way, so without the unwrap
          // those files emitted an EMPTY edge list, `inheritanceEdges` stayed
          // absent, and `inheritance-edges.ts` read the absence as "walker not
          // migrated" and lifted the `<relPath>::<fq>`-keyed `classAncestors`
          // into junk `include` rows on every reindex (bd tea-rags-mcp-m1sf0).
          const named = base.type === "subscript" ? base.childForFieldName("value") : base;
          if (!named) continue;
          if (named.type !== "identifier" && named.type !== "attribute" && named.type !== "dotted_name") continue;
          const ancestor = named.text;
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
function collectPythonClassFieldTypes(root: AstNode): Record<string, Record<string, string>> {
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
      const found = pythonSelfFieldType(inner);
      if (found !== undefined) fields[found.field] = found.type;
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
 * The same facts as {@link collectPythonClassFieldTypes} under the RUN-GLOBAL
 * class key `<relPath>::<dotted class FQ>` (bd tea-rags-mcp-f0xaa) — the key
 * shape {@link collectPythonClassAncestors} writes, so a linearized ancestor key
 * reads the fields straight off this map.
 *
 * Two differences from the short-name collector, both forced by the key. Scope
 * is tracked through EVERY named container (a class inside a `def` reads
 * `build.Local`, exactly as the ancestor channel spells it), and a field is
 * attributed to the INNERMOST enclosing class rather than to every class whose
 * body contains it — a nested class's `self.x` belongs to the nested class, and
 * a run-global key has no room for the short-name channel's tolerated overlap.
 */
function collectPythonClassFieldTypesByClassKey(
  root: AstNode,
  relPath: string,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const walkScope = (node: AstNode, scope: readonly string[], classFq: string | undefined): void => {
    const isContainer = node.type === "class_definition" || node.type === "function_definition";
    const nameNode = isContainer ? node.childForFieldName("name") : null;
    if (nameNode) {
      const childScope = [...scope, nameNode.text];
      const childClassFq = node.type === "class_definition" ? childScope.join(".") : classFq;
      const body = node.childForFieldName("body");
      for (const child of body ? body.children : node.children) walkScope(child, childScope, childClassFq);
      return;
    }
    if (classFq !== undefined) {
      const found = pythonSelfFieldType(node);
      if (found !== undefined) {
        const key = `${relPath}::${classFq}`;
        out[key] = { ...(out[key] ?? {}), [found.field]: found.type };
      }
    }
    for (const child of node.children) walkScope(child, scope, classFq);
  };
  walkScope(root, [], undefined);
  return out;
}

/**
 * `self.<field> = <typed RHS>` read off ONE node, or `undefined` for anything
 * else. The gate both field collectors share, so the qualified channel can never
 * disagree with the short-name one about what a field's type is.
 */
function pythonSelfFieldType(inner: AstNode): { readonly field: string; readonly type: string } | undefined {
  if (inner.type !== "assignment") return undefined;
  // LHS must be `self.<field>` — an `attribute` whose object is the
  // `self` identifier. Anything else (plain local, subscript) skips.
  const lhs = inner.childForFieldName("left");
  if (lhs?.type !== "attribute") return undefined;
  const obj = lhs.childForFieldName("object");
  const attr = lhs.childForFieldName("attribute");
  if (obj?.type !== "identifier" || obj.text !== "self") return undefined;
  if (!attr) return undefined;
  const fieldName = attr.text;

  // PEP 526 annotation wins — `self.x: ClassName = ...`.
  const typeField = inner.childForFieldName("type");
  if (typeField) {
    const typeName = extractTypeName(typeField);
    return typeName ? { field: fieldName, type: typeName } : undefined;
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
  if (right?.type !== "call") return undefined;
  const fnNode = right.childForFieldName("function");
  if (!fnNode) return undefined;
  const typeName = extractConstructorTypeName(fnNode);
  return typeName && isCapWordsConstructor(typeName) ? { field: fieldName, type: typeName } : undefined;
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
function collectPythonClassExtends(root: AstNode): Record<string, string> {
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

/** Join two module-path halves, honouring the leading dots of a relative import. */
function joinModulePath(head: string, tail: string): string {
  if (head.length === 0) return tail;
  return head.endsWith(".") ? `${head}${tail}` : `${head}.${tail}`;
}

function joinModuleSegments(head: string, segments: readonly string[]): string {
  return segments.reduce(joinModulePath, head);
}

/**
 * A base-class spelling with the DEFINING file's import binding applied, so the
 * resolver can turn it into a class key without the CALLER's imports — which is
 * what makes a linearization memoizable once per run (bd tea-rags-mcp-y4hro).
 *
 *   `Base`     + `from a.b import Base`     → `a.b::Base`
 *   `D`        + `from a.b import C as D`   → `a.b::C`      (the EXPORTED name)
 *   `db.Model` + `import django.db as db`   → `django.db::Model`
 *   `db.Model` + `from django import db`    → `django.db::Model`
 *   `a.b.Model`+ `import a.b`               → `a.b::Model`
 *   `Base`     with no binding              → `Base` (same file, or a builtin)
 *   `Base`     + `from a.b import *`        → `Base|a.b::Base` (see below)
 *
 * `::` and not a dot: `Outer.Inner` is a legal class FQ and would not split.
 *
 * The discriminator is `importedBindings[local] === importText`, verified
 * against `collectPythonImports` below. An `import` statement binds a MODULE
 * PATH and records the module text as the value; a `from` statement binds an
 * EXPORTED NAME and records that instead. The trap in the module case is the
 * unaliased `import a.b`, which binds only `a` — recognisable because the value
 * starts with the bound key. First matching import wins; a name rebound twice
 * in one file is not a shape any corpus row exercises.
 */
function qualifyPythonBase(baseText: string, imports: readonly ImportRef[]): string {
  const segments = baseText.split(".");
  const root = segments[0];
  if (root === undefined || root.length === 0) return baseText;
  const trailing = segments.slice(1);
  const tail = (parts: readonly string[]): string => parts[parts.length - 1] ?? "";
  for (const imp of imports) {
    const bound = imp.importedBindings?.[root];
    if (bound === undefined) {
      // A name with no recorded binding — only `*` today. Read it as the
      // from-import default: the statement's own module is the container.
      if (imp.importedNames?.includes(root) !== true) continue;
      return `${joinModuleSegments(imp.importText, segments.slice(0, -1))}::${tail(segments)}`;
    }
    if (bound === imp.importText) {
      // MODULE-PATH binding. A module used bare as a base is not a class, so
      // leave it verbatim and let the resolver's short-name lookup decide.
      if (trailing.length === 0) return baseText;
      const head = bound === root || bound.startsWith(`${root}.`) ? root : bound;
      return `${joinModuleSegments(head, trailing.slice(0, -1))}::${tail(trailing)}`;
    }
    // EXPORTED-NAME binding.
    if (trailing.length === 0) return `${imp.importText}::${bound}`;
    const container = joinModulePath(imp.importText, bound);
    return `${joinModuleSegments(container, trailing.slice(0, -1))}::${tail(trailing)}`;
  }
  return qualifyThroughStarImports(baseText, segments, imports);
}

/**
 * A bare base no import bound, in a file that STAR-imports (bd
 * tea-rags-mcp-4yh64).
 *
 * `from netbox.models.features import *` binds no local name — the walker
 * records it as the `importedNames` entry `"*"` with the module in
 * `importText`, and there is nothing in `importedBindings` for the loop above
 * to match. netbox's `netbox/netbox/models/__init__.py` takes ELEVEN bases of
 * `NetBoxFeatureSet` from exactly that statement, so every one of them stayed
 * bare, `classKeyIn` could not pin any of them against `__init__.py`, and the
 * MRO of all 133 models below stopped one hop in.
 *
 * The DEFINING file's star modules are the only candidates for such a name, and
 * this walker is the one place that knows them: `CallContext` carries the
 * CALLER's `imports`, and `PythonImportFileMapper` answers from the symbol
 * table alone. So the spelling becomes a DISJUNCTION the resolver tries in
 * order — bare first, because a class declared in the file itself shadows
 * anything a star brought in, then one candidate per star module in declaration
 * order. `|` cannot occur in a Python identifier or a dotted module path, and
 * `resolveBaseKey` in `../resolver/python-ancestor-policy.ts` owns the split —
 * the same division of labour the `::` grammar already uses.
 *
 * Only a SINGLE-SEGMENT base takes this path. A dotted `mod.Base` is rooted in
 * a name, and a star import binds names rather than module paths, so a star
 * cannot be what bound `mod`.
 */
function qualifyThroughStarImports(
  baseText: string,
  segments: readonly string[],
  imports: readonly ImportRef[],
): string {
  if (segments.length !== 1) return baseText;
  const starModules: string[] = [];
  for (const imp of imports) {
    if (imp.importedNames?.includes("*") !== true) continue;
    if (imp.importText.length === 0 || starModules.includes(imp.importText)) continue;
    starModules.push(imp.importText);
  }
  if (starModules.length === 0) return baseText;
  return [baseText, ...starModules.map((module) => `${module}::${baseText}`)].join("|");
}

/**
 * The base spelling that says "this branch of the hierarchy is unreadable" (bd
 * tea-rags-mcp-invuy).
 *
 * A base can be an arbitrary expression, and django's
 * `class Device(Manager.from_queryset(RestrictedQuerySet))` is the shape that
 * costs rows: the class the call RETURNS is only known at run time. Skipping
 * such a base silently is the trap — a class whose ONLY base is a call records
 * no `classAncestors` entry at all, `basesOf` returns `[]`, the closure stays
 * `closed`, and `selfMember` reads "the hierarchy is fully known and does not
 * own this member" from what is really an absence of evidence. It then DROPs
 * every inherited call on the class.
 *
 * Writing the marker instead makes the unreadable branch explicit, so
 * `resolveBaseKey` in `../resolver/python-ancestor-policy.ts` can degrade the
 * closure to `unknown`. That is strictly a DROP → CONTINUE change: `unknown`
 * never fabricates a target, it only declines to claim the member is absent.
 * `unknown` and not `external`, because "I could not read this base" is not the
 * same evidence as "this base IS a library class" — the latter is what makes a
 * miss provably right, and a computed base proves nothing either way.
 *
 * The spelling is illegal in both halves of the base grammar — `<` and `>`
 * occur in neither a Python identifier nor a dotted module path — so it cannot
 * collide with a real spelling, the same argument that lets
 * {@link qualifyThroughStarImports} use `|` as its disjunction separator. Owned
 * here and imported by the resolver, mirroring Ruby's `SUPER_RECEIVER_SENTINEL`.
 */
export const PYTHON_UNRESOLVABLE_BASE = "<unresolvable>";

/**
 * `class Child(A, M[T])` → `{ "<relPath>::Child": ["a::A", "m::M"] }`
 * (bd tea-rags-mcp-y4hro).
 *
 * Three things this does that `collectPythonClassExtends` does not, each one a
 * measured miss family: EVERY base rather than the first (netbox
 * `ProviderView(GetRelatedModelsMixin, generic.ObjectView)` loses its second
 * base), `subscript` bases (polar declares every repository base as
 * `RepositoryBase[Account]`, a node type the old filter skipped entirely, so
 * those classes recorded NO base at all), and a FILE-QUALIFIED key so two
 * `Base` classes in two files do not conflate in the run-global map.
 *
 * The dotted FQ counts EVERY named container, a `function_definition` as well
 * as a `class_definition` (bd tea-rags-mcp-graiw). That is not a choice this
 * function is free to make: `collectSymbols` in `../../kernel/collect-symbols.ts`
 * pushes each `nameOf`-named node onto `scope`, `pyNameOf` names a
 * `function_definition`, and `classKeyIn` in
 * `../resolver/python-ancestor-policy.ts` already addresses a BASE class as
 * `[...def.scope, def.shortName].join(".")`. So polar's
 * `class _AuthenticatorSignature(_Authenticator)` — declared inside
 * `def Authenticator()` in `server/polar/auth/dependencies.py` — is
 * `Authenticator._AuthenticatorSignature` to the symbol table and to every
 * base-key the policy builds. Keying it bare here made the resolver ask for a
 * class that, by that spelling, nothing declares: `basesOf` returned `[]`, the
 * closure read `closed`, and `super().__call__()` DROPped.
 *
 * Returns a plain object (Record) for NDJSON round-trip — Map would serialise
 * to `{}`.
 */
function collectPythonClassAncestors(
  root: AstNode,
  relPath: string,
  imports: readonly ImportRef[],
): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  const walkScope = (node: AstNode, scope: string[]): void => {
    const isContainer = node.type === "class_definition" || node.type === "function_definition";
    const nameNode = isContainer ? node.childForFieldName("name") : null;
    if (!nameNode) {
      for (const child of node.children) walkScope(child, scope);
      return;
    }
    const localName = nameNode.text;
    const childScope = [...scope, localName];
    if (node.type !== "class_definition") {
      const fnBody = node.childForFieldName("body");
      for (const child of fnBody ? fnBody.children : node.children) walkScope(child, childScope);
      return;
    }
    const fq = childScope.join(".");
    const supers = node.childForFieldName("superclasses");
    const bases: string[] = [];
    if (supers) {
      for (const base of supers.namedChildren) {
        // A `subscript` is a generic base: `RepositoryBase[Event]`. Its `value`
        // child is the class; the subscript is a type argument and is never
        // part of the hierarchy.
        const named = base.type === "subscript" ? base.childForFieldName("value") : base;
        if (!named) continue;
        // A COMPUTED base — `Manager.from_queryset(QuerySet)`. The class it
        // returns is a run-time value, so record that the branch is unreadable
        // rather than dropping it and leaving the closure to read `closed`.
        if (named.type === "call") {
          bases.push(PYTHON_UNRESOLVABLE_BASE);
          continue;
        }
        // Everything else that is not a name is not a base at all — a
        // `keyword_argument` is the `metaclass=` / `**kwargs` class-keyword
        // channel, which carries no hierarchy and must NOT degrade the closure.
        if (named.type !== "identifier" && named.type !== "attribute" && named.type !== "dotted_name") continue;
        const { text } = named;
        if (text.length === 0 || text === "object") continue;
        bases.push(qualifyPythonBase(text, imports));
      }
    }
    if (bases.length > 0) out[`${relPath}::${fq}`] = bases;
    const body = node.childForFieldName("body");
    for (const child of body ? body.children : node.children) walkScope(child, childScope);
  };
  walkScope(root, []);
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
function collectPythonDecoratorCalls(root: AstNode): CallRef[] {
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
  root: AstNode,
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
      //
      // bd tea-rags-mcp-z68v9 — the CapWords gate `collectPythonClassFieldTypes`
      // has always applied now applies here too. `repository =
      // AccountRepository.from_session(session)` was recorded as
      // `type: "AccountRepository.from_session"`, and a method is not a type:
      // `resolveOnBoundType` takes its last segment, asks for a class called
      // `from_session`, finds none and DROPs. That was harmless while nothing
      // else could answer; it is not harmless now that `callResultBindings`
      // records the same site as a callee the resolver CAN fold, because a
      // binding here shadows the fold. So a lowercase callee is left to the
      // channel that can type it — 470 rows on polar, all one shape.
      const right = node.childForFieldName("right");
      if (right?.type === "call") {
        const fnNode = right.childForFieldName("function");
        if (!fnNode) return;
        const typeName = extractConstructorTypeName(fnNode);
        if (typeName && pythonLocalCalleeIsConstructor(typeName)) (out[varName] ??= []).push({ line, type: typeName });
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
function extractTypeName(typeField: AstNode): string | null {
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
function extractConstructorTypeName(fnNode: AstNode): string | null {
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

/**
 * The LOCAL name an `import` statement binds, and the module it binds it to
 * (bd tea-rags-mcp-9fgdi).
 *
 * Unaliased `import a.b` binds `a`, NOT `a.b` — after `import os.path` the name
 * in scope is `os`. The aliased form binds the alias to the full submodule
 * path, so the imported side is the dotted text in both cases.
 */
function pythonModuleBinding(moduleText: string, alias: string | null): { local: string; imported: string } {
  if (alias) return { local: alias, imported: moduleText };
  return { local: moduleText.split(".")[0], imported: moduleText };
}

/**
 * The import statements of one file, plus the names its `from` statements
 * re-export (bd tea-rags-mcp-xpl83.3).
 *
 * Both come off ONE walk because both read the same nodes, and because the two
 * are not separable after the fact: `import a` and `from a import a` produce an
 * IDENTICAL `ImportRef`, and only the node type tells them apart. A re-export
 * derived from the `ImportRef` list alone would have to guess, and guessing
 * wrong invents an export the module does not have.
 */
interface PythonImportScan {
  readonly imports: ImportRef[];
  readonly reexports: ModuleReexport[];
}

function collectPythonImports(root: AstNode): PythonImportScan {
  const out: ImportRef[] = [];
  const reexports: ModuleReexport[] = [];
  walk(root, (node) => {
    if (node.type === "import_statement") {
      // `import a`, `import a.b`, `import a as x`, `import a, b`
      // Tree-sitter-python wraps each dotted_name (or aliased_import)
      // in `name` field of `dotted_as_name` etc. Walk children for
      // `dotted_name` / `aliased_import` nodes.
      for (const child of node.namedChildren) {
        const moduleText = pickModuleText(child);
        if (!moduleText) continue;
        const alias = child.type === "aliased_import" ? (child.childForFieldName("alias")?.text ?? null) : null;
        const { local, imported } = pythonModuleBinding(moduleText, alias);
        out.push({
          importText: moduleText,
          startLine: node.startPosition.row + 1,
          importedNames: [local],
          importedBindings: { [local]: imported },
        });
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
      // Everything that is not the module and not the dot prefix is an imported
      // NAME. There is no `childrenForFieldName` on `AstNode`, so the module is
      // excluded by node IDENTITY — `from a import a` is a real shape and a
      // text comparison would drop it.
      const importedNames: string[] = [];
      const importedBindings: Record<string, string> = {};
      // The module text the re-export entries point back at, spelled exactly as
      // `importText` below spells it — the mapper resolves both through the same
      // relative/absolute rules and a divergence here would silently miss.
      const sourceModule = moduleField ? prefix + (pickModuleText(moduleField) ?? "") : prefix;
      const reexport = (entry: ModuleReexport): void => {
        if (sourceModule.length > 0) reexports.push(entry);
      };
      for (const child of node.namedChildren) {
        if (child === moduleField || child.type === "import_prefix") continue;
        if (child.type === "wildcard_import") {
          // A star binds no single member: it is a name for the resolver's
          // star-import path and nothing for the binding table.
          importedNames.push("*");
          reexport({ exportedName: "*", sourceModule });
          continue;
        }
        if (child.type === "aliased_import") {
          const importedName = child.childForFieldName("name")?.text;
          const localName = child.childForFieldName("alias")?.text;
          if (!importedName || !localName) continue;
          importedNames.push(localName);
          importedBindings[localName] = importedName;
          reexport({ exportedName: localName, sourceModule, sourceName: importedName });
          continue;
        }
        if (child.type === "dotted_name" || child.type === "identifier") {
          importedNames.push(child.text);
          importedBindings[child.text] = child.text;
          reexport({ exportedName: child.text, sourceModule, sourceName: child.text });
        }
      }
      // Emit only non-empty: a channel the statement does not carry is absent,
      // never `[]` / `{}` — same discipline the Ruby walker applies to its
      // optional channels, and what keeps the NDJSON spill small.
      const names = importedNames.length > 0 ? { importedNames } : {};
      const bindings = Object.keys(importedBindings).length > 0 ? { importedBindings } : {};
      if (moduleField) {
        out.push({ importText: sourceModule, startLine, ...names, ...bindings });
      } else if (prefix) {
        // `from . import x` — no module name, just the prefix.
        out.push({ importText: prefix, startLine, ...names, ...bindings });
      }
    }
  });
  return { imports: out, reexports };
}

function pickModuleText(node: AstNode): string | null {
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

/**
 * A zero-argument `super()` receiver is recorded as the bare text `super` (bd
 * tea-rags-mcp-ntnke). `classifyReceiverKind`'s `SUPER_MARKERS` holds `"super"`
 * and `"<super>"`, so the verbatim `"super()"` filed every one of these sites
 * under `dynamic` — 1,446 rows on netbox, 1,242 on polar. Normalizing here
 * rather than widening the classifier keeps a shared, language-neutral
 * instrument free of one language's spelling, and
 * `PythonSuperSymbolResolutionStrategy` already accepts both texts, so the
 * resolver needs no change.
 *
 * The match is on the node SHAPE — `function` is the identifier `super`, the
 * argument list is empty — not on the text, so `super ()` normalizes too.
 *
 * The explicit two-argument `super(Cls, self)` is NOT normalized: its first
 * argument names the class the walk starts after, which is not always the
 * enclosing class, and no E0.9 corpus row uses it. It keeps its verbatim
 * receiver text and stays `dynamic`.
 */
function normalizePythonReceiverText(node: AstNode): string {
  if (node.type !== "call") return node.text;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "identifier" || fn.text !== "super") return node.text;
  const args = node.childForFieldName("arguments");
  return args === null || args.namedChildren.length === 0 ? "super" : node.text;
}

function collectPythonCalls(root: AstNode): CallRef[] {
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
      out.push({ callText: node.text, receiver: normalizePythonReceiverText(obj), member: attr.text, startLine });
    } else {
      // Bare call like `foo(...)`.
      out.push({ callText: node.text, receiver: null, member: fn.text, startLine });
    }
  });
  return out;
}

function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/** Scopes whose body is a function body — a local established there is a LOCAL. */
const PYTHON_NESTED_SCOPES = new Set(["function_definition", "lambda"]);

/** A plain dotted name: `make`, `Repo.from_session`, `self.factory.build`. */
const PYTHON_CALLEE_SPELLING = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/;

/**
 * The callee spelling of a call node, or `null` when it is not a plain dotted
 * name. A spelling carrying a call, an index or a newline is a CHAIN, not a
 * name; folding it would mean re-parsing the text and this channel does not do
 * that (bd tea-rags-mcp-z68v9).
 */
function pythonCalleeSpelling(call: AstNode): string | null {
  const fn = call.childForFieldName("function");
  if (fn === null) return null;
  if (fn.type !== "identifier" && fn.type !== "attribute" && fn.type !== "dotted_name") return null;
  return PYTHON_CALLEE_SPELLING.test(fn.text) ? fn.text : null;
}

/**
 * `NAME = <callee>(…)` sites, keyed by the bound name (bd tea-rags-mcp-z68v9).
 *
 * The RHS's return TYPE is deliberately not inferred here: for the measured
 * shape (`repository = SubscriptionRepository.from_session(session)`, polar 470
 * rows) the callee is cross-file and its return is declared on an ancestor, so
 * a per-file pass has nothing to read. The spelling is the whole contribution;
 * `pythonCallBindingType` folds it at resolve time.
 *
 * Declined by construction, each because there is no single nominal answer:
 * tuple unpacking, a chained / subscripted callee, a non-call RHS, an annotated
 * assignment (the annotation is the better answer and `localBindings` already
 * carries it), and a MODULE-level assignment — a module global is not a local,
 * and binding one would type every call site in the file from a single write.
 * `await <call>` IS unwrapped: awaiting a coroutine yields what it declares.
 *
 * Returns a plain object (Record) for NDJSON round-trip — `Map` serialises to
 * `{}` and loses every entry.
 */
function collectPythonCallResultBindings(root: AstNode): Record<string, CallResultBinding[]> {
  const out: Record<string, CallResultBinding[]> = {};
  const scan = (node: AstNode, inFunction: boolean): void => {
    if (node.type === "assignment" && inFunction && node.childForFieldName("type") === null) {
      const lhs = node.namedChild(0);
      const rhs = node.childForFieldName("right");
      const call = rhs?.type === "await" ? (rhs.namedChild(0) ?? rhs) : rhs;
      if (lhs?.type === "identifier" && call?.type === "call") {
        const callee = pythonCalleeSpelling(call);
        if (callee !== null) (out[lhs.text] ??= []).push({ line: node.startPosition.row + 1, callee });
      }
    }
    for (const child of node.namedChildren) scan(child, inFunction || PYTHON_NESTED_SCOPES.has(node.type));
  };
  for (const child of root.namedChildren) scan(child, false);
  for (const list of Object.values(out)) list.sort((a, b) => a.line - b.line);
  return out;
}

/** The subset of `bindings` established inside `[startLine, endLine]`, or undefined when none is. */
function pythonCallResultBindingsInRange(
  bindings: Record<string, CallResultBinding[]>,
  startLine: number,
  endLine: number,
): Record<string, CallResultBinding[]> | undefined {
  const out: Record<string, CallResultBinding[]> = {};
  for (const [name, list] of Object.entries(bindings)) {
    const kept = list.filter((binding) => binding.line >= startLine && binding.line <= endLine);
    if (kept.length > 0) out[name] = kept;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * {@link isCapWordsConstructor}, but a leading underscore run does not disqualify
 * the name (bd tea-rags-mcp-z68v9).
 *
 * PEP8 spells a module-private class `_CapWords`, and polar's
 * `placer = _BlockPlacer()` (`server/polar/compass/assistant/stream.py:147`) is
 * exactly that — the ONE row the plain CapWords gate lost when
 * `collectLocalBindingsForChunk` adopted it. A private class is still a class.
 *
 * Separate from `isCapWordsConstructor` rather than a fix to it because that
 * predicate gates the FIELD channel, whose behaviour is measured under its own
 * bead (tea-rags-mcp-m46z). Widening both at once would put an unmeasured change
 * inside a measured one.
 */
function pythonLocalCalleeIsConstructor(typeName: string): boolean {
  const finalSegment = typeName.slice(typeName.lastIndexOf(".") + 1);
  return /^_*[A-Z]/.test(finalSegment);
}
