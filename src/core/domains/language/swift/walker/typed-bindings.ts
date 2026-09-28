/**
 * Typed bindings — the `localBindings` / `callResultBindings` engine: the
 * scope machinery (`SwiftTypeScope`, `SwiftScopedBinding`), the one walk that
 * types every binding this file can prove (`collectSwiftTypedBindings`), the
 * expression-fact evaluator it consults (`swiftExpressionFact` and its arms),
 * and the innermost-chunk attribution that emits the bindings per chunk
 * (`assignBindingsToInnermostChunks`).
 */

import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { AstNode } from "../../../../contracts/types/ast.js";
import type { CallResultBinding, LocalBinding } from "../../../../contracts/types/codegraph.js";
import { lastClosureArgument, swiftConstructionSpelling } from "./calls.js";
import {
  enclosingSwiftTypeName,
  enclosingSwiftTypePath,
  singleIdentifierPatternName,
  SWIFT_FUNCTION_LIKE_NODES,
  SWIFT_MAX_TYPE_HOPS,
  SWIFT_TYPE_NAME_TEXT,
  swiftLambdaParameters,
  swiftParameterTypeNode,
  swiftTypeDeclarationKind,
  swiftTypeNodeAfter,
  walk,
} from "./shared.js";
import {
  NO_TYPE,
  returnKey,
  SWIFT_PSEUDO_BINDING_NAMES,
  swiftCollectionConstructionFact,
  swiftConstructedGenericFact,
  swiftDeclaredPropertyFact,
  swiftDeclaresOptional,
  swiftGenericResolvedFact,
  swiftMetatypeArgumentType,
  swiftTypeFactOf,
  swiftValueChainSpelling,
  swiftValueIsOptionalChained,
  type SwiftFileTypeEvidence,
  type SwiftTypeFact,
} from "./type-evidence.js";

/** Nodes that open a value scope — the ancestor a `guard let` binding stays alive to the end of. */
const SWIFT_BLOCK_NODES: ReadonlySet<string> = new Set([
  "statements",
  "function_body",
  "class_body",
  "enum_class_body",
  "protocol_body",
  "source_file",
]);

/**
 * Sequence methods whose closure receives the ELEMENT — one parameter, or two
 * for the comparators. Read only off an `element` fact, which only an `[T]`
 * type produces, so a project type's own namesake method is never re-read as a
 * collection's.
 */
const SWIFT_ELEMENT_CLOSURE_ARITY: ReadonlyMap<string, number> = new Map([
  ["forEach", 1],
  ["map", 1],
  ["compactMap", 1],
  ["flatMap", 1],
  ["filter", 1],
  ["first", 1],
  ["last", 1],
  ["contains", 1],
  ["allSatisfy", 1],
  ["firstIndex", 1],
  ["lastIndex", 1],
  ["drop", 1],
  ["prefix", 1],
  ["removeAll", 1],
  ["sorted", 2],
  ["sort", 2],
  ["min", 2],
  ["max", 2],
]);

/**
 * The evidence a CALL reads from a table keyed by {@link returnKey}, in
 * Swift's lookup order: a bare callee on the enclosing type, then at the top
 * level; a qualified one on whatever its receiver types to.
 */
function swiftCalleeEvidence<T>(
  callee: AstNode,
  table: ReadonlyMap<string, T>,
  scope: SwiftTypeScope,
  depth: number,
): T | undefined {
  if (callee.type === "simple_identifier") {
    const own = table.get(returnKey(scope.site.enclosingType, callee.text));
    return own !== undefined ? own : table.get(returnKey(null, callee.text));
  }
  if (callee.type !== "navigation_expression") return undefined;
  const member = callee.childForFieldName("suffix")?.childForFieldName("suffix");
  const owner = swiftReceiverTypeName(callee.childForFieldName("target"), scope, depth);
  return member && owner ? table.get(returnKey(owner, member.text)) : undefined;
}

/**
 * The positional facts a closure literal's parameters take from the call it
 * is an argument of — trailing or parenthesized — or null when nothing proves
 * them.
 *
 * Two sources, both declarations: the callee's ONE function-typed parameter
 * when this file declares the callee (same lookup order as
 * {@link swiftCallResultFact}), and the ELEMENT of an `[T]` receiver for a
 * sequence method (`xs.forEach { $0… }`).
 */
function swiftClosureArgumentFacts(lambda: AstNode, scope: SwiftTypeScope): readonly SwiftTypeFact[] | null {
  let suffix = lambda.parent;
  if (suffix?.type === "value_argument") suffix = suffix.parent?.parent ?? null;
  if (suffix?.type !== "call_suffix") return null;
  const call = suffix.parent;
  if (call?.type !== "call_expression") return null;
  const callee = call.namedChildren.find((c) => c.type !== "call_suffix");
  if (!callee) return null;
  if (callee.type === "navigation_expression") {
    const member = callee.childForFieldName("suffix")?.childForFieldName("suffix")?.text;
    const target = callee.childForFieldName("target");
    const element = target ? swiftExpressionFact(target, scope, 0).element : null;
    const arity = member === undefined ? undefined : SWIFT_ELEMENT_CLOSURE_ARITY.get(member);
    if (element && arity !== undefined) {
      return Array.from({ length: arity }, () => ({ nominal: element, element: null }));
    }
  }
  return swiftCalleeEvidence(callee, scope.evidence.closureParameters, scope, 0) ?? null;
}

