/**
 * The `annotations` type source: PEP 484 / 526 / 604 annotations → `TypeFact`s
 * (E2 seam 2, bd tea-rags-mcp-9fgdi). The largest recall lever in the E0
 * baseline — `annotationReturn` carries 2,955 of the 4,509 losses.
 *
 * It emits only what the native walker declines. `extractTypeName`
 * (`walker/walker.ts:447`) answers for a bare `identifier` and a dotted
 * `attribute` and returns `null` for everything else, so the walker already
 * binds `x: Foo` and `x: mod.Foo` and drops `Optional[Foo]`, `list[Foo]`,
 * `Foo | Bar` and `"Foo"`. Re-emitting the two shapes it handles would only
 * duplicate a binding — `mergeLocalBindings` concatenates, it does not dedupe
 * (`kernel/merge-extraction.ts:70`) — so those two node types are skipped.
 * `ivar` and `return` facts have no such gate: their channels union by key.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { InlineTypeSource, TypeFact } from "../../../kernel/type-facts.js";
import {
  isPythonClassFormDef,
  pythonAnnotationExpression,
  walkPythonScopes,
  type PythonAnnotatedAssignmentSite,
  type PythonDefSite,
} from "./python-def-scope-walk.js";
import { pythonNominalReceiverName, pythonTypeRefFromNode } from "./python-type-annotation.js";

export const PYTHON_ANNOTATION_SOURCE = "annotations";

export interface PythonTypeSourceInput {
  readonly root: AstNode;
  /** `CODEGRAPH_PY_LOCAL_TYPE_TRACKING`, read once by the pass. Gates `param` / `local` only. */
  readonly trackLocalTypes: boolean;
}

interface PythonTypedParam {
  readonly name: string;
  readonly annotation: AstNode;
}

function typedParameters(fn: AstNode): PythonTypedParam[] {
  const params = fn.childForFieldName("parameters");
  if (params === null) return [];
  const out: PythonTypedParam[] = [];
  for (const param of params.namedChildren) {
    if (param.type !== "typed_parameter" && param.type !== "typed_default_parameter") continue;
    const typeField = param.childForFieldName("type");
    if (typeField === null) continue;
    // `typed_default_parameter` names the identifier; `typed_parameter` puts the
    // pattern first. A `*args: int` / `**kw: Any` pattern is not an identifier
    // and is skipped — a splat binds a tuple / dict, never the annotated type.
    const nameNode = param.childForFieldName("name") ?? param.namedChild(0);
    if (nameNode?.type !== "identifier") continue;
    out.push({ name: nameNode.text, annotation: pythonAnnotationExpression(typeField) });
  }
  return out;
}

/** The walker already binds these two shapes; only what it declines is new. */
function walkerAlreadyBinds(annotation: AstNode): boolean {
  return annotation.type === "identifier" || annotation.type === "attribute";
}

function extractPythonAnnotationFacts(input: PythonTypeSourceInput): TypeFact[] {
  const facts: TypeFact[] = [];
  walkPythonScopes(input.root, {
    onDef: (site) => {
      const selfClass = site.classChain[site.classChain.length - 1];
      if (input.trackLocalTypes) {
        for (const param of typedParameters(site.node)) {
          if (walkerAlreadyBinds(param.annotation)) continue;
          const ref = pythonTypeRefFromNode(param.annotation, selfClass);
          if (ref === undefined || pythonNominalReceiverName(ref) === undefined) continue;
          facts.push({
            kind: "param",
            source: PYTHON_ANNOTATION_SOURCE,
            symbolScope: [...site.classChain],
            methodName: site.name,
            name: param.name,
            // The `def` line, ALWAYS — a signature spanning lines must not put
            // one parameter's binding below another's, and the docstring source
            // has to be able to collide with this coordinate.
            line: site.line,
            type: ref,
          });
        }
      }
      pushParameterFieldFacts(facts, site);
      const returnType = site.node.childForFieldName("return_type");
      if (returnType === null) return;
      const ref = pythonTypeRefFromNode(pythonAnnotationExpression(returnType), selfClass);
      // A nil-only ref states "no receiver" and no consumer reads that yet;
      // emitting it would put a `-> None` entry on every annotated def.
      if (ref === undefined || ref.form === "nil") return;
      const fact: TypeFact = {
        kind: "return",
        source: PYTHON_ANNOTATION_SOURCE,
        symbolScope: [...site.classChain],
        methodName: site.name,
        type: ref,
      };
      if (isPythonClassFormDef(site.decorators)) fact.classForm = true;
      facts.push(fact);
    },
    onAnnotatedAssignment: (site) => {
      pushAssignmentFact(facts, site, input.trackLocalTypes);
    },
  });
  return facts;
}

/**
 * `self.<field> = <annotated parameter>` inside a method → an `ivar` fact
 * (bd tea-rags-mcp-f0xaa).
 *
 * The largest single field shape in the measured corpora and the one the native
 * walker declines by construction: `collectPythonClassFieldTypes` records a
 * field only when the RHS is a constructor CALL, and polar's
 * `SyncServiceBase.__init__` writes `self.client = client` where `client:
 * SyncClientBase` is a parameter — 1,504 `chain` rows on that corpus alone.
 *
 * Deliberately narrow, because a field type feeds a resolver that pins EDGES:
 *
 *   - ONE hop. `self.x = param` only; `self.x = param.attr` and
 *     `self.x = param or Default()` are not this shape and record nothing.
 *   - ONE nominal arm. A parameter annotated `Conn | None` or `Union[A, B]`
 *     collapses to no single receiver, and `classFieldTypes` is a bare string
 *     map with nowhere to carry the arms — so it is dropped, not guessed.
 *   - Any method, not only `__init__` (the walker already tolerates a field
 *     bound outside the constructor, bd rjuc).
 *
 * NOT gated on `trackLocalTypes`: that flag governs `param` / `local` facts, and
 * this is a class ATTRIBUTE — the same channel a class-body `x: T` writes.
 */
