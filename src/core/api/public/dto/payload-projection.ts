/**
 * Payload projection — the `fields` allow-list every payload-bearing search
 * tool accepts (bd tea-rags-mcp-l2lix).
 *
 * A search response carries ~40 payload fields when a caller needs three, and
 * `metaOnly` does not shrink that: it removes the chunk BODY and leaves every
 * signal, every structural field, and at `level: "file"` the whole `members`
 * outline. For an agent consumer that is a context-budget tax on every call.
 *
 * `fields` is a list of DOT-PATHS, so it composes with the nested signal
 * namespaces (`git.file.commitCount`, `codegraph.symbols.chunk.pageRank`), and
 * the projected payload keeps the same nesting the caller addressed. Absent →
 * today's behaviour exactly; the param is purely additive.
 *
 * Two decisions live here:
 *
 *   - The result is EXACTLY what was asked for. Nothing is added back in,
 *     `relativePath` included. An allow-list that silently keeps extras is the
 *     same defect in a smaller size, and the caller can name the path.
 *
 *   - A path that matched NOTHING in any returned payload is REPORTED. The
 *     payload shape is not statically knowable — `git.*` exists only where git
 *     enrichment ran — so "unknown path" cannot be decided up front and a hard
 *     error would reject legitimate calls against an unenriched index. But
 *     returning `{}` and saying nothing is the trap an agent cannot debug, so
 *     the miss rides back on `fieldsWarning`, together with any path in the
 *     actual payloads that carries the same leaf name. That is what turns
 *     `git.commitCount` into `git.file.commitCount` without a second call.
 */

import type { SearchResult } from "./explore.js";

/** Results after projection, plus the advisory about paths that matched nothing. */
export interface PayloadProjectionOutcome {
  results: SearchResult[];
  /** Present only when a requested path matched no result. Advisory — results still return. */
  fieldsWarning?: string;
}

/** Same-leaf suggestions listed per unmatched path. Enough to disambiguate, short enough to read. */
const MAX_SUGGESTIONS_PER_PATH = 4;

/** How deep the suggestion scan walks a payload. Past this, signal namespaces are exhausted. */
const MAX_SUGGESTION_DEPTH = 5;

/**
 * Narrow every result's payload to `fields`, and report the paths that landed
 * nowhere.
 *
 * An absent, empty, or all-blank `fields` returns the input array by identity —
 * "asked for nothing" means no projection, not empty payloads.
 */
export function projectSearchResultPayloads(
  results: SearchResult[],
  fields: readonly string[] | undefined,
): PayloadProjectionOutcome {
  const paths = normalizeFieldPaths(fields);
  if (paths.length === 0) return { results };

  const matched = new Set<string>();
  const projected = results.map((result) => {
    if (!result.payload) return result;
    return { ...result, payload: projectPayload(result.payload, paths, matched) };
  });

  const unmatched = paths.filter((path) => !matched.has(path));
  // No results means nobody looked — a path cannot be called wrong on an empty
  // batch, the same reason a detached enrichment run reports "not measured"
  // rather than "nothing broke".
  const fieldsWarning =
    unmatched.length > 0 && results.length > 0 ? describeUnmatchedPaths(unmatched, results) : undefined;

  return { results: projected, ...(fieldsWarning ? { fieldsWarning } : {}) };
}

/** Trim, drop blanks, de-duplicate — order of first appearance is kept for the warning. */
function normalizeFieldPaths(fields: readonly string[] | undefined): string[] {
  if (!fields) return [];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const field of fields) {
    if (typeof field !== "string") continue;
    const path = field.trim();
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/** Copy each resolvable path into a fresh payload, rebuilt at the nesting it was addressed by. */
function projectPayload(
  payload: Record<string, unknown>,
  paths: readonly string[],
  matched: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const segments = path.split(".");
    const value = readPath(payload, segments);
    if (value === MISSING) continue;
    matched.add(path);
    writePath(out, segments, value);
  }
  return out;
}

/** Sentinel for "this path is not present", so a stored `undefined` still counts as a hit. */
const MISSING = Symbol("missing");

function readPath(payload: Record<string, unknown>, segments: readonly string[]): unknown {
  let cursor: unknown = payload;
  for (const segment of segments) {
    if (!isPlainRecord(cursor) || !(segment in cursor)) return MISSING;
    cursor = cursor[segment];
  }
  return cursor;
}

function writePath(target: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const next = cursor[segment];
    if (!isPlainRecord(next)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
}

/**
 * Name each path that landed nowhere and, where the returned payloads carry the
 * same LEAF name at another path, point at it. The nesting level is what
 * callers get wrong — `git.commitCount` for `git.file.commitCount` — so the
 * leaf is the discriminator worth matching on.
 */
function describeUnmatchedPaths(unmatched: readonly string[], results: readonly SearchResult[]): string {
  const available = collectPayloadPaths(results);
  const parts = unmatched.map((path) => {
    const leaf = path.split(".").pop() ?? path;
    const candidates = available.filter((known) => known !== path && known.endsWith(`.${leaf}`));
    return candidates.length === 0
      ? `no result carried "${path}"`
      : `no result carried "${path}" — did you mean ${candidates.slice(0, MAX_SUGGESTIONS_PER_PATH).join(", ")}?`;
  });
  return `fields: ${parts.join("; ")}`;
}

/** Every dot-path present in the returned payloads. Arrays are leaves — a path addresses objects. */
function collectPayloadPaths(results: readonly SearchResult[]): string[] {
  const paths = new Set<string>();
  const visit = (node: Record<string, unknown>, prefix: string, depth: number): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix.length > 0 ? `${prefix}.${key}` : key;
      paths.add(path);
      if (depth < MAX_SUGGESTION_DEPTH && isPlainRecord(value)) visit(value, path, depth + 1);
    }
  };
  for (const result of results) {
    if (result.payload) visit(result.payload, "", 1);
  }
  return [...paths];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
