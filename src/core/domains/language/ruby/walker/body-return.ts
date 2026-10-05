/**
 * Ruby's answers to the kernel's return-inference engine for the MEMBER body
 * channels (bd tea-rags-mcp-m99j1.1.61) — the flat `functionReturnTypes` map
 * (`collectRubyBodyReturnTypes`) and its owner-keyed twin
 * (`collectRubyScopedBodyReturnTypes`), both in `walker/local-bindings.ts`.
 *
 * Those channels used to run their own engine (body tail → `constInstanceType`)
 * beside the kernel's `inferReturnTypeName`, which the service-entry source
 * (`body-last-expr.ts`) already used — two places deciding what a Ruby def
 * returns. Both now ask the kernel; what differs is only the PORT SET:
 *
 *  - the service-entry ports follow a bare binding to its single plain
 *    assignment, peel `.freeze` / `.tap` tails and type coercion ternaries;
 *  - the member ports below do none of that. They answer `isBinding` with
 *    `false`, so the kernel never indirects, and type an expression with
 *    `constInstanceType` alone — plus, on the owner-keyed channel only, the
 *    memoized-reader tail, which needs the declaring class body.
 *
 * The narrowness is the contract the channels always had (an identity lift):
 * widening them to the service-entry shapes would be a behaviour change and
 * belongs to its own measured bead, not here.
 *
 * One measured widening exists, on the OWNER-KEYED channel only (bd
 * tea-rags-mcp-0qaht.54): a site carrying its {@link RubyMemberReturnOwner} also
 * types a receiverless `new` in a singleton method, a self-returning tail, and
 * qualifies a relative constant by the def's lexical nesting. The flat channel
 * passes no owner and answers exactly as before.
 *
 * {@link rubyBodyTailExpression} is the ONE tail selection both port sets use.
 */
import type { AstNode } from "../../../../contracts/types/ast.js";
import { inferReturnTypeName, type ReturnInferencePorts } from "../../kernel/index.js";
import type { RubyDslCatalogue } from "../dsl/index.js";
import { constInstanceType, isOrAssignment, singletonNewInstanceType } from "./type-sources/ast-inference.js";

/**
 * The def whose body return the member ports are asked about. `classBody` is the
 * declaring class's body for the owner-keyed channel — it unlocks the memoized-
 * reader tail, whose soundness check scans sibling methods — and `null` for the
 * flat channel, which never typed that tail.
 */
export interface RubyMemberReturnSite {
  readonly method: AstNode;
  readonly classBody: AstNode | null;
  /** The declaring class or module, which only the owner-keyed channel knows. */
  readonly owner?: RubyMemberReturnOwner;
}

/**
 * The declaring class / module of an owner-keyed site (bd tea-rags-mcp-0qaht.54).
 * Its presence unlocks the three shapes that need the owner — a receiverless
 * `new` in a singleton method, a self-returning tail, and a relative constant
 * qualified by the def's lexical nesting. Absent (the flat channel), the ports
 * answer exactly as they did before those shapes existed.
 */
export interface RubyMemberReturnOwner {
  /** The owner's fq, as `forEachClassScope` composes it. */
  readonly fq: string;
  /** A `class` — `new` and an instance `self` name an instance of it; a module has neither. */
  readonly isClass: boolean;
  /** The fq of every class / module lexically enclosing the def, innermost first (`fq` itself first). */
  readonly nesting: readonly string[];
  /** Every class / module fq this FILE declares — the bound of the relative-constant read. */
  readonly declaredTypes: ReadonlySet<string>;
  /** The owner's own INSTANCE defs by name, for a self-returning sibling call. */
  readonly instanceMethods: ReadonlyMap<string, readonly AstNode[]>;
}

/**
 * A def body's last value-producing expression: `rescue` / `ensure` / `else`
 * tails skipped so the tail seen is the NORMAL-path value, and an explicit
 * `return EXPR` unwrapped to `EXPR`. `null` when the body produces no value.
 */
export function rubyBodyTailExpression(method: AstNode): AstNode | null {
  const body = method.childForFieldName("body");
  if (!body) return null;
  const stmts = body.namedChildren.filter((n) => n.type !== "rescue" && n.type !== "ensure" && n.type !== "else");
  let last = stmts[stmts.length - 1];
  if (!last) return null;
  if (last.type === "return") {
    const arg = last.namedChildren[0];
    if (!arg) return null;
    last = arg.type === "argument_list" ? arg.namedChildren[0] : arg;
    if (!last) return null;
  }
  return last;
}