/**
 * The SPELLING of the callee a closure literal is passed to — `mutableState.write`
 * for `mutableState.write { … }`, `withCheckedContinuation` for a BARE callee
 * (bd tea-rags-mcp-y99pg.29) — or undefined when the callee is neither a member
 * access on a value chain the resolver can fold nor a bare name.
 *
 * Only the call's LAST closure is spelled: the resolver reads the callee's
 * last function-typed parameter, the one a trailing closure fills, so an
 * earlier closure of `handle { … } onCancel: { … }` would be typed by the
 * wrong parameter.
 */
function swiftClosureCalleeSpelling(lambda: AstNode): string | undefined {
  let suffix = lambda.parent;
  if (suffix?.type === "value_argument") suffix = suffix.parent?.parent ?? null;
  if (suffix?.type !== "call_suffix" && suffix?.type !== "constructor_suffix") return undefined;
  const call = suffix.parent;
  if (call?.type !== "call_expression" && call?.type !== "constructor_expression") return undefined;
  if (lastClosureArgument(suffix)?.startIndex !== lambda.startIndex) return undefined;
  // `StreamOf<T>(…) { … }` — an explicitly specialised construction — is spelled
  // by its type, generic arguments dropped: the resolver reads the type's `init`.
  if (call.type === "constructor_expression") {
    // Positional, not `constructed_type`: see the materialization hazard {@link swiftTypeNodeAfter} documents.
    const typeNode = call.namedChildren.find((c) => c.type === "user_type");
    const constructed = typeNode?.text.replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, "");
    return constructed !== undefined && SWIFT_TYPE_NAME_TEXT.test(constructed) && /^[\w.]+$/.test(constructed)
      ? constructed
      : undefined;
  }
  const callee = call.namedChildren.find((c) => c.type !== "call_suffix");
  if (callee?.type === "simple_identifier") return callee.text;
  if (callee?.type !== "navigation_expression") return undefined;
  const member = callee.childForFieldName("suffix")?.childForFieldName("suffix")?.text;
  const targetNode = callee.childForFieldName("target");
  const target = swiftValueChainSpelling(targetNode) ?? swiftConstructionSpelling(targetNode);
  return member && target ? `${target}.${member}` : undefined;
}

/** How many `$n` parameters a closure's own body reads: one past the highest `n`. */
function swiftImplicitParameterCount(lambda: AstNode): number {
  let count = 0;
  for (const match of lambda.text.matchAll(/\$(\d+)/g)) count = Math.max(count, Number(match[1]) + 1);
  return count;
}

/**
 * Whether a closure body nests an implicit-parameter closure. Such a closure
 * re-binds `$0` for its own body, and one this walker cannot type would
 * otherwise see the OUTER `$0`'s type, since a binding here is scoped by line.
 */
function nestsImplicitParameterClosure(lambda: AstNode): boolean {
  let nested = false;
  const visit = (node: AstNode): void => {
    for (const child of node.children) {
      if (nested) return;
      if (child.type === "lambda_literal" && swiftLambdaParameters(child) === null) nested = true;
      else visit(child);
    }
  };
  visit(lambda);
  return nested;
}

/**
 * A binding as the walker holds it: the full {@link SwiftTypeFact} plus the
 * scope coordinates the emitted `LocalBinding` cannot carry.
 *
 * `functionKey` never leaves the walker — it exists so an identifier on one
 * method's right-hand side cannot be typed by a same-named local of another
 * method. A binding with no `nominal` is kept in the list and never emitted:
 * that is how an `[T]` annotation feeds `for x in xs` without typing the array.
 */
export interface SwiftScopedBinding {
  readonly name: string;
  readonly fact: SwiftTypeFact;
  /** 1-based declaration line — used for innermost-chunk attribution and position-aware reads. */
  readonly line: number;
  /** `startIndex` of the nearest enclosing function-like declaration; `-1` at type / file level. */
  readonly functionKey: number;
  /** 1-based last line the binding is visible on; absent ⇒ visible to the end of its chunk. */
  readonly scopeEndLine?: number;
  /**
   * The right-hand side's SPELLING when this file cannot type it — a value
   * chain whose links live in other files (bd tea-rags-mcp-y99pg.6). Emitted as
   * a `callResultBindings` entry for the resolver to fold; inside the walker the
   * binding types nothing but still SHADOWS a same-named property.
   */
  readonly valueChain?: string;
  /**
   * Set when `valueChain` is the CALLEE a closure is passed to and this
   * binding is that closure's N-th parameter (bd tea-rags-mcp-y99pg.13).
   */
  readonly closureParameter?: number;
  /**
   * Set when `valueChain` is a switch SUBJECT and this binding is payload
   * slot `index` of its case `caseName` (bd tea-rags-mcp-y99pg.16).
   */
  readonly enumPayload?: { readonly caseName: string; readonly index: number };
  /**
   * Set when the binding's own declaration spells its type `T?` — a
   * parameter or an annotated `let` / `var` — so its value is an `Optional`
   * of `fact.nominal` (bd tea-rags-mcp-y99pg.33). Never inferred: an
   * `if let` re-binding is the unwrapped value.
   */
  readonly optional?: true;
  /** Set when `valueChain` spells a `for` loop's SEQUENCE and this binding is its item (bd tea-rags-mcp-y99pg.37). */
  readonly sequenceElement?: true;
}

