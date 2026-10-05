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
 * {@link rubyBodyTailExpression} is the ONE tail selection both port sets use.
 */
import type { AstNode } from "../../../../contracts/types/ast.js";
import { inferReturnTypeName, type ReturnInferencePorts } from "../../kernel/index.js";
import type { RubyDslCatalogue } from "../dsl/index.js";
import { constInstanceType, isOrAssignment } from "./type-sources/ast-inference.js";

/**
 * The def whose body return the member ports are asked about. `classBody` is the
 * declaring class's body for the owner-keyed channel — it unlocks the memoized-
 * reader tail, whose soundness check scans sibling methods — and `null` for the
 * flat channel, which never typed that tail.
 */
export interface RubyMemberReturnSite {
  readonly method: AstNode;
  readonly classBody: AstNode | null;
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
      constInstanceType(node, catalogue) ??
      (site.classBody === null ? null : memoizedTailInstanceType(node, site.method, site.classBody, catalogue)),
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
): string | null {
  return inferReturnTypeName(method, { method, classBody }, rubyMemberReturnPorts(catalogue));
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
  method: AstNode,
  classBody: AstNode,
  catalogue: RubyDslCatalogue,
): string | null {
  const plain = tail.type === "assignment";
  if (!plain && !isOrAssignment(tail)) return null;
  const lhs = tail.childForFieldName("left");
  const rhs = tail.childForFieldName("right");
  if (!lhs || !rhs) return null;
  if (lhs.type !== "identifier" && lhs.type !== "instance_variable") return null;
  const type = constInstanceType(rhs, catalogue);
  if (type === null) return null;
  if (plain) return type;
  const ivar = lhs.type === "instance_variable";
  return countAssignmentsTo(ivar ? classBody : method, lhs.text, ivar) === 1 ? type : null;
}
