/**
 * The `ast` type source (E2 seam 5, bd tea-rags-mcp-9fgdi) — a def's return
 * type inferred from its own `return` statements, through the kernel engine.
 *
 * Ranked LAST in `PYTHON_TYPE_SOURCE_ORDER`, so an annotation or a docstring on
 * the same def always wins; the store's coordinate dedupe does that for free.
 * It exists for the 30-odd percent of project defs that carry no annotation at
 * all, whose return type is what a call-result binding needs to fold.
 *
 * Two pre-scans run ONCE per file before the emitting walk — the class field
 * table and the file's annotated top-level returns — so the pass stays O(defs)
 * and the netbox perf budget holds.
 */
import { isSameAstNode, type AstNode } from "../../../../../contracts/types/ast.js";
import type { TypeRef } from "../../../../../contracts/types/language.js";
import {
  inferReturnTypeNames,
  typeRefUnionOf,
  type InlineTypeSource,
  type ReturnArmTypes,
  type ReturnInferencePorts,
  type ReturnUnionPolicy,
  type TypeFact,
} from "../../../kernel/index.js";
import type { PythonTypeSourceInput } from "./python-annotation-type-source.js";
import { isPythonClassFormDef, pythonAnnotationExpression, walkPythonScopes } from "./python-def-scope-walk.js";
import { pythonReturnExpressionType, type PythonReturnScope } from "./python-return-expression.js";
import {
  PYTHON_SELF_RETURN,
  pythonBareTypeName,
  pythonNominalReceiverName,
  pythonTypeRefFromNode,
} from "./python-type-annotation.js";

/**
 * The rank shared by every source that reads the TREE rather than something a
 * human wrote down — this one and `python-iteration-facts.ts`. It lives here
 * because the file is named after it; both sources emit under it, and they
 * never contend because `coordinateKey` separates their fact kinds.
 */
export const PYTHON_AST_SOURCE = "ast";

/** Nodes that open a new function scope — a `return` inside one belongs to IT, not to the outer def. */
const PYTHON_NESTED_SCOPES = new Set(["function_definition", "class_definition", "lambda"]);

/** Every `return` in this def's own scope, as the expression it yields (the statement itself when bare). */
function pythonReturnTerminals(defNode: AstNode): AstNode[] {
  const out: AstNode[] = [];
  const body = defNode.childForFieldName("body");
  if (body === null) return out;
  let generator = false;
  const scan = (n: AstNode): void => {
    if (generator) return;
    if (PYTHON_NESTED_SCOPES.has(n.type)) return;
    // A generator's `return` does not name what the caller receives.
    if (n.type === "yield") {
      generator = true;
      out.length = 0;
      out.push(n);
      return;
    }
    if (n.type === "return_statement") {
      const arg = n.namedChild(0);
      out.push(arg ?? n); // a BARE `return` yields None; the mapper answers null for the statement
      return;
    }
    for (const child of n.namedChildren) scan(child);
  };
  for (const child of body.namedChildren) scan(child);
  return out;
}

/**
 * Assignment events to `name` in this def's own scope. Augmented / multiple
 * targets contribute `null`, and so does a plain assignment a LATER plain one
 * overwrites unconditionally (see {@link isOverwrittenLater}) — the union
 * engine reads several events as one per branch, which a straight-line
 * reassignment is not.
 */
function pythonAssignmentEvents(defNode: AstNode, name: string): (AstNode | null)[] {
  const events: { rhs: AstNode | null; statement: AstNode | null }[] = [];
  const body = defNode.childForFieldName("body");
  if (body === null) return [];
  const scan = (n: AstNode): void => {
    if (PYTHON_NESTED_SCOPES.has(n.type)) return;
    if (n.type === "assignment") {
      const lhs = n.namedChild(0);
      if (lhs?.type === "identifier" && lhs.text === name) {
        events.push({ rhs: n.childForFieldName("right"), statement: n.parent });
      } else if (lhs?.type === "pattern_list" && lhs.namedChildren.some((t) => t.text === name)) {
        events.push({ rhs: null, statement: null });
      }
    } else if (n.type === "augmented_assignment") {
      const lhs = n.namedChild(0);
      if (lhs?.type === "identifier" && lhs.text === name) events.push({ rhs: null, statement: null });
    } else if (n.type === "for_statement") {
      const target = n.childForFieldName("left");
      if (target?.text === name) events.push({ rhs: null, statement: null }); // rebound each iteration
    }
    for (const child of n.namedChildren) scan(child);
  };
  for (const child of body.namedChildren) scan(child);
  return events.map((event, i) => (isOverwrittenLater(event.statement, events.slice(i + 1)) ? null : event.rhs));
}

