/**
 * Swift extraction walker — tier 2 of the Swift vertical (the tier-1 vertical
 * shipped grammar + chunking only). Produces the four channels the resolver
 * chain reads: `imports`, per-chunk `calls`, per-chunk `localBindings`, and the
 * file-level `classFieldTypes`.
 *
 * Shaped after the Java walker (`java/walker/walker.ts`): innermost-chunk
 * attribution for BOTH calls (via the kernel's `assignCallsToInnermostChunks`)
 * and bindings, a flat `{ name, type, startLine }` collection pass, and a
 * file-level type→field→type map for the `self.field.method()` path.
 *
 * ## What tree-sitter-swift makes non-obvious
 *
 * - **Imports name a MODULE, never a symbol.** `import Foundation` and
 *   `import struct Foundation.Data` both yield a module path, so `importText`
 *   is that path and nothing downstream can map it to a declaration. The
 *   resolver has no import-receiver pass for exactly this reason — see
 *   `../resolver/swift-resolver.ts`.
 * - **A subscript read parses as a `call_expression`.** `items[i]` is a
 *   `call_expression` whose `call_suffix` is bracketed. Recording it emits a
 *   bare call named after a PROPERTY, which the terminal short-name pass then
 *   pins to an unrelated function, so the bracketed suffix is skipped.
 * - **Optional chaining and force unwrap live INSIDE the receiver text.**
 *   `obj!.forced()` gives a `postfix_expression` target whose text is `obj!`,
 *   and `a?.b!.c()` gives `a?.b!`. `normalizeSwiftReceiver` strips `?` and `!`
 *   so the text matches the name a binding or a stored property is keyed by;
 *   without it every unwrapped receiver in the corpus misses.
 * - **`try` / `await` wrap the call, not the other way round.** The walk visits
 *   every node, so `try await session.data(for:)` is reached as the ordinary
 *   `call_expression` nested inside them — no unwrapping needed. An
 *   INITIALIZER is the other way round: `let x = try load()` hands the binding
 *   collector a `try_expression`, so the type walk unwraps them there.
 * - **A `guard` / `if` / `while` condition list is FLAT.** The grammar emits
 *   `value_binding_pattern`, the bound `simple_identifier`, `=` and the
 *   right-hand side as sibling children under a REPEATED `condition` field, so
 *   the clauses are read by scanning `children` in order — `childForFieldName`
 *   answers with the first writer only and cannot see clause two. It is also
 *   what separates `if let x = y` from `if case let .some(v) = y`: the
 *   pattern-matching form puts a `.` where the plain form puts the bound name.
 * - **A TYPE position carries TWO field names, and materialization keeps one.**
 *   `parameter.type`, `type_annotation.type` and a `func`'s `return_type` are
 *   each ALSO registered under `name`, which is the one `fieldNameForChild`
 *   reports and therefore the only one `materializeTree` records — so those
 *   three fields exist on a native node and are gone on the node the pipeline
 *   actually walks. Every type here is read positionally instead; see
 *   {@link swiftTypeNodeAfter}, which is the single place that reasoning lives.
 *
 * ## What the walker can prove about a receiver's type
 *
 * Every type below is READ, never guessed: an annotation, a CapWords
 * initializer, a declared `-> T`, or a stored property's declared type. The
 * evidence is FILE-LOCAL — {@link SwiftFileTypeEvidence} is built from this
 * file's own declarations — because a walker resolves nothing, and a
 * same-file answer is the only one it can be sure names the right declaration.
 *
 *   1. `parameter` / `lambda_parameter` annotations, and annotated `let` / `var`.
 *   2. A CapWords initializer call (`var tmp = Helper()`).
 *   3. `guard let x = …` / `if let x = …` / `if let x` / `while let x = …`,
 *      typed from the unwrapped expression — a stored property, an
 *      already-typed local, an initializer, a declared return, or the binding's
 *      own `: T` annotation.
 *   4. A local assigned from a call whose callee this FILE declares with a
 *      return type (`let x = make()` against `func make() -> Invoice`).
 *   5. `for x in xs`, typed from the ELEMENT of an `[T]`-typed collection.
 *
 * ## Scope extent is the interesting half of 3 and 5
 *
 * `LocalBinding.scopeEndLine` is what keeps a block-scoped unwrap from typing a
 * call below its block, and Swift's two forms differ:
 *
 * - a `guard let` binding is visible for the REST OF ITS ENCLOSING BLOCK (the
 *   `else` branch must leave the scope), so its `scopeEndLine` is that block's
 *   last line — the enclosing block, not the function, so a guard inside an
 *   `if` body stops at the `if`'s closing brace;
 * - an `if let` / `while let` / `for in` binding dies with its OWN block, so
 *   its `scopeEndLine` is the closing brace of the then-body. Taking the
 *   statement's end instead would carry the binding into the `else` branch,
 *   where Swift does not bind it at all.
 *
 * The lookups have no column, so a one-line `if let a = b { a.x() } else { a.y() }`
 * types the else arm too. That is the same limitation Go's declaration rule
 * documents (`domains/language/CLAUDE.md`), not a Swift-specific one.
 *
 * ## What is deliberately NOT bound
 *
 * - `[Thing]` and `[String: Foo]` annotations bind NOTHING for the annotated
 *   NAME. `LocalBinding.type` is a bare string with no container slot, so
 *   binding the element type would type the ARRAY as a `Thing` and pin
 *   `xs.append(_:)` to `Thing#append` — the Python lesson
 *   (`domains/language/CLAUDE.md`, "Python publishes type facts on THREE
 *   channels"), reached here through a different grammar. The element type is
 *   held in {@link SwiftTypeFact}'s own slot, which only `for x in xs` reads
 *   and which nothing emits, so the invariant is structural rather than a rule
 *   someone has to remember. A `Set<Foo>` / `[String: Foo]` element is NOT
 *   read: `swiftTypeFactOf` reduces a generic to its base name, and a
 *   dictionary iterates as a tuple the single-name pattern rejects anyway.
 * - A non-CapWords initializer whose callee this file does NOT declare
 *   (`let t = makeThing()`) binds nothing — its return type is unknowable here
 *   and recording the FUNCTION name as a type fabricates a `makeThing#member`
 *   target (Rust `isCapWordsType`, Python `isCapWordsConstructor`).
 * - A declared return of `Self` / `Any` / `AnyObject` / `Never` / `Void`, or of
 *   the function's own generic parameter, binds nothing: each names a type the
 *   symbol table cannot hold, and `T` would fabricate a `T#member` target.
 * - Two same-file overloads declaring DIFFERENT return types drop the name
 *   rather than let declaration order pick. A member declaration DOES beat a
 *   top-level namesake, which is Swift's own lookup order, not a tie-break.
 * - `if case let .some(v) = opt` binds nothing: it destructures a pattern, and
 *   the payload type is not written at the binding site.
 * - A binding named `self` / `Self` / `super` is never emitted. The idiomatic
 *   `guard let self = self else { return }` would otherwise put a local under a
 *   pseudo receiver, where the FIRST chain pass answers and DROPS what
 *   `selfMember` resolves.
 * - `classFieldTypes` keeps the NARROW rule — annotation or CapWords
 *   initializer — while a local reads the full expression walk. The map is the
 *   INPUT to that walk, so widening it would make a property's type depend on
 *   another property's.
 *
 * `fileScope` stays empty, as it is for java / rust / go / python / bash: the
 * Swift resolver has no reverse "which file declares X" channel, and the
 * resolution runner uses `fileScope` as the caller scope for file-level calls,
 * where a populated list would silently retarget them.
 */

