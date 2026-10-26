/**
 * Response budget guard (bd tea-rags-mcp-c01gm).
 *
 * Claude Code caps an MCP tool answer at 25k tokens and dumps a larger one to a
 * file the agent is told not to read — the turn is lost. Every tool that
 * declares a {@link ResponseRowsPolicy} at registration passes this guard: an
 * answer over {@link RESPONSE_BUDGET_CHARS} loses WHOLE rows from the tail of
 * its row collections until it fits, and says so in `truncated` with the call
 * that reads the rest.
 *
 * Measured on what the model receives: `structuredContent` when the answer has
 * one, else the JSON of `content[0].text`. Only declared row collections are
 * cut — every other field (summary, workingTree, empty, next, notices,
 * reportId, directory, missing) rides through untouched.
 */

import type { SuggestedToolCall } from "../../contracts/types/suggested-tool-call.js";
import { toolCallAddressFromWorkingTree } from "../../domains/explore/index.js";
import { isColumnTable } from "./columns.js";
import { makeStrictJsonSafe, type McpToolResult } from "./format.js";

/** Owner decision: half Claude Code's 25k default, leaving room for the rest of the turn. */
export const RESPONSE_BUDGET_TOKENS = 12_000;
/**
 * One conversion for every answer: compact JSON of identifiers, paths and code
 * runs ~3.5 chars per token on the Claude tokenizer (measured on the
 * self-index answers this guard was written for).
 */
export const RESPONSE_CHARS_PER_TOKEN = 3.5;
export const RESPONSE_BUDGET_CHARS = RESPONSE_BUDGET_TOKENS * RESPONSE_CHARS_PER_TOKEN;

/** What the guard cut, handed to the tool's continuation. */
export interface ResponseRowsCut {
  /** Rows kept in EVERY collection that had more: the one per-collection count. */
  perCollection: number;
  /** The trimmed answer (truncated block not yet attached). */
  answer: Record<string, unknown>;
  /** Dropped rows, as stored (ColumnTable row arrays or records), collection order. */
  omittedRows: readonly unknown[];
  /** Columns of the first cut ColumnTable, when the collection is one. */
  columns?: readonly string[];
}

/** Arguments of the call that reads the omitted tail; `undefined` = none expressible. */
export type ResponseContinuation = (
  args: Record<string, unknown>,
  cut: ResponseRowsCut,
) => Record<string, unknown> | undefined;

/** A tool's row declaration, given at registration. */
export interface ResponseRowsPolicy {
  /**
   * Dotted paths of the row collections; a trailing `.*` names every member of
   * that object (one collection each). Absent = every top-level row collection
   * outside the protected fields.
   */
  rows?: readonly string[];
  /** How the tail is reached; absent = the tool has no paging param. */
  continuation?: ResponseContinuation;
  /** Params that shrink the answer, named when there is no continuation. */
  narrowing: readonly string[];
}

/** The `truncated` block the guard attaches. */
export interface ResponseTruncation {
  returned: number;
  omitted: number;
  next?: SuggestedToolCall;
  message?: string;
}

/** Fields the default row discovery never treats as rows. */
const PROTECTED_FIELDS = new Set([
  "summary",
  "workingTree",
  "empty",
  "next",
  "reportId",
  "directory",
  "missing",
  "truncated",
]);
const NOTICE_FIELD = /warning|notice|unavailable|drift/i;

/**
 * `offset` = original offset + the per-collection count kept, plus each
 * `carry` field copied from the answer when present (`reportId` pages a held
 * judgement instead of recomputing it).
 */
export function offsetContinuation(carry: readonly string[] = []): ResponseContinuation {
  return (args, cut) => {
    const offset = typeof args.offset === "number" ? args.offset : 0;
    const carried = Object.fromEntries(
      carry.filter((key) => cut.answer[key] !== undefined).map((key) => [key, cut.answer[key]]),
    );
    return { ...args, offset: offset + cut.perCollection, ...carried };
  };
}

interface RowCollection {
  /** Reads the collection's rows. */
  rows: readonly unknown[];
  /** Writes `count` leading rows back into a copy of the answer. */
  keep: (answer: Record<string, unknown>, count: number) => void;
  columns?: readonly string[];
}

/** Answer of an MCP result as the model reads it, or null when it is not a JSON object. */
function readAnswer(result: McpToolResult): { answer: Record<string, unknown>; channel: "structured" | "text" } | null {
  if (isRecord(result.structuredContent)) return { answer: result.structuredContent, channel: "structured" };
  const text = result.content[0]?.text;
  if (typeof text !== "string" || !text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? { answer: parsed, channel: "text" } : null;
  } catch {
    return null;
  }
}

function writeAnswer(
  result: McpToolResult,
  answer: Record<string, unknown>,
  channel: "structured" | "text",
): McpToolResult {
  if (channel === "structured") return { ...result, structuredContent: answer };
  const [, ...rest] = result.content;
  return { ...result, content: [{ type: "text", text: makeStrictJsonSafe(JSON.stringify(answer)) }, ...rest] };
}

function sizeOf(answer: Record<string, unknown>): number {
  return JSON.stringify(answer).length;
}