/**
 * Does a later plain assignment run whenever this one has? It does when the
 * later statement sits in this statement's own block or in a block enclosing
 * it: `if c: w = A()` then `w = B()` — `A` never reaches a `return w` after
 * both. A later statement in a SIBLING branch (`else:`, `except:`) or nested
 * deeper (`w = A()` then `if c: w = B()`) leaves the earlier value reachable.
 */
function isOverwrittenLater(statement: AstNode | null, later: readonly { statement: AstNode | null }[]): boolean {
  const block = statement?.parent ?? null;
  if (block === null) return false;
  return later.some((laterEvent) => {
    const laterBlock = laterEvent.statement?.parent ?? null;
    if (laterBlock === null) return false;
    for (let cursor: AstNode | null = block; cursor !== null; cursor = cursor.parent) {
      if (isSameAstNode(cursor, laterBlock)) return true;
    }
    return false;
  });
}

function pythonReturnPorts(scope: PythonReturnScope): ReturnInferencePorts<AstNode, null> {
  return {
    terminalExpressions: (defNode) => pythonReturnTerminals(defNode),
    typeOfExpression: (node) => pythonReturnExpressionType(node, scope),
    isBinding: (node) => node.type === "identifier" && node.text !== "self" && node.text !== "cls",
    bindingName: (node) => node.text,
    assignmentEvents: (defNode, name) => pythonAssignmentEvents(defNode, name),
  };
}

/**
 * Python opts into kernel rule 4's union form (bd tea-rags-mcp-m99j1.1.53):
 * `_prepare_cursor` binding `CursorDebugWrapper` on one branch and
 * `CursorWrapper` on the other returns BOTH, and the union-receiver dispatch
 * fans a call on it to each arm's own member. The cap EQUALS the resolver's
 * `PY_DISPATCH_FAN_MAX` — a union wider than the fan Python publishes would type
 * a receiver no edge can follow. It is restated rather than imported so the
 * walker takes no dependency on the resolver; the test file pins the two equal.
 */
export const PYTHON_RETURN_UNION: ReturnUnionPolicy = { maxArms: 4 };

/** One name, or a union of instance arms. */
function pythonReturnTypeRef(names: readonly string[]): TypeRef | undefined {
  return typeRefUnionOf(names.map((name) => ({ form: "instance", name })));
}

/** One def a delegation can land on, with what `walkPythonScopes` read off it. */
interface PythonDelegateDef {
  readonly node: AstNode;
  readonly decorators: readonly string[];
}

/** What one class (by short name) declares that a delegated return can read. */
interface PythonClassDelegates {
  /** `<method> → defs` for the defs DIRECTLY in the class body. */
  readonly methods: Map<string, PythonDelegateDef[]>;
  /**
   * `<field> → write events` for every unannotated `self.<field> = …` in the
   * class's methods (nested defs included, nested classes not) and every
   * class-body `<field> = …`. A write the language will not vouch for —
   * augmented, tuple target — is `null`.
   */
  readonly fieldWrites: Map<string, (AstNode | null)[]>;
}

/** The lookup tables the return inference reads before it starts. */
interface PythonAstScopeTables {
  /** Per-class `<field> → <class>` from annotated class-body and `self.x: T` assignments. */
  readonly fieldTypes: Map<string, Map<string, string>>;
  /** `<top-level def name> → <declared return class>` — annotated defs only. */
  readonly fileReturnTypes: Map<string, string>;
  /** `<top-level def name> → defs`, for the unannotated ones a delegation infers through. */
  readonly fileDefs: Map<string, AstNode[]>;
  /** Per-class sibling methods and field writes; a short name two classes share is absent. */
  readonly classDelegates: Map<string, PythonClassDelegates>;
}

