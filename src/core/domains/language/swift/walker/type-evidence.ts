/**
 * File-local TYPE EVIDENCE: the one-pass collection of what this file's own
 * declarations prove about types (`SwiftFileTypeEvidence`), the type-node →
 * fact reducer (`swiftTypeFactOf`), generic-constraint resolution
 * (`swiftGenericConstraint` / `swiftGenericResolvedFact`), the property /
 * construction / module-value facts read off declarations, and the scope-free
 * value-chain spellings. A walker resolves nothing, so every fact here is
 * file-local by construction — a same-file answer is the only one it can be
 * sure names the right declaration.
 */

import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { AstNode } from "../../../../contracts/types/ast.js";
import { swiftTypeFieldKey } from "../type-field-address.js";
import {
  enclosingSwiftTypeName,
  parenthesizedSwiftTypeNode,
  singleIdentifierPatternName,
  SWIFT_MAX_TYPE_HOPS,
  SWIFT_TYPE_NAME_TEXT,
  swiftFunctionTypeNode,
  swiftNestingPath,
  swiftParameterTypeNode,
  swiftTypeNodeAfter,
  walk,
} from "./shared.js";

/**
 * What a Swift type node PROVES about a value, in two separate slots.
 *
 * `nominal` is the type the value itself has and is the only slot anything
 * emits. `element` is the type of what the value CONTAINS — set for `[T]` and
 * nothing else — and exists so `for x in xs` can type `x` without ever letting
 * `xs` be typed as a `T`. Keeping them apart is what makes the container rule
 * structural: a caller that wants a receiver type reads `nominal` and gets
 * `Array` for an array, whatever the element is.
 */
export interface SwiftTypeFact {
  readonly nominal: string | null;
  readonly element: string | null;
  /**
   * A `Dictionary`'s key and value nominals, for a `for (key, value) in`
   * over it (bd tea-rags-mcp-y99pg.17). Absent on every other fact.
   */
  readonly entry?: readonly [string | null, string | null];
}

export const NO_TYPE: SwiftTypeFact = { nominal: null, element: null };

/** Names a binding must never be recorded under — each is claimed by a chain pass of its own. */
export const SWIFT_PSEUDO_BINDING_NAMES: ReadonlySet<string> = new Set(["self", "Self", "super"]);

/** The `structuredReturnTypes` marker a `-> Self` return publishes (bd tea-rags-mcp-y99pg.18). */
const SWIFT_SELF_RETURN = "Self";

/**
 * Return types that name nothing the symbol table can hold. `Self` is the
 * conforming type, unknowable at the declaration (the run-global channel
 * publishes it as {@link SWIFT_SELF_RETURN} for the resolver to substitute);
 * the other four are universal or empty and carry no member a call could land
 * on.
 */
export const SWIFT_UNUSABLE_RETURN_TYPES: ReadonlySet<string> = new Set(["Self", "Any", "AnyObject", "Never", "Void"]);

/**
 * Everything this file declares about types, gathered in ONE walk before any
 * binding is typed.
 *
 * File-local by construction. A walker resolves nothing, so the only callee
 * whose return type it may read is one this file declares, and the only
 * property whose type it may read is one this file's type body declares — which
 * is also exactly what `classFieldTypes` publishes.
 */
export interface SwiftFileTypeEvidence {
  /**
   * `typeName → propertyName → fact`, the fact-valued source of
   * `classFieldTypes`, keyed by nesting path AND by short name
   * ({@link swiftPropertyTypeViews}).
   */
  readonly propertyTypes: Map<string, Map<string, SwiftTypeFact>>;
  /**
   * `returnKey(owner, funcName) → fact`, or `null` where two declarations of
   * that coordinate disagree and the name is therefore unusable.
   */
  readonly returnTypes: Map<string, SwiftTypeFact | null>;
  /**
   * `returnKey(owner, funcName) → positional parameter facts` of the ONE
   * function-typed parameter that declaration takes — what a closure passed to
   * it binds `$0`, `$1`, … or its named parameters to (bd
   * tea-rags-mcp-y99pg.3). `null` where two declarations of the coordinate
   * disagree, or where one declaration takes two function-typed parameters and
   * which one a closure lands on is a label question.
   */
  readonly closureParameters: Map<string, readonly SwiftTypeFact[] | null>;
  /**
   * `returnKey(owner, funcName) → the argument` whose `Type.self` value names
   * what a generic return is (`as type: R.Type` → `-> R`), `null` where two
   * declarations disagree. Read before `returnTypes`, which holds only the
   * return's constraint.
   */
  readonly metatypeReturns: Map<string, SwiftMetatypeSlot | null>;
}

/** Which argument of a call binds a generic return: by label, or by position when unlabelled. */
export interface SwiftMetatypeSlot {
  readonly label: string | null;
  readonly index: number;
}

