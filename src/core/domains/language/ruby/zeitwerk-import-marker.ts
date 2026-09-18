/**
 * The marker that splits Ruby's `ImportRef.importText` into its two channels.
 *
 * The walker (`walker/constant-refs.ts`) prefixes every Zeitwerk autoload
 * reference with it; the resolver tests for it to switch that entry from
 * load-path resolution to constant-to-file inference. Both sides import it from
 * this leaf rather than one from the other: the resolver hub reaching into the
 * walker orchestrator for a string constant was a dependency pointing the wrong
 * way (bd tea-rags-mcp-xuywm).
 */

/** Prefix marker the resolver uses to recognise Zeitwerk constant refs. */
export const ZEITWERK_PREFIX = "zeitwerk:";