/**
 * A callee whose CALL does not yield its `return`: a property (`self.p()` calls
 * what `p` returns), its setter/deleter, and a context-manager factory.
 */
const PYTHON_NON_RETURNING_DECORATORS: ReadonlySet<string> = new Set([
  "property",
  "cached_property",
  "setter",
  "getter",
  "deleter",
  "contextmanager",
  "asynccontextmanager",
]);

/** The `class_definition` a def sits DIRECTLY in, or null (module-level, or nested in a def). */
function enclosingClassNode(defNode: AstNode): AstNode | null {
  const outer = defNode.parent?.type === "decorated_definition" ? defNode.parent : defNode;
  const block = outer.parent;
  return block?.type === "block" && block.parent?.type === "class_definition" ? block.parent : null;
}

/** Is this def a module-level statement (`if` / `try` blocks at module scope do not count)? */
function isModuleLevelDef(defNode: AstNode): boolean {
  const outer = defNode.parent?.type === "decorated_definition" ? defNode.parent : defNode;
  return outer.parent?.type === "module";
}

/** `self.<field>` as an assignment target → the field name. */
function selfFieldName(target: AstNode | null): string | null {
  if (target?.type !== "attribute") return null;
  const object = target.childForFieldName("object");
  if (object?.type !== "identifier" || object.text !== "self") return null;
  return target.childForFieldName("attribute")?.text ?? null;
}

function pushEvent(writes: Map<string, (AstNode | null)[]>, field: string, event: AstNode | null): void {
  const events = writes.get(field);
  if (events === undefined) writes.set(field, [event]);
  else events.push(event);
}

/** Every `self.<field>` write in one method body; a nested class's `self` is another object. */
function collectSelfFieldWrites(defNode: AstNode, writes: Map<string, (AstNode | null)[]>): void {
  const body = defNode.childForFieldName("body");
  if (body === null) return;
  const scan = (n: AstNode): void => {
    if (n.type === "class_definition") return;
    if (n.type === "assignment") {
      const lhs = n.childForFieldName("left");
      const field = selfFieldName(lhs);
      // An annotated `self.x: T = …` is the field table's; it outranks every derived write.
      if (field !== null && n.childForFieldName("type") === null) {
        pushEvent(writes, field, n.childForFieldName("right"));
      } else if (lhs !== null && lhs.type !== "attribute" && lhs.type !== "identifier") {
        for (const target of lhs.namedChildren) {
          const unpacked = selfFieldName(target);
          if (unpacked !== null) pushEvent(writes, unpacked, null);
        }
      }
    } else if (n.type === "augmented_assignment") {
      const field = selfFieldName(n.childForFieldName("left"));
      if (field !== null) pushEvent(writes, field, null);
    } else if (n.type === "for_statement") {
      const field = selfFieldName(n.childForFieldName("left"));
      if (field !== null) pushEvent(writes, field, null);
    }
    for (const child of n.namedChildren) scan(child);
  };
  for (const child of body.namedChildren) scan(child);
}

/** Class-body `<field> = …` statements: a class attribute `self.<field>` reads too. */
function collectClassBodyWrites(classNode: AstNode, writes: Map<string, (AstNode | null)[]>): void {
  const body = classNode.childForFieldName("body");
  if (body === null) return;
  for (const statement of body.namedChildren) {
    const assignment = statement.type === "expression_statement" ? statement.namedChild(0) : null;
    if (assignment?.type !== "assignment" || assignment.childForFieldName("type") !== null) continue;
    const lhs = assignment.childForFieldName("left");
    if (lhs?.type === "identifier") pushEvent(writes, lhs.text, assignment.childForFieldName("right"));
  }
}

