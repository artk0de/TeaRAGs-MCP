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
import { pythonDefHasQualifiedDecorator, pythonModuleImportBindings } from "./python-qualified-decorators.js";
import { pythonNominalReceiverName, pythonTypeRefFromNode } from "./python-type-annotation.js";

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
        if (!pythonDefHasQualifiedDecorator(site.node, bindings, descriptors)) return;
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