/** Key a declared return under its owning type (`null` = top level) plus its name. */
export function returnKey(owner: string | null, name: string): string {
  return `${owner ?? ""}\u0000${name}`;
}

/**
 * Collect the file's property types and declared return types.
 *
 * Properties are gathered per nominal type body exactly as the published
 * `classFieldTypes` needs them — `class_declaration` covers class / struct /
 * enum / extension / actor, `protocol_declaration` its requirements — and
 * computed properties count: `var total: Money { … }` still HAS type `Money`,
 * and a call on it dispatches on `Money` as a stored one does. An extension
 * body declares no stored properties (Swift forbids them), so it contributes
 * only computed ones and cannot collide with the type's own entry.
 *
 * Return types are gathered per `func`, keyed by the enclosing type so a
 * member beats a top-level namesake at lookup time without either erasing the
 * other. A coordinate two declarations disagree on is poisoned to `null`.
 */
export function collectSwiftFileTypeEvidence(root: AstNode): SwiftFileTypeEvidence {
  const propertyTypesByPath = new Map<string, SwiftTypePropertyFacts>();
  const returnTypes = new Map<string, SwiftTypeFact | null>();
  const closureParameters = new Map<string, readonly SwiftTypeFact[] | null>();
  const metatypeReturns = new Map<string, SwiftMetatypeSlot | null>();
  walk(root, (node) => {
    if (node.type === "class_declaration" || node.type === "protocol_declaration") {
      collectSwiftPropertyTypes(node, propertyTypesByPath);
      return;
    }
    if (node.type !== "function_declaration" && node.type !== "protocol_function_declaration") return;
    const name = node.childForFieldName("name")?.text;
    if (!name) return;
    const key = returnKey(enclosingSwiftTypeName(node), name);
    const closure = swiftClosureParameterFacts(node);
    if (closure !== undefined) {
      const seen = closureParameters.get(key);
      if (seen === undefined) closureParameters.set(key, closure);
      else if (!sameSwiftFacts(seen, closure)) closureParameters.set(key, null);
    }
    const slot = swiftMetatypeReturnSlot(node);
    if (slot !== undefined) {
      const seen = metatypeReturns.get(key);
      if (seen === undefined) metatypeReturns.set(key, slot);
      else if (seen?.label !== slot.label || seen.index !== slot.index) metatypeReturns.set(key, null);
    }
    const fact = swiftDeclaredReturnFact(node);
    if (!fact) return;
    const previous = returnTypes.get(key);
    if (previous === undefined) returnTypes.set(key, fact);
    // `previous === null` is the poisoned marker, and optional access keeps it poisoned.
    else if (previous?.nominal !== fact.nominal || previous?.element !== fact.element) returnTypes.set(key, null);
  });
  return {
    propertyTypes: swiftPropertyTypeViews(propertyTypesByPath),
    returnTypes,
    closureParameters,
    metatypeReturns,
  };
}

/** Whether two positional fact lists state the same types; `null` (poisoned) equals nothing. */
function sameSwiftFacts(a: readonly SwiftTypeFact[] | null, b: readonly SwiftTypeFact[] | null): boolean {
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  return a.every((fact, i) => fact.nominal === b[i].nominal && fact.element === b[i].element);
}

/**
 * The positional parameter facts of the ONE function-typed parameter a
 * declaration takes: `undefined` when it takes none, `null` when it takes two
 * or more. A name that is a generic parameter of the declaration or of its
 * enclosing type (`(inout Value) -> U` on `Protected<Value>`) proves nothing —
 * it is bound per use, not declared.
 */
function swiftClosureParameterFacts(fn: AstNode): readonly SwiftTypeFact[] | null | undefined {
  let found: readonly SwiftTypeFact[] | null | undefined;
  for (const parameter of fn.children) {
    if (parameter.type !== "parameter") continue;
    const functionType = swiftFunctionTypeNode(swiftParameterTypeNode(parameter));
    if (!functionType) continue;
    if (found !== undefined) return null;
    const params = functionType.children.find((c) => c.type === "tuple_type");
    const facts: SwiftTypeFact[] = [];
    for (const item of params?.namedChildren ?? []) {
      if (item.type !== "tuple_type_item") continue;
      facts.push(swiftGenericResolvedFact(swiftTypeFactOf(item.namedChildren[item.namedChildCount - 1] ?? null), fn));
    }
    found = facts;
  }
  return found;
}

/**
 * Where a generic return is bound by a METATYPE argument —
 * `func request<R: Request>(for: …, as type: R.Type) -> R?` returns whatever
 * type the `as:` argument names. The slot is the argument's label, or its
 * position when the parameter has none; `undefined` when the return is not
 * the declaration's own generic parameter or no parameter carries `R.Type`.
 */