import type { AstNode, MaterializedTree } from "../../../../contracts/types/ast.js";
import type {
  CallRef,
  ChunkExtraction,
  FileExtraction,
  ImportRef,
  LocalBinding,
} from "../../../../contracts/types/codegraph.js";
import { assignCallsToInnermostChunks } from "../../kernel/assign-calls-to-chunks.js";

export interface SwiftExtractInput {
  tree: MaterializedTree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromSwiftFile(input: SwiftExtractInput): FileExtraction {
  const root = input.tree.rootNode;
  const imports = collectSwiftImports(root);
  const calls = collectSwiftCalls(root);
  const evidence = collectSwiftFileTypeEvidence(root);
  const bindingOwnership = assignBindingsToInnermostChunks(collectSwiftTypedBindings(root, evidence), input.chunks);
  const callOwnership = assignCallsToInnermostChunks(calls, input.chunks);
  const byChunk: ChunkExtraction[] = input.chunks.map((c, chunkIndex) => {
    const chunk: ChunkExtraction = {
      symbolId: c.symbolId,
      scope: c.scope,
      startLine: c.startLine,
      endLine: c.endLine,
      calls: callOwnership.get(chunkIndex) ?? [],
    };
    const bindings = bindingOwnership.get(chunkIndex);
    if (bindings && Object.keys(bindings).length > 0) chunk.localBindings = bindings;
    return chunk;
  });
  const out: FileExtraction = {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks: byChunk,
    fileScope: [],
  };
  const classFieldTypes = swiftClassFieldTypes(evidence);
  if (Object.keys(classFieldTypes).length > 0) out.classFieldTypes = classFieldTypes;
  return out;
}

/**
 * One `ImportRef` per `import_declaration`, carrying the MODULE path.
 *
 * The path lives in the declaration's `identifier` child (`Foundation`,
 * `Foundation.Data`), which is what separates it from the optional kind
 * keyword a declaration import carries (`import struct Foundation.Data`). A
 * grammar that stops emitting that child falls back to stripping the leading
 * `import` plus kind keyword from the node text.
 */
function collectSwiftImports(root: AstNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type !== "import_declaration") return;
    const path = node.children.find((c) => c.type === "identifier");
    const text = (path?.text ?? stripImportKeywords(node.text)).trim();
    if (text.length === 0) return;
    out.push({ importText: text, startLine: node.startPosition.row + 1 });
  });
  return out;
}

