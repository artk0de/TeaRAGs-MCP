/**
 * The identity leg of hybrid search (bd tea-rags-mcp-2fefq): when the query is
 * one code identifier, the chunks that BELONG to that symbol must rank first.
 *
 * Neither retrieval leg knows that fact. Measured on taxdome with
 * `Platform::Async::Operation::Worker` + `testFile: "only"`: the dense leg put
 * two ~100-byte look-alike chunks (`Tech::SampleWorker`, `PlainWorker`) ahead of
 * the class's own spec, and the BM25 leg did not return that spec in its top 40
 * at all — the query tokenizes to platform/async/operation/worker, all common in
 * that domain. The fused result put the spec 5th. Lexical fixes were measured
 * and rejected: a realistic avgDocLength moved it 40→24, a whole-constant BM25
 * token only 40→10 (neighbouring specs legitimately mention the constant) and
 * would need a sparse migration.
 *
 * The only carrier of "this chunk belongs to symbol X" is structural payload:
 * every chunk of that spec has `parentSymbolId` equal to the constant. So the
 * leg is the dense query restricted to chunks whose `parentSymbolId` or
 * `symbolId` IS the identifier. It joins the fusion as a third prefetch and
 * only boosts through RRF — the fused result set is still filtered by the
 * request filter alone.
 *
 * Deciding WHETHER the leg exists is a product decision about query shape, so
 * it lives here in explore; the qdrant adapter only knows how to send an
 * optional extra prefetch.
 */

import { symbolIdTextToken } from "../../../adapters/qdrant/filters/symbolid-text-token.js";
import {
  exactMatchOnTextIndexed,
  type TextIndexedExactMatch,
} from "../../../adapters/qdrant/filters/text-indexed-exact.js";

/**
 * One code identifier: name segments joined by the symbolId separators `::`,
 * `.` or `#`, with an optional Ruby method suffix `?`, `!` or `=` on the last
 * segment. A segment starts with a letter, `_` or `$` and continues with
 * letters, digits, `_` or `$` (Unicode-aware, like the index tokenizer).
 *
 * Deliberately strict: whitespace, paths, operators (`<=>`, `[]`) and dangling
 * separators are not identifiers. A false positive costs one extra prefetch
 * that matches nothing; a loose predicate would turn prose into symbol lookups.
 */
const SYMBOL_IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*(?:(?:::|[.#])[\p{L}_$][\p{L}\p{N}_$]*)*[?!=]?$/u;

/** The identity leg's restriction: exact symbol on either structural key. */
export type SymbolIdentityFilter = {
  should: [{ must: TextIndexedExactMatch }, { must: TextIndexedExactMatch }];
};

/**
 * Is the query exactly ONE code identifier (surrounding whitespace ignored)?
 * `Foo`, `Acme::User`, `Outer.Nested`, `Reranker#rerank`, `valid?`, `save!`.
 */
export function isSymbolIdentifierQuery(query: string | undefined): query is string {
  return query !== undefined && SYMBOL_IDENTIFIER.test(query.trim());
}

/**
 * Chunks whose `parentSymbolId` OR `symbolId` equals the identifier EXACTLY.
 *
 * Both keys carry a `text` index, where a bare `match.text` is token-based
 * (`A::B` would also hit `A::BFoo`) and a bare `match.value` scans the whole
 * collection. `exactMatchOnTextIndexed` pairs them: the last-segment token
 * (`symbolIdTextToken`, the one token the row is guaranteed to carry) serves
 * the candidates from the index, the `value` condition decides exactness.
 */
export function buildSymbolIdentityFilter(identifier: string): SymbolIdentityFilter {
  const symbol = identifier.trim();
  const token = symbolIdTextToken(symbol);
  return {
    should: [
      { must: exactMatchOnTextIndexed("parentSymbolId", symbol, token) },
      { must: exactMatchOnTextIndexed("symbolId", symbol, token) },
    ],
  };
}
