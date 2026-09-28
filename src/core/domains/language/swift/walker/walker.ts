/**
 * Swift extraction walker — tier 2 of the Swift vertical (the tier-1 vertical
 * shipped grammar + chunking only). Produces the four channels the resolver
 * chain reads: `imports`, per-chunk `calls`, per-chunk `localBindings`, and the
 * field types published under BOTH addresses — the per-file `classFieldTypes`
 * and the run-global `classFieldTypesByClassKey` a chained receiver folds
 * across files (`../type-field-address.ts`).
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
 * - A `[Thing]` annotation never binds the annotated NAME as a `Thing`.
 *   `LocalBinding.type` is a bare string with no container slot, so binding
 *   the element type would type the ARRAY as a `Thing` and pin
 *   `xs.append(_:)` to `Thing#append` — the Python lesson
 *   (`domains/language/CLAUDE.md`, "Python publishes type facts on THREE
 *   channels"), reached here through a different grammar. It binds `Array`
 *   (and `[String: Foo]` binds `Dictionary`), the standard-library types those
 *   spellings ARE, so a call reaches the project's `extension Array where
 *   Element == Header` (bd tea-rags-mcp-y99pg.14; until then they bound
 *   nothing). The element type is held in {@link SwiftTypeFact}'s own slot,
 *   which only `for x in xs` and the element accessors read and which
 *   nothing emits, so the invariant is structural rather than a rule someone
 *   has to remember. A `Set<Foo>` / `Array<Foo>` spelling fills the same slot
 *   (bd tea-rags-mcp-y99pg.32) — its one generic argument IS its element — and
 *   a `[String: Foo]` element is NOT read: a dictionary iterates as a tuple the
 *   single-name pattern rejects anyway.
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
 * - `classFieldTypes` keeps the NARROW rule — annotation, CapWords
 *   initializer, or a collection / string literal initializer (bd
 *   tea-rags-mcp-y99pg.39) — while a local reads the full expression walk. The map is the
 *   INPUT to that walk, so widening it would make a property's type depend on
 *   another property's.
 *
 * `fileScope` stays empty, as it is for java / rust / go / python / bash: the
 * Swift resolver has no reverse "which file declares X" channel, and the
 * resolution runner uses `fileScope` as the caller scope for file-level calls,
 * where a populated list would silently retarget them.
 */

// Cluster modules — the former monolith split verbatim; this file is the entry
// facade and keeps the walker's public surface:
//   shared.ts (cross-cluster primitives), type-declarations.ts, generics.ts,
//   calls.ts, type-evidence.ts, typed-bindings.ts, chunk-declarations.ts.

import type { MaterializedTree } from "../../../../contracts/types/ast.js";
import type { ChunkExtraction, FileExtraction } from "../../../../contracts/types/codegraph.js";
import { assignCallsToInnermostChunks } from "../../kernel/index.js";
import { collectSwiftCalls } from "./calls.js";
import { collectSwiftChunkDeclarations, collectSwiftClassExtends, collectSwiftImports } from "./chunk-declarations.js";
import { collectSwiftStructuredReturnTypes, collectSwiftTypeDeclarations } from "./type-declarations.js";
import { collectSwiftFileTypeEvidence, swiftClassFieldTypes, swiftClassFieldTypesByClassKey } from "./type-evidence.js";
import { assignBindingsToInnermostChunks, collectSwiftTypedBindings } from "./typed-bindings.js";

export { swiftTypeDeclarationKind } from "./shared.js";
export { normalizeSwiftReceiver, swiftCallSiteShape, type SwiftCallShape } from "./calls.js";
export { SWIFT_SINGLE_ELEMENT_SEQUENCES, swiftModuleValueOf, type SwiftModuleValueFact } from "./type-evidence.js";

export interface SwiftExtractInput {
  tree: MaterializedTree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[]; bodyScope?: string[] }[];
}

export function extractFromSwiftFile(input: SwiftExtractInput): FileExtraction {
  const root = input.tree.rootNode;
  const imports = collectSwiftImports(root);
  const calls = collectSwiftCalls(root);
  const evidence = collectSwiftFileTypeEvidence(root);
  const bindingOwnership = assignBindingsToInnermostChunks(collectSwiftTypedBindings(root, evidence), input.chunks);
  const callOwnership = assignCallsToInnermostChunks(calls, input.chunks);
  const { signatures, symbolKinds } = collectSwiftChunkDeclarations(root, input.chunks);
  const byChunk: ChunkExtraction[] = input.chunks.map((c, chunkIndex) => {
    const chunk: ChunkExtraction = {
      symbolId: c.symbolId,
      scope: c.scope,
      startLine: c.startLine,
      endLine: c.endLine,
      calls: callOwnership.get(chunkIndex) ?? [],
    };
    // A type chunk's own calls run inside the type (`swiftNameOf` opts in).
    if (c.bodyScope !== undefined) chunk.bodyScope = c.bodyScope;
    const symbolKind = symbolKinds.get(chunkIndex);
    if (symbolKind !== undefined) chunk.symbolKind = symbolKind;
    const signature = signatures.get(chunkIndex);
    if (signature) {
      chunk.arity = signature.arity;
      chunk.kwargs = signature.kwargs;
      chunk.acceptsBlock = signature.acceptsBlock;
    }
    const bindings = bindingOwnership.get(chunkIndex);
    if (bindings && Object.keys(bindings.localBindings).length > 0) chunk.localBindings = bindings.localBindings;
    if (bindings && Object.keys(bindings.callResultBindings).length > 0) {
      chunk.callResultBindings = bindings.callResultBindings;
    }
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
  if (Object.keys(classFieldTypes).length > 0) {
    out.classFieldTypes = classFieldTypes;
    // The SAME facts under the run-global address. `classFieldTypes` reaches a
    // resolver per-FILE, so it can only ever answer about the caller's own
    // file; this key is the one that survives the pass-1 barrier and lets a
    // chained receiver read a field of a type declared somewhere else.
    out.classFieldTypesByClassKey = swiftClassFieldTypesByClassKey(classFieldTypes, input.relPath);
  }
  const classExtends = collectSwiftClassExtends(root);
  if (Object.keys(classExtends).length > 0) out.classExtends = classExtends;
  const structuredReturnTypes = collectSwiftStructuredReturnTypes(root, input.chunks);
  if (Object.keys(structuredReturnTypes).length > 0) out.structuredReturnTypes = structuredReturnTypes;
  const typeDeclarations = collectSwiftTypeDeclarations(root);
  if (typeDeclarations.length > 0) out.typeDeclarations = typeDeclarations;
  return out;
}