/** `import struct Foundation.Data` → `Foundation.Data`. Fallback only — see `collectSwiftImports`. */
function stripImportKeywords(text: string): string {
  return text.replace(/^import\s+(?:typealias|struct|class|enum|protocol|let|var|func)?\s*/, "");
}

/**
 * One `CallRef` per invoking `call_expression`. Two callee shapes carry a call:
 * a bare `simple_identifier` (receiverless) and a `navigation_expression`
 * (`target` = receiver, `suffix.suffix` = member). Every other shape — an
 * immediately-invoked closure, a call on a parenthesised expression — names no
 * receiver this resolver could use and is skipped rather than guessed.
 *
 * `Foo()` is recorded as a BARE call whose member is `Foo`, not as
 * `Foo#init`. Swift's `Foo()` is sugar for `Foo.init(…)`, but a type relying on
 * the memberwise or default initializer declares no `init_declaration` and so
 * has no `Foo#init` symbol to land on; the bare form still resolves to the TYPE
 * through the terminal short-name pass, which is the edge that exists.
 */
function collectSwiftCalls(root: AstNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
    if (node.type !== "call_expression") return;
    const suffix = node.children.find((c) => c.type === "call_suffix");
    // Bracketed suffix = subscript read (`items[i]`, `dict["k"]`), not a call.
    if (!suffix || suffix.text.startsWith("[")) return;
    const callee = node.namedChildren.find((c) => c !== suffix);
    if (!callee) return;
    const startLine = node.startPosition.row + 1;
    if (callee.type === "simple_identifier") {
      out.push({ callText: node.text, receiver: null, member: callee.text, startLine });
      return;
    }
    if (callee.type !== "navigation_expression") return;
    const target = callee.childForFieldName("target");
    const member = callee.childForFieldName("suffix")?.childForFieldName("suffix");
    if (!target || !member) return;
    out.push({
      callText: node.text,
      receiver: normalizeSwiftReceiver(target.text),
      member: member.text,
      startLine,
    });
  });
  return out;
}

/**
 * Strip optional-chaining `?` and force-unwrap `!` out of a receiver's source
 * text: `obj!` → `obj`, `a?.b!` → `a.b`, `self.db` unchanged. The resolver
 * matches a receiver against `localBindings` keys and `classFieldTypes` field
 * names, neither of which carries the sugar, so an un-normalized receiver never
 * matches.
 */
export function normalizeSwiftReceiver(text: string): string {
  return text.replace(/[?!]/g, "");
}

/**
 * What a Swift type node PROVES about a value, in two separate slots.
 *
 * `nominal` is the type the value itself has and is the only slot anything
 * emits. `element` is the type of what the value CONTAINS — set for `[T]` and
 * nothing else — and exists so `for x in xs` can type `x` without ever letting
 * `xs` be typed as a `T`. Keeping them apart is what makes the container rule
 * structural: a caller that wants a receiver type reads `nominal` and gets
 * `null` for an array, whatever the element is.
 */