function swiftMetatypeReturnSlot(fn: AstNode): SwiftMetatypeSlot | undefined {
  const returned = swiftTypeFactOf(swiftTypeNodeAfter(fn, "->")).nominal;
  if (!returned || !declaresSwiftTypeParameter(fn, returned)) return undefined;
  let index = 0;
  for (const parameter of fn.children) {
    if (parameter.type !== "parameter") continue;
    if (swiftParameterTypeNode(parameter)?.text === `${returned}.Type`) {
      const names = parameter.children.filter((c) => c.type === "simple_identifier").map((c) => c.text);
      const label = names.length > 1 ? names[0] : (names[0] ?? "_");
      return { label: label === "_" ? null : label, index };
    }
    index += 1;
  }
  return undefined;
}

/**
 * The type a call's metatype argument names — `DataRequest` for
 * `request(for: task, as: DataRequest.self)` — or null when the argument is
 * not a `Type.self` literal.
 */
export function swiftMetatypeArgumentType(suffix: AstNode, slot: SwiftMetatypeSlot): string | null {
  const args = suffix.children.find((c) => c.type === "value_arguments")?.namedChildren ?? [];
  const values = args.filter((a) => a.type === "value_argument");
  const labelOf = (arg: AstNode): string | null =>
    arg.children.find((c) => c.type === "value_argument_label")?.text ?? null;
  const arg = slot.label === null ? values[slot.index] : values.find((a) => labelOf(a) === slot.label);
  const value = arg?.namedChildren[arg.namedChildCount - 1];
  if (value?.type !== "navigation_expression") return null;
  if (value.childForFieldName("suffix")?.childForFieldName("suffix")?.text !== "self") return null;
  const typeText = value.childForFieldName("target")?.text;
  return typeText !== undefined && /^_*[A-Z][\w.]*$/.test(typeText) ? typeText : null;
}

/** Declarations whose `type_parameters` and `where` clause scope a generic name over their subtree. */
const SWIFT_GENERIC_SCOPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "protocol_function_declaration",
  "init_declaration",
  "subscript_declaration",
  "class_declaration",
]);

/**
 * What a generic parameter NAME stands for at `at`: `undefined` when no
 * enclosing declaration declares it (so it is a real type name), else the
 * nominal of its conformance constraint — inline (`<R: Request>`) or in a
 * `where` clause (`where T: Authenticator`) — or null when unconstrained.
 *
 * A call on a value of a constrained generic type dispatches on the
 * constraint's requirement, which is the declaration the typechecker binds, so
 * the constraint IS the receiver type for member lookup. The nearest declaring
 * scope wins, which is Swift's own shadowing.
 */
export function swiftGenericConstraint(name: string, at: AstNode): string | null | undefined {
  for (let current: AstNode | null = at; current; current = current.parent) {
    if (!SWIFT_GENERIC_SCOPES.has(current.type)) continue;
    const declared = current.children
      .find((c) => c.type === "type_parameters")
      ?.namedChildren.find((p) => p.type === "type_parameter" && p.namedChildren[0]?.text === name);
    if (!declared) continue;
    if (declared.namedChildCount > 1) return swiftTypeFactOf(declared.namedChildren[1]).nominal;
    for (const clause of current.children) {
      if (clause.type !== "type_constraints") continue;
      for (const constraint of clause.namedChildren) {
        const inheritance = constraint.namedChildren.find((c) => c.type === "inheritance_constraint");
        if (inheritance?.namedChildren[0]?.text !== name) continue;
        return swiftTypeFactOf(inheritance.namedChildren[inheritance.namedChildCount - 1]).nominal;
      }
    }
    return null;
  }
  return undefined;
}

/**
 * A fact with every generic parameter name replaced by its constraint
 * ({@link swiftGenericConstraint}). A member of a generic parameter
 * (`Serializer.SerializedObject`, an associated type) proves nothing.
 */
export function swiftGenericResolvedFact(fact: SwiftTypeFact, at: AstNode): SwiftTypeFact {
  const resolve = (name: string | null): string | null => {
    if (name === null) return null;
    const head = name.split(".")[0];
    const constraint = swiftGenericConstraint(head, at);
    if (constraint === undefined) return name;
    return head === name ? constraint : null;
  };
  const nominal = resolve(fact.nominal);
  const element = resolve(fact.element);
  return nominal === fact.nominal && element === fact.element ? fact : { nominal, element };
}

/** One type declaration's property facts, under the path it is nested at. */
interface SwiftTypePropertyFacts {
  /** The declaration's own name text — what the short-name view keys it by. */
  readonly name: string;
  readonly fields: Map<string, SwiftTypeFact>;
}

/**
 * One nominal type body's `propertyName → fact` entries, merged into the file
 * map under its NESTING PATH (`DownloadResponsePublisher.Inner`) — the
 * enclosing types' names outward-in, then its own. A same-path re-opening (a
 * same-file extension) merges into the same entry, first writer kept.
 */
