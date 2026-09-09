/**
 * Iteration-variable typing (E2 seam 5 / R3, bd tea-rags-mcp-9fgdi) —
 * `for item in self.items:` where `items: list[Item]` binds `item` as an `Item`
 * at the loop line. Measured hole: netbox `dynamic` 18, polar 53 across three
 * kinds, httpx 4.
 *
 * The container → element mapping is the one the annotation parser already
 * owns; this reads it in the ITERATION direction, and that direction is where
 * `dict` parts company with the rest. `pythonTypeRefFromNode` renders
 * `dict[K, V]` as `container(V)` because SUBSCRIPTING a dict yields the value,
 * but ITERATING one yields the KEYS — and `TypeRef`'s container form carries a
 * single `element` and no key slot (`kernel/type-ref.ts:40`). So a bare
 * `for k in mapping:` is DECLINED outright rather than widening the algebra for
 * a row count the attribution never attributed to it. `.values()` is the same
 * mapping read the subscript rule already performs and is typed; `.items()`
 * yields a 2-tuple and is declined, as is every other call — a tuple target is
 * not a single nominal receiver and this seam does not destructure.
 *
 * The annotation must be a DIRECT subscript. `Optional[list[Row]]` collapses to
 * `container(Row)` just as `Optional[dict[str, Row]]` does, and at that point
 * nothing distinguishes the sequence element from the mapping value — so the
 * wrapper forms are declined, which is the precision-first reading and the one
 * the phantom gate can defend.
 *
 * Emitted under the `ast` source, the lowest Python rank, so an explicit
 * `item: Item` annotation on the same coordinate outranks it.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { TypeRef } from "../../../../../contracts/types/language.js";
import type { InlineTypeSource, TypeFact } from "../../../kernel/type-facts.js";
import type { PythonTypeSourceInput } from "./python-annotation-type-source.js";
import { pythonAnnotationExpression, walkPythonScopes, type PythonForStatementSite } from "./python-def-scope-walk.js";
import {
  PYTHON_CONTAINER_FIRST,
  PYTHON_CONTAINER_LAST,
  pythonBareTypeName,
  pythonNominalReceiverName,
  pythonTypeRefFromNode,
} from "./python-type-annotation.js";

/**
 * Python's third type source: what the walker infers from the AST itself,
 * outranked by both `annotations` and `docstring`. The rank was reserved in
 * `PYTHON_TYPE_SOURCE_ORDER` before any source claimed it.
 */
export const PYTHON_AST_SOURCE = "ast";

/** One annotated binding, kept with its line so a later re-annotation cannot type an earlier loop. */
interface PythonAnnotatedBinding {
  readonly annotation: AstNode;
  readonly line: number;
}

/** `self.<attr>` annotations keyed by class chain; names keyed by class chain + def. */
interface PythonAnnotationIndex {
  readonly fields: Map<string, Map<string, PythonAnnotatedBinding[]>>;
  readonly names: Map<string, Map<string, PythonAnnotatedBinding[]>>;
}

const scopeKey = (classChain: readonly string[], methodName: string): string => `${classChain.join(".")}|${methodName}`;

function pushBinding(
  index: Map<string, Map<string, PythonAnnotatedBinding[]>>,
  key: string,
  name: string,
  binding: PythonAnnotatedBinding,
): void {
  const forScope = index.get(key) ?? new Map<string, PythonAnnotatedBinding[]>();
  index.set(key, forScope);
  const list = forScope.get(name) ?? [];
  forScope.set(name, list);
  list.push(binding);
}

/** The last annotation at or above `atLine`; class fields pass `Infinity` because a field has no order. */
function bindingAt(bindings: PythonAnnotatedBinding[] | undefined, atLine: number): AstNode | undefined {
  let best: PythonAnnotatedBinding | undefined;
  for (const binding of bindings ?? []) {
    if (binding.line > atLine) continue;
    if (best === undefined || binding.line >= best.line) best = binding;
  }
  return best?.annotation;
}

/** The arguments of a subscripted annotation, read positionally exactly as `pythonTypeRefFromNode` reads them. */
function subscriptArgNodes(node: AstNode): readonly AstNode[] {
  const rest = node.namedChildren.slice(1);
  return rest.length === 1 && rest[0].type === "type_parameter" ? rest[0].namedChildren : rest;
}

/** The bare base name of a DIRECT subscript annotation; undefined for every other shape. */
function subscriptBaseName(node: AstNode): string | undefined {
  if (node.type !== "subscript" && node.type !== "generic_type") return undefined;
  const value = node.childForFieldName("value") ?? node.namedChild(0);
  return value === null ? undefined : pythonBareTypeName(value.text);
}

/**
 * `tuple[A, B]` is heterogeneous and iterating it yields `A | B`, which is no
 * single nominal. Only the one-argument and `[T, ...]` spellings are containers
 * in the iteration sense.
 */
function homogeneousTupleAnnotation(node: AstNode): boolean {
  const args = subscriptArgNodes(node);
  if (args.length === 1) return true;
  if (args.length !== 2) return false;
  const second = pythonAnnotationExpression(args[1]);
  return second.type === "ellipsis";
}

/**
 * The element an annotated container yields when iterated, or `undefined`.
 * `wantValues` is set by a `.values()` receiver and REQUIRES a mapping base;
 * a bare iteration requires the opposite, which is what declines dict keys.
 */