function pushParameterFieldFacts(facts: TypeFact[], site: PythonDefSite): void {
  if (site.classChain.length === 0) return;
  const body = site.node.childForFieldName("body");
  if (body === null) return;
  const annotated = new Map<string, AstNode>();
  for (const param of typedParameters(site.node)) annotated.set(param.name, param.annotation);
  if (annotated.size === 0) return;
  const selfClass = site.classChain[site.classChain.length - 1];
  for (const assignment of selfFieldParameterAssignments(body)) {
    const annotation = annotated.get(assignment.parameter);
    if (annotation === undefined) continue;
    const ref = pythonTypeRefFromNode(annotation, selfClass);
    if (ref === undefined) continue;
    const nominal = pythonNominalReceiverName(ref);
    if (nominal === undefined) continue;
    facts.push({
      kind: "ivar",
      source: PYTHON_ANNOTATION_SOURCE,
      symbolScope: [...site.classChain],
      name: assignment.field,
      line: assignment.line,
      type: { form: "instance", name: nominal },
    });
  }
}

/**
 * Every `self.<field> = <bare identifier>` in a def's body, NOT descending into
 * a nested `def` / `class` — a nested def's `self` is its own scope's, and that
 * def gets its own `onDef` visit with its own parameter list.
 */
function selfFieldParameterAssignments(
  body: AstNode,
): { readonly field: string; readonly parameter: string; readonly line: number }[] {
  const out: { field: string; parameter: string; line: number }[] = [];
  const descend = (node: AstNode): void => {
    if (node.type === "function_definition" || node.type === "class_definition") return;
    if (node.type === "assignment" && node.childForFieldName("type") === null) {
      const lhs = node.childForFieldName("left");
      const rhs = node.childForFieldName("right");
      if (lhs?.type === "attribute" && rhs?.type === "identifier") {
        const object = lhs.childForFieldName("object");
        const attribute = lhs.childForFieldName("attribute");
        if (object?.type === "identifier" && object.text === "self" && attribute !== null) {
          out.push({ field: attribute.text, parameter: rhs.text, line: node.startPosition.row + 1 });
        }
      }
    }
    for (const child of node.namedChildren) descend(child);
  };
  for (const child of body.namedChildren) descend(child);
  return out;
}

export const pythonAnnotationTypeSource: InlineTypeSource<PythonTypeSourceInput> = {
  name: PYTHON_ANNOTATION_SOURCE,
  extract: extractPythonAnnotationFacts,
};

/**
 * `x: T` inside a function is a LOCAL; `self.x: T` and a class-body `x: T` are
 * both class ATTRIBUTES. The last one is the case the walker cannot see at all:
 * `collectPythonClassFieldTypes` requires an `attribute` LHS whose object is
 * `self` (`walker/walker.ts:215`), so a dataclass / pydantic / Django field
 * declared in the class body reaches `classFieldTypes` only through here.
 *
 * An attribute fact stores the COLLAPSED nominal ref, not the original.
 * `ivarTypesMap` reduces its value with `refToName`, which answers `undefined`
 * for a union and drops the entry silently (`kernel/type-fact-store.ts:24`), and
 * `classFieldTypes` is a bare string map with nowhere to carry the arms anyway.
 * A local / param fact keeps the original, because `LocalBinding.typeRef` does
 * carry them.
 */
function pushAssignmentFact(facts: TypeFact[], site: PythonAnnotatedAssignmentSite, trackLocalTypes: boolean): void {
  const typeField = site.node.childForFieldName("type");
  if (typeField === null) return;
  const annotation = pythonAnnotationExpression(typeField);
  const selfClass = site.classChain[site.classChain.length - 1];
  const ref = pythonTypeRefFromNode(annotation, selfClass);
  if (ref === undefined) return;
  const nominal = pythonNominalReceiverName(ref);
  if (nominal === undefined) return;
  const attributeFact = (name: string): TypeFact => ({
    kind: "ivar",
    source: PYTHON_ANNOTATION_SOURCE,
    symbolScope: [...site.classChain],
    name,
    line: site.line,
    type: { form: "instance", name: nominal },
  });

  const lhs = site.node.namedChild(0);
  if (lhs === null) return;

  if (lhs.type === "attribute") {
    const object = lhs.childForFieldName("object");
    const attribute = lhs.childForFieldName("attribute");
    if (object?.type !== "identifier" || object.text !== "self" || attribute === null) return;
    if (site.classChain.length === 0) return;
    facts.push(attributeFact(attribute.text));
    return;
  }
  if (lhs.type !== "identifier") return;

  if (site.methodName === undefined) {
    // Class body — a declared attribute. Module level has no channel that reads it.
    if (site.classChain.length > 0) facts.push(attributeFact(lhs.text));
    return;
  }
  if (!trackLocalTypes || walkerAlreadyBinds(annotation)) return;
  facts.push({
    kind: "local",
    source: PYTHON_ANNOTATION_SOURCE,
    symbolScope: [...site.classChain],
    methodName: site.methodName,
    name: lhs.text,
    line: site.line,
    type: ref,
  });
}