function collectSwiftPropertyTypes(node: AstNode, into: Map<string, SwiftTypePropertyFacts>): void {
  const name = node.childForFieldName("name");
  const body = node.childForFieldName("body");
  if (!name || !body) return;
  const path = swiftNestingPath(node);
  for (const member of body.children) {
    if (member.type !== "property_declaration" && member.type !== "protocol_property_declaration") continue;
    const fieldName =
      member.type === "property_declaration"
        ? singleIdentifierPatternName(member.childForFieldName("name"))
        : protocolRequirementName(member);
    const fact = swiftStoredPropertyFact(member);
    if (!fieldName || (!fact.nominal && !fact.element)) continue;
    let entry = into.get(path);
    if (!entry) {
      entry = { name: name.text, fields: new Map<string, SwiftTypeFact>() };
      into.set(path, entry);
    }
    if (!entry.fields.has(fieldName)) entry.fields.set(fieldName, fact);
  }
}

/**
 * The file's property facts keyed BOTH ways a reader asks (bd
 * tea-rags-mcp-y99pg.36): by nesting path, and by the short name text every
 * pre-path reader — and every type-name spelling a receiver fold produces —
 * keys a type by.
 *
 * A short name several nested types share (Alamofire's Combine.swift nests an
 * `Inner` in each of three publishers) used to take the first body's fields,
 * so `request` typed `DataRequest` inside `DownloadResponsePublisher.Inner`.
 * The short entry is now:
 *
 *   - a declaration whose path IS its name (top-level, or an extension
 *     spelled `extension A.B`) speaks for it alone — nothing nested under a
 *     namesake reaches it;
 *   - otherwise the nested namesakes' union, keeping only the fields every
 *     namesake declaring them agrees on. A disagreement names no type, and a
 *     reader that can tell the namesakes apart reads the path key instead.
 */
function swiftPropertyTypeViews(
  byPath: ReadonlyMap<string, SwiftTypePropertyFacts>,
): Map<string, Map<string, SwiftTypeFact>> {
  const out = new Map<string, Map<string, SwiftTypeFact>>();
  const pathsByName = new Map<string, string[]>();
  for (const [path, entry] of byPath) {
    out.set(path, entry.fields);
    const paths = pathsByName.get(entry.name) ?? [];
    paths.push(path);
    pathsByName.set(entry.name, paths);
  }
  for (const [name, paths] of pathsByName) {
    if (out.has(name)) continue;
    const merged = new Map<string, SwiftTypeFact>();
    const poisoned = new Set<string>();
    for (const path of paths) {
      for (const [field, fact] of byPath.get(path)?.fields ?? []) {
        const seen = merged.get(field);
        if (seen === undefined) merged.set(field, fact);
        else if (seen.nominal !== fact.nominal || seen.element !== fact.element) poisoned.add(field);
      }
    }
    for (const field of poisoned) merged.delete(field);
    if (merged.size > 0) out.set(name, merged);
  }
  return out;
}

/**
 * The name a protocol property requirement (`var manager: Manager { get }`)
 * declares. Its `pattern` carries the `var` keyword's binding pattern BESIDE
 * the name, so the one-identifier read a stored property uses finds nothing.
 */
function protocolRequirementName(requirement: AstNode): string | null {
  const pattern = requirement.children.find((c) => c.type === "pattern");
  const names = pattern?.namedChildren.filter((c) => c.type === "simple_identifier") ?? [];
  return names.length === 1 ? names[0].text : null;
}

/**
 * The published `typeName → fieldName → typeName` view of the property
 * evidence — the channel the resolver's stored-property pass reads for
 * `self.db.write()` and for Swift's implicit-self `db.write()`.
 *
 * Only `nominal` survives the projection, so an `[Thing]` property contributes
 * nothing here while still typing `for item in items` inside the walker.
 */
export function swiftClassFieldTypes(evidence: SwiftFileTypeEvidence): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = createIdentifierRecord();
  for (const [typeName, fields] of evidence.propertyTypes) {
    const published: Record<string, string> = createIdentifierRecord();
    for (const [fieldName, fact] of fields) if (fact.nominal) published[fieldName] = fact.nominal;
    if (Object.keys(published).length > 0) out[typeName] = published;
  }
  return out;
}

/**
 * The same published view, re-keyed to the run-global address
 * (`../type-field-address.ts`).
 *
 * A projection and not a second collection pass: both addresses state exactly
 * the facts `swiftClassFieldTypes` already published, so the two can never
 * disagree about a type's fields. The file-qualified key is what
 * `CodegraphRunState` merges per-key across the run, which is what keeps a type
 * re-opened by an `extension` in another file from overwriting the entry
 * carrying its own body.
 */
