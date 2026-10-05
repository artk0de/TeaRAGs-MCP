/**
 * P3 descriptor members (bd tea-rags-mcp-m99j1.1.20) — a method decorated with
 * a DESCRIPTOR decorator is recorded as the class FIELD it reads as.
 *
 * `@cached_property def output_field(self) -> Field` makes `self.output_field`
 * a `Field`, exactly as `self.output_field = Field()` would. So the fact lands
 * on the two channels such an assignment writes — `classFieldTypes` under the
 * class's short name and `classFieldTypesByClassKey` under
 * `<relPath>::<dotted class FQ>` — and every field reader (the `self.x.m()`
 * strategy, the chain fold's attribute hop, the MRO walk) answers for it with
 * no new channel. The resolver's attribute hop reads fields only, which is what
 * keeps a PLAIN method accessed without a call untyped.
 *
 * Merged UNDER the native walker: `mergeExtraction` lets the base win a nested
 * key, so a field the class also assigns keeps the assignment's type — a typed
 * binding outranks a derived one.
 *
 * The type is the def's return, read the way the type sources read it: the
 * annotation through `pythonTypeRefFromNode`, else the `ast` source's
 * return-expression inference. Either must name ONE nominal class; a union or
 * a container records nothing, because a field is a bare string with nowhere
 * to carry arms — a value that does not fold is untyped, never typed by
 * presence.
 *
 * A decorator qualifies by its QUALIFIED spelling, composed from the file's
 * module-level imports (`from functools import cached_property` →
 * `functools.cached_property`). A relative import composes nothing, so its
 * decorator stays unqualified and matches only a builtin spelling.
 */

import { createIdentifierRecord } from "../../../../../contracts/identifier-record.js";
import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { FileExtraction } from "../../../../../contracts/types/codegraph.js";
import type { ExtractionFacetPass } from "../../../kernel/index.js";
import { pythonDescriptorDecorators } from "../../vocabulary/descriptors.js";
import { pythonInferredReturnReader } from "./python-ast-type-source.js";
import { pythonAnnotationExpression, walkPythonScopes } from "./python-def-scope-walk.js";
import { isPythonMethodDef } from "./python-def-signatures.js";
import { pythonNominalReceiverName, pythonTypeRefFromNode } from "./python-type-annotation.js";

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
function pythonModuleImportBindings(root: AstNode): Map<string, string> {
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

/** Does the def's `decorated_definition` carry a decorator in `descriptors`? */
function isAttributeDescriptor(
  def: AstNode,
  bindings: ReadonlyMap<string, string>,
  descriptors: ReadonlySet<string>,
): boolean {
  const decorated = def.parent;
  if (decorated?.type !== "decorated_definition") return false;
  for (const child of decorated.namedChildren) {
    if (child.type !== "decorator") continue;
    const qualified = qualifiedDecorator(child, bindings);
    if (qualified !== null && descriptors.has(qualified)) return true;
  }
  return false;
}

/** The one nominal class a def returns — annotated, else inferred — or undefined. */
function descriptorFieldType(
  def: AstNode,
  selfClass: string,
  inferReturn: ReturnType<typeof pythonInferredReturnReader>,
): string | undefined {
  const returnType = def.childForFieldName("return_type");
  if (returnType === null) return inferReturn(def, selfClass) ?? undefined;
  const ref = pythonTypeRefFromNode(pythonAnnotationExpression(returnType), selfClass);
  return ref === undefined ? undefined : pythonNominalReceiverName(ref);
}

function setField(
  channel: Record<string, Record<string, string>>,
  key: string,
  field: string,
  fieldType: string,
): void {
  channel[key] ??= createIdentifierRecord();
  channel[key][field] = fieldType;
}

export const pythonDescriptorMembersFacetPass: ExtractionFacetPass = {
  run: (root, ctx): Partial<FileExtraction> => {
    const descriptors = pythonDescriptorDecorators(ctx.declaredDependencies);
    let bindings: Map<string, string> | undefined;
    const inferReturn = pythonInferredReturnReader(root);
    const byShortName: Record<string, Record<string, string>> = createIdentifierRecord();
    const byClassKey: Record<string, Record<string, string>> = createIdentifierRecord();
    walkPythonScopes(root, {
      onDef: (site) => {
        // Cheapest test first: an undecorated def, or one outside a class body,
        // never reaches the import scan.
        if (site.decorators.length === 0 || !isPythonMethodDef(site.node)) return;
        bindings ??= pythonModuleImportBindings(root);
        if (!isAttributeDescriptor(site.node, bindings, descriptors)) return;
        const selfClass = site.classChain[site.classChain.length - 1];
        const fieldType = descriptorFieldType(site.node, selfClass, inferReturn);
        if (fieldType === undefined) return;
        setField(byShortName, selfClass, site.name, fieldType);
        setField(byClassKey, `${ctx.relPath}::${site.classChain.join(".")}`, site.name, fieldType);
      },
    });
    if (Object.keys(byShortName).length === 0) return {};
    return { classFieldTypes: byShortName, classFieldTypesByClassKey: byClassKey };
  },
};