/** Short names more than one `class_definition` in the file carries — their tables would mix two classes. */
function sharedClassNames(root: AstNode): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  const scan = (n: AstNode): void => {
    if (n.type === "class_definition") {
      const name = n.childForFieldName("name")?.text;
      if (name !== undefined) {
        if (seen.has(name)) shared.add(name);
        seen.add(name);
      }
    }
    for (const child of n.namedChildren) scan(child);
  };
  scan(root);
  return shared;
}

/**
 * Every table off ONE scoped descent (bd tea-rags-mcp-1v12o.2.7, E6.2). The
 * annotated-assignment and annotated-def collectors read disjoint node kinds
 * and write disjoint maps; the delegate tables (bd tea-rags-mcp-m99j1.1.36)
 * ride the same `onDef` and scan each class body once, keyed by its node.
 */
function collectPythonAstScopeTables(root: AstNode): PythonAstScopeTables {
  const byClass = new Map<string, Map<string, string>>();
  const returns = new Map<string, string>();
  const fileDefs = new Map<string, AstNode[]>();
  const classDelegates = new Map<string, PythonClassDelegates>();
  const classBodiesScanned = new Set<AstNode>();
  const shared = sharedClassNames(root);
  const delegatesOf = (className: string): PythonClassDelegates => {
    let delegates = classDelegates.get(className);
    if (delegates === undefined) {
      delegates = { methods: new Map(), fieldWrites: new Map() };
      classDelegates.set(className, delegates);
    }
    return delegates;
  };
  const recordDelegateDef = (site: { node: AstNode; decorators: readonly string[]; name: string }): void => {
    if (isModuleLevelDef(site.node)) {
      const defs = fileDefs.get(site.name);
      if (defs === undefined) fileDefs.set(site.name, [site.node]);
      else defs.push(site.node);
      return;
    }
    const classNode = enclosingClassNode(site.node);
    const className = classNode?.childForFieldName("name")?.text;
    if (classNode === null || className === undefined || shared.has(className)) return;
    const delegates = delegatesOf(className);
    const defs = delegates.methods.get(site.name);
    const def = { node: site.node, decorators: site.decorators };
    if (defs === undefined) delegates.methods.set(site.name, [def]);
    else defs.push(def);
    collectSelfFieldWrites(site.node, delegates.fieldWrites);
    if (!classBodiesScanned.has(classNode)) {
      classBodiesScanned.add(classNode);
      collectClassBodyWrites(classNode, delegates.fieldWrites);
    }
  };
  walkPythonScopes(root, {
    onAnnotatedAssignment: (site) => {
      const owner = site.classChain[site.classChain.length - 1];
      if (owner === undefined) return;
      const typeField = site.node.childForFieldName("type");
      if (typeField === null) return;
      const ref = pythonTypeRefFromNode(pythonAnnotationExpression(typeField), owner);
      const nominal = ref === undefined ? undefined : pythonNominalReceiverName(ref);
      if (nominal === undefined) return;
      const lhs = site.node.namedChild(0);
      const name =
        lhs?.type === "identifier" && site.methodName === undefined
          ? lhs.text
          : lhs?.type === "attribute" && lhs.childForFieldName("object")?.text === "self"
            ? (lhs.childForFieldName("attribute")?.text ?? null)
            : null;
      if (name === null) return;
      let fields = byClass.get(owner);
      if (fields === undefined) {
        fields = new Map<string, string>();
        byClass.set(owner, fields);
      }
      fields.set(name, nominal);
    },
    onDef: (site) => {
      recordDelegateDef(site);
      if (site.classChain.length > 0) return;
      const returnType = site.node.childForFieldName("return_type");
      if (returnType === null) return;
      const ref = pythonTypeRefFromNode(pythonAnnotationExpression(returnType), undefined);
      const nominal = ref === undefined ? undefined : pythonNominalReceiverName(ref);
      if (nominal !== undefined) returns.set(site.name, nominal);
    },
  });
  return { fieldTypes: byClass, fileReturnTypes: returns, fileDefs, classDelegates };
}

/** Marks a fixpoint node whose answer is being computed — re-entry is a cycle, and a cycle is silence. */
const IN_PROGRESS = Symbol("in-progress");