export function swiftClassFieldTypesByClassKey(
  published: Record<string, Record<string, string>>,
  relPath: string,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = createIdentifierRecord();
  for (const [typeName, fields] of Object.entries(published)) out[swiftTypeFieldKey(relPath, typeName)] = fields;
  return out;
}

/**
 * A `func`'s DECLARED return type, or null when it names nothing usable.
 *
 * Swift writes its return types, so this is a read rather than the terminal-
 * expression fold `kernel/return-inference.ts` performs for Ruby and Python.
 * The two gates are what keep the read honest: a universal / empty type
 * (`Any`, `Void`, `Self`) has no member to land on, and a generic parameter
 * is a name that exists only inside the signature — recording `T` would
 * fabricate a `T#member` target at every call site, so it reads as its
 * constraint, or as nothing when it has none (bd tea-rags-mcp-y99pg.6).
 */
export function swiftDeclaredReturnFact(node: AstNode): SwiftTypeFact | null {
  const fact = swiftGenericResolvedFact(swiftTypeFactOf(swiftTypeNodeAfter(node, "->")), node);
  const named = fact.nominal ?? fact.element;
  if (!named) return null;
  return SWIFT_UNUSABLE_RETURN_TYPES.has(named) ? null : fact;
}

/**
 * `SWIFT_SELF_RETURN` for a `func` declared `-> Self`, else null (bd
 * tea-rags-mcp-y99pg.18). Published as a MARKER, never as the declaring type:
 * `Self` is the RECEIVER's type, which only the resolver's fold knows —
 * `dataRequest.configured()` on a method `Request` declares returns a
 * `DataRequest`.
 */
export function swiftSelfReturnMarker(node: AstNode): string | null {
  const declared = swiftTypeFactOf(swiftTypeNodeAfter(node, "->")).nominal;
  return declared === SWIFT_SELF_RETURN ? SWIFT_SELF_RETURN : null;
}

/** Whether `name` is one of the declaration's own generic parameters (`func decode<T>() -> T`). */
function declaresSwiftTypeParameter(node: AstNode, name: string): boolean {
  const parameters = node.children.find((c) => c.type === "type_parameters");
  if (!parameters) return false;
  return parameters.children.some(
    (p) => p.type === "type_parameter" && p.children.find((c) => c.type === "type_identifier")?.text === name,
  );
}

/** What a module-level value declaration states about the value (bd tea-rags-mcp-y99pg.30). */
export interface SwiftModuleValueFact {
  readonly name: string;
  /** The nominal the declaration spells — an annotation or a CapWords construction. */
  readonly type?: string;
  /** Else the right-hand side's value-chain spelling, for the resolver to fold. */
  readonly spelling?: string;
}

/**
 * What a FILE-SCOPE `property_declaration` publishes as a module value, or
 * null: a single bound name, typed by the same narrow rule a stored property
 * is ({@link swiftDeclaredPropertyFact}), else spelled by the rule a local's
 * cross-file right-hand side is ({@link swiftValueChainSpelling}). The caller
 * owns which nodes are file-scope and which access levels leave the file.
 */
export function swiftModuleValueOf(node: AstNode): SwiftModuleValueFact | null {
  if (node.type !== "property_declaration") return null;
  const name = singleIdentifierPatternName(node.childForFieldName("name"));
  if (name === null || SWIFT_PSEUDO_BINDING_NAMES.has(name)) return null;
  const declared = swiftDeclaredPropertyFact(node);
  if (declared.nominal) return { name, type: declared.nominal };
  const spelling = swiftValueChainSpelling(node.childForFieldName("value"));
  return spelling === null ? null : { name, spelling };
}

/**
 * The type a `property_declaration` DECLARES, or nothing. Annotation first; on
 * its absence, a CapWords initializer call.
 *
 * This is the narrow rule `classFieldTypes` publishes — evidence written at the
 * declaration and nothing inferred through it. A local falls back to
 * {@link swiftExpressionFact} when this is silent; a type-level property does
 * not, because the property map is that walk's input.
 */
/**
 * Whether a `property_declaration` ANNOTATES its type as `T?` (bd
 * tea-rags-mcp-y99pg.33). `T!` is not: an implicitly unwrapped value reads its
 * members off `T`. Read positionally, as every type position here is.
 */
export function swiftDeclaresOptional(node: AstNode): boolean {
  const annotation = node.children.find((c) => c.type === "type_annotation");
  return annotation !== undefined && swiftTypeNodeAfter(annotation, ":")?.type === "optional_type";
}

export function swiftDeclaredPropertyFact(node: AstNode): SwiftTypeFact {
  const annotation = node.children.find((c) => c.type === "type_annotation");
  if (annotation) return swiftGenericResolvedFact(swiftTypeFactOf(swiftTypeNodeAfter(annotation, ":")), node);
  return constructedTypeFact(node.childForFieldName("value"));
}