/** Where a right-hand side is being typed — the coordinates every lookup is relative to. */
interface SwiftBindingSite {
  readonly line: number;
  readonly functionKey: number;
  readonly enclosingType: string | null;
  /** The enclosing type's nesting path — what tells same-named nested types apart. */
  readonly enclosingTypePath: string | null;
}

/**
 * Everything {@link swiftExpressionFact} consults: the file's declarations plus
 * what is bound above.
 *
 * `bindingsByName` is an INDEX over the bindings collected so far, not a second
 * copy of them — the identifier lookup runs once per typed right-hand side and
 * a flat scan would make the pass quadratic in a file's binding count, which is
 * the shape a single generated source file turns into a measurable stall.
 */
interface SwiftTypeScope {
  readonly evidence: SwiftFileTypeEvidence;
  readonly bindingsByName: ReadonlyMap<string, SwiftScopedBinding[]>;
  readonly site: SwiftBindingSite;
}

/**
 * Collect every binding in the file whose type this file can PROVE, in source
 * order, so a right-hand side may read what was bound above it.
 *
 * Pre-order is what makes the ordering work: a `function_declaration`'s
 * parameters are visited before its body, and a statement's bindings before
 * every statement below. The type-level `property_declaration`s a body
 * contains are visited too — they are the implicit-self receivers — and
 * innermost-chunk attribution keeps them off the method chunks.
 */
