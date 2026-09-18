/**
 * The receiver marker for Ruby's `super` keyword.
 *
 * The walker (`walker/call-collection.ts`) emits it on the synthetic CallRefs it
 * builds for `super`; the resolver's `super` pass, the external vocabulary and
 * the dynamic fan-out gates branch on it. Both sides import it from this leaf,
 * as they do `ZEITWERK_PREFIX` from `zeitwerk-import-marker.ts`, rather than the
 * resolver reaching into the walker orchestrator for a string constant
 * (bd tea-rags-mcp-xuywm).
 */

/**
 * Sentinel receiver value emitted by the walker for synthetic CallRefs
 * representing the Ruby `super` keyword (bd tea-rags-mcp-brp1). The token
 * begins with `<` — invalid in real Ruby identifiers — so the resolver
 * can branch on it unambiguously without colliding with any actual
 * receiver text. Mirrors the `zeitwerk:` prefix discipline: a single
 * exported constant is the contract between walker and resolver.
 */
export const SUPER_RECEIVER_SENTINEL = "<super>";
