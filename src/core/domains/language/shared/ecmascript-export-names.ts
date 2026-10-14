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

import { createIdentifierRecord } from "../../../contracts/identifier-record.js";
import type { AstNode } from "../../../contracts/types/ast.js";
import { WHOLE_MODULE_EXPORT_NAME, type ImportRef } from "../../../contracts/types/codegraph-extraction.js";

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
 * One name an `export` statement exposes (bd tea-rags-mcp-zl3so): `exposed` is
 * what an importer of THIS file writes, `forwarded` the name it stands for —
 * the target's export for a source re-export, the local binding for an
 * `export { … }` without a source.
 */
export interface EsmExportedName {
  exposed: string;
  forwarded: string;
}

/**
 * `export { a, b as c } from "./x"` → `a→a, c→b`; `export * from "./x"` →
 * `*→*`; `export * as ns from "./x"` → `ns→*`. Without a source the clause
 * names local bindings: `export { local as b }` → `b→local`.
 */
export function esmExportedNames(exportStatement: AstNode): EsmExportedName[] {
  const names: EsmExportedName[] = [];
  for (const child of exportStatement.children) {
    if (child.type === "*") names.push({ exposed: WHOLE_MODULE_EXPORT_NAME, forwarded: WHOLE_MODULE_EXPORT_NAME });
    else if (child.type === "namespace_export") {
      const exposed = specifierName(child.namedChildren[0] ?? null) ?? WHOLE_MODULE_EXPORT_NAME;
      names.push({ exposed, forwarded: WHOLE_MODULE_EXPORT_NAME });
    } else if (child.type === "export_clause") {
      for (const spec of child.children) {
        if (spec.type !== "export_specifier") continue;
        const forwarded = specifierName(spec.childForFieldName("name"));
        if (!forwarded) continue;
        names.push({ exposed: specifierName(spec.childForFieldName("alias")) ?? forwarded, forwarded });
      }
    }
  }
  return names;
}

/**
 * The local bindings an import statement introduces, each with the target
 * name it stands for: `import D, { a as b } from` → `D→default, b→a`;
 * `import * as ns from` → `ns→*`. The local-side twin of
 * {@link esmImportExportNames}.
 */
export function esmImportLocalBindings(importStatement: AstNode): { local: string; target: string }[] {
  const clause = importStatement.children.find((c) => c.type === "import_clause");
  if (!clause) return [];
  const bindings: { local: string; target: string }[] = [];
  for (const child of clause.children) {
    if (child.type === "identifier") bindings.push({ local: child.text, target: DEFAULT_EXPORT_NAME });
    else if (child.type === "namespace_import") {
      const local = child.namedChildren.find((c) => c.type === "identifier");
      if (local) bindings.push({ local: local.text, target: WHOLE_MODULE_EXPORT_NAME });
    } else if (child.type === "named_imports") {
      for (const spec of child.children) {
        if (spec.type !== "import_specifier") continue;
        const target = specifierName(spec.childForFieldName("name"));
        if (!target) continue;
        bindings.push({ local: specifierName(spec.childForFieldName("alias")) ?? target, target });
      }
    }
  }
  return bindings;
}

/**
 * Spread-ready re-export facts of one reference (bd tea-rags-mcp-zl3so):
 * `reexportedExportNames` = the distinct target names forwarded (`*` alone
 * when the whole module is), plus `reexportedExportBindings` — the complete
 * exposed→target table — only when some name is exposed under another
 * spelling. Nothing when `names` is empty.
 */
export function reexportNamesFields(
  names: readonly EsmExportedName[],
): Pick<ImportRef, "reexportedExportNames" | "reexportedExportBindings"> {
  if (names.length === 0) return {};
  const forwarded = [...new Set(names.map((n) => n.forwarded))];
  const reexportedExportNames = forwarded.includes(WHOLE_MODULE_EXPORT_NAME) ? [WHOLE_MODULE_EXPORT_NAME] : forwarded;
  if (names.every((n) => n.exposed === n.forwarded)) return { reexportedExportNames };
  const bindings = createIdentifierRecord<string>();
  for (const { exposed, forwarded: target } of names) bindings[exposed] = target;
  return { reexportedExportNames, reexportedExportBindings: bindings };
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
