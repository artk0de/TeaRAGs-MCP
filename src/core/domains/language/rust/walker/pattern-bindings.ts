/**
 * Rust pattern-bound names (bd tea-rags-mcp-s3i8m, Task 1a). Every name an
 * `if let` / `while let` / match arm / `for` / closure parameter /
 * destructuring `let` binds SHADOWS the same name from outside for the
 * pattern's scope. Before this pass Rust recorded only `let x` and fn params,
 * so an outer binding leaked into arm, loop and closure bodies — a provably
 * wrong read.
 *
 * Each name is recorded as a `"patternProjection"` {@link LocalBinding}: the
 * scrutinee (or iterable, or adapter receiver) as `sourceExpression`, the path
 * from that value to the name as `projection`, the scope as `scopeEndLine`, and
 * the scrutinee's span as `conditionSpan` so `if let Some(x) = x.get()` still
 * reads the outer `x` inside the scrutinee. A shape no projection describes (a
 * callback parameter, disagreeing or-pattern arms, a slice) records the shadow
 * with no projection: the name is untyped there, never the outer binding.
 */

import { isSameAstNode, type AstNode } from "../../../../contracts/types/ast.js";
import type { LocalBinding, ModifierConditionSpan, PatternStep } from "../../../../contracts/types/codegraph.js";

/** A typed closure parameter's binding (`|x: Foo|`) — the fn-parameter typing path, supplied by the walker. */
export type RustClosureParamTyper = (typeNode: AstNode | null) => Pick<LocalBinding, "type" | "typeRef"> | null;

/** A name's projection, or `null` when the pattern shape cannot be unfolded. */
type PatternProjections = Map<string, PatternStep[] | null>;

interface RustPatternSite {
  readonly pattern: AstNode;
  readonly prefix: PatternStep[] | null;
  /** Where the bound names are visible: the arm, body or closure body, or the rest of a `let`'s block. */
  readonly visible: ModifierConditionSpan;
  readonly source: AstNode | null;
}

/**
 * Emit a shadow binding for every pattern-bound name inside `fn` whose site
 * starts within `[startLine, endLine]`. Nested `fn` items are their own chunks
 * and are not entered.
 */
export function collectRustPatternBindings(
  fn: AstNode,
  startLine: number,
  endLine: number,
  typeClosureParam: RustClosureParamTyper,
  push: (name: string, binding: LocalBinding) => void,
): void {
  const visit = (node: AstNode): void => {
    const line = node.startPosition.row + 1;
    if (line >= startLine && line <= endLine) {
      for (const site of rustPatternSitesOf(node, typeClosureParam, push)) emitSite(site, push);
    }
    for (const child of node.children) {
      if (child.type !== "function_item") visit(child);
    }
  };
  const body = fn.childForFieldName("body");
  if (body !== null) visit(body);
}

function emitSite(site: RustPatternSite, push: (name: string, binding: LocalBinding) => void): void {
  const projections = unfoldPattern(site.pattern, site.prefix ?? []);
  const sourceExpression = site.source?.text.replace(/\s+/g, " ");
  for (const [name, projection] of projections) {
    const binding: LocalBinding = {
      line: firstBindingLine(site.pattern, name),
      type: "",
      valueKind: "patternProjection",
      scopeEndLine: site.visible.endLine,
      visibleSpan: site.visible,
    };
    if (sourceExpression !== undefined && site.source !== null) {
      binding.sourceExpression = sourceExpression;
      binding.conditionSpan = {
        startLine: site.source.startPosition.row + 1,
        startColumn: site.source.startPosition.column,
        endLine: site.source.endPosition.row + 1,
        endColumn: site.source.endPosition.column,
      };
      if (projection !== null && site.prefix !== null) binding.projection = projection;
    }
    push(name, binding);
  }
}