export function collectSwiftTypedBindings(root: AstNode, evidence: SwiftFileTypeEvidence): SwiftScopedBinding[] {
  const collected: SwiftScopedBinding[] = [];
  const bindingsByName = new Map<string, SwiftScopedBinding[]>();
  const siteOf = (node: AstNode): SwiftBindingSite => ({
    line: node.startPosition.row + 1,
    functionKey: enclosingSwiftFunctionKey(node),
    enclosingType: enclosingSwiftTypeName(node),
    enclosingTypePath: enclosingSwiftTypePath(node),
  });
  const record = (
    name: string,
    fact: SwiftTypeFact,
    site: SwiftBindingSite,
    scopeEndLine?: number,
    valueChain?: string,
    closureParameter?: number,
    enumPayload?: { readonly caseName: string; readonly index: number },
    optional?: boolean,
    sequenceElement?: true,
  ): void => {
    if (SWIFT_PSEUDO_BINDING_NAMES.has(name)) return;
    if (!fact.nominal && !fact.element && valueChain === undefined) return;
    const binding: SwiftScopedBinding = {
      name,
      fact,
      line: site.line,
      functionKey: site.functionKey,
      scopeEndLine,
      valueChain,
      ...(closureParameter === undefined ? {} : { closureParameter }),
      ...(enumPayload === undefined ? {} : { enumPayload }),
      ...(optional === true ? { optional: true as const } : {}),
      ...(sequenceElement === undefined ? {} : { sequenceElement }),
    };
    collected.push(binding);
    const sameName = bindingsByName.get(name);
    if (sameName) sameName.push(binding);
    else bindingsByName.set(name, [binding]);
  };
  // A local only: a type-level property's initializer is not a scope a
  // receiver is read in.
  const deferredSpelling = (fact: SwiftTypeFact, value: AstNode | null, site: SwiftBindingSite): string | undefined =>
    fact.nominal || fact.element || site.functionKey === -1 ? undefined : (swiftValueChainSpelling(value) ?? undefined);
  walk(root, (node) => {
    switch (node.type) {
      case "parameter":
      case "lambda_parameter": {
        const name = node.childForFieldName("name");
        if (name) {
          // Past `inout` / `@escaping`, which sit between the colon and the type.
          const typeNode = swiftParameterTypeNode(node);
          const declared = swiftTypeFactOf(typeNode);
          const optional = typeNode?.type === "optional_type";
          record(
            name.text,
            swiftGenericResolvedFact(declared, node),
            siteOf(node),
            undefined,
            undefined,
            undefined,
            undefined,
            optional,
          );
        }
        return;
      }
      case "property_declaration": {
        const name = singleIdentifierPatternName(node.childForFieldName("name"));
        if (!name) return;
        const site = siteOf(node);
        const declared = swiftDeclaredPropertyFact(node);
        const value = node.childForFieldName("value");
        const fact = declared.nominal ? declared : swiftExpressionFact(value, { evidence, bindingsByName, site }, 0);
        const spelling = deferredSpelling(fact, value, site);
        record(
          name,
          fact,
          site,
          enclosingSwiftClosureEndLine(node),
          spelling,
          undefined,
          undefined,
          declared.nominal !== null
            ? swiftDeclaresOptional(node)
            : spelling !== undefined && swiftValueIsOptionalChained(value),
        );
        // `didSet { oldValue… }` / `willSet { newValue… }`: an observer's
        // parameter is a value of the property's DECLARED type, for the
        // clause's own body (bd tea-rags-mcp-y99pg.31).
        if (declared.nominal) {
          for (const clause of swiftPropertyObserverClauses(node)) {
            record(clause.name, declared, siteOf(clause.node), clause.node.endPosition.row + 1);
          }
        }
        return;
      }
      case "guard_statement":
      case "if_statement":
      case "while_statement": {
        const scopeEndLine =
          node.type === "guard_statement" ? enclosingSwiftBlockEndLine(node) : swiftThenBlockEndLine(node);
        for (const clause of swiftOptionalBindingClauses(node)) {
          // Each clause on its OWN line: a multi-line condition's later clause
          // folds the earlier ones, and a spelling is visible strictly below
          // its line (bd tea-rags-mcp-y99pg.32).
          const site = siteOf(clause.nameNode);
          const annotated = swiftGenericResolvedFact(swiftTypeFactOf(clause.annotation), node);
          const annotatedOrInferred =
            annotated.nominal || annotated.element
              ? annotated
              : swiftExpressionFact(clause.value, { evidence, bindingsByName, site }, 0);
          // Unwrapping `[T]?` yields `[T]`, so the element slot survives the
          // unwrap — the array still binds no receiver, and a `for` over the
          // unwrapped name still types its item.
          const spelling = deferredSpelling(annotatedOrInferred, clause.value, site);
          record(clause.name, annotatedOrInferred, site, scopeEndLine, spelling);
        }
        return;
      }
      case "for_statement": {
        const item = node.childForFieldName("item");
        const name = singleIdentifierPatternName(item);
        const pair = name ? null : swiftTuplePatternNames(item);
        if (!name && !pair) return;
        const site = siteOf(node);
        const collection = swiftExpressionFact(
          node.childForFieldName("collection"),
          { evidence, bindingsByName, site },
          0,
        );
        const scopeEnd = swiftThenBlockEndLine(node);
        if (name && collection.element) record(name, { nominal: collection.element, element: null }, site, scopeEnd);
        // A sequence only the resolver can type: the item is its element (bd tea-rags-mcp-y99pg.37).
        const sequence =
          name && !collection.element && site.functionKey !== -1
            ? swiftValueChainSpelling(node.childForFieldName("collection"))
            : null;
        if (name && sequence !== null) {
          record(name, NO_TYPE, site, scopeEnd, sequence, undefined, undefined, undefined, true);
        }
        // `for (key, value) in dictionary` (bd tea-rags-mcp-y99pg.17).
        if (pair && collection.entry) {
          pair.forEach((slotName, i) => {
            const nominal = collection.entry?.[i] ?? null;
            if (slotName !== null && nominal !== null) record(slotName, { nominal, element: null }, site, scopeEnd);
          });
        }
        break;
      }
      // `switch unit { case .group(let g): … }` — each payload name is bound
      // to its case's slot on the subject's enum, which another file
      // declares (bd tea-rags-mcp-y99pg.16).
      case "switch_statement": {
        const subject = swiftValueChainSpelling(
          node.childForFieldName("expr") ?? node.namedChildren.find((c) => c.type !== "switch_entry") ?? null,
        );
        if (subject === null) return;
        for (const entry of node.namedChildren) {
          if (entry.type !== "switch_entry") continue;
          const patterns = entry.namedChildren.filter((c) => c.type === "switch_pattern");
          if (patterns.length !== 1) continue;
          const site = siteOf(entry);
          // The entry and its `statements` run on to the next `case`; the last
          // statement is where the scope ends.
          let last = entry.namedChildren[entry.namedChildCount - 1];
          while (last.type === "statements" && last.namedChildCount > 0) {
            last = last.namedChildren[last.namedChildCount - 1];
          }
          const endLine = last.endPosition.row + 1;
          for (const payload of swiftEnumCasePayloadNames(patterns[0])) {
            record(payload.name, NO_TYPE, site, endLine, subject, undefined, payload.slot);
          }
        }
        return;
      }
      // `catch { error… }` — a clause with no pattern binds `error: any Error`
      // for its own block (bd tea-rags-mcp-y99pg.10).
      case "catch_block": {
        if (node.namedChildren.some((c) => c.type !== "catch_keyword" && c.type !== "statements")) return;
        const body = node.namedChildren.find((c) => c.type === "statements");
        if (!body) return;
        record("error", { nominal: "Error", element: null }, siteOf(body), node.endPosition.row + 1);
        return;
      }
      case "lambda_literal": {
        const site = siteOf(node);
        const facts = swiftClosureArgumentFacts(node, { evidence, bindingsByName, site });
        // No declaration in this file types the closure: hand its callee to
        // the resolver, which reads the callee's closure signature run-wide
        // (bd tea-rags-mcp-y99pg.13).
        const callee = facts ? undefined : swiftClosureCalleeSpelling(node);
        if (!facts && callee === undefined) return;
        const endLine = node.endPosition.row + 1;
        const bind = (name: string, i: number): void => {
          if (facts) {
            if (i < facts.length) record(name, facts[i], site, endLine);
          } else record(name, NO_TYPE, site, endLine, callee, i);
        };
        const named = swiftLambdaParameters(node);
        if (named === null) {
          if (nestsImplicitParameterClosure(node)) return;
          const count = facts ? facts.length : swiftImplicitParameterCount(node);
          for (let i = 0; i < count; i++) bind(`$${i}`, i);
          return;
        }
        named.forEach((parameter, i) => {
          const name = parameter.childForFieldName("name")?.text;
          // An annotated parameter is typed by its own `lambda_parameter` arm.
          if (!name || name === "_" || parameter.children.some((c) => c.type === ":")) return;
          bind(name, i);
        });
        break;
      }
      default:
        break;
    }
  });
  return collected;
}

