/**
 * Python walker half of interprocedural parameter typing (K7, bd
 * tea-rags-mcp-m99j1.1.17) — the Python producer of the three channels the
 * language-agnostic fold in `trajectory/codegraph/symbols/call-arg-param-types.ts`
 * joins (Task 15A made it admit Python through `ChunkExtraction.paramCoordinate`).
 * Ruby's producer (`ruby/walker/param-arg-types.ts`) is the reference.
 *
 * The known-target call site in Python is the PYTHON_INIT_METHOD call: `View(x)` runs
 * `View.__init__`, whatever the rest of the program does, so its argument types
 * can be harvested in pass 1 and folded at the barrier before any call resolves.
 * Three facts, every key spelled with Python's file-qualified class key
 * `<relPath>::<dotted class FQ>` (the key `pythonClassKey` builds):
 *
 *   - `paramNames` on each `__init__` chunk — the leading positional run, the
 *     receiver dropped — with its `paramCoordinate` `<classKey>#__init__`, the
 *     coordinate the fold indexes it under and pass 2 seeds it back from (a
 *     Python symbolId `View#__init__` is NOT that coordinate);
 *   - `knownTargetCallArgs` — per-position argument types at a CapWords call
 *     whose name the file binds to a class: one it declares at module scope, or
 *     one a `from M import Name` names (the candidates are the files module `M`
 *     can live in; the fold keeps the first that is a real definition);
 *   - `classFieldParamLinks` — `self.<field> = <param>` verbatim copies.
 *
 * Every collector is SILENT where it cannot be exact: an argument whose type is
 * not conservatively known is a `null` slot, a field fed by two parameter
 * coordinates links nothing, and a re-exported class (`from django.http import
 * HttpRequest`, declared one package deeper) matches no candidate and derives
 * nothing rather than guessing.
 */

import { createIdentifierRecord } from "../../../../../contracts/identifier-record.js";
import type { AstNode } from "../../../../../contracts/types/ast.js";
import type {
  ChunkExtraction,
  ClassFieldParamLink,
  FileExtraction,
  KnownTargetCallArgs,
} from "../../../../../contracts/types/codegraph.js";
import type { RubyTypeRef, WalkContext } from "../../../../../contracts/types/language.js";
import { symbolIdNames, type ExtractionFacetPass } from "../../../kernel/index.js";
import { extractConstructorTypeName, isCapWordsConstructor } from "../walker.js";
import { isPythonMethodDef, pythonBoundParamNames, pythonPositionalParamNames } from "./python-def-signatures.js";

/** The only Python callee the fold can address from syntax: the constructor. */
const PYTHON_INIT_METHOD = "__init__";

/** Nodes that open a new scope — a walk over one def's body stops at them. */
const SCOPE_NODES: ReadonlySet<string> = new Set(["function_definition", "class_definition", "lambda"]);

/** Argument nodes past which positions stop corresponding to parameters. */
const POSITION_BREAKERS: ReadonlySet<string> = new Set(["keyword_argument", "list_splat", "dictionary_splat"]);

/**
 * Python's file-qualified class key, `<relPath>::<dotted class FQ>` — the same
 * spelling `classAncestors` and `classFieldTypesByClassKey` carry
 * (`pythonClassKey` on the resolver side). Every key this pass emits goes
 * through here: the fold joins by string equality and never re-spells one.
 */
function fileQualifiedClassKey(relPath: string, classChain: readonly string[]): string {
  return `${relPath}::${classChain.join(".")}`;
}

/** One def as the collectors see it. */
interface PythonDefFrame {
  readonly node: AstNode;
  /** Dotted class chain of the class whose body declares the def, `[]` otherwise. */
  readonly classChain: readonly string[];
  /** Implicit `self` parameter name for an instance method, else `null`. */
  readonly receiver: string | null;
  /** Lazily computed constructor-typed locals of this def. */
  locals?: ReadonlyMap<string, string | null>;
}

