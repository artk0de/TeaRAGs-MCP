/**
 * Naming of the codegraph output-spill liveness marker. The extraction sink
 * (domain) writes it and the pool's stale-spill sweep (adapter) reads it; the
 * suffix is a contract between the two, so it lives here rather than in either.
 */

/** Suffix of the sibling liveness marker for an output spill. */
export const SPILL_LIVE_MARKER_SUFFIX = ".live";

/**
 * Sibling liveness marker for `spillPath`: `<spill>.ndjson.live`, holding the
 * decimal pid of the process whose sink owns the spill.
 *
 * The sink creates it BEFORE opening the spill stream and removes it in its
 * cleanup, so "marker present with a live pid" is the only state in which a
 * spill must be left alone. Deriving the marker from the spill path rather than
 * passing it around keeps one owner of the naming — a marker that got out of
 * step with its spill would silently re-open the deletion window.
 */
export function spillLiveMarkerPath(spillPath: string): string {
  return `${spillPath}${SPILL_LIVE_MARKER_SUFFIX}`;
}