/**
 * The names a `.caseName(let a, _)` / `let .caseName(a, _)` switch pattern
 * binds, each with its payload slot (bd tea-rags-mcp-y99pg.16). Any other
 * pattern shape — a qualified case, a nested pattern, a labelled slot — binds
 * nothing here.
 */
function swiftEnumCasePayloadNames(
  switchPattern: AstNode,
): { name: string; slot: { caseName: string; index: number } }[] {
  const pattern = switchPattern.namedChildren.find((c) => c.type === "pattern");
  if (!pattern) return [];
  const { children } = pattern;
  const outerLet = children[0]?.type === "value_binding_pattern" && children[0].namedChildCount <= 1;
  const dot = children.findIndex((c) => c.type === ".");
  const caseNode = dot === -1 ? undefined : children[dot + 1];
  if (dot !== (outerLet ? 1 : 0) || caseNode?.type !== "simple_identifier") return [];
  const out: { name: string; slot: { caseName: string; index: number } }[] = [];
  children
    .filter((c) => c.type === "pattern")
    .forEach((slot, index) => {
      const named = slot.namedChildren;
      let name: string | undefined;
      if (named.length === 2 && named[0].type === "value_binding_pattern" && named[1].type === "simple_identifier") {
        name = named[1].text;
      } else if (outerLet && named.length === 1 && named[0].type === "simple_identifier") {
        name = named[0].text;
      }
      if (name !== undefined && name !== "_") out.push({ name, slot: { caseName: caseNode.text, index } });
    });
  return out;
}

/** The parameter name each observer clause the language gives it when the clause names none. */
const SWIFT_OBSERVER_DEFAULT_PARAMETER: Readonly<Record<string, string>> = {
  didset_clause: "oldValue",
  willset_clause: "newValue",
};

/**
 * A property's `didSet` / `willSet` clauses, each with the name its parameter
 * goes by — the one the clause spells (`didSet(previous)`), else the
 * language's implicit `oldValue` / `newValue`.
 */
function swiftPropertyObserverClauses(property: AstNode): { name: string; node: AstNode }[] {
  const block = property.namedChildren.find((c) => c.type === "willset_didset_block");
  if (!block) return [];
  const out: { name: string; node: AstNode }[] = [];
  for (const clause of block.namedChildren) {
    const implicit = SWIFT_OBSERVER_DEFAULT_PARAMETER[clause.type];
    if (implicit === undefined) continue;
    const spelled = clause.namedChildren.find((c) => c.type === "simple_identifier")?.text;
    out.push({ name: spelled ?? implicit, node: clause });
  }
  return out;
}

/**
 * The two names of a `(a, b)` for-in pattern, `null` for a `_` slot; null
 * for any other pattern shape.
 */
function swiftTuplePatternNames(item: AstNode | null): [string | null, string | null] | null {
  if (!item || item.children[0]?.type !== "(") return null;
  const slots = item.namedChildren.filter((c) => c.type === "pattern");
  if (slots.length !== 2 || slots.length !== item.namedChildCount) return null;
  const names = slots.map((slot) => {
    const only = slot.namedChildCount === 1 ? slot.namedChildren[0] : null;
    return only?.type === "simple_identifier" ? only.text : null;
  });
  return [names[0], names[1]];
}

/** One `let x` / `var x` clause of a `guard` / `if` / `while` condition list. */
interface SwiftOptionalBindingClause {
  readonly name: string;
  /** The bound identifier — where the clause's binding is positioned. */
  readonly nameNode: AstNode;
  /** The binding's own `: T` annotation, when written. */
  readonly annotation: AstNode | null;
  /**
   * The expression being unwrapped. For the Swift 5.7 shorthand (`if let x`)
   * this is the bound identifier itself — the form re-binds the name it
   * unwraps, so the outer value is exactly what to type it from.
   */
  readonly value: AstNode | null;
}

/**
 * Read the `let` / `var` clauses out of a flat condition list.
 *
 * A clause is `value_binding_pattern`, then the bound `simple_identifier`,
 * then an optional `type_annotation`, then an optional `=` and its right-hand
 * side. Anything else after the binding pattern — the `.` of
 * `if case let .some(v)` — means the form destructures a pattern rather than
 * binding one name, and the clause is skipped.
 */
function swiftOptionalBindingClauses(node: AstNode): SwiftOptionalBindingClause[] {
  const out: SwiftOptionalBindingClause[] = [];
  const kids = node.children;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].type !== "value_binding_pattern") continue;
    const nameNode = kids[i + 1];
    if (nameNode?.type !== "simple_identifier") continue;
    let next = i + 2;
    let annotation: AstNode | null = null;
    if (kids[next]?.type === "type_annotation") {
      annotation = swiftTypeNodeAfter(kids[next], ":");
      next += 1;
    }
    const value = kids[next]?.type === "=" ? (kids[next + 1] ?? null) : nameNode;
    out.push({ name: nameNode.text, nameNode, annotation, value });
  }
  return out;
}

/**
 * What an expression PROVES about its value, from this file's evidence alone.
 *
 * Every arm reads a declaration: a binding above, a declared property, a
 * declared return, or a CapWords construction. An expression no arm recognises
 * proves nothing — the walk STOPS rather than degrading to a guess, which is
 * the same discipline `kernel/receiver-type-propagation.ts` applies to a
 * multi-hop receiver.
 */