/** The member channels' port set. Built per file (it closes over the catalogue). */
export function rubyMemberReturnPorts(
  catalogue: RubyDslCatalogue,
): ReturnInferencePorts<AstNode, RubyMemberReturnSite> {
  return {
    terminalExpressions: (defNode) => {
      const tail = rubyBodyTailExpression(defNode);
      return tail === null ? [] : [tail];
    },
    typeOfExpression: (node, site) =>
      memberExpressionType(node, site, catalogue) ??
      (site.classBody === null ? null : memoizedTailInstanceType(node, site, site.classBody, catalogue)),
    // The member channels never followed a binding: the kernel's rule 2 stays off.
    isBinding: () => false,
    bindingName: (node) => node.text,
    assignmentEvents: () => [],
  };
}

/**
 * The constant a def's body evaluates to as an INSTANCE through the kernel
 * engine under the member ports, or `null` (silence). `classBody` as on
 * {@link RubyMemberReturnSite}.
 */
export function inferRubyMemberReturnType(
  method: AstNode,
  catalogue: RubyDslCatalogue,
  classBody: AstNode | null,
  owner?: RubyMemberReturnOwner,
): string | null {
  const site: RubyMemberReturnSite = owner === undefined ? { method, classBody } : { method, classBody, owner };
  return inferReturnTypeName(method, site, rubyMemberReturnPorts(catalogue));
}

/**
 * The instance type of a value expression at a member site: a constructor /
 * finder (`constInstanceType`), and — on an owner-keyed site only — that
 * constant qualified by the def's lexical nesting, a receiverless `new` in a
 * singleton method, or a self-returning expression.
 */
function memberExpressionType(node: AstNode, site: RubyMemberReturnSite, catalogue: RubyDslCatalogue): string | null {
  const direct = constInstanceType(node, catalogue);
  const { owner } = site;
  if (owner === undefined) return direct;
  if (direct !== null) return qualifyByLexicalNesting(direct, owner);
  if (!owner.isClass) return null;
  return singletonNewInstanceType(node) ?? (selfReturning(node, site.method, owner, new Set()) ? owner.fq : null);
}

/**
 * A constant written relative to the def's lexical scope, read the way Ruby's
 * lexical lookup reads it: the innermost enclosing class / module under which
 * THIS FILE declares the name wins (`Query.new` inside `class Trends::Links`,
 * whose body declares `class Query` → `Trends::Links::Query`). A compact
 * `class A::B` nests only `A::B`, never `A`. Nothing declared under any nesting
 * level → the literal stays, and the resolver's own qualification runs as before.
 *
 * File-scoped like every walker inference: a reopening in another file that
 * declares the same name under an INNER level would win at runtime.
 */
function qualifyByLexicalNesting(name: string, owner: RubyMemberReturnOwner): string {
  for (const scope of owner.nesting) {
    const candidate = `${scope}::${name}`;
    if (owner.declaredTypes.has(candidate)) return candidate;
  }
  return name;
}

/** Copying / passthrough methods whose result is (a copy of) their receiver. */
const RECEIVER_RETURNING_METHODS = new Set(["clone", "dup", "tap"]);

/**
 * Whether an expression in an INSTANCE method evaluates to the receiver or a
 * copy of it: `self`, a receiverless `clone` / `dup`, `clone` / `dup` / `tap`
 * on such an expression, or a call on one to a sibling instance method — defined
 * exactly once in the owner's body — whose own tail is self-returning
 * (`clone.allowed!` with `def allowed!; …; self; end`). `visiting` breaks a
 * mutual recursion (`ping → clone.pong → clone.ping`) by answering no.
 *
 * The answer names the DECLARING class: a subclass receiver gets its parent's
 * type, as every other owner-keyed fact does.
 */
function selfReturning(node: AstNode, method: AstNode, owner: RubyMemberReturnOwner, visiting: Set<string>): boolean {
  if (inSingletonContext(method)) return false;
  switch (node.type) {
    case "self":
      return true;
    case "identifier":
      return node.text === "clone" || node.text === "dup";
    case "call":
      return selfReturningCall(node, method, owner, visiting);
    default:
      return false;
  }
}