/** The pattern sites `node` opens; a typed closure parameter is pushed directly as a plain typed binding. */
function rustPatternSitesOf(
  node: AstNode,
  typeClosureParam: RustClosureParamTyper,
  push: (name: string, binding: LocalBinding) => void,
): RustPatternSite[] {
  switch (node.type) {
    case "let_condition": {
      const pattern = node.childForFieldName("pattern");
      const scope = letConditionScope(node);
      if (pattern === null || scope === null) return [];
      return [{ pattern, prefix: [], visible: spanOf(scope, scope), source: node.childForFieldName("value") }];
    }
    case "match_expression": {
      const scrutinee = node.childForFieldName("value");
      const sites: RustPatternSite[] = [];
      for (const arm of node.childForFieldName("body")?.namedChildren ?? []) {
        if (arm.type !== "match_arm") continue;
        const pattern = matchArmPattern(arm);
        if (pattern !== null) {
          sites.push({ pattern, prefix: [], visible: spanOf(pattern, arm), source: scrutinee });
        }
      }
      return sites;
    }
    case "for_expression": {
      const pattern = node.childForFieldName("pattern");
      const body = node.childForFieldName("body");
      if (pattern === null || body === null) return [];
      return [
        {
          pattern,
          prefix: [{ kind: "element" }],
          visible: spanOf(body, body),
          source: node.childForFieldName("value"),
        },
      ];
    }
    case "closure_expression":
      return closureSites(node, typeClosureParam, push);
    case "let_declaration": {
      const pattern = node.childForFieldName("pattern");
      const block = node.parent;
      if (pattern === null || pattern.type === "identifier" || block === null) return [];
      // An annotated destructuring `let` names its type, not the value's path.
      const typed = node.childForFieldName("type") !== null;
      return [
        {
          pattern,
          prefix: typed ? null : [],
          visible: spanBetween(node.endPosition, block.endPosition),
          source: node.childForFieldName("value"),
        },
      ];
    }
    default:
      return [];
  }
}

/** The block an `if let` / `while let` condition scopes its names to: the consequence or loop body. */
export function letConditionScope(node: AstNode): AstNode | null {
  const owner = node.parent?.type === "let_chain" ? node.parent.parent : node.parent;
  if (owner?.type === "if_expression") return owner.childForFieldName("consequence");
  if (owner?.type === "while_expression") return owner.childForFieldName("body");
  return null;
}

/** The arm's pattern without its `if` guard. */
export function matchArmPattern(arm: AstNode): AstNode | null {
  const matchPattern = arm.childForFieldName("pattern");
  if (matchPattern === null) return null;
  const guard = matchPattern.childForFieldName("condition");
  return matchPattern.namedChildren.find((child) => !isSameAstNode(child, guard)) ?? null;
}

/**
 * Closure parameters. On a method call's argument (`recv.map(|p| …)`) each
 * parameter projects through `adapterParam{map, index}` from the receiver; any
 * other closure is a callback whose parameters no projection describes.
 */
function closureSites(
  closure: AstNode,
  typeClosureParam: RustClosureParamTyper,
  push: (name: string, binding: LocalBinding) => void,
): RustPatternSite[] {
  const body = closure.childForFieldName("body") ?? closure;
  const visible = spanOf(body, body);
  const adapterCall = closure.parent?.type === "arguments" ? closure.parent.parent : null;
  const callee = adapterCall?.type === "call_expression" ? adapterCall.childForFieldName("function") : null;
  const adapter = callee?.type === "field_expression" ? callee.childForFieldName("field")?.text : undefined;
  const adapterReceiver = callee?.type === "field_expression" ? callee.childForFieldName("value") : null;
  const argumentIndex = closure.parent?.namedChildren.findIndex((argument) => isSameAstNode(argument, closure)) ?? -1;
  const sites: RustPatternSite[] = [];
  const parameters = closure.childForFieldName("parameters")?.namedChildren ?? [];
  parameters.forEach((parameter, index) => {
    if (parameter.type === "parameter") {
      const pattern = parameter.childForFieldName("pattern");
      const typed = pattern?.type === "identifier" ? typeClosureParam(parameter.childForFieldName("type")) : null;
      if (pattern !== null && typed !== null) {
        push(pattern.text, {
          line: pattern.startPosition.row + 1,
          ...typed,
          scopeEndLine: visible.endLine,
          visibleSpan: visible,
        });
        return;
      }
      if (pattern !== null) sites.push({ pattern, prefix: null, visible, source: null });
      return;
    }
    const prefix: PatternStep[] | null =
      adapter !== undefined && adapterReceiver !== null && argumentIndex >= 0
        ? [{ kind: "adapterParam", adapter, argument: argumentIndex, index }]
        : null;
    sites.push({ pattern: parameter, prefix, visible, source: prefix === null ? null : adapterReceiver });
  });
  return sites;
}