/**
 * The type a STORED property (a type member or a module-level value)
 * publishes: {@link swiftDeclaredPropertyFact}, else the literal it is
 * initialised by. A local reads the full expression walk instead, which also
 * types a literal's elements.
 */
function swiftStoredPropertyFact(node: AstNode): SwiftTypeFact {
  const declared = swiftDeclaredPropertyFact(node);
  if (declared.nominal || declared.element) return declared;
  return swiftLiteralPropertyFact(node.childForFieldName("value")) ?? declared;
}

/**
 * The type a collection, string or Boolean LITERAL names at the declaration itself (bd
 * tea-rags-mcp-y99pg.39): `[(1, 2), (14, 1)]` is an `Array`, `["a": 1]` a
 * `Dictionary`, `"GitHub"` a `String` — Swift's defaults for an unannotated
 * literal. Evidence written at the declaration, like a CapWords initializer,
 * and read without typing any element, so a property's type still never
 * depends on another's. An empty `[]` is not here — only its context types
 * it — and neither is a number, whose default the resolver has no use for.
 */
function swiftLiteralPropertyFact(value: AstNode | null): SwiftTypeFact | null {
  if (value === null) return null;
  switch (value.type) {
    case "array_literal":
      return value.namedChildren.some((c) => c.type !== "comment") ? { nominal: "Array", element: null } : null;
    case "dictionary_literal":
      return { nominal: "Dictionary", element: null };
    case "line_string_literal":
    case "multi_line_string_literal":
    case "raw_string_literal":
      return { nominal: "String", element: null };
    // `@State private var showing = false` (bd tea-rags-mcp-3j7rg): a Boolean
    // literal's default type is `Bool`, and reading the property reads it.
    case "boolean_literal":
      return { nominal: "Bool", element: null };
    default:
      return null;
  }
}

/**
 * `Helper()` → `Helper`. Nothing for anything else, including a lowercase callee.
 *
 * Swift types are UpperCamelCase and functions lowerCamelCase by universal
 * convention, so a CapWords callee is a construction. A lowercase one is a
 * function, and its return type is answered — where this file declares it — by
 * {@link swiftDeclaredReturnFact}, never by recording the function's own name
 * as a type. Same gate as Rust's `isCapWordsType` and Python's
 * `isCapWordsConstructor`.
 */
export function constructedTypeFact(value: AstNode | null): SwiftTypeFact {
  if (value?.type === "constructor_expression") return swiftConstructedGenericFact(value);
  if (value?.type !== "call_expression") return NO_TYPE;
  const callee = value.namedChildren.find((c) => c.type !== "call_suffix");
  if (!callee) return NO_TYPE;
  if (callee.type !== "simple_identifier") return swiftCollectionConstructionFact(callee) ?? NO_TYPE;
  return /^_*[A-Z]/.test(callee.text) ? { nominal: callee.text, element: null } : NO_TYPE;
}

/**
 * `Protected<[T]>(…)` — tree-sitter-swift parses an explicitly specialised
 * construction as a `constructor_expression` over a `user_type`, not a call —
 * types as the generic's nominal (bd tea-rags-mcp-y99pg.10).
 */
export function swiftConstructedGenericFact(node: AstNode): SwiftTypeFact {
  const constructed = node.namedChildren.find((c) => c.type === "user_type") ?? null;
  const fact = swiftTypeFactOf(constructed);
  return fact.nominal && /^_*[A-Z]/.test(fact.nominal) ? fact : NO_TYPE;
}

/**
 * Reduce a Swift type node to what it proves.
 *
 *   - `user_type` — `Foo` → nominal `Foo`, `Set<Foo>` → nominal `Set` (generics
 *     stripped by text, which also keeps a qualified `Outer.Inner` intact as
 *     the nested type's own composed id spells it).
 *   - `optional_type` — `Foo?` → whatever `Foo` proves. The receiver of
 *     `x?.m()` is the wrapped value, so the Optional is transparent here.
 *   - `existential_type` — `any Proto` → whatever `Proto` proves. Swift 5.7
 *     made the keyword mandatory, so this is how protocol-typed storage is
 *     SPELLED in modern code rather than an exotic corner: a call on such a
 *     value dispatches on the protocol's own requirement, which is a project
 *     symbol whenever the protocol is.
 *   - `tuple_type` holding exactly one unlabelled item — `(any Proto)`, `(Foo)`
 *     → whatever the item proves. Swift has no one-element tuple; that shape is
 *     a PARENTHESIZED type, and the parentheses are required around an
 *     existential before `?`. A tuple with two or more items proves nothing,
 *     because no member dispatches on a tuple.
 *   - `array_type` — `[Foo]` → nominal `Array`, ELEMENT `Foo`. An Array is not
 *     a Foo; see the container note in the file docblock.
 *   - `dictionary_type` — `[K: V]` → nominal `Dictionary`, no element.
 *   - anything else, notably `function_type`, and a `tuple_type` that is a
 *     real tuple — nothing.
 */
