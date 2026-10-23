import type { AstNode } from "../../../../contracts/types/ast.js";
import type { InferredBindingShape } from "../../../../contracts/types/codegraph.js";
import { isCapWordsType, isRustConstructorAssocFn } from "../associated-constructor.js";
import { readRustBareType } from "./bare-type.js";

/** Macros whose expansion never returns, so an arm ending in one yields no value. */
const RUST_DIVERGING_MACROS = new Set(["panic", "unreachable", "todo", "unimplemented"]);

/** Block children that are statements, never the block's value. */
function isRustStatement(node: AstNode): boolean {
  return (
    node.type === "expression_statement" ||
    node.type === "empty_statement" ||
    node.type === "macro_definition" ||
    node.type.endsWith("_declaration") ||
    node.type.endsWith("_item")
  );
}

function isRustDiverging(node: AstNode): boolean {
  if (node.type === "return_expression" || node.type === "break_expression" || node.type === "continue_expression") {
    return true;
  }
  if (node.type !== "macro_invocation") return false;
  const macro = node.childForFieldName("macro");
  const name = macro?.type === "scoped_identifier" ? macro.childForFieldName("name")?.text : macro?.text;
  return name !== undefined && RUST_DIVERGING_MACROS.has(name);
}

/**
 * The expressions a `let` initializer's value comes from: an `if` / `match` /
 * block contributes each arm's value, recursively; a diverging arm (`return`,
 * `panic!`) contributes none; any other expression is its own single value.
 * `null` when an arm yields `()` — an `if` without `else`, a block ending in a
 * statement that does not diverge — since then no nominal type is produced.
 */
export function rustInitializerValues(value: AstNode): AstNode[] | null {
  if (value.type === "if_expression") {
    const consequence = value.childForFieldName("consequence");
    const otherwise = value.childForFieldName("alternative")?.namedChildren[0] ?? null;
    if (consequence === null || otherwise === null) return null;
    const first = rustInitializerValues(consequence);
    const rest = rustInitializerValues(otherwise);
    return first === null || rest === null ? null : [...first, ...rest];
  }
  if (value.type === "match_expression") {
    const arms = value.childForFieldName("body")?.namedChildren.filter((arm) => arm.type === "match_arm") ?? [];
    const values: AstNode[] = [];
    for (const arm of arms) {
      const armValue = arm.childForFieldName("value");
      const armValues = armValue === null ? null : rustInitializerValues(armValue);
      if (armValues === null) return null;
      values.push(...armValues);
    }
    return arms.length === 0 ? null : values;
  }
  if (value.type === "block") {
    const last = value.namedChildren.filter((child) => !child.type.endsWith("comment")).at(-1);
    if (last === undefined) return null;
    if (!isRustStatement(last)) return rustInitializerValues(last);
    const statement = last.type === "expression_statement" ? last.namedChildren[0] : undefined;
    return statement !== undefined && isRustDiverging(statement) ? [] : null;
  }
  return isRustDiverging(value) ? [] : [value];
}

/**
 * The nominal type a constructor call spells by itself: an associated-fn
 * constructor (`Worker::new()`, `Foo::with_capacity(n)`) or an enum variant
 * (`Res::Ok(x)` — a CapWords member of a CapWords path) both produce the path's
 * type. Anything else (a method or free call, a literal) spells no type.
 */
export function rustConstructorCallType(value: AstNode): string | null {
  if (value.type !== "call_expression") return null;
  const callee = value.childForFieldName("function");
  if (callee?.type !== "scoped_identifier") return null;
  const pathNode = callee.childForFieldName("path");
  const member = callee.childForFieldName("name");
  // `Worker::<Token>::new` — the path is the receiving type, a turbofish included.
  if (pathNode === null || member?.type !== "identifier") return null;
  const typeName = readRustBareType(pathNode);
  if (typeName === null || !isCapWordsType(typeName)) return null;
  return isRustConstructorAssocFn(member.text) || isCapWordsType(member.text) ? typeName : null;
}

/**
 * The initializer value whose constructor spells the `let`'s type, and that
 * type. Every arm of an `if` / `match` shares one type in Rust, and an
 * unannotated `let` gives no expected type to coerce towards, so one spelled
 * arm types them all; arms spelling DIFFERENT types decline, as does an
 * initializer no arm spells.
 */
export function rustAgreedConstructorValue(
  value: AstNode,
): { readonly type: string; readonly expression: AstNode } | null {
  let agreed: { readonly type: string; readonly expression: AstNode } | null = null;
  for (const expression of rustInitializerValues(value) ?? []) {
    const type = rustConstructorCallType(expression);
    if (type === null) continue;
    if (agreed !== null && agreed.type !== type) return null;
    agreed ??= { type, expression };
  }
  return agreed;
}

/**
 * The type a `let` initializer's constructor spells, and the inferred shape it
 * took when that shape is newer than the direct associated-fn constructor
 * (`let w = Worker::new()`): an enum variant (`Res::Ok(x)`) or agreeing
 * `if` / `match` / block arms. The resolver reads a shaped binding whose type
 * does not place as absent, so the shape only ever adds edges.
 */
export function rustInferredConstructorType(
  value: AstNode,
): { readonly type: string; readonly shape?: InferredBindingShape } | null {
  const agreed = rustAgreedConstructorValue(value);
  if (agreed === null) return null;
  if (agreed.expression !== value) return { type: agreed.type, shape: "initializerArms" };
  const member = value.childForFieldName("function")?.childForFieldName("name")?.text ?? "";
  return isRustConstructorAssocFn(member) ? { type: agreed.type } : { type: agreed.type, shape: "variantConstructor" };
}