/** Every name `pattern` binds, with the steps from the matched value to it. */
function unfoldPattern(pattern: AstNode, prefix: PatternStep[]): PatternProjections {
  const projections: PatternProjections = new Map();
  const bind = (name: string, projection: PatternStep[] | null): void => {
    projections.set(name, projections.has(name) ? null : projection);
  };
  const visit = (node: AstNode, steps: PatternStep[] | null): void => {
    switch (node.type) {
      case "identifier":
        if (!/^[A-Z]/.test(node.text)) bind(node.text, steps);
        return;
      case "mut_pattern":
      case "ref_pattern":
      case "reference_pattern":
        for (const child of node.namedChildren) {
          if (child.type !== "mutable_specifier") visit(child, steps);
        }
        return;
      case "captured_pattern": {
        const [name, inner] = node.namedChildren;
        if (name !== undefined) visit(name, steps);
        if (inner !== undefined) visit(inner, steps);
        return;
      }
      case "tuple_pattern":
        visitPositional(positionalElements(node), steps, (index) => ({ kind: "tuple", index }));
        return;
      case "tuple_struct_pattern": {
        const typeNode = node.childForFieldName("type");
        const path = typeNode?.text.replace(/\s+/g, "") ?? "";
        const elements = positionalElements(node).filter((child) => !isSameAstNode(child, typeNode));
        visitPositional(elements, steps, (index) => ({ kind: "variant", path, index }));
        return;
      }
      case "struct_pattern": {
        const path = node.childForFieldName("type")?.text.replace(/\s+/g, "") ?? "";
        for (const field of node.namedChildren) {
          if (field.type !== "field_pattern") continue;
          const name = field.childForFieldName("name")?.text;
          if (name === undefined) continue;
          const step: PatternStep = path.includes("::")
            ? { kind: "variant", path, field: name }
            : { kind: "field", name };
          const fieldSteps = steps === null ? null : [...steps, step];
          const sub = field.childForFieldName("pattern");
          if (sub === null) bind(name, fieldSteps);
          else visit(sub, fieldSteps);
        }
        return;
      }
      case "or_pattern":
        visitAlternatives(node.namedChildren, steps);
        return;
      case "slice_pattern":
        for (const child of node.namedChildren) visit(child, null);
        return;
      case "scoped_identifier":
      case "scoped_type_identifier":
      case "type_identifier":
        return;
      default:
        for (const child of node.namedChildren) visit(child, null);
    }
  };
  const visitPositional = (
    elements: readonly AstNode[],
    steps: PatternStep[] | null,
    stepAt: (index: number) => PatternStep,
  ): void => {
    let afterRest = false;
    elements.forEach((element, index) => {
      if (element.type === "remaining_field_pattern") {
        afterRest = true;
        return;
      }
      visit(element, steps === null || afterRest ? null : [...steps, stepAt(index)]);
    });
  };
  const visitAlternatives = (alternatives: readonly AstNode[], steps: PatternStep[] | null): void => {
    const unfolded = alternatives.map((alternative) => unfoldPattern(alternative, steps ?? []));
    const names = new Set(unfolded.flatMap((alternative) => [...alternative.keys()]));
    for (const name of names) {
      const projections = unfolded.map((alternative) => alternative.get(name));
      const first = projections[0];
      const agree =
        steps !== null &&
        first !== undefined &&
        first !== null &&
        projections.every((projection) => JSON.stringify(projection) === JSON.stringify(first));
      bind(name, agree ? first : null);
    }
  };
  visit(pattern, prefix);
  return projections;
}

/** The line of the first identifier token spelling `name` inside `pattern`. */
function firstBindingLine(pattern: AstNode, name: string): number {
  const find = (node: AstNode): AstNode | null => {
    if ((node.type === "identifier" || node.type === "shorthand_field_identifier") && node.text === name) return node;
    for (const child of node.namedChildren) {
      const hit = find(child);
      if (hit !== null) return hit;
    }
    return null;
  };
  return (find(pattern) ?? pattern).startPosition.row + 1;
}

/** The source region from `first`'s start to `last`'s end. */
function spanOf(first: AstNode, last: AstNode): ModifierConditionSpan {
  return spanBetween(first.startPosition, last.endPosition);
}

function spanBetween(
  start: { readonly row: number; readonly column: number },
  end: { readonly row: number; readonly column: number },
): ModifierConditionSpan {
  return { startLine: start.row + 1, startColumn: start.column, endLine: end.row + 1, endColumn: end.column };
}

/** A tuple-shaped pattern's element nodes in position order — the anonymous `_` wildcard holds a position too. */
function positionalElements(node: AstNode): AstNode[] {
  return node.children.filter((child) => child.isNamed || child.type === "_");
}