/**
 * The file's return inference as a memoised, cycle-guarded fixpoint (bd
 * tea-rags-mcp-m99j1.1.36). A def's return may read a sibling method's, a
 * same-file def's, or a field whose writes call either, so each lookup can
 * recurse into another inference. Re-entering a node still in progress answers
 * null; because any null arm kills an inference (kernel rule 3), every node on
 * a cycle answers null whichever node the walk entered first, and caching that
 * is order-independent.
 *
 * A def's answer is a list: one class, or a union of up to
 * {@link PYTHON_RETURN_UNION} classes that a delegating def inherits whole
 * (`cursor` → `_cursor` → `_prepare_cursor`). A union never carries the `Self`
 * marker — its substitution reads ONE receiver class, so a marker arm is silence.
 */
class PythonReturnFixpoint {
  private readonly defReturns = new Map<AstNode, readonly string[] | null | typeof IN_PROGRESS>();
  private readonly fieldReturns = new Map<string, string | null | typeof IN_PROGRESS>();

  constructor(private readonly tables: PythonAstScopeTables) {}

  /** The classes an UNANNOTATED def's return expressions name; null on silence. */
  inferDef(defNode: AstNode, selfClass: string | undefined): readonly string[] | null {
    const cached = this.defReturns.get(defNode);
    if (cached === IN_PROGRESS) return null;
    if (cached !== undefined) return cached;
    this.defReturns.set(defNode, IN_PROGRESS);
    const names = inferReturnTypeNames(defNode, null, pythonReturnPorts(this.scopeOf(selfClass)), PYTHON_RETURN_UNION);
    const inferred = names !== null && names.length > 1 && names.includes(PYTHON_SELF_RETURN) ? null : names;
    this.defReturns.set(defNode, inferred);
    return inferred;
  }

  private scopeOf(selfClass: string | undefined): PythonReturnScope {
    return {
      selfClass,
      fieldType: (field) => (selfClass === undefined ? null : this.fieldType(selfClass, field)),
      selfMethodReturn: (method) => (selfClass === undefined ? null : this.methodReturn(selfClass, method)),
      fileReturn: (name) => this.fileReturn(name),
    };
  }

  /** An annotation on the callee wins; otherwise its body is inferred. `-> Self` stays the marker. */
  private delegateReturn(def: PythonDelegateDef, selfClass: string | undefined): ReturnArmTypes | null {
    if (def.decorators.some((d) => PYTHON_NON_RETURNING_DECORATORS.has(d))) return null;
    const returnType = def.node.childForFieldName("return_type");
    if (returnType === null) return this.inferDef(def.node, selfClass);
    const ref = pythonTypeRefFromNode(
      pythonAnnotationExpression(returnType),
      selfClass === undefined ? undefined : PYTHON_SELF_RETURN,
    );
    return (ref === undefined ? undefined : pythonNominalReceiverName(ref)) ?? null;
  }

  /** `self.<method>(…)` — exactly one def of that name in the class body, or silence. */
  private methodReturn(selfClass: string, method: string): ReturnArmTypes | null {
    const defs = this.tables.classDelegates.get(selfClass)?.methods.get(method);
    if (defs?.length !== 1) return null;
    return this.delegateReturn(defs[0], selfClass);
  }

  /** `<name>(…)` — the annotated table first (its long-standing behaviour), then ONE unannotated def. */
  private fileReturn(name: string): ReturnArmTypes | null {
    const declared = this.tables.fileReturnTypes.get(name);
    if (declared !== undefined) return declared;
    const defs = this.tables.fileDefs.get(name);
    if (defs?.length !== 1) return null;
    return this.delegateReturn({ node: defs[0], decorators: pythonDefDecorators(defs[0]) }, undefined);
  }