/** A name a `from M import Source as Local` binds. `null` = bound twice, unusable. */
interface PythonFromImport {
  readonly module: string;
  readonly sourceName: string;
}

function decoratorNamesOf(defNode: AstNode): string[] {
  const outer = defNode.parent;
  if (outer?.type !== "decorated_definition") return [];
  return outer.namedChildren.filter((c) => c.type === "decorator").map((c) => c.text.replace(/^@/, "").trim());
}

/** Walk `node`'s subtree without entering a nested scope. */
function walkScope(node: AstNode, visit: (n: AstNode) => void): void {
  for (const child of node.namedChildren) {
    visit(child);
    if (!SCOPE_NODES.has(child.type)) walkScope(child, visit);
  }
}

function identifiersUnder(node: AstNode | null, out: Set<string>): void {
  if (node === null) return;
  if (node.type === "identifier") {
    out.add(node.text);
    return;
  }
  for (const child of node.namedChildren) identifiersUnder(child, out);
}

/**
 * Every `def` with its class chain and receiver, in source order. A class
 * nested inside a def is skipped together with its body: its run-global class
 * key carries the def in its FQ, which a class-only chain cannot spell.
 */
function collectDefFrames(root: AstNode): PythonDefFrame[] {
  const frames: PythonDefFrame[] = [];
  const visit = (node: AstNode, classChain: readonly string[], inDef: boolean): void => {
    for (const child of node.namedChildren) {
      const def = child.type === "decorated_definition" ? (child.childForFieldName("definition") ?? child) : child;
      if (def.type === "class_definition") {
        const name = def.childForFieldName("name")?.text;
        const body = def.childForFieldName("body");
        if (name !== undefined && body !== null && !inDef) visit(body, [...classChain, name], false);
        continue;
      }
      if (def.type === "function_definition") {
        const isMethod = isPythonMethodDef(def);
        const decorators = decoratorNamesOf(def);
        const instanceMethod = isMethod && !decorators.includes("staticmethod") && !decorators.includes("classmethod");
        const first = pythonBoundParamNames(def)[0];
        frames.push({ node: def, classChain, receiver: instanceMethod && first !== undefined ? first : null });
        const body = def.childForFieldName("body");
        if (body !== null) visit(body, classChain, true);
        continue;
      }
      visit(child, classChain, inDef);
    }
  };
  visit(root, [], false);
  return frames;
}

/** The constructor type a value expression is, or null (CapWords gate as the field channel). */
function constructorTypeOf(expr: AstNode | null, imports: ReadonlyMap<string, PythonFromImport | null>): string | null {
  if (expr?.type !== "call") return null;
  const fn = expr.childForFieldName("function");
  if (fn === null) return null;
  const typeName = extractConstructorTypeName(fn);
  if (typeName === null || !isCapWordsConstructor(typeName)) return null;
  // An aliased import spells the class under a name only THIS file knows; the
  // fact is read in the callee's file, so it carries the source name.
  if (fn.type === "identifier") return imports.get(typeName)?.sourceName ?? typeName;
  return typeName;
}

/**
 * The def's locals bound ONLY to one constructor type. Any other binding form
 * (a tuple target, `for`, `with … as`, `:=`, `+=`, an import, `global`, a
 * parameter) or a second, different constructor poisons the name.
 */