interface SwiftTypeFact {
  readonly nominal: string | null;
  readonly element: string | null;
}

const NO_TYPE: SwiftTypeFact = { nominal: null, element: null };

/** Names a binding must never be recorded under — each is claimed by a chain pass of its own. */
const SWIFT_PSEUDO_BINDING_NAMES: ReadonlySet<string> = new Set(["self", "Self", "super"]);

/**
 * Return types that name nothing the symbol table can hold. `Self` is the
 * conforming type, unknowable at the declaration; the other four are universal
 * or empty and carry no member a call could land on.
 */
const SWIFT_UNUSABLE_RETURN_TYPES: ReadonlySet<string> = new Set(["Self", "Any", "AnyObject", "Never", "Void"]);

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
 * Declarations that own their own local names. Two bindings of one name in two
 * methods of the same type are different variables, so an identifier lookup is
 * confined to the bindings whose nearest such ancestor is the SAME node.
 *
 * `lambda_literal` is deliberately absent: a closure CAPTURES its enclosing
 * function's locals, so a `guard let` inside one must still see them.
 */
const SWIFT_FUNCTION_LIKE_NODES: ReadonlySet<string> = new Set([
  "function_declaration",
  "protocol_function_declaration",
  "init_declaration",
  "deinit_declaration",
  "subscript_declaration",
  "computed_property",
]);

/**
 * Everything this file declares about types, gathered in ONE walk before any
 * binding is typed.
 *
 * File-local by construction. A walker resolves nothing, so the only callee
 * whose return type it may read is one this file declares, and the only
 * property whose type it may read is one this file's type body declares — which
 * is also exactly what `classFieldTypes` publishes.
 */
interface SwiftFileTypeEvidence {
  /** `typeName → propertyName → fact`, the fact-valued source of `classFieldTypes`. */
  readonly propertyTypes: Map<string, Map<string, SwiftTypeFact>>;
  /**
   * `returnKey(owner, funcName) → fact`, or `null` where two declarations of
   * that coordinate disagree and the name is therefore unusable.
   */
  readonly returnTypes: Map<string, SwiftTypeFact | null>;
}

/** Key a declared return under its owning type (`null` = top level) plus its name. */
function returnKey(owner: string | null, name: string): string {
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
function collectSwiftFileTypeEvidence(root: AstNode): SwiftFileTypeEvidence {
  const propertyTypes = new Map<string, Map<string, SwiftTypeFact>>();
  const returnTypes = new Map<string, SwiftTypeFact | null>();
  walk(root, (node) => {
    if (node.type === "class_declaration" || node.type === "protocol_declaration") {
      collectSwiftPropertyTypes(node, propertyTypes);
      return;
    }
    if (node.type !== "function_declaration" && node.type !== "protocol_function_declaration") return;
    const name = node.childForFieldName("name")?.text;
    if (!name) return;
    const fact = swiftDeclaredReturnFact(node);
    if (!fact) return;
    const key = returnKey(enclosingSwiftTypeName(node), name);
    const previous = returnTypes.get(key);
    if (previous === undefined) returnTypes.set(key, fact);
    // `previous === null` is the poisoned marker, and optional access keeps it poisoned.
    else if (previous?.nominal !== fact.nominal || previous?.element !== fact.element) returnTypes.set(key, null);
  });
  return { propertyTypes, returnTypes };
}

/** One nominal type body's `propertyName → fact` entries, merged into the file map. */
function collectSwiftPropertyTypes(node: AstNode, into: Map<string, Map<string, SwiftTypeFact>>): void {
  const name = node.childForFieldName("name");
  const body = node.childForFieldName("body");
  if (!name || !body) return;
  for (const member of body.children) {
    if (member.type !== "property_declaration") continue;
    const fieldName = singleIdentifierPatternName(member.childForFieldName("name"));
    const fact = swiftDeclaredPropertyFact(member);
    if (!fieldName || (!fact.nominal && !fact.element)) continue;
    let fields = into.get(name.text);
    if (!fields) {
      fields = new Map<string, SwiftTypeFact>();
      into.set(name.text, fields);
    }
    if (!fields.has(fieldName)) fields.set(fieldName, fact);
  }
}

/**
 * The published `typeName → fieldName → typeName` view of the property
 * evidence — the channel the resolver's stored-property pass reads for
 * `self.db.write()` and for Swift's implicit-self `db.write()`.
 *
 * Only `nominal` survives the projection, so an `[Thing]` property contributes
 * nothing here while still typing `for item in items` inside the walker.
 */
function swiftClassFieldTypes(evidence: SwiftFileTypeEvidence): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [typeName, fields] of evidence.propertyTypes) {
    const published: Record<string, string> = {};
    for (const [fieldName, fact] of fields) if (fact.nominal) published[fieldName] = fact.nominal;
    if (Object.keys(published).length > 0) out[typeName] = published;
  }
  return out;
}