  /**
   * `self.<field>` — the annotated table wins (a typed binding outranks a derived
   * one). Otherwise every write must map to ONE class: a `None` write is the
   * unset state and neutral, a write that maps to nothing kills, two classes —
   * across writes or inside one write's union return — kill (a field type is a
   * bare class name), and a field written only `None` is silence.
   */
  private fieldType(selfClass: string, field: string): string | null {
    const annotated = this.tables.fieldTypes.get(selfClass)?.get(field);
    if (annotated !== undefined) return annotated;
    const key = `${selfClass}\u0000${field}`;
    const cached = this.fieldReturns.get(key);
    if (cached === IN_PROGRESS) return null;
    if (cached !== undefined) return cached;
    this.fieldReturns.set(key, IN_PROGRESS);
    const typed = this.inferField(selfClass, field);
    this.fieldReturns.set(key, typed);
    return typed;
  }

  private inferField(selfClass: string, field: string): string | null {
    const events = this.tables.classDelegates.get(selfClass)?.fieldWrites.get(field);
    if (events === undefined) return null;
    const scope = this.scopeOf(selfClass);
    let agreed: string | null = null;
    for (const event of events) {
      if (event === null) return null;
      if (event.type === "none") continue;
      const typed = singleName(pythonReturnExpressionType(event, scope));
      if (typed === null || (agreed !== null && agreed !== typed)) return null;
      agreed = typed;
    }
    return agreed;
  }
}

/** A def's decorator names, read the way `walkPythonScopes` reads them (the callee's last segment). */
function pythonDefDecorators(defNode: AstNode): string[] {
  if (defNode.parent?.type !== "decorated_definition") return [];
  const out: string[] = [];
  for (const child of defNode.parent.namedChildren) {
    if (child.type !== "decorator") continue;
    const expr = child.namedChild(0);
    const target = expr?.type === "call" ? expr.childForFieldName("function") : expr;
    if (target !== null && target !== undefined) out.push(pythonBareTypeName(target.text));
  }
  return out;
}

/**
 * This source's return inference for ONE file, for a pass that needs the
 * inferred return of a def it picked itself (the descriptor pass, bd
 * tea-rags-mcp-m99j1.1.20). The scope tables cost a descent, so they are built
 * on the first question and never for a file that asks none.
 *
 * Its consumer files the answer as a FIELD type, which has no receiver to
 * substitute a `Self` marker with, so the marker answers as the declaring class;
 * and a field type is one class, so a union return answers null.
 */
export function pythonInferredReturnReader(
  root: AstNode,
): (defNode: AstNode, selfClass: string | undefined) => string | null {
  let fixpoint: PythonReturnFixpoint | undefined;
  return (defNode, selfClass) => {
    fixpoint ??= new PythonReturnFixpoint(collectPythonAstScopeTables(root));
    const inferred = singleName(fixpoint.inferDef(defNode, selfClass));
    return inferred === PYTHON_SELF_RETURN ? (selfClass ?? null) : inferred;
  };
}

/** The one class an answer names; a union (or silence) is null. */
function singleName(typed: ReturnArmTypes | null): string | null {
  if (typed === null || typeof typed === "string") return typed;
  return typed.length === 1 ? typed[0] : null;
}

function extractPythonAstFacts(input: PythonTypeSourceInput): TypeFact[] {
  const fixpoint = new PythonReturnFixpoint(collectPythonAstScopeTables(input.root));
  const facts: TypeFact[] = [];
  walkPythonScopes(input.root, {
    onDef: (site) => {
      // An annotated def is the `annotations` source's; re-emitting would only
      // lose the coordinate dedupe race and cost a walk.
      if (site.node.childForFieldName("return_type") !== null) return;
      const names = fixpoint.inferDef(site.node, site.classChain[site.classChain.length - 1]);
      const type = names === null ? undefined : pythonReturnTypeRef(names);
      if (type === undefined) return;
      const fact: TypeFact = {
        kind: "return",
        source: PYTHON_AST_SOURCE,
        symbolScope: [...site.classChain],
        methodName: site.name,
        type,
      };
      if (isPythonClassFormDef(site.decorators)) fact.classForm = true;
      facts.push(fact);
    },
  });
  return facts;
}

export const pythonAstTypeSource: InlineTypeSource<PythonTypeSourceInput> = {
  name: PYTHON_AST_SOURCE,
  extract: extractPythonAstFacts,
};