function constructorTypedLocals(
  frame: PythonDefFrame,
  imports: ReadonlyMap<string, PythonFromImport | null>,
): ReadonlyMap<string, string | null> {
  const types = new Map<string, string | null>();
  const poisoned = new Set<string>(pythonBoundParamNames(frame.node));
  const body = frame.node.childForFieldName("body");
  if (body === null) return types;
  walkScope(body, (n) => {
    switch (n.type) {
      case "assignment": {
        const left = n.childForFieldName("left");
        if (left?.type === "identifier") {
          const type = constructorTypeOf(n.childForFieldName("right"), imports);
          const seen = types.get(left.text);
          if (type === null || (seen !== undefined && seen !== type)) poisoned.add(left.text);
          else types.set(left.text, type);
        } else if (left !== null && left.type !== "attribute" && left.type !== "subscript") {
          identifiersUnder(left, poisoned);
        }
        return;
      }
      case "augmented_assignment":
      case "for_statement":
      case "for_in_clause":
        identifiersUnder(n.childForFieldName("left"), poisoned);
        return;
      case "as_pattern":
        identifiersUnder(n.childForFieldName("alias"), poisoned);
        return;
      case "named_expression":
        identifiersUnder(n.childForFieldName("name"), poisoned);
        return;
      case "global_statement":
      case "nonlocal_statement":
      case "import_statement":
      case "import_from_statement":
        identifiersUnder(n, poisoned);
        break;
      default:
        break;
    }
  });
  for (const name of poisoned) types.set(name, null);
  return types;
}

/**
 * Every `from M import Name [as Alias]` the file makes, by LOCAL name. A local
 * name bound by two different imports is `null` — no single class to name.
 */
function collectFromImports(root: AstNode): Map<string, PythonFromImport | null> {
  const out = new Map<string, PythonFromImport | null>();
  const visit = (node: AstNode): void => {
    if (node.type === "import_from_statement") {
      const moduleNode = node.childForFieldName("module_name");
      if (moduleNode === null) return;
      const module = moduleNode.text;
      const names = node.namedChildren.filter(
        (c) => (c.type === "dotted_name" || c.type === "aliased_import") && c.startIndex !== moduleNode.startIndex,
      );
      for (const nameNode of names) {
        const aliased = nameNode.type === "aliased_import";
        const sourceName = aliased ? nameNode.childForFieldName("name")?.text : nameNode.text;
        const localName = aliased ? nameNode.childForFieldName("alias")?.text : nameNode.text;
        if (sourceName === undefined || localName === undefined || sourceName.includes(".")) continue;
        const seen = out.get(localName);
        if (seen === undefined) out.set(localName, { module, sourceName });
        else if (seen !== null && (seen.module !== module || seen.sourceName !== sourceName)) out.set(localName, null);
      }
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return out;
}

/** Module-scope class names → declared once (true) or twice (false). */
function collectModuleClasses(root: AstNode): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const child of root.namedChildren) {
    const def = child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
    if (def?.type !== "class_definition") continue;
    const name = def.childForFieldName("name")?.text;
    if (name !== undefined) out.set(name, !out.has(name));
  }
  return out;
}

/**
 * The files module `moduleText` can be, as the importer at `relPath` spells it.
 * A relative module resolves against the importer's package; an absolute one
 * against EVERY ancestor directory of the importer, outermost first, because the
 * walker does not know the project's source roots (`src/flask/app.py` imports
 * `flask.helpers`). The fold's existence gate keeps only a real definition.
 */
export function pythonModuleFileCandidates(relPath: string, moduleText: string): string[] {
  const dirParts = relPath.split("/").slice(0, -1);
  const dots = /^\.*/.exec(moduleText)?.[0].length ?? 0;
  const segments = moduleText
    .slice(dots)
    .split(".")
    .filter((s) => s.length > 0);
  const bases: string[][] = [];
  if (dots > 0) {
    if (dots - 1 > dirParts.length) return [];
    bases.push(dirParts.slice(0, dirParts.length - (dots - 1)));
  } else {
    for (let depth = 0; depth <= dirParts.length; depth++) bases.push(dirParts.slice(0, depth));
  }
  const out: string[] = [];
  for (const base of bases) {
    const path = [...base, ...segments].join("/");
    if (segments.length > 0) out.push(`${path}.py`);
    out.push(path.length > 0 ? `${path}/__init__.py` : "__init__.py");
  }
  return out;
}

/** The file's resolution context for constructor calls. */
interface PythonCallSiteScope {
  readonly relPath: string;
  readonly imports: ReadonlyMap<string, PythonFromImport | null>;
  readonly moduleClasses: ReadonlyMap<string, boolean>;
}

