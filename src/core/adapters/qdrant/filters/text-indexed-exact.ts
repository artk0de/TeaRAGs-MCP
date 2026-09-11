/**
 * Exact matching on a payload key whose Qdrant index is `text`
 * (bd tea-rags-mcp-ivp12).
 *
 * Qdrant keeps ONE index per payload key, and the keys below carry a `text`
 * one. A text index does not serve `match.value` or `match.any`: the planner
 * has no posting list to read, so it falls back to fetching the payload of
 * every point in the collection. Nothing fails — the answer is correct, it is
 * just paid for at scan price, which is why this went unnoticed for six schema
 * versions while `initializeSchema` created a keyword index the text index
 * immediately replaced.
 *
 * Measured on the live self-index, 22,415 points, idle daemon:
 *
 *   - `relativePath` `match: { value }` alone .......... 677–1002 ms (full scan)
 *   - `should` of 50 of those ......................... 33,597 ms (50 scans)
 *   - `must: [match.text, match.value]`, same answer ... 1.7–2.0 ms
 *
 * The pair works because the planner takes CANDIDATES from the indexed text
 * condition and checks the `value` condition only on those: exact because of
 * the value half, index-served because of the text half. No migration and no
 * new payload field — the `text` index the collection already has is enough.
 *
 * **Rule: never a bare `match: { value }` / `match: { any }` on a
 * {@link TEXT_INDEXED_KEYS} key.** Route it through this module.
 * `tests/core/adapters/qdrant/text-indexed-keys-guard.test.ts` scans `src/**`
 * and fails naming the offender.
 */

/**
 * The payload keys `SchemaManager.initializeSchema` gives a `text` index, and
 * therefore the keys exact matching has to pair. Declared here, beside the
 * matcher that depends on the fact, and CONSUMED by `schema-manager.ts` — the
 * list and the indexes it creates cannot drift apart while there is one list.
 *
 * `parentSymbolId` is on the list even though nothing matches it exactly today
 * (the symbol strategy asks it for a token). Membership is decided by the INDEX
 * TYPE, not by who currently queries it: leaving it off would mean the guard
 * test never sees the first `match.value` someone writes against it, which is
 * exactly how the other two keys went six schema versions unnoticed.
 */
export const TEXT_INDEXED_KEYS = ["relativePath", "symbolId", "parentSymbolId"] as const;

/** One of the payload keys indexed as `text`. */
export type TextIndexedKey = (typeof TEXT_INDEXED_KEYS)[number];

/** The indexed half: cheap, and a token SUPERSET of the value on its own. */
type TextIndexedTokenCondition = { key: TextIndexedKey; match: { text: string } };

/** The exact half: unserved on its own, checked on the text half's candidates. */
type TextIndexedValueCondition = { key: TextIndexedKey; match: { value: string } };

/** The pair, in planner order — text first, so the scan never happens. */
export type TextIndexedExactMatch = [TextIndexedTokenCondition, TextIndexedValueCondition];

/** Set membership as an OR of exact pairs; `must` clauses are the branches. */
export type TextIndexedAnyOf = { should: { must: TextIndexedExactMatch }[] };

/**
 * The two conditions that match `key` EXACTLY against `value`, to be spread
 * into a `must`.
 *
 * `textToken` defaults to the value, which is right for a `relativePath`: the
 * `word` tokenizer splits a path on `/`, `.` and `-`, so the whole path as a
 * text query is the conjunction of the file's own tokens and every candidate it
 * returns already contains them all.
 *
 * It is NOT right for a `symbolId`. A fully-qualified id tokenizes to several
 * tokens joined by AND, and under some live index states that join returns
 * nothing at all for a row that is present — which is why the symbol strategy
 * reduces the query to the LAST name segment (see
 * `domains/explore/strategies/symbol.ts` and `infra/symbolid/text-token.ts`).
 * Pass that token here; the `value` condition still decides exactness, so a
 * loose token costs candidates, never correctness.
 */
export function exactMatchOnTextIndexed(
  key: TextIndexedKey,
  value: string,
  textToken: string = value,
): TextIndexedExactMatch {
  return [
    { key, match: { text: textToken } },
    { key, match: { value } },
  ];
}

/**
 * Set membership over a text-indexed key: `should` of per-value exact pairs.
 *
 * Deliberately NOT `match: { any }`. MatchAny is one condition against the
 * key's index, so on a text-indexed key it is one full scan for the whole set —
 * cheaper than N scans, and still hundreds of times more expensive than this.
 * Twenty pairs measured 27 ms against 706 ms for the equivalent MatchAny.
 *
 * `tokenOf` derives each branch's text token; omit it where the value is its
 * own token (paths).
 */
export function anyOfOnTextIndexed(
  key: TextIndexedKey,
  values: readonly string[],
  tokenOf?: (value: string) => string,
): TextIndexedAnyOf {
  return { should: values.map((value) => ({ must: exactMatchOnTextIndexed(key, value, tokenOf?.(value)) })) };
}