const SWIFT_METATYPE_SUFFIX = /\.(?:Type|Protocol)$/;

/** Constraints that declare no member a call could dispatch on: marker protocols and `AnyObject`. */
const SWIFT_MARKER_PROTOCOLS: ReadonlySet<string> = new Set([
  "Sendable",
  "AnyObject",
  "Copyable",
  "Escapable",
  "BitwiseCopyable",
  "SendableMetatype",
]);

export function swiftTypeFactOf(typeNode: AstNode | null): SwiftTypeFact {
  if (!typeNode) return NO_TYPE;
  if (typeNode.type === "optional_type") return swiftTypeFactOf(typeNode.namedChildren[0] ?? null);
  if (typeNode.type === "array_type") {
    return { nominal: "Array", element: swiftTypeFactOf(typeNode.namedChildren[0] ?? null).nominal };
  }
  if (typeNode.type === "dictionary_type") {
    // Positionally, for the materialization hazard `swiftTypeNodeAfter` documents.
    const [key, value] = typeNode.namedChildren;
    return {
      nominal: "Dictionary",
      element: null,
      entry: [swiftTypeFactOf(key ?? null).nominal, swiftTypeFactOf(value ?? null).nominal],
    };
  }
  // `any P` and `some P` both dispatch a member call on P's requirement.
  if (typeNode.type === "existential_type" || typeNode.type === "opaque_type") {
    return swiftTypeFactOf(typeNode.namedChildren[0] ?? null);
  }
  // `Subscriber & Sendable` dispatches on Subscriber: a marker protocol declares
  // no member. Two real protocols leave the lookup undecided (bd tea-rags-mcp-y99pg.28).
  if (typeNode.type === "protocol_composition_type") {
    const real = typeNode.namedChildren.filter((c) => !SWIFT_MARKER_PROTOCOLS.has(c.text.trim()));
    return real.length === 1 ? swiftTypeFactOf(real[0]) : NO_TYPE;
  }
  if (typeNode.type === "tuple_type") return swiftTypeFactOf(parenthesizedSwiftTypeNode(typeNode));
  if (typeNode.type === "metatype") return swiftTypeFactOf(typeNode.namedChildren[0] ?? null);
  if (typeNode.type !== "user_type") return NO_TYPE;
  const raw = typeNode.text;
  const generics = raw.indexOf("<");
  // `Foo.Type` / `Foo.Protocol` is Foo's metatype: a member read off it is one
  // of Foo's static members, which compose under Foo (bd tea-rags-mcp-y99pg.12).
  const bare = (generics === -1 ? raw : raw.slice(0, generics)).trim().replace(SWIFT_METATYPE_SUFFIX, "");
  if (bare.length === 0) return NO_TYPE;
  return { nominal: bare, element: swiftSpelledSequenceElement(typeNode, bare) };
}

/**
 * The standard library sequences whose ONE generic argument is their
 * `Element` — `Set<Request>` iterates `Request`s exactly as `[Request]` does
 * (bd tea-rags-mcp-y99pg.32). `Dictionary`, `Result` and every other generic
 * type are absent: an argument of theirs is not what a `for` or a `forEach`
 * hands its body.
 */
export const SWIFT_SINGLE_ELEMENT_SEQUENCES: ReadonlySet<string> = new Set([
  "Array",
  "Set",
  "ArraySlice",
  "ContiguousArray",
]);

/**
 * The element nominal a `user_type` spelling one of
 * {@link SWIFT_SINGLE_ELEMENT_SEQUENCES} with its argument states, or null.
 * Read positionally off `type_arguments`, for the materialization hazard
 * {@link swiftTypeNodeAfter} documents.
 */
function swiftSpelledSequenceElement(typeNode: AstNode, nominal: string): string | null {
  if (!SWIFT_SINGLE_ELEMENT_SEQUENCES.has(nominal)) return null;
  const args = typeNode.children.find((c) => c.type === "type_arguments")?.namedChildren ?? [];
  return args.length === 1 ? swiftTypeFactOf(args[0]).nominal : null;
}

/**
 * The SPELLING of a value chain the resolver can fold — `self`, a value or
 * type name, then `.member` and `.method(…)` links — with `try` / `await`,
 * optional chaining, force unwraps and call arguments stripped, and `a ?? b`
 * read as `a`. Null for anything else, a chain headed by a bare call included:
 * the fold types a head by name, and `make()` is no name.
 */
