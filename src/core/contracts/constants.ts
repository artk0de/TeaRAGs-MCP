/**
 * Cross-layer well-known identifiers.
 *
 * Payload-level constants every layer agrees on. They live in `contracts`
 * because `infra`, `adapters`, the domain modules and `api` all address the
 * same stored points by them — a constant owned by one domain would force the
 * others to import upward or sideways to name a point they legitimately read.
 */

/** Point id of the per-collection indexing-metadata marker. */
export const INDEXING_METADATA_ID = "__indexing_metadata__";

/**
 * Text whose embedding fingerprints the model's WEIGHTS rather than its name.
 * Stored in the marker on first sight and re-embedded on every later guard
 * check: a model republished under the same tag (`:latest`) keeps its name but
 * moves its vectors, and the name comparison alone cannot see that.
 *
 * The value is code-shaped on purpose — this index embeds source, so the canary
 * should sit in the same region of the space as the corpus it guards. Changing
 * it invalidates every stored canary (the guard rewrites mismatched text rather
 * than reporting drift), so treat it as frozen.
 */
export const EMBEDDING_CANARY_TEXT = "tea-rags embedding canary: resolve(callSite) -> SymbolResolutionOutcome";

/**
 * Cosine below which the re-embedded canary counts as a different model.
 *
 * Provisional. The same model served by two ollama endpoints is expected to
 * agree to within floating-point noise, but that has NOT been measured yet —
 * the cross-endpoint check (primary vs `EMBEDDING_FALLBACK_URL`) is the
 * user-gated step of task C4. If the measured cross-endpoint cosine lands below
 * this, lower the constant to that value minus 0.001 and record the measurement
 * here.
 */
export const EMBEDDING_CANARY_MIN_COSINE = 0.999;
