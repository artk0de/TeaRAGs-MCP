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
import type { TypeRef } from "../../../../../contracts/types/language.js";
import { typeRefReceiverForm, type InlineTypeSource, type TypeFact } from "../../../kernel/index.js";
import { PYTHON_GENERATOR_CONTEXT_MANAGERS } from "../../generator-context-manager-marker.js";
import {
  isPythonClassFormDef,
  pythonAnnotationExpression,
  walkPythonScopes,
  type PythonAnnotatedAssignmentSite,
  type PythonDefSite,
} from "./python-def-scope-walk.js";
import { pythonModuleImportBindings, pythonQualifiedDecorators } from "./python-qualified-decorators.js";
import { PYTHON_SELF_RETURN, pythonNominalReceiverName, pythonTypeRefFromNode } from "./python-type-annotation.js";

export const PYTHON_ANNOTATION_SOURCE = "annotations";

export interface PythonTypeSourceInput {
  readonly root: AstNode;
  /** `CODEGRAPH_PY_LOCAL_TYPE_TRACKING`, read once by the pass. Gates `param` / `local` only. */
  readonly trackLocalTypes: boolean;
  /** `CODEGRAPH_PY_MODULE_VALUES`, read once by the pass. Gates `moduleValue` facts only; absent = off. */
  readonly moduleValues?: boolean;
  /**
   * A written class spelling → the one the file's imports bind it to
   * (`utils.CursorWrapper` → `db.backends.utils::CursorWrapper`), bare for a
   * same-file class or builtin (bd tea-rags-mcp-m99j1.1.55). Read by the `ast`
   * source's return publish and by this source's multi-arm union `param` /
   * `local` facts (bd tea-rags-mcp-m99j1.1.30); absent = arms stay bare.
   */
  readonly qualifyTypeName?: (written: string) => string;
}

export interface PythonTypedParam {
  readonly name: string;
  readonly annotation: AstNode;
}

