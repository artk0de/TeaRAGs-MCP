/**
 * A decorator's QUALIFIED spelling, composed from the file's module-level
 * imports (`from functools import cached_property` →
 * `functools.cached_property`, `import contextlib as cl` + `@cl.contextmanager`
 * → `contextlib.contextmanager`). A relative import composes nothing, so its
 * decorator stays unqualified and matches only a builtin spelling.
 *
 * Shared by the passes that decide what a decorator turns a def into: the
 * descriptor pass (a def read as an attribute) and the annotation source (a
 * context-manager generator, bd tea-rags-mcp-m99j1.1.87).
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";

/** Statements whose blocks still bind at module scope (`try: import x`). */
const MODULE_SCOPE_BLOCKS: ReadonlySet<string> = new Set([
  "if_statement",
  "elif_clause",
  "else_clause",
  "try_statement",
  "except_clause",
  "finally_clause",
  "block",
]);

/** `local name → qualified dotted path` for every absolute module-level import. */
export function pythonModuleImportBindings(root: AstNode): Map<string, string> {
  const bindings = new Map<string, string>();
  const visit = (node: AstNode): void => {
    if (node.type === "import_statement") {
      for (const name of node.namedChildren) bindImported(bindings, name, null);
      return;
    }
    if (node.type === "import_from_statement") {
      const [module, ...names] = node.namedChildren;
      if (module?.type !== "dotted_name") return;
      for (const name of names) bindImported(bindings, name, module.text);
      return;
    }
    if (node.type === "module" || MODULE_SCOPE_BLOCKS.has(node.type)) {
      for (const child of node.namedChildren) visit(child);
    }
  };
  visit(root);
  return bindings;
}

/**
 * One imported name. `import a.b` binds `a` to `a`; `import a.b as c` binds
 * `c` to `a.b`; `from m import x as y` binds `y` to `m.x`.
 */
function bindImported(bindings: Map<string, string>, node: AstNode, fromModule: string | null): void {
  if (node.type === "aliased_import") {
    const path = node.childForFieldName("name")?.text;
    const alias = node.childForFieldName("alias")?.text;
    if (path !== undefined && alias !== undefined) {
      bindings.set(alias, fromModule === null ? path : `${fromModule}.${path}`);
    }
    return;
  }
  if (node.type !== "dotted_name") return;
  if (fromModule !== null) {
    bindings.set(node.text, `${fromModule}.${node.text}`);
    return;
  }
  const head = node.text.split(".")[0];
  bindings.set(head, head);
}

/**
 * The qualified spelling of one decorator, or null for a decorator CALL — a
 * factory (`@app.route("/")`) returns the decorator, so its own name says
 * nothing about what the def becomes.
 */
function qualifiedDecorator(node: AstNode, bindings: ReadonlyMap<string, string>): string | null {
  const expr = node.namedChild(0);
  if (expr === null || (expr.type !== "identifier" && expr.type !== "attribute")) return null;
  const segments = expr.text.split(".");
  const head = bindings.get(segments[0]) ?? segments[0];
  return [head, ...segments.slice(1)].join(".");
}

/** The qualified spelling of every non-factory decorator on the def, outermost first; empty when undecorated. */
export function pythonQualifiedDecorators(def: AstNode, bindings: ReadonlyMap<string, string>): string[] {
  const decorated = def.parent;
  if (decorated?.type !== "decorated_definition") return [];
  const out: string[] = [];
  for (const child of decorated.namedChildren) {
    if (child.type !== "decorator") continue;
    const qualified = qualifiedDecorator(child, bindings);
    if (qualified !== null) out.push(qualified);
  }
  return out;
}

/** Does the def's `decorated_definition` carry a decorator whose qualified spelling is in `wanted`? */
export function pythonDefHasQualifiedDecorator(
  def: AstNode,
  bindings: ReadonlyMap<string, string>,
  wanted: ReadonlySet<string>,
): boolean {
  return pythonQualifiedDecorators(def, bindings).some((qualified) => wanted.has(qualified));
}