export function swiftValueChainSpelling(node: AstNode | null, depth = 0): string | null {
  if (!node || depth > SWIFT_MAX_TYPE_HOPS + 2) return null;
  switch (node.type) {
    case "try_expression":
    case "await_expression":
      return swiftValueChainSpelling(node.namedChildren[node.namedChildCount - 1] ?? null, depth + 1);
    case "postfix_expression":
    case "nil_coalescing_expression":
      return swiftValueChainSpelling(node.namedChildren[0] ?? null, depth + 1);
    case "self_expression":
      return "self";
    case "simple_identifier":
      return node.text;
    case "navigation_expression": {
      const member = node.childForFieldName("suffix")?.childForFieldName("suffix");
      const target = swiftValueChainSpelling(node.childForFieldName("target"), depth + 1);
      return member?.type === "simple_identifier" && target !== null ? `${target}.${member.text}` : null;
    }
    case "call_expression": {
      const suffix = node.children.find((c) => c.type === "call_suffix");
      // `tiles.filter { … }`: a trailing closure is one more argument, and the
      // spelling strips arguments (bd tea-rags-mcp-y99pg.39).
      if (!suffix || suffix.children.some((c) => c.type !== "value_arguments" && c.type !== "lambda_literal")) {
        return null;
      }
      const callee = node.namedChildren.find((c) => c.type !== "call_suffix");
      const spelled = callee?.type === "navigation_expression" ? swiftValueChainSpelling(callee, depth + 1) : null;
      // `read(\.activeRequests)`: the one argument a generic return can be
      // bound by, so the spelling keeps it (bd tea-rags-mcp-y99pg.37).
      const keyPath = suffix.children.some((c) => c.type === "lambda_literal")
        ? null
        : swiftLoneKeyPathArgument(suffix);
      return spelled !== null && keyPath !== null ? `${spelled}(${keyPath})` : spelled;
    }
    default:
      return null;
  }
}

/**
 * Whether the value a {@link swiftValueChainSpelling} spells is an OPTIONAL
 * the spelling cannot show (bd tea-rags-mcp-y99pg.39): some link of the chain
 * is optional-chained (`a.first?.model` — the `?` is a child of the
 * navigation, read positionally because its field collides with `target`),
 * or the whole is `try?`'d. A force unwrap and a `??` end the question with
 * "not known optional", which is what a spelling meant before.
 */
export function swiftValueIsOptionalChained(node: AstNode | null, depth = 0): boolean {
  if (!node || depth > SWIFT_MAX_TYPE_HOPS + 2) return false;
  switch (node.type) {
    case "try_expression": {
      const operator = node.children.find((c) => c.type === "try_operator");
      if (operator?.children.some((c) => c.type === "?")) return true;
      return swiftValueIsOptionalChained(node.namedChildren[node.namedChildCount - 1] ?? null, depth + 1);
    }
    case "await_expression":
      return swiftValueIsOptionalChained(node.namedChildren[node.namedChildCount - 1] ?? null, depth + 1);
    case "navigation_expression":
      if (node.children.some((c) => c.type === "?")) return true;
      return swiftValueIsOptionalChained(
        node.namedChildren.find((c) => c.type !== "navigation_suffix") ?? null,
        depth + 1,
      );
    case "call_expression":
      return swiftValueIsOptionalChained(node.namedChildren.find((c) => c.type !== "call_suffix") ?? null, depth + 1);
    default:
      return false;
  }
}

/** `\.p`, `\.p.q`, `\.self` — a root-inferred key path of plain property names. */
const SWIFT_PLAIN_KEY_PATH = /^\\\.(?:self|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)$/;

/** The text of a call's ONE unlabeled argument when it is a plain key path, else null. */
function swiftLoneKeyPathArgument(suffix: AstNode): string | null {
  const list = suffix.children.find((c) => c.type === "value_arguments");
  const args = (list?.namedChildren ?? []).filter((c) => c.type === "value_argument");
  if (args.length !== 1) return null;
  const [arg] = args;
  if (arg.children.some((c) => c.type === "value_argument_label")) return null;
  const text = arg.text.trim();
  return SWIFT_PLAIN_KEY_PATH.test(text) ? text : null;
}

/**
 * The collection an `[T]()` / `[K: V]()` callee constructs, or null when the
 * literal holds anything but type names. Read positionally: the literal's
 * `element` / `key` / `value` fields are not relied on.
 */
export function swiftCollectionConstructionFact(callee: AstNode): SwiftTypeFact | null {
  const names = callee.namedChildren;
  if (!names.every((n) => n.type === "simple_identifier" && SWIFT_TYPE_NAME_TEXT.test(n.text))) return null;
  if (callee.type === "array_literal" && names.length === 1) {
    return { nominal: "Array", element: names[0].text };
  }
  if (callee.type === "dictionary_literal" && names.length === 2) {
    return { nominal: "Dictionary", element: null, entry: [names[0].text, names[1].text] };
  }
  return null;
}