/** `<classKey>#__init__` candidates for a constructor call spelled `name`, or `[]`. */
function constructorTargets(name: string, scope: PythonCallSiteScope): string[] {
  const declared = scope.moduleClasses.get(name);
  if (declared === true) return [`${fileQualifiedClassKey(scope.relPath, [name])}#${PYTHON_INIT_METHOD}`];
  if (declared === false) return [];
  const imported = scope.imports.get(name);
  if (imported === undefined || imported === null) return [];
  return pythonModuleFileCandidates(scope.relPath, imported.module).map(
    (file) => `${fileQualifiedClassKey(file, [imported.sourceName])}#${PYTHON_INIT_METHOD}`,
  );
}

/** The conservatively known type of ONE argument expression, or null. */
function argTypeOf(arg: AstNode, frame: PythonDefFrame | null, scope: PythonCallSiteScope): RubyTypeRef | null {
  const ctor = constructorTypeOf(arg, scope.imports);
  if (ctor !== null) return { form: "instance", name: ctor };
  if (arg.type !== "identifier" || frame === null) return null;
  if (frame.receiver !== null && arg.text === frame.receiver) {
    const owner = frame.classChain[frame.classChain.length - 1];
    return owner === undefined ? null : { form: "instance", name: owner };
  }
  frame.locals ??= constructorTypedLocals(frame, scope.imports);
  const local = frame.locals.get(arg.text);
  return local === undefined || local === null ? null : { form: "instance", name: local };
}

function collectSiteArgs(
  callNode: AstNode,
  frame: PythonDefFrame | null,
  scope: PythonCallSiteScope,
  out: KnownTargetCallArgs[],
): void {
  const fn = callNode.childForFieldName("function");
  const args = callNode.childForFieldName("arguments");
  if (fn?.type !== "identifier" || args?.type !== "argument_list" || !isCapWordsConstructor(fn.text)) return;
  if (frame !== null && pythonBoundParamNames(frame.node).includes(fn.text)) return; // shadowed by a parameter
  const targets = constructorTargets(fn.text, scope);
  if (targets.length === 0) return;
  const argTypes: (RubyTypeRef | null)[] = [];
  let known = false;
  for (const arg of args.namedChildren) {
    if (arg.type === "comment") continue;
    if (POSITION_BREAKERS.has(arg.type)) break;
    const type = argTypeOf(arg, frame, scope);
    if (type !== null) known = true;
    argTypes.push(type);
  }
  if (known) out.push({ targets, argTypes });
}

/** Per-position argument types at the file's constructor call sites. */
function collectPythonKnownTargetCallArgs(
  root: AstNode,
  frames: readonly PythonDefFrame[],
  scope: PythonCallSiteScope,
): KnownTargetCallArgs[] {
  const out: KnownTargetCallArgs[] = [];
  const frameByStart = new Map(frames.map((f) => [f.node.startIndex, f]));
  const visit = (node: AstNode, frame: PythonDefFrame | null): void => {
    for (const child of node.namedChildren) {
      if (child.type === "call") collectSiteArgs(child, frame, scope, out);
      const inner = child.type === "function_definition" ? (frameByStart.get(child.startIndex) ?? null) : frame;
      // A class nested in a def has no frame; its methods' calls are skipped
      // with it (their `self` cannot be spelled), module-level code is `null`.
      if (child.type === "function_definition" && inner === null) continue;
      visit(child, inner);
    }
  };
  visit(root, null);
  return out;
}

/**
 * `<classKey> → field → (method, param)` for `self.<field> = <param>` in an
 * instance method. A field fed by two different coordinates is dropped, as in
 * Ruby: two origins are two candidate types and the fold never picks one.
 */