export function pythonTypedParameters(fn: AstNode): PythonTypedParam[] {
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

const BARE_IDENTIFIER = /^[A-Za-z_]\w*$/;
const CLASS_OBJECT_ANNOTATION = /^(?:typing\.)?[Tt]ype\[(.+)\]$/;

/** `"T"` and `T` name the same thing; a forward-reference quote is not a different type. */
function unquoted(text: string): string {
  const trimmed = text.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
}

/**
 * `def m(self: T) -> T` — a return that names the FIRST parameter's own
 * annotation — is a `Self` return spelled with a TypeVar (httpx's
 * `Client.__enter__`, bd tea-rags-mcp-m99j1.1.44). Whatever the receiver is,
 * the return is too, so it records the {@link PYTHON_SELF_RETURN} marker exactly
 * as `-> Self` does; the reader substitutes the receiver's class. Purely
 * syntactic on purpose: no TypeVar table and no `bound=` lookup, because the
 * substitution is the right answer for a self-typed TypeVar whatever its bound.
 *
 * `@classmethod def m(cls: type[T]) -> T` is the same rule one level up. Only a
 * def declared in a class body qualifies, and a `@staticmethod` has no self
 * parameter to read.
 */
function isSelfTypedReturn(site: PythonDefSite, returnExpression: AstNode): boolean {
  if (site.classChain.length === 0 || site.decorators.includes("staticmethod")) return false;
  const first = site.node.childForFieldName("parameters")?.namedChildren[0];
  if (first?.type !== "typed_parameter" && first?.type !== "typed_default_parameter") return false;
  const typeField = first.childForFieldName("type");
  if (typeField === null) return false;
  let annotation = unquoted(pythonAnnotationExpression(typeField).text);
  if (site.decorators.includes("classmethod")) {
    const inner = CLASS_OBJECT_ANNOTATION.exec(annotation)?.[1];
    if (inner === undefined) return false;
    annotation = unquoted(inner);
  }
  return BARE_IDENTIFIER.test(annotation) && annotation === unquoted(returnExpression.text);
}

/** The generator protocols a `@contextmanager` / `@asynccontextmanager` def may declare. */
const GENERATOR_RETURN = /^(?:typing\.|collections\.abc\.)?(?:Async)?(?:Iterator|Generator)\s*\[/;

/**
 * The CALL result of a context-manager generator (bd tea-rags-mcp-m99j1.1.87),
 * or `undefined` to keep the declared return. `@contextlib.contextmanager def
 * f() -> Iterator[T]` returns a `_GeneratorContextManager[T]`, recorded as
 * that manager carrying `T` ({@link PYTHON_GENERATOR_CONTEXT_MANAGERS}) so
 * `with f() as x` can bind the yielded `T`. The decorator qualifies only
 * through the file's imports — a namesake from elsewhere is not contextlib's.
 * Any shape this cannot read — a non-generator return, a `None` element —
 * keeps the declared return, exactly as before.
 */
function generatorContextManagerReturn(
  site: PythonDefSite,
  returnExpression: AstNode,
  declared: TypeRef | undefined,
  importBindings: () => ReadonlyMap<string, string>,
): TypeRef | undefined {
  if (!site.decorators.some((name) => GENERATOR_DECORATOR_NAMES.has(name))) return undefined;
  if (declared?.form !== "container" || declared.element.form === "nil") return undefined;
  if (!GENERATOR_RETURN.test(returnExpression.text)) return undefined;
  for (const qualified of pythonQualifiedDecorators(site.node, importBindings())) {
    const manager = PYTHON_GENERATOR_CONTEXT_MANAGERS.get(qualified);
    if (manager !== undefined) return { form: "instance", name: manager, args: [declared.element] };
  }
  return undefined;
}

/** The decorators' bare names, as {@link PythonDefSite.decorators} spells them — a cheap pre-gate. */
const GENERATOR_DECORATOR_NAMES: ReadonlySet<string> = new Set(
  [...PYTHON_GENERATOR_CONTEXT_MANAGERS.keys()].map((qualified) => qualified.slice(qualified.lastIndexOf(".") + 1)),
);

function extractPythonAnnotationFacts(input: PythonTypeSourceInput): TypeFact[] {
  const facts: TypeFact[] = [];
  let bindings: ReadonlyMap<string, string> | undefined;
  const importBindings = (): ReadonlyMap<string, string> => (bindings ??= pythonModuleImportBindings(input.root));
  walkPythonScopes(input.root, {
    onDef: (site) => {
      const selfClass = site.classChain[site.classChain.length - 1];
      if (input.trackLocalTypes) {
        for (const param of pythonTypedParameters(site.node)) {
          if (walkerAlreadyBinds(param.annotation)) continue;
          const ref = pythonBindingTypeRef(
            param.annotation,
            pythonTypeRefFromNode(param.annotation, selfClass),
            input.qualifyTypeName,
          );
          if (ref === undefined) continue;
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
      // `Self` resolves to the MARKER here, not to `selfClass`: on a return it
      // means the class the RECEIVER names, which only the resolver knows.
      // See {@link PYTHON_SELF_RETURN}.
      const returnExpression = pythonAnnotationExpression(returnType);
      const declared = isSelfTypedReturn(site, returnExpression)
        ? ({ form: "instance", name: PYTHON_SELF_RETURN } as const)
        : pythonTypeRefFromNode(returnExpression, selfClass === undefined ? undefined : PYTHON_SELF_RETURN);
      const ref = generatorContextManagerReturn(site, returnExpression, declared, importBindings) ?? declared;
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
      pushAssignmentFact(facts, site, input);
    },
  });
  return facts;
}

/**
 * The ref a `param` / `local` fact carries, or `undefined` to emit none.
 *
 * One reachable nominal arm (`Foo`, `Optional[Foo]`) passes UNCHANGED — the
 * shape every existing binding has. A union of two or more reachable arms
 * (`A | B`, `Union[A, B]`, `A | B | None`) passes only when every non-nil arm is
 * an INSTANCE of a named class, and then each arm is qualified through the
 * file's imports exactly as an inferred return arm is (bd
 * tea-rags-mcp-m99j1.1.55), so the resolver places it by the declaring file and
 * an arm it cannot place kills the whole fact (bd tea-rags-mcp-m99j1.1.30). A
 * container or class-object arm declines: per arm it names no receiver.
 */
function pythonBindingTypeRef(
  annotation: AstNode,
  ref: TypeRef | undefined,
  qualifyTypeName: ((written: string) => string) | undefined,
): TypeRef | undefined {
  if (ref === undefined) return undefined;
  if (pythonNominalReceiverName(ref) !== undefined) return ref;
  if (typeRefReceiverForm(ref)?.form !== "union" || ref.form !== "union") return undefined;
  const written = qualifyTypeName === undefined ? undefined : writtenArmSpellings(annotation);
  const members: TypeRef[] = [];
  for (const arm of ref.members) {
    if (arm.form === "nil") {
      members.push(arm);
      continue;
    }
    if (arm.form !== "instance") return undefined;
    const spelling = written?.get(arm.name);
    members.push(qualifyTypeName === undefined ? arm : { ...arm, name: qualifyTypeName(spelling ?? arm.name) });
  }
  return { ...ref, members };
}

/**
 * Bare class name → the spelling the annotation WROTE it with
 * (`models.Bar` → `Bar` maps back to `models.Bar`). The ref keeps only the bare
 * name, and the qualifier needs the module the spelling goes through. A bare
 * name written two different ways in one annotation maps to nothing — the arm
 * stays bare and the resolver places it by the bare rules.
 */
function writtenArmSpellings(annotation: AstNode): Map<string, string> {
  const spellings = new Map<string, string>();
  const conflicting = new Set<string>();
  const record = (text: string): void => {
    const bare = text.slice(text.lastIndexOf(".") + 1);
    const seen = spellings.get(bare);
    if (seen !== undefined && seen !== text) conflicting.add(bare);
    spellings.set(bare, text);
  };
  const descend = (node: AstNode): void => {
    if (node.type === "identifier" || node.type === "attribute") {
      record(node.text);
      return;
    }
    for (const child of node.namedChildren) descend(child);
  };
  descend(annotation);
  for (const bare of conflicting) spellings.delete(bare);
  return spellings;
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
  for (const param of pythonTypedParameters(site.node)) annotated.set(param.name, param.annotation);
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
function pushAssignmentFact(
  facts: TypeFact[],
  site: PythonAnnotatedAssignmentSite,
  input: Pick<PythonTypeSourceInput, "trackLocalTypes" | "qualifyTypeName">,
): void {
  const typeField = site.node.childForFieldName("type");
  if (typeField === null) return;
  const annotation = pythonAnnotationExpression(typeField);
  const selfClass = site.classChain[site.classChain.length - 1];
  const ref = pythonTypeRefFromNode(annotation, selfClass);
  if (ref === undefined) return;
  const lhs = site.node.namedChild(0);
  if (lhs === null) return;
  const nominal = pythonNominalReceiverName(ref);
  if (nominal === undefined) {
    pushLocalFact(facts, site, lhs, annotation, pythonBindingTypeRef(annotation, ref, input.qualifyTypeName), input);
    return;
  }
  const attributeFact = (name: string): TypeFact => ({
    kind: "ivar",
    source: PYTHON_ANNOTATION_SOURCE,
    symbolScope: [...site.classChain],
    name,
    line: site.line,
    type: { form: "instance", name: nominal },
  });

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
  pushLocalFact(facts, site, lhs, annotation, ref, input);
}

/**
 * `x: T` inside a function, for a ref {@link pythonBindingTypeRef} admitted.
 * A union reaches here only from an identifier LHS inside a def: an attribute
 * fact has no channel that carries arms, so `self.x: A | B` stays silent.
 */
function pushLocalFact(
  facts: TypeFact[],
  site: PythonAnnotatedAssignmentSite,
  lhs: AstNode,
  annotation: AstNode,
  ref: TypeRef | undefined,
  input: Pick<PythonTypeSourceInput, "trackLocalTypes">,
): void {
  if (ref === undefined || lhs.type !== "identifier" || site.methodName === undefined) return;
  if (!input.trackLocalTypes || walkerAlreadyBinds(annotation)) return;
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