function selfReturningCall(
  node: AstNode,
  method: AstNode,
  owner: RubyMemberReturnOwner,
  visiting: Set<string>,
): boolean {
  const name = node.childForFieldName("method")?.text;
  if (name === undefined) return false;
  const receiver = node.childForFieldName("receiver");
  if (receiver === null) return (name === "clone" || name === "dup") && node.childForFieldName("arguments") === null;
  if (!selfReturning(receiver, method, owner, visiting)) return false;
  if (RECEIVER_RETURNING_METHODS.has(name)) return true;
  const defs = owner.instanceMethods.get(name);
  const sibling = defs?.length === 1 ? defs[0] : undefined;
  if (sibling === undefined || visiting.has(name)) return false;
  const tail = rubyBodyTailExpression(sibling);
  if (tail === null) return false;
  visiting.add(name);
  return selfReturning(tail, sibling, owner, visiting);
}

/** A def whose `self` is the class object: `def self.x`, or any def inside `class << self`. */
function inSingletonContext(method: AstNode): boolean {
  if (method.type === "singleton_method") return true;
  for (let p = method.parent; p !== null; p = p.parent) {
    if (p.type === "singleton_class") return true;
    if (p.type === "class" || p.type === "module") return false;
  }
  return false;
}

/**
 * How many times `name` is assigned (plain or operator) under `root`.
 *
 * A nested class / module is always a different scope and is never entered. A
 * nested `def` is entered only when counting an `@ivar`: ivars belong to the
 * INSTANCE, so every method of the class can write the same one, and that is
 * precisely what the memoization guard needs to see. Locals are method-scoped,
 * so for them a nested def is a different scope too.
 */
function countAssignmentsTo(root: AstNode, name: string, crossMethods: boolean): number {
  let seen = 0;
  const scan = (n: AstNode): void => {
    if (n.type === "class" || n.type === "module") return;
    if (!crossMethods && (n.type === "method" || n.type === "singleton_method")) return;
    if (n.type === "assignment" || n.type === "operator_assignment") {
      if (n.childForFieldName("left")?.text === name) seen += 1;
    }
    for (const child of n.children) scan(child);
  };
  for (const child of root.children) scan(child);
  return seen;
}

/**
 * The instance type of a MEMOIZED-READER tail — `@x ||= Const.new` / `x = Const.new`
 * (bd tea-rags-mcp-smvyk). `null` for every other tail.
 *
 * ── WHY THIS SHAPE AND NO OTHER ──
 * The taxdome census classified all 1 678 nullary-receiver misses whose callee
 * carries no return fact. Ranked by miss reach, the classes are: opaque qualified
 * call tails (118), memoized tails whose RHS is opaque (108), memoized tails
 * whose RHS is a `Const.m()` with no fact of its own (85), literals (56), and
 * then THIS — a memoized tail whose RHS types, 49 misses over 13 defs. Everything
 * above it is a genuine floor: an opaque RHS has no nominal type to name, and the
 * `Const.m()` cases bottom out in nilable conditionals (`HostHelper.current_firm`
 * returns a Firm or nil). The conditional-agree and passthrough-tail shapes the
 * design anticipated measured 1 and 0 sites respectively, so neither is built.
 *
 * ── WHY IT IS SOUND ──
 * The value of `x = e` IS `e`, unconditionally. The value of `x ||= e` is `e`
 * whenever `x` was falsy — so the fact holds exactly when nothing else could have
 * put a different value in `x`. That is checked, not assumed: an `@ivar` must be
 * assigned exactly once in the whole class body (no sibling method writes it), a
 * local exactly once in the method. `+=` and `&&=` are arithmetic and guard
 * idioms, not memoization, and are rejected outright.
 *
 * The check is file-scoped, like every walker inference: a class reopened in
 * another file could assign the same ivar. That is the same bound
 * `collectRubyIvarFieldTypes` and the service-entry source already accept.
 */
function memoizedTailInstanceType(
  tail: AstNode,
  site: RubyMemberReturnSite,
  classBody: AstNode,
  catalogue: RubyDslCatalogue,
): string | null {
  const { method } = site;
  const plain = tail.type === "assignment";
  if (!plain && !isOrAssignment(tail)) return null;
  const lhs = tail.childForFieldName("left");
  const rhs = tail.childForFieldName("right");
  if (!lhs || !rhs) return null;
  if (lhs.type !== "identifier" && lhs.type !== "instance_variable") return null;
  const type = memberExpressionType(rhs, site, catalogue);
  if (type === null) return null;
  if (plain) return type;
  const ivar = lhs.type === "instance_variable";
  return countAssignmentsTo(ivar ? classBody : method, lhs.text, ivar) === 1 ? type : null;
}
