/**
 * Query variants contract (bd tea-rags-mcp-2vuz): semantic_search /
 * hybrid_search fuse several phrasings of one intent in ONE call. Shared by the
 * explore domain (which splits and fuses) and the tool schema (which caps the
 * array), so both read the same numbers.
 */

/** `"rate limit ||| retry after"` = two variants. */
export const QUERY_VARIANT_SEPARATOR = "|||";

/**
 * Each variant costs one embedding and one Qdrant prefetch per leg (two on
 * hybrid), and RRF gives every leg an equal say — past a handful of
 * paraphrases the extra legs dilute the fused ranking more than they recall.
 */
export const MAX_QUERY_VARIANTS = 5;