/**
 * A `func`'s DECLARED return type, or null when it names nothing usable.
 *
 * Swift writes its return types, so this is a read rather than the terminal-
 * expression fold `kernel/return-inference.ts` performs for Ruby and Python.
 * The two gates are what keep the read honest: a universal / empty type
 * (`Any`, `Void`, `Self`) has no member to land on, and the function's OWN
 * generic parameter is a name that exists only inside the signature —
 * recording `T` would fabricate a `T#member` target at every call site.
 */
function swiftDeclaredReturnFact(node: AstNode): SwiftTypeFact | null {
  const fact = swiftTypeFactOf(swiftTypeNodeAfter(node, "->"));
  const named = fact.nominal ?? fact.element;
  if (!named) return null;
  if (SWIFT_UNUSABLE_RETURN_TYPES.has(named)) return null;
  return declaresSwiftTypeParameter(node, named) ? null : fact;
}

/** Whether `name` is one of the declaration's own generic parameters (`func decode<T>() -> T`). */
function declaresSwiftTypeParameter(node: AstNode, name: string): boolean {
  const parameters = node.children.find((c) => c.type === "type_parameters");
  if (!parameters) return false;
  return parameters.children.some(
    (p) => p.type === "type_parameter" && p.children.find((c) => c.type === "type_identifier")?.text === name,
  );
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
interface SwiftScopedBinding {
  readonly name: string;
  readonly fact: SwiftTypeFact;
  /** 1-based declaration line — used for innermost-chunk attribution and position-aware reads. */
  readonly line: number;
  /** `startIndex` of the nearest enclosing function-like declaration; `-1` at type / file level. */
  readonly functionKey: number;
  /** 1-based last line the binding is visible on; absent ⇒ visible to the end of its chunk. */
  readonly scopeEndLine?: number;
}

/** Where a right-hand side is being typed — the coordinates every lookup is relative to. */
interface SwiftBindingSite {
  readonly line: number;
  readonly functionKey: number;
  readonly enclosingType: string | null;
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

/** Receiver chains longer than this are not walked — a cap, not a semantic boundary. */
const SWIFT_MAX_TYPE_HOPS = 4;

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
function collectSwiftTypedBindings(root: AstNode, evidence: SwiftFileTypeEvidence): SwiftScopedBinding[] {
  const collected: SwiftScopedBinding[] = [];
  const bindingsByName = new Map<string, SwiftScopedBinding[]>();
  const siteOf = (node: AstNode): SwiftBindingSite => ({
    line: node.startPosition.row + 1,
    functionKey: enclosingSwiftFunctionKey(node),
    enclosingType: enclosingSwiftTypeName(node),
  });
  const record = (name: string, fact: SwiftTypeFact, site: SwiftBindingSite, scopeEndLine?: number): void => {
    if (SWIFT_PSEUDO_BINDING_NAMES.has(name)) return;
    if (!fact.nominal && !fact.element) return;
    const binding: SwiftScopedBinding = {
      name,
      fact,
      line: site.line,
      functionKey: site.functionKey,
      scopeEndLine,
    };
    collected.push(binding);
    const sameName = bindingsByName.get(name);
    if (sameName) sameName.push(binding);
    else bindingsByName.set(name, [binding]);
  };
  walk(root, (node) => {
    switch (node.type) {
      case "parameter":
      case "lambda_parameter": {
        const name = node.childForFieldName("name");
        if (name) record(name.text, swiftTypeFactOf(swiftTypeNodeAfter(node, ":")), siteOf(node));
        return;
      }
      case "property_declaration": {
        const name = singleIdentifierPatternName(node.childForFieldName("name"));
        if (!name) return;
        const site = siteOf(node);
        const declared = swiftDeclaredPropertyFact(node);
        const fact = declared.nominal
          ? declared
          : swiftExpressionFact(node.childForFieldName("value"), { evidence, bindingsByName, site }, 0);
        record(name, fact, site);
        return;
      }
      case "guard_statement":
      case "if_statement":
      case "while_statement": {
        const scopeEndLine =
          node.type === "guard_statement" ? enclosingSwiftBlockEndLine(node) : swiftThenBlockEndLine(node);
        for (const clause of swiftOptionalBindingClauses(node)) {
          const site = siteOf(node);
          const annotated = swiftTypeFactOf(clause.annotation);
          const annotatedOrInferred =
            annotated.nominal || annotated.element
              ? annotated
              : swiftExpressionFact(clause.value, { evidence, bindingsByName, site }, 0);
          // Unwrapping `[T]?` yields `[T]`, so the element slot survives the
          // unwrap — the array still binds no receiver, and a `for` over the
          // unwrapped name still types its item.
          record(clause.name, annotatedOrInferred, site, scopeEndLine);
        }
        return;
      }
      case "for_statement": {
        const name = singleIdentifierPatternName(node.childForFieldName("item"));
        if (!name) return;
        const site = siteOf(node);
        const collection = swiftExpressionFact(
          node.childForFieldName("collection"),
          { evidence, bindingsByName, site },
          0,
        );
        if (!collection.element) return;
        record(name, { nominal: collection.element, element: null }, site, swiftThenBlockEndLine(node));
        break;
      }
      default:
        break;
    }
  });
  return collected;
}

/** One `let x` / `var x` clause of a `guard` / `if` / `while` condition list. */
interface SwiftOptionalBindingClause {
  readonly name: string;
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
    out.push({ name: nameNode.text, annotation, value });
  }
  return out;
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
function swiftDeclaredPropertyFact(node: AstNode): SwiftTypeFact {
  const annotation = node.children.find((c) => c.type === "type_annotation");
  if (annotation) return swiftTypeFactOf(swiftTypeNodeAfter(annotation, ":"));
  return constructedTypeFact(node.childForFieldName("value"));
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
function constructedTypeFact(value: AstNode | null): SwiftTypeFact {
  if (value?.type !== "call_expression") return NO_TYPE;
  const callee = value.namedChildren.find((c) => c.type !== "call_suffix");
  if (callee?.type !== "simple_identifier") return NO_TYPE;
  return /^[A-Z]/.test(callee.text) ? { nominal: callee.text, element: null } : NO_TYPE;
}

/** A `pattern` node's identifier when it binds exactly one name; null for tuple / destructuring patterns. */
function singleIdentifierPatternName(pattern: AstNode | null): string | null {
  if (pattern?.type !== "pattern" || pattern.namedChildCount !== 1) return null;
  const id = pattern.namedChildren[0];
  return id.type === "simple_identifier" ? id.text : null;
}

/**
 * The type node that follows `separator` among a node's children — how EVERY
 * Swift type position is read here, and never `childForFieldName`.
 *
 * `materializeTree` rebuilds the field map from `fieldNameForChild`, which
 * reports ONE field name per child, and tree-sitter-swift registers every type
 * position under `name` as WELL as under `type` / `return_type`. `name` is what
 * gets reported, so on a MATERIALIZED node — the only kind the pipeline ever
 * walks, `CodegraphFileExtractor` materializes before calling a walker — both
 * `type` and `return_type` are simply absent. A field read therefore works in
 * every unit test (which parse natively) and silently returns nothing in
 * production, leaving `localBindings` and `classFieldTypes` empty for the whole
 * language.
 *
 * The position is unambiguous in each case a caller uses: `:` in a `parameter`,
 * `lambda_parameter` or `type_annotation`, `->` in a `func` signature. A
 * default value, a variadic `...` or a `throws` clause all sit on the far side
 * of the separator or beyond the type, so none of them displaces it.
 * `tests/…/swift-walker.test.ts` pins native-vs-materialized parity.
 */
function swiftTypeNodeAfter(node: AstNode, separator: string): AstNode | null {
  const at = node.children.findIndex((c) => c.type === separator);
  return at === -1 ? null : (node.children[at + 1] ?? null);
}

/**
 * Reduce a Swift type node to what it proves.
 *
 *   - `user_type` — `Foo` → nominal `Foo`, `Set<Foo>` → nominal `Set` (generics
 *     stripped by text, which also keeps a qualified `Outer.Inner` intact as
 *     the nested type's own composed id spells it).
 *   - `optional_type` — `Foo?` → whatever `Foo` proves. The receiver of
 *     `x?.m()` is the wrapped value, so the Optional is transparent here.
 *   - `array_type` — `[Foo]` → ELEMENT `Foo` and no nominal. An Array is not a
 *     Foo; see the container note in the file docblock.
 *   - anything else, notably `dictionary_type` / `tuple_type` / `function_type`
 *     / `opaque_type` — nothing.
 */
function swiftTypeFactOf(typeNode: AstNode | null): SwiftTypeFact {
  if (!typeNode) return NO_TYPE;
  if (typeNode.type === "optional_type") return swiftTypeFactOf(typeNode.namedChildren[0] ?? null);
  if (typeNode.type === "array_type") {
    const element = swiftTypeFactOf(typeNode.namedChildren[0] ?? null).nominal;
    return element ? { nominal: null, element } : NO_TYPE;
  }
  if (typeNode.type !== "user_type") return NO_TYPE;
  const raw = typeNode.text;
  const generics = raw.indexOf("<");
  const bare = (generics === -1 ? raw : raw.slice(0, generics)).trim();
  return bare.length > 0 ? { nominal: bare, element: null } : NO_TYPE;
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
      return { nominal: scope.site.enclosingType, element: null };
    case "simple_identifier":
      return node.text === "Self"
        ? { nominal: scope.site.enclosingType, element: null }
        : swiftIdentifierFact(node.text, scope);
    case "navigation_expression": {
      const member = node.childForFieldName("suffix")?.childForFieldName("suffix");
      const owner = swiftReceiverTypeName(node.childForFieldName("target"), scope, depth);
      if (!member || !owner) return NO_TYPE;
      return scope.evidence.propertyTypes.get(owner)?.get(member.text) ?? NO_TYPE;
    }
    case "call_expression":
      return swiftCallResultFact(node, scope, depth);
    default:
      return NO_TYPE;
  }
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
  return (owner ? scope.evidence.propertyTypes.get(owner)?.get(name) : undefined) ?? NO_TYPE;
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
    return /^[A-Z]/.test(node.text) ? node.text : null;
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
  if (callee.type === "simple_identifier") {
    if (/^[A-Z]/.test(callee.text)) return { nominal: callee.text, element: null };
    const own = scope.evidence.returnTypes.get(returnKey(scope.site.enclosingType, callee.text));
    if (own !== undefined) return own ?? NO_TYPE;
    return scope.evidence.returnTypes.get(returnKey(null, callee.text)) ?? NO_TYPE;
  }
  if (callee.type !== "navigation_expression") return NO_TYPE;
  const member = callee.childForFieldName("suffix")?.childForFieldName("suffix");
  const owner = swiftReceiverTypeName(callee.childForFieldName("target"), scope, depth);
  if (!member || !owner) return NO_TYPE;
  return scope.evidence.returnTypes.get(returnKey(owner, member.text)) ?? NO_TYPE;
}

/** `startIndex` of the nearest enclosing function-like declaration; `-1` at type / file level. */
function enclosingSwiftFunctionKey(node: AstNode): number {
  for (let current = node.parent; current; current = current.parent) {
    if (SWIFT_FUNCTION_LIKE_NODES.has(current.type)) return current.startIndex;
  }
  return -1;
}

/** Short name of the nearest enclosing nominal type, as `classFieldTypes` keys it. */
function enclosingSwiftTypeName(node: AstNode): string | null {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "class_declaration" || current.type === "protocol_declaration") {
      return current.childForFieldName("name")?.text ?? null;
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
function assignBindingsToInnermostChunks(
  bindings: readonly SwiftScopedBinding[],
  chunks: { startLine: number; endLine: number; scope: string[] }[],
): Map<number, Record<string, LocalBinding[]>> {
  const out = new Map<number, Record<string, LocalBinding[]>>();
  for (const binding of bindings) {
    if (!binding.fact.nominal) continue;
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
      bucket = {};
      out.set(bestIdx, bucket);
    }
    const emitted: LocalBinding = { line: binding.line, type: binding.fact.nominal };
    if (binding.scopeEndLine !== undefined) emitted.scopeEndLine = binding.scopeEndLine;
    (bucket[binding.name] ??= []).push(emitted);
  }
  return out;
}

function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