function collectPythonClassFieldParamLinks(
  frames: readonly PythonDefFrame[],
  relPath: string,
): Record<string, Record<string, ClassFieldParamLink>> {
  const links = new Map<string, Map<string, ClassFieldParamLink>>();
  const poisoned = new Set<string>();
  for (const frame of frames) {
    if (frame.receiver === null || frame.classChain.length === 0) continue;
    const method = frame.node.childForFieldName("name")?.text;
    const body = frame.node.childForFieldName("body");
    if (method === undefined || body === null) continue;
    const params = new Set(pythonBoundParamNames(frame.node).slice(1));
    const classKey = fileQualifiedClassKey(relPath, frame.classChain);
    walkScope(body, (n) => {
      if (n.type !== "assignment" || n.childForFieldName("type") !== null) return;
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      if (left?.type !== "attribute" || right?.type !== "identifier" || !params.has(right.text)) return;
      const fieldOwner = left.childForFieldName("object");
      const field = left.childForFieldName("attribute")?.text;
      if (fieldOwner?.type !== "identifier" || fieldOwner.text !== frame.receiver || field === undefined) return;
      const fields = links.get(classKey) ?? new Map<string, ClassFieldParamLink>();
      links.set(classKey, fields);
      const existing = fields.get(field);
      if (existing === undefined) fields.set(field, { method, param: right.text });
      else if (existing.method !== method || existing.param !== right.text) poisoned.add(`${classKey}|${field}`);
    });
  }
  const out: Record<string, Record<string, ClassFieldParamLink>> = createIdentifierRecord();
  for (const [classKey, fields] of links) {
    const kept: Record<string, ClassFieldParamLink> = createIdentifierRecord();
    for (const [field, link] of fields) if (!poisoned.has(`${classKey}|${field}`)) kept[field] = link;
    if (Object.keys(kept).length > 0) out[classKey] = kept;
  }
  return out;
}

/**
 * `paramNames` + `paramCoordinate` records for the `__init__` chunks, matched
 * by def line and name. Only `__init__`: it is the one def a known-target call
 * site addresses, so another method's names would index nothing.
 */
function constructorParamNameChunks(
  frames: readonly PythonDefFrame[],
  chunks: WalkContext["chunks"],
  relPath: string,
): ChunkExtraction[] {
  const initChunks: ChunkExtraction[] = [];
  for (const frame of frames) {
    if (frame.receiver === null || frame.node.childForFieldName("name")?.text !== PYTHON_INIT_METHOD) continue;
    const names = pythonPositionalParamNames(frame.node, true);
    if (names.length === 0) continue;
    const line = frame.node.startPosition.row + 1;
    const chunk = chunks.find((c) => c.startLine === line && symbolIdNames(c.symbolId, PYTHON_INIT_METHOD));
    if (chunk === undefined) continue;
    initChunks.push({
      symbolId: chunk.symbolId,
      scope: chunk.scope,
      calls: [],
      paramNames: names,
      paramCoordinate: `${fileQualifiedClassKey(relPath, frame.classChain)}#${PYTHON_INIT_METHOD}`,
    });
  }
  return initChunks;
}

export const pythonParamArgTypesFacetPass: ExtractionFacetPass = {
  run: (root, ctx): Partial<FileExtraction> => {
    const frames = collectDefFrames(root);
    const scope: PythonCallSiteScope = {
      relPath: ctx.relPath,
      imports: collectFromImports(root),
      moduleClasses: collectModuleClasses(root),
    };
    const out: Partial<FileExtraction> = {};
    const chunks = constructorParamNameChunks(frames, ctx.chunks, ctx.relPath);
    if (chunks.length > 0) out.chunks = chunks;
    const knownTargetCallArgs = collectPythonKnownTargetCallArgs(root, frames, scope);
    if (knownTargetCallArgs.length > 0) out.knownTargetCallArgs = knownTargetCallArgs;
    const links = collectPythonClassFieldParamLinks(frames, ctx.relPath);
    if (Object.keys(links).length > 0) out.classFieldParamLinks = links;
    return out;
  },
};