function swiftExpressionFact(node: AstNode | null, scope: SwiftTypeScope, depth: number): SwiftTypeFact {
  if (!node || depth > SWIFT_MAX_TYPE_HOPS) return NO_TYPE;
  switch (node.type) {
    // `try f()` / `await f()` wrap the value; the operand is the last named child.
    case "try_expression":
    case "await_expression":
      return swiftExpressionFact(node.namedChildren[node.namedChildCount - 1] ?? null, scope, depth + 1);
    // `obj!` — the operand is first, the `bang` second.
    case "postfix_expression":
      return swiftExpressionFact(node.namedChildren[0] ?? null, scope, depth + 1);
    case "self_expression":
      return { nominal: scope.site.enclosingType, element: enclosingSwiftSelfElement(node) };
    case "simple_identifier":
      return node.text === "Self"
        ? { nominal: scope.site.enclosingType, element: null }
        : swiftIdentifierFact(node.text, scope);
    case "navigation_expression": {
      const member = node.childForFieldName("suffix")?.childForFieldName("suffix");
      if (!member) return NO_TYPE;
      const element = swiftElementAccess(
        node.childForFieldName("target"),
        member.text,
        SWIFT_ELEMENT_PROPERTIES,
        scope,
        depth,
      );
      if (element) return element;
      const owner = swiftReceiverTypeName(node.childForFieldName("target"), scope, depth);
      if (!owner) return NO_TYPE;
      return swiftPropertyFact(owner, member.text, scope);
    }
    case "call_expression":
      return swiftCallResultFact(node, scope, depth);
    case "constructor_expression":
      return swiftConstructedGenericFact(node);
    // A literal's default type (bd tea-rags-mcp-y99pg.27): `"…"` is String.
    case "line_string_literal":
    case "multi_line_string_literal":
    case "raw_string_literal":
      return { nominal: "String", element: null };
    case "array_literal":
      return swiftArrayLiteralFact(node, scope, depth);
    // `x as? Foo` / `x as! Foo` / `x as Foo` — the cast names its type.
    case "as_expression":
      return swiftTypeFactOf(node.namedChildren[node.namedChildCount - 1] ?? null);
    // `a ?? b` — the left operand, unwrapped; the right one where it proves nothing.
    case "nil_coalescing_expression": {
      const left = swiftExpressionFact(node.namedChildren[0] ?? null, scope, depth + 1);
      if (left.nominal || left.element) return left;
      return swiftExpressionFact(node.namedChildren[node.namedChildCount - 1] ?? null, scope, depth + 1);
    }
    default:
      return NO_TYPE;
  }
}

/**
 * `[a, b]` is an Array whose element is the type every element proves, or no
 * element where they disagree or one proves nothing; `[]` proves nothing, since
 * only its context types it (bd tea-rags-mcp-y99pg.27).
 */
function swiftArrayLiteralFact(node: AstNode, scope: SwiftTypeScope, depth: number): SwiftTypeFact {
  const elements = node.namedChildren.filter((c) => c.type !== "comment");
  if (elements.length === 0) return NO_TYPE;
  const types = new Set(elements.map((element) => swiftExpressionFact(element, scope, depth + 1).nominal));
  const [only] = types;
  return { nominal: "Array", element: types.size === 1 && only !== undefined ? only : null };
}

/**
 * The type a bare identifier holds: the nearest binding ABOVE it in the same
 * function scope, else the enclosing type's property of that name — Swift's
 * implicit `self`.
 *
 * The scope filters are the precision story. `functionKey` keeps one method's
 * local out of another's right-hand side; `line` keeps a later binding from
 * typing an earlier use; `scopeEndLine` keeps a block-scoped unwrap out of the
 * lines below its block. Same rule as the kernel's
 * {@link resolveLocalBinding}, applied inside the walker where the bindings
 * are still being built.
 */
function swiftIdentifierFact(name: string, scope: SwiftTypeScope): SwiftTypeFact {
  let best: SwiftScopedBinding | undefined;
  for (const binding of scope.bindingsByName.get(name) ?? []) {
    if (binding.functionKey !== scope.site.functionKey) continue;
    if (binding.line > scope.site.line) continue;
    if (binding.scopeEndLine !== undefined && binding.scopeEndLine < scope.site.line) continue;
    if (!best || binding.line > best.line) best = binding;
  }
  if (best) return best.fact;
  const owner = scope.site.enclosingType;
  return owner ? swiftPropertyFact(owner, name, scope) : NO_TYPE;
}

/**
 * The fact of property `name` on the type `owner` names. The enclosing type's
 * own name reads its NESTING PATH first — Swift resolves that name lexically,
 * so inside `DownloadResponsePublisher.Inner` an `Inner` is that type and not
 * a namesake nested elsewhere (bd tea-rags-mcp-y99pg.36).
 */
function swiftPropertyFact(owner: string, name: string, scope: SwiftTypeScope): SwiftTypeFact {
  const path = owner === scope.site.enclosingType ? scope.site.enclosingTypePath : null;
  return (
    (path ? scope.evidence.propertyTypes.get(path)?.get(name) : undefined) ??
    scope.evidence.propertyTypes.get(owner)?.get(name) ??
    NO_TYPE
  );
}

