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
 *   - A real nonempty `relativePath` is mandatory source identity and comes
 *     first. Every other payload field remains exactly allowlisted. Missing or
 *     invalid upstream locators are reported by result id, never invented.
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
  /** Advisory for unmatched requested fields or source rows without a valid relativePath. */
  fieldsWarning?: string;
}

/** Same-leaf suggestions listed per unmatched path. Enough to disambiguate, short enough to read. */
const MAX_SUGGESTIONS_PER_PATH = 4;

/** How deep the suggestion scan walks a payload. Past this, signal namespaces are exhausted. */
const MAX_SUGGESTION_DEPTH = 5;

/** A sibling key this many edits from the requested leaf is a typo of it (`comitCount` → `commitCount`). */
const NEAR_MISS_MAX_EDIT_DISTANCE = 2;

/** Shortest requested leaf a sibling may merely contain — below it, containment matches noise. */
const MIN_CONTAINED_LEAF_LENGTH = 4;

/**
 * The call mode that picks the DEFAULT projection when `fields` is absent
 * (agent turn economy N4, bd tea-rags-mcp-r4rl1). `reranked` = a rerank other
 * than plain relevance ran, so the caller asked for signals.
 */
export interface PayloadProjectionMode {
  metaOnly: boolean;
  reranked: boolean;
  migration?: boolean;
  /**
   * A search tool (semantic_search, hybrid_search, rank_chunks, find_similar)
   * answers: its default is {@link DEFAULT_SEARCH_FIELDS} /
   * {@link DEFAULT_META_ONLY_FIELDS} whatever the rerank (bd
   * tea-rags-mcp-q1g6s.16). Absent → find_symbol's lean per-mode default.
   */
  searchTool?: boolean;
  /**
   * The rows are find_symbol `relativePath` answers — file outlines, directory
   * listings. Their `content` / `symbols` IS the outline, the metadata metaOnly
   * asks for, so a metaOnly row keeps it beside the locator (bd
   * tea-rags-mcp-hditp).
   */
  outline?: boolean;
  /**
   * A search tool's `taskId` filter matched `git.<level>.taskIds` at this level:
   * its default projection keeps that array, so a ticket drill sees which ids
   * the ticket touched without a second search (bd tea-rags-mcp-d9w4o).
   */
  taskIdsLevel?: "file" | "chunk";
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
 * an outline (bd tea-rags-mcp-03yel), or a class row whose outline carries its
 * inlined header code (`CONTAINER_HEADER_KIND`); no stored chunk carries it.
 * `referencedDefinitions` is a find_symbol method row's inlined constant
 * definitions (bd tea-rags-mcp-d0z7b.4), part of its body.
 */
const CONTENT_FIELDS = [...LOCATOR_FIELDS, "content", "navigation", "symbols", "kind", "referencedDefinitions"];

/** A metaOnly outline row: the locator plus the outline itself. */
const OUTLINE_META_ONLY_FIELDS = [...LOCATOR_FIELDS, "content", "symbols"];

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
  reportUnmatchedFields = true,
): PayloadProjectionOutcome {
  const paths = normalizeFieldPaths(fields);
  const unlocated = results
    .filter((result) => {
      const relativePath = result.payload?.relativePath;
      return typeof relativePath !== "string" || relativePath.trim().length === 0;
    })
    .map((result) => JSON.stringify(result.id));
  const locatorWarning =
    unlocated.length > 0
      ? `relativePath: missing or invalid upstream locator for result(s) ${unlocated.join(", ")}`
      : undefined;
  if (paths.length === 0) {
    return {
      results: mode ? projectByMode(results, mode) : results,
      ...(locatorWarning ? { fieldsWarning: locatorWarning } : {}),
    };
  }

  const matched = new Set<string>();
  const projected = results.map((result) => {
    if (!result.payload) return result;
    const payload = projectPayload(result.payload, paths, matched);
    const { relativePath } = result.payload;
    return {
      ...result,
      payload:
        typeof relativePath === "string" && relativePath.trim().length > 0 ? { relativePath, ...payload } : payload,
    };
  });

  const unmatched = paths.filter((path) => !matched.has(path));
  // No results means nobody looked — a path cannot be called wrong on an empty
  // batch, the same reason a detached enrichment run reports "not measured"
  // rather than "nothing broke".
  const fieldsWarning =
    [
      reportUnmatchedFields && unmatched.length > 0 && results.length > 0
        ? describeUnmatchedPaths(unmatched, results)
        : undefined,
      locatorWarning,
    ]
      .filter(Boolean)
      .join("; ") || undefined;

  return { results: projected, ...(fieldsWarning ? { fieldsWarning } : {}) };
}

