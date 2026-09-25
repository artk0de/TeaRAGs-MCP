/**
 * The names an ECMAScript module reference takes from, or forwards out of, its
 * target's export surface (bd tea-rags-mcp-r8hme.2) — shared by the TypeScript
 * and JavaScript walkers, whose grammars agree on every node read here.
 *
 * Names are the TARGET's spelling: `import { a as b }` takes `a`,
 * `export { a as b } from` forwards `a`. `default` is the default export and
 * `*` the whole module. The facade check compares a deep import's names with
 * the names the module's entry file forwards, so a local alias would compare
 * the wrong thing.
 */

import type { AstNode } from "../../../contracts/types/ast.js";

/** Name of the whole-module import / re-export. */
export const WHOLE_MODULE_EXPORT_NAME = "*";
/** Name of the default export. */
export const DEFAULT_EXPORT_NAME = "default";

function specifierName(node: AstNode | null): string | undefined {
  if (!node) return undefined;
  return node.type === "string" ? node.text.replace(/^['"`]|['"`]$/g, "") : node.text;
}

/**
 * `import D, { a as b, c } from "./m"` → `["default", "a", "c"]`;
 * `import * as ns from "./m"` → `["*"]`; a side-effect import → `[]`.
 */
export function esmImportExportNames(importStatement: AstNode): string[] {
  const clause = importStatement.children.find((c) => c.type === "import_clause");
  if (!clause) return [];
  const names: string[] = [];
  for (const child of clause.children) {
    if (child.type === "identifier") names.push(DEFAULT_EXPORT_NAME);
    else if (child.type === "namespace_import") names.push(WHOLE_MODULE_EXPORT_NAME);
    else if (child.type === "named_imports") {
      for (const spec of child.children) {
        if (spec.type !== "import_specifier") continue;
        const name = specifierName(spec.childForFieldName("name"));
        if (name) names.push(name);
      }
    }
  }
  return names;
}

/**
 * `export { a, b as c } from "./x"` → `["a", "b"]`; `export * from "./x"` and
 * `export * as ns from "./x"` → `["*"]`. Only meaningful on an export
 * statement that HAS a source.
 */
export function esmReexportExportNames(exportStatement: AstNode): string[] {
  const names: string[] = [];
  for (const child of exportStatement.children) {
    if (child.type === "*" || child.type === "namespace_export") names.push(WHOLE_MODULE_EXPORT_NAME);
    else if (child.type === "export_clause") {
      for (const spec of child.children) {
        if (spec.type !== "export_specifier") continue;
        const name = specifierName(spec.childForFieldName("name"));
        if (name) names.push(name);
      }
    }
  }
  return names.includes(WHOLE_MODULE_EXPORT_NAME) ? [WHOLE_MODULE_EXPORT_NAME] : names;
}

/**
 * A `require("./m")` / `import("./m")` call's names, read off the declarator it
 * initialises: `const m = require(…)` binds the whole module (`*`),
 * `const { a, b: c } = require(…)` takes `a` and `b`, a bare call takes
 * nothing. The call may sit under `await`.
 */
export function moduleCallExportNames(call: AstNode): string[] {
  const owner = call.parent?.type === "await_expression" ? call.parent.parent : call.parent;
  if (owner?.type !== "variable_declarator") return [];
  const target = owner.childForFieldName("name");
  if (!target) return [];
  if (target.type === "identifier") return [WHOLE_MODULE_EXPORT_NAME];
  if (target.type !== "object_pattern") return [];
  const names: string[] = [];
  for (const child of target.namedChildren) {
    if (child.type === "shorthand_property_identifier_pattern") names.push(child.text);
    else if (child.type === "pair_pattern") {
      const key = specifierName(child.childForFieldName("key"));
      if (key) names.push(key);
    }
  }
  return names;
}

/** Spread-ready: the field when `names` is non-empty, nothing otherwise. */
export function exportNamesField<K extends "importedExportNames" | "reexportedExportNames">(
  key: K,
  names: readonly string[],
): Partial<Record<K, string[]>> {
  return names.length > 0 ? ({ [key]: [...new Set(names)] } as Partial<Record<K, string[]>>) : {};
}