/**
 * The type name a RECEIVER denotes — the owner a member lookup is keyed by.
 *
 * Differs from {@link swiftExpressionFact} in one arm: a CapWords identifier
 * that names no value is read as the TYPE itself, which is how `Foo.shared`
 * and `Foo.make()` find their member. The metatype never becomes a binding —
 * this function is reachable only from a navigation target or a call's callee,
 * so `let v = Foo` still binds nothing.
 */
function swiftReceiverTypeName(node: AstNode | null, scope: SwiftTypeScope, depth: number): string | null {
  if (!node) return null;
  if (node.type === "simple_identifier" && node.text !== "Self") {
    const fact = swiftIdentifierFact(node.text, scope);
    if (fact.nominal) return fact.nominal;
    return /^_*[A-Z]/.test(node.text) ? node.text : null;
  }
  return swiftExpressionFact(node, scope, depth + 1).nominal;
}

/**
 * What a call evaluates to: a CapWords construction, or the DECLARED return
 * type of a callee this file also declares.
 *
 * A bare callee is looked up on the enclosing type BEFORE the top level, which
 * is Swift's own lookup order — a method shadows a global of the same name. A
 * qualified one is looked up on whatever its receiver types to, so
 * `self.build()`, `Foo.make()` and `repo.load()` are one arm.
 *
 * A bracketed `call_suffix` is a subscript read, not a call: `items[i]` proves
 * only that `items` is a collection, which this type language cannot say.
 */
function swiftCallResultFact(node: AstNode, scope: SwiftTypeScope, depth: number): SwiftTypeFact {
  const suffix = node.children.find((c) => c.type === "call_suffix");
  if (!suffix || suffix.text.startsWith("[")) return NO_TYPE;
  const callee = node.namedChildren.find((c) => c.type !== "call_suffix");
  if (!callee) return NO_TYPE;
  if (callee.type === "simple_identifier" && /^_*[A-Z]/.test(callee.text)) {
    return { nominal: callee.text, element: null };
  }
  // `[T]()` / `[K: V]()` construct an empty collection of the named types
  // (bd tea-rags-mcp-y99pg.17); a literal holding values is no type name.
  const collection = swiftCollectionConstructionFact(callee);
  if (collection) return collection;
  if (callee.type === "navigation_expression") {
    const member = callee.childForFieldName("suffix")?.childForFieldName("suffix")?.text;
    const target = callee.childForFieldName("target");
    const element = member ? swiftElementAccess(target, member, SWIFT_ELEMENT_METHODS, scope, depth) : null;
    if (element) return element;
  }
  // A generic return bound by a `Type.self` argument names its type at the
  // call; the declared return holds only its constraint.
  const slot = swiftCalleeEvidence(callee, scope.evidence.metatypeReturns, scope, depth);
  const bound = slot ? swiftMetatypeArgumentType(suffix, slot) : null;
  if (bound !== null) return { nominal: bound, element: null };
  return swiftCalleeEvidence(callee, scope.evidence.returnTypes, scope, depth) ?? NO_TYPE;
}

/** `startIndex` of the nearest enclosing function-like declaration; `-1` at type / file level. */
function enclosingSwiftFunctionKey(node: AstNode): number {
  for (let current = node.parent; current; current = current.parent) {
    if (SWIFT_FUNCTION_LIKE_NODES.has(current.type)) return current.startIndex;
  }
  return -1;
}

/** `[T]` properties that read one element. */
const SWIFT_ELEMENT_PROPERTIES: ReadonlySet<string> = new Set(["first", "last"]);

/** `[T]` methods that return one element (optional or not). */
const SWIFT_ELEMENT_METHODS: ReadonlySet<string> = new Set([
  "removeFirst",
  "removeLast",
  "popLast",
  "randomElement",
  "first",
  "last",
  "min",
  "max",
]);

/**
 * The element an accessor reads off an `[T]` value — `xs.first`,
 * `xs.removeFirst()` — or null. Keyed on the `element` slot, which only an
 * array type produces, so a project type's own `first` is never read this way.
 */
function swiftElementAccess(
  target: AstNode | null,
  member: string,
  accessors: ReadonlySet<string>,
  scope: SwiftTypeScope,
  depth: number,
): SwiftTypeFact | null {
  if (!target || !accessors.has(member)) return null;
  const { element } = swiftExpressionFact(target, scope, depth + 1);
  return element ? { nominal: element, element: null } : null;
}

/**
 * 1-based last line of the closure a declaration sits in, when its nearest
 * scope is a closure rather than a function: a `let` inside `{ … }` is gone at
 * the brace, and without the bound a sibling closure's same-named local would
 * type this one's reads. `undefined` outside any closure.
 */
function enclosingSwiftClosureEndLine(node: AstNode): number | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "lambda_literal") return current.endPosition.row + 1;
    if (SWIFT_FUNCTION_LIKE_NODES.has(current.type)) return undefined;
  }
  return undefined;
}

/**
 * The element `self` iterates as inside an extension of an ARRAY type:
 * `extension [ServerTrustEvaluating]` or `extension Array where Element ==
 * ServerTrustEvaluating` — so `for evaluator in self` types `evaluator` (bd
 * tea-rags-mcp-y99pg). Any other enclosing type answers null. The `where`
 * clause is read positionally: the constrained name first, the type last.
 */
