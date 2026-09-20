/**
 * `SwiftLanguage` — the native per-language facade for Swift, tier 1 of the
 * Swift vertical: grammar + generic-AST chunking that emits symbolId-carrying
 * chunks, so `find_symbol` resolves Swift outlines and bodies and
 * `hybrid_search`'s BM25 leg hits Swift tokens. NO walker, NO resolver — the
 * call graph is tier 2 (see `capability.ts`), which is also why the ctor takes
 * no ambiguous-resolve `mode`: there is no resolver to thread it into.
 *
 * Chunking shape mirrors Java (methods + inits are leaf chunks, types are
 * scope containers) because tree-sitter-swift's shape maps onto it directly:
 *
 *   - `class_declaration` covers `class` / `struct` / `enum` / `extension` /
 *     `actor` (the keyword is an anonymous child; the `name` field is the type
 *     identifier in every shape). Container + scope container — nested types
 *     compose `Outer.Inner`, extension methods attribute to the extended type.
 *   - `function_declaration` is BOTH the top-level function and the method
 *     inside a type body. As a child chunk it composes `Type#method`
 *     (instance) or `Type.method` (`static` / `class` func) via
 *     `classifyMethod`; at the top level it composes the bare `name` form.
 *   - `init_declaration` composes `Type#init` — instance-bound per the
 *     convention, like the Java constructor. Its chunkType lands on "block"
 *     (the engine's `getChunkType` has no `init` family) — the same accepted
 *     state as a bash `command` chunk; the symbolId is what find_symbol reads.
 *   - `protocol_declaration` is a scope container so its
 *     `protocol_function_declaration` signatures compose `Proto#method`.
 *     Signatures are `keepShortChildChunkTypes` — they are routinely under the
 *     50-char child floor and the declaration IS the symbol (Java abstract
 *     methods, bd tea-rags-mcp-52e8).
 *
 * Deliberately NOT chunkable in tier 1: `property_declaration` (stored +
 * computed), `subscript_declaration` (its `name` field points at the RETURN
 * type, not a name), `deinit_declaration` (no name field), `typealias_declaration`,
 * `associatedtype_declaration`, `enum_entry`.
 */

import type { LanguageChunkerHooks, LanguageProvider } from "../../../contracts/types/language.js";
import { swiftKernel } from "./kernel.js";

/**
 * Chunk-boundary config for Swift — mirrors the chunker slice of
 * `LANGUAGE_DEFINITIONS.java` 1:1 (chunkableTypes / childChunkTypes /
 * alwaysExtractChildren, plus `keepShortChildChunkTypes` for signature-only
 * protocol requirements). No `hooks` / `nameExtractor` / `classifier` chain —
 * Swift needs none (generic chunking). `scopeContainerTypes` + `scopeSeparator`
 * + `disambiguateOverloads` live on the KERNEL per the `LanguageKernel`
 * contract.
 *
 * `childChunkTypes` lists ONLY the leaf chunks (funcs, inits, protocol
 * signatures); `class_declaration` / `protocol_declaration` are intentionally
 * excluded so the descent traverses THROUGH nested types to reach methods,
 * while `scopeContainerTypes` (kernel) accumulates `Outer.Inner` into the
 * symbolId.
 */
const swiftChunkerHooks: LanguageChunkerHooks = {
  chunkableTypes: [
    "function_declaration",
    "init_declaration",
    "class_declaration",
    "protocol_declaration",
    "protocol_function_declaration",
  ],
  childChunkTypes: ["function_declaration", "init_declaration", "protocol_function_declaration"],
  alwaysExtractChildren: true,
  keepShortChildChunkTypes: ["protocol_function_declaration", "init_declaration"],
};

/**
 * Native Swift `LanguageProvider`. Construction is trivial — no resolver (tier
 * 1), no walker, and the kernel is a shared module-level const — so the only
 * per-instance cost is the Parser the chunker engine builds.
 */
export class SwiftLanguage implements LanguageProvider {
  readonly kernel = swiftKernel;
  readonly chunkerHooks: LanguageChunkerHooks = swiftChunkerHooks;
}

export { swiftKernel } from "./kernel.js";