/** The default projection of `mode`; a missing key is simply absent, never warned about. */
function projectByMode(results: SearchResult[], mode: PayloadProjectionMode): SearchResult[] {
  if (!mode.searchTool && !mode.metaOnly && mode.reranked) return results;
  const keys = defaultKeysOf(mode);
  const matched = new Set<string>();
  return results.map((result) => {
    const { payload } = result;
    if (!payload) return result;
    return { ...result, payload: projectPayload(payload, keys, matched) };
  });
}

function defaultKeysOf(mode: PayloadProjectionMode): readonly string[] {
  if (mode.searchTool) {
    const defaults = mode.metaOnly ? DEFAULT_META_ONLY_FIELDS : DEFAULT_SEARCH_FIELDS;
    const keys = mode.migration
      ? [...defaults, "chunkType", "version", "operation", "direction", "table", "columns"]
      : defaults;
    return mode.taskIdsLevel ? [...keys, `git.${mode.taskIdsLevel}.taskIds`] : keys;
  }
  if (!mode.metaOnly) return CONTENT_FIELDS;
  return mode.outline ? OUTLINE_META_ONLY_FIELDS : LOCATOR_FIELDS;
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
    const candidates = suggestedPaths(path, available);
    return candidates.length === 0
      ? `no result carried "${path}"`
      : `no result carried "${path}" — did you mean ${candidates.join(", ")}?`;
  });
  return `fields: ${parts.join("; ")}`;
}

/**
 * The paths a miss most likely meant, at most {@link MAX_SUGGESTIONS_PER_PATH}:
 * first the same leaf anywhere (`git.commitCount` → `git.file.commitCount`),
 * then a near-miss sibling under the same parent (bd tea-rags-mcp-9f0yn.12) —
 * a key whose name contains the requested leaf (`git.file.dominantAuthor` →
 * `git.file.blameDominantAuthor`) or lies within
 * {@link NEAR_MISS_MAX_EDIT_DISTANCE} edits of it, containment first, then by
 * distance.
 */
function suggestedPaths(path: string, available: readonly string[]): string[] {
  const leaf = path.split(".").pop() ?? path;
  const parent = path.slice(0, path.length - leaf.length);
  const sameLeaf = available.filter((known) => known !== path && known.endsWith(`.${leaf}`));
  const needle = leaf.toLowerCase();
  const nearMisses = available
    .filter((known) => known.startsWith(parent) && !known.slice(parent.length).includes("."))
    .filter((known) => known !== path && !sameLeaf.includes(known))
    .map((known) => {
      const sibling = known.slice(parent.length).toLowerCase();
      return {
        known,
        contains: needle.length >= MIN_CONTAINED_LEAF_LENGTH && sibling.includes(needle),
        distance: editDistance(needle, sibling),
      };
    })
    .filter(({ contains, distance }) => contains || distance <= NEAR_MISS_MAX_EDIT_DISTANCE)
    .sort((a, b) => Number(b.contains) - Number(a.contains) || a.distance - b.distance)
    .map(({ known }) => known);
  return [...sameLeaf, ...nearMisses].slice(0, MAX_SUGGESTIONS_PER_PATH);
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

/**
 * Levenshtein distance, two-row — the same approach the project-alias and CLI
 * tool-name suggestions use, kept local: the DTO layer imports nothing outside
 * itself, and a shared primitive edge here re-partitioned the review's
 * component graph (bd tea-rags-mcp-9f0yn.12).
 */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, (previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