function enclosingSwiftSelfElement(node: AstNode): string | null {
  let declaration: AstNode | null = node.parent;
  while (declaration && declaration.type !== "class_declaration" && declaration.type !== "protocol_declaration") {
    declaration = declaration.parent;
  }
  if (declaration?.type !== "class_declaration" || swiftTypeDeclarationKind(declaration) !== "extension") return null;
  const name = declaration.childForFieldName("name");
  if (name?.type === "array_type") return swiftTypeFactOf(name).element;
  if (name?.type !== "user_type" || name.text.trim() !== "Array") return null;
  for (const clause of declaration.children) {
    if (clause.type !== "type_constraints") continue;
    for (const constraint of clause.namedChildren) {
      const equality = constraint.namedChildren.find((c) => c.type === "equality_constraint");
      if (equality?.namedChildren[0]?.text !== "Element") continue;
      return swiftTypeFactOf(equality.namedChildren[equality.namedChildCount - 1]).nominal;
    }
  }
  return null;
}

/**
 * 1-based last line of the block CONTAINING `node` — a `guard let` binding's
 * scope extent. The `else` branch must exit, so everything below the guard and
 * inside the same block sees the unwrapped value, and nothing outside it does.
 */
function enclosingSwiftBlockEndLine(node: AstNode): number | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (SWIFT_BLOCK_NODES.has(current.type)) return current.endPosition.row + 1;
  }
  return undefined;
}

/**
 * 1-based line of the brace closing a statement's OWN body — an `if let` /
 * `while let` / `for in` binding's scope extent.
 *
 * The first `}` among the direct children is that brace: a condition's own
 * braces are nested inside its subtree, and an `else` block's `}` comes after
 * the `else` keyword. Reading the statement's end line instead would carry an
 * `if let` binding into the `else` branch, which Swift does not bind.
 */
function swiftThenBlockEndLine(node: AstNode): number | undefined {
  const close = node.children.find((c) => c.type === "}");
  return close ? close.endPosition.row + 1 : undefined;
}

/**
 * Attribute each binding to the INNERMOST chunk whose line range contains the
 * declaration, tie-broken by deeper scope — the same discipline
 * `assignCallsToInnermostChunks` applies to call sites, so a method's parameter
 * lands on the method chunk rather than the type chunk that also spans its
 * line. Bindings outside every chunk are dropped silently, and so is every
 * binding with no nominal type: an `[T]`-typed name reached this far only to
 * type a `for` loop's item.
 *
 * Returns chunk index → `Record<name, LocalBinding[]>`: the position-aware
 * contract shape, so a re-bound name accumulates one `{ line, type }` per
 * declaration and `resolveLocalBindingType` picks the most recent one at or
 * before a call's line, skipping one whose `scopeEndLine` has passed.
 */
export function assignBindingsToInnermostChunks(
  bindings: readonly SwiftScopedBinding[],
  chunks: { startLine: number; endLine: number; scope: string[] }[],
): Map<number, SwiftChunkBindings> {
  const out = new Map<number, SwiftChunkBindings>();
  for (const binding of bindings) {
    if (!binding.fact.nominal && binding.valueChain === undefined) continue;
    let bestIdx = -1;
    let bestSpan = Number.POSITIVE_INFINITY;
    let bestDepth = -1;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (binding.line < c.startLine || binding.line > c.endLine) continue;
      const span = c.endLine - c.startLine;
      const depth = c.scope.length;
      if (span < bestSpan || (span === bestSpan && depth > bestDepth)) {
        bestIdx = i;
        bestSpan = span;
        bestDepth = depth;
      }
    }
    if (bestIdx === -1) continue;
    let bucket = out.get(bestIdx);
    if (!bucket) {
      bucket = { localBindings: createIdentifierRecord(), callResultBindings: createIdentifierRecord() };
      out.set(bestIdx, bucket);
    }
    const scoped = binding.scopeEndLine === undefined ? {} : { scopeEndLine: binding.scopeEndLine };
    if (binding.fact.nominal) {
      const emitted: LocalBinding = {
        line: binding.line,
        type: binding.fact.nominal,
        ...scoped,
        // `T?` keeps `type: T` for every reader that wants the wrapped type,
        // and says what the value IS beside it (bd tea-rags-mcp-y99pg.33).
        ...(binding.optional === true
          ? {
              typeRef: {
                form: "instance" as const,
                name: "Optional",
                args: [{ form: "instance" as const, name: binding.fact.nominal }],
              },
            }
          : {}),
      };
      (bucket.localBindings[binding.name] ??= []).push(emitted);
    } else if (binding.valueChain !== undefined) {
      const emitted: CallResultBinding = {
        line: binding.line,
        callee: binding.valueChain,
        ...(binding.closureParameter === undefined ? {} : { closureParameter: binding.closureParameter }),
        ...(binding.enumPayload === undefined ? {} : { enumPayload: binding.enumPayload }),
        ...(binding.sequenceElement === undefined ? {} : { sequenceElement: binding.sequenceElement }),
        ...(binding.optional === true ? { optional: true as const } : {}),
        ...scoped,
      };
      (bucket.callResultBindings[binding.name] ??= []).push(emitted);
    }
  }
  return out;
}

/** One chunk's share of the file's bindings, in the two channels a chunk carries them in. */
export interface SwiftChunkBindings {
  readonly localBindings: Record<string, LocalBinding[]>;
  readonly callResultBindings: Record<string, CallResultBinding[]>;
}