/**
 * Trim an over-budget answer to fit: every declared collection keeps the same
 * leading count k — the largest k that fits — so one per-collection `offset`
 * continues each of them without overlap or gap. At least one row is kept so a
 * continuation always advances.
 */
export function enforceResponseBudget(
  result: McpToolResult,
  tool: string,
  args: unknown,
  policy: ResponseRowsPolicy,
  budgetChars: number = RESPONSE_BUDGET_CHARS,
): McpToolResult {
  if (result.isError === true) return result;
  const read = readAnswer(result);
  if (!read || sizeOf(read.answer) <= budgetChars) return result;

  const collections = findRowCollections(read.answer, policy.rows);
  const longest = Math.max(0, ...collections.map((c) => c.rows.length));
  if (longest <= 1) return result;

  const request = isRecord(args) ? args : {};
  const build = (perCollection: number) => buildTrimmed(read.answer, collections, perCollection, tool, request, policy);

  let low = 1;
  let high = longest - 1;
  let best = build(1);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = build(mid);
    if (sizeOf(candidate) <= budgetChars) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  // The fields no cut may touch plus one row per collection still overflow:
  // the page goes out anyway (a continuation must advance) and names the knobs
  // that shrink the fixed part.
  if (sizeOf(best) > budgetChars) {
    const truncated = best.truncated as ResponseTruncation;
    truncated.message ??= narrowingMessage(policy);
  }
  return writeAnswer(result, best, read.channel);
}

function narrowingMessage(policy: ResponseRowsPolicy): string {
  return (
    `Answer trimmed to the ${String(RESPONSE_BUDGET_TOKENS)}-token response budget. ` +
    `Narrow it with: ${policy.narrowing.join(", ")}.`
  );
}

function buildTrimmed(
  original: Record<string, unknown>,
  collections: readonly RowCollection[],
  perCollection: number,
  tool: string,
  args: Record<string, unknown>,
  policy: ResponseRowsPolicy,
): Record<string, unknown> {
  const answer = structuredClone(original);
  let returned = 0;
  const omittedRows: unknown[] = [];
  let columns: readonly string[] | undefined;
  for (const collection of collections) {
    const kept = Math.min(collection.rows.length, perCollection);
    returned += kept;
    if (kept < collection.rows.length) {
      omittedRows.push(...collection.rows.slice(kept));
      columns ??= collection.columns;
    }
    collection.keep(answer, kept);
  }
  const truncated: ResponseTruncation = { returned, omitted: omittedRows.length };
  const cut: ResponseRowsCut = { perCollection, answer, omittedRows, ...(columns && { columns }) };
  const nextArgs = policy.continuation?.(args, cut);
  if (nextArgs) {
    truncated.next = {
      tool,
      args: { ...nextArgs, ...toolCallAddressFromWorkingTree(workingTreeOf(answer)) },
      why: "the rows this answer omitted to stay within the response budget",
    };
  } else {
    truncated.message = narrowingMessage(policy);
  }
  answer.truncated = truncated;
  return answer;
}

/** The answer's tree marker (full or compact) — only its `tree` / `project` address the call. */
function workingTreeOf(answer: Record<string, unknown>): { tree: string; project?: string } | undefined {
  const { workingTree } = answer;
  if (!isRecord(workingTree) || typeof workingTree.tree !== "string") return undefined;
  return {
    tree: workingTree.tree,
    ...(typeof workingTree.project === "string" && { project: workingTree.project }),
  };
}

function findRowCollections(answer: Record<string, unknown>, paths: readonly string[] | undefined): RowCollection[] {
  if (!paths) {
    return Object.keys(answer)
      .filter((key) => !PROTECTED_FIELDS.has(key) && !NOTICE_FIELD.test(key))
      .flatMap((key) => collectionAt(answer, [key]));
  }
  return paths.flatMap((path) => {
    const segments = path.split(".");
    if (segments[segments.length - 1] !== "*") return collectionAt(answer, segments);
    const parent = valueAt(answer, segments.slice(0, -1));
    if (!isRecord(parent)) return [];
    return Object.keys(parent).flatMap((key) => collectionAt(answer, [...segments.slice(0, -1), key]));
  });
}

/** The collection at `segments`, when the value there is a ColumnTable or an array. */
function collectionAt(answer: Record<string, unknown>, segments: readonly string[]): RowCollection[] {
  const value = valueAt(answer, segments);
  const parentOf = (copy: Record<string, unknown>) => valueAt(copy, segments.slice(0, -1)) as Record<string, unknown>;
  const key = segments[segments.length - 1];
  if (isRecord(value) && isColumnTable(value)) {
    return [
      {
        rows: value.rows,
        columns: value.columns,
        keep: (copy, count) => {
          const table = parentOf(copy)[key] as { rows: unknown[][] };
          table.rows = table.rows.slice(0, count);
        },
      },
    ];
  }
  if (Array.isArray(value)) {
    return [
      {
        rows: value,
        keep: (copy, count) => {
          const parent = parentOf(copy);
          parent[key] = (parent[key] as unknown[]).slice(0, count);
        },
      },
    ];
  }
  return [];
}

function valueAt(root: unknown, segments: readonly string[]): unknown {
  let value = root;
  for (const segment of segments) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
