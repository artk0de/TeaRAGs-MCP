/**
 * Payload projection — the `fields` allow-list every payload-bearing search
 * tool accepts (bd tea-rags-mcp-l2lix).
 *
 * A search response carries ~40 payload fields when a caller needs three, and
 * `metaOnly` does not shrink that: it removes the chunk BODY and leaves every
 * signal and every structural field. For an agent consumer that is a
 * context-budget tax on every call.
 *
 * `fields` is a list of DOT-PATHS, so it composes with the nested signal
 * namespaces (`git.file.commitCount`, `codegraph.symbols.chunk.pageRank`), and
 * the projected payload keeps the same nesting the caller addressed. Absent →
 * the call mode's lean default projection (agent turn economy N4, bd
 * tea-rags-mcp-r4rl1): a row an agent pays for on every later turn carries what
 * it drills from, not every signal.
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
 * The call mode that picks the DEFAULT projection when `fields` is absent
 * (agent turn economy N4, bd tea-rags-mcp-r4rl1). `reranked` = a rerank other
 * than plain relevance ran, so the caller asked for signals.
 */
export interface PayloadProjectionMode {
  metaOnly: boolean;
  reranked: boolean;
  /**
   * A search tool (semantic_search, hybrid_search, rank_chunks, find_similar)
   * answers: its default is {@link DEFAULT_SEARCH_FIELDS} /
   * {@link DEFAULT_META_ONLY_FIELDS} whatever the rerank (bd
   * tea-rags-mcp-q1g6s.16). Absent → find_symbol's lean per-mode default.
   */
  searchTool?: boolean;
}

/**
 * A search tool's content-mode default `fields` (bd tea-rags-mcp-q1g6s.16): the
 * row an agent reads, and the address it drills from with find_symbol. Preset
 * signals ride on `rankingOverlay`; anything else is named through `fields`.
 */
export const DEFAULT_SEARCH_FIELDS: readonly string[] = ["relativePath", "symbolId", "startLine", "endLine", "content"];

/** A search tool's metaOnly default `fields`: the locator plus the first code line. */
export const DEFAULT_META_ONLY_FIELDS: readonly string[] = [
  "relativePath",
  "symbolId",
  "startLine",
  "endLine",
  "signature",
];

/**
 * What a row needs to be drilled: where it is, what it is, its first code line.
 * `signature` is derived by `filterMetaOnly` before the body is stripped.
 */
const LOCATOR_FIELDS = ["relativePath", "symbolId", "startLine", "endLine", "chunkType", "language", "signature"];

/**
 * A content row: the locator plus the body and the prev/next drill ids.
 * `symbols` is the body of a find_symbol directory row (N2) — the file's
 * top-level symbols; no other row carries a top-level `symbols` key. `kind`
 * marks a find_symbol file row whose `content` is the file's full text, not
 * an outline (bd tea-rags-mcp-03yel); no stored chunk carries it.
 */
const CONTENT_FIELDS = [...LOCATOR_FIELDS, "content", "navigation", "symbols", "kind"];

/**
 * Narrow every result's payload to `fields`, and report the paths that landed
 * nowhere.
 *
 * `fields` absent, empty, or all-blank: with a `mode` the default projection of
 * that mode applies — metaOnly → locator (a reranked row keeps its sibling
 * `rankingOverlay`), content → locator + `content` + `navigation`, reranked
 * content → whole payload. Raw `git.*`, `codegraph.*`, `imports` and
 * `enrichedAt` stay reachable through `fields` (`["git"]` copies the subtree).
 * A search tool (`mode.searchTool`) gets the search defaults instead, reranked
 * or not. Without a `mode` the input array returns by identity.
 */
export function projectSearchResultPayloads(
  results: SearchResult[],
  fields: readonly string[] | undefined,
  mode?: PayloadProjectionMode,
): PayloadProjectionOutcome {
  const paths = normalizeFieldPaths(fields);
  if (paths.length === 0) return { results: mode ? projectByMode(results, mode) : results };

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

/** The default projection of `mode`; a missing key is simply absent, never warned about. */
function projectByMode(results: SearchResult[], mode: PayloadProjectionMode): SearchResult[] {
  if (!mode.searchTool && !mode.metaOnly && mode.reranked) return results;
  const keys = defaultKeysOf(mode);
  return results.map((result) => {
    const { payload } = result;
    if (!payload) return result;
    const projected: Record<string, unknown> = {};
    for (const key of keys) {
      if (key in payload) projected[key] = payload[key];
    }
    return { ...result, payload: projected };
  });
}

function defaultKeysOf(mode: PayloadProjectionMode): readonly string[] {
  if (mode.searchTool) return mode.metaOnly ? DEFAULT_META_ONLY_FIELDS : DEFAULT_SEARCH_FIELDS;
  return mode.metaOnly ? LOCATOR_FIELDS : CONTENT_FIELDS;
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