function iterationElementOf(
  annotation: AstNode,
  selfClass: string | undefined,
  wantValues: boolean,
): TypeRef | undefined {
  const base = subscriptBaseName(annotation);
  if (base === undefined) return undefined;
  if (!(wantValues ? PYTHON_CONTAINER_LAST : PYTHON_CONTAINER_FIRST).has(base)) return undefined;
  if ((base === "tuple" || base === "Tuple") && !homogeneousTupleAnnotation(annotation)) return undefined;
  const ref = pythonTypeRefFromNode(annotation, selfClass);
  if (ref?.form !== "container") return undefined;
  return pythonNominalReceiverName(ref.element) === undefined ? undefined : ref.element;
}

/** `self.<attr>` through the field index, a bare name through the enclosing def's index; nothing else. */
function iterableAnnotationOf(
  node: AstNode,
  site: PythonForStatementSite,
  methodName: string,
  index: PythonAnnotationIndex,
): AstNode | undefined {
  if (node.type === "identifier") {
    return bindingAt(index.names.get(scopeKey(site.classChain, methodName))?.get(node.text), site.line);
  }
  if (node.type !== "attribute") return undefined;
  const object = node.childForFieldName("object");
  const attribute = node.childForFieldName("attribute");
  if (object?.type !== "identifier" || object.text !== "self" || attribute === null) return undefined;
  if (site.classChain.length === 0) return undefined;
  // A field has no order relative to the loop: it may be declared in the class
  // body below the method, or assigned in a method that runs first.
  return bindingAt(index.fields.get(site.classChain.join("."))?.get(attribute.text), Infinity);
}

function iterationFactFor(site: PythonForStatementSite, index: PythonAnnotationIndex): TypeFact | undefined {
  const { methodName } = site;
  // Module level has no `methodName` coordinate, and a `local` fact keyed
  // without one would speak for every def in the file.
  if (methodName === undefined) return undefined;
  const target = site.node.childForFieldName("left");
  if (target?.type !== "identifier") return undefined;
  let iterable = site.node.childForFieldName("right");
  if (iterable === null) return undefined;
  let wantValues = false;
  if (iterable.type === "call") {
    const fn = iterable.childForFieldName("function");
    if (fn?.type !== "attribute" || fn.childForFieldName("attribute")?.text !== "values") return undefined;
    const object = fn.childForFieldName("object");
    if (object === null) return undefined;
    wantValues = true;
    iterable = object;
  }
  const annotation = iterableAnnotationOf(iterable, site, methodName, index);
  if (annotation === undefined) return undefined;
  const element = iterationElementOf(annotation, site.classChain[site.classChain.length - 1], wantValues);
  if (element === undefined) return undefined;
  return {
    kind: "local",
    source: PYTHON_AST_SOURCE,
    symbolScope: [...site.classChain],
    methodName,
    name: target.text,
    line: site.line,
    type: element,
  };
}

/**
 * ONE descent collects both halves — a loop can precede the annotation that
 * types it (a class-body field below the method, a parameter of an enclosing
 * def) — so the sites are folded after the walk rather than during it.
 */
function extractPythonIterationFacts(input: PythonTypeSourceInput): TypeFact[] {
  if (!input.trackLocalTypes) return [];
  const index: PythonAnnotationIndex = { fields: new Map(), names: new Map() };
  const sites: PythonForStatementSite[] = [];
  walkPythonScopes(input.root, {
    onDef: (site) => {
      const params = site.node.childForFieldName("parameters");
      for (const param of params?.namedChildren ?? []) {
        if (param.type !== "typed_parameter" && param.type !== "typed_default_parameter") continue;
        const typeField = param.childForFieldName("type");
        const nameNode = param.childForFieldName("name") ?? param.namedChild(0);
        if (typeField === null || nameNode?.type !== "identifier") continue;
        pushBinding(index.names, scopeKey(site.classChain, site.name), nameNode.text, {
          annotation: pythonAnnotationExpression(typeField),
          line: site.line,
        });
      }
    },
    onAnnotatedAssignment: (site) => {
      const typeField = site.node.childForFieldName("type");
      const lhs = site.node.namedChild(0);
      if (typeField === null || lhs === null) return;
      const binding: PythonAnnotatedBinding = { annotation: pythonAnnotationExpression(typeField), line: site.line };
      if (lhs.type === "attribute") {
        const object = lhs.childForFieldName("object");
        const attribute = lhs.childForFieldName("attribute");
        if (object?.type !== "identifier" || object.text !== "self" || attribute === null) return;
        if (site.classChain.length > 0) pushBinding(index.fields, site.classChain.join("."), attribute.text, binding);
        return;
      }
      if (lhs.type !== "identifier") return;
      if (site.methodName === undefined) {
        // Class body — a declared attribute, reachable through `self`.
        if (site.classChain.length > 0) pushBinding(index.fields, site.classChain.join("."), lhs.text, binding);
        return;
      }
      pushBinding(index.names, scopeKey(site.classChain, site.methodName), lhs.text, binding);
    },
    onForStatement: (site) => {
      sites.push(site);
    },
  });
  const facts: TypeFact[] = [];
  for (const site of sites) {
    const fact = iterationFactFor(site, index);
    if (fact !== undefined) facts.push(fact);
  }
  return facts;
}

export const pythonIterationTypeSource: InlineTypeSource<PythonTypeSourceInput> = {
  name: PYTHON_AST_SOURCE,
  extract: extractPythonIterationFacts,
};
