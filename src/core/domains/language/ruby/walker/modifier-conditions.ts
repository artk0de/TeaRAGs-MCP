/**
 * Modifier conditions and the assignments they guard (bd tea-rags-mcp-0qaht.55).
 *
 * `record = Status.new unless record.present?` evaluates the condition BEFORE
 * it assigns, so `record.present?` reads whatever `record` held above the
 * statement. A line number cannot say so — the condition and the assignment
 * share it — so the walker records two positions: the condition's span on the
 * binding the guarded assignment establishes (`conditionSpan`), and the column
 * of each call inside such a condition (`CallRef.startColumn`). The resolver
 * compares the two; where either is absent it reads as it always did.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { CallResultBinding, LocalBinding, ModifierConditionSpan } from "../../../../contracts/types/codegraph.js";
import { walk } from "./ast-utils.js";

/** Modifiers whose `condition` field runs BEFORE their `body`. */
const CONDITION_FIRST_MODIFIERS: ReadonlySet<string> = new Set([
  "if_modifier",
  "unless_modifier",
  "while_modifier",
  "until_modifier",
]);

/** Statements that establish a local binding a modifier may guard. */
const BINDING_ASSIGNMENTS: ReadonlySet<string> = new Set(["assignment", "operator_assignment"]);

/** Native nodes are fresh objects per access, so identity is the span plus the type. */
function sameNode(candidate: AstNode | null, node: AstNode): boolean {
  return (
    candidate !== null &&
    candidate.type === node.type &&
    candidate.startIndex === node.startIndex &&
    candidate.endIndex === node.endIndex
  );
}

/**
 * The span of every modifier condition guarding `assignment` — from the
 * innermost condition's start to the outermost one's end, since each of them
 * runs before the assignment (`x = a if b unless c` spans `b … c`) — or
 * `undefined` when no modifier has it as its body.
 */
export function rubyModifierConditionSpan(assignment: AstNode): ModifierConditionSpan | undefined {
  let statement = assignment;
  let innermost: AstNode | undefined;
  let outermost: AstNode | undefined;
  for (let modifier = statement.parent; modifier !== null; modifier = statement.parent) {
    if (!CONDITION_FIRST_MODIFIERS.has(modifier.type)) break;
    if (!sameNode(modifier.childForFieldName("body"), statement)) break;
    const condition = modifier.childForFieldName("condition");
    if (condition === null) break;
    innermost ??= condition;
    outermost = condition;
    statement = modifier;
  }
  if (innermost === undefined || outermost === undefined) return undefined;
  return {
    startLine: innermost.startPosition.row + 1,
    startColumn: innermost.startPosition.column,
    endLine: outermost.endPosition.row + 1,
    endColumn: outermost.endPosition.column,
  };
}

/**
 * Whether `node` sits inside the condition of a modifier that guards an
 * assignment — the one place a call's column decides which binding it reads.
 * A modifier guarding anything else (`log(x) if x.ok?`) binds nothing, so its
 * condition's calls need no column.
 */
export function isInsideRubyAssignmentCondition(node: AstNode): boolean {
  let child = node;
  for (let { parent } = child; parent !== null; { parent } = parent) {
    if (CONDITION_FIRST_MODIFIERS.has(parent.type) && sameNode(parent.childForFieldName("condition"), child)) {
      if (guardsAssignment(parent)) return true;
    }
    child = parent;
  }
  return false;
}

/** Whether a modifier's body — through nested modifiers — is an assignment. */
function guardsAssignment(modifier: AstNode): boolean {
  let body = modifier.childForFieldName("body");
  while (body !== null && CONDITION_FIRST_MODIFIERS.has(body.type)) body = body.childForFieldName("body");
  return body !== null && BINDING_ASSIGNMENTS.has(body.type);
}

/**
 * `line → name → span`: the assignments a modifier guards, keyed by line and by
 * each name the left-hand side binds.
 */
export type RubyGuardedAssignments = ReadonlyMap<number, ReadonlyMap<string, ModifierConditionSpan>>;

/**
 * Every assignment in `startLine..endLine` that a modifier guards, keyed by
 * each name its left-hand side binds — a plain local or the members of a
 * multiple assignment.
 */
export function collectRubyGuardedAssignments(
  root: AstNode,
  startLine: number,
  endLine: number,
): RubyGuardedAssignments {
  const out = new Map<number, Map<string, ModifierConditionSpan>>();
  walk(root, (node) => {
    if (!BINDING_ASSIGNMENTS.has(node.type)) return;
    const line = node.startPosition.row + 1;
    if (line < startLine || line > endLine) return;
    const span = rubyModifierConditionSpan(node);
    if (span === undefined) return;
    for (const name of boundNames(node.childForFieldName("left"))) {
      const byName = out.get(line) ?? new Map<string, ModifierConditionSpan>();
      byName.set(name, span);
      out.set(line, byName);
    }
  });
  return out;
}

/** The local names an assignment's left-hand side binds. */
function boundNames(lhs: AstNode | null): string[] {
  if (lhs === null) return [];
  if (lhs.type === "identifier") return [lhs.text];
  if (lhs.type !== "left_assignment_list") return [];
  return lhs.namedChildren.filter((c) => c.type === "identifier").map((c) => c.text);
}

/**
 * Give each binding in `bindings` that a guarded assignment establishes its
 * modifier's `conditionSpan`, matched by name and line, as a COPY of the
 * binding — the original object may be shared. Serves both positioned channels
 * (`localBindings`, `callResultBindings`). Every other binding stays the same
 * object, and with no guarded assignment `bindings` is left untouched.
 */
export function attachModifierConditionSpans<B extends LocalBinding | CallResultBinding>(
  guarded: RubyGuardedAssignments,
  bindings: Record<string, B[]>,
): void {
  if (guarded.size === 0) return;
  for (const [name, list] of Object.entries(bindings)) {
    bindings[name] = list.map((binding) => {
      const span = guarded.get(binding.line)?.get(name);
      return span === undefined ? binding : { ...binding, conditionSpan: span };
    });
  }
}
