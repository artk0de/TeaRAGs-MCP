/**
 * TestSetupHydrator — puts a test example's setup back in front of it when
 * explore returns it (bd tea-rags-mcp-5xpq4).
 *
 * The test-scope chunker stores each scope's own setup ONCE, and PACKS the
 * setup of consecutive scopes into one chunk up to the content budget. Per
 * member scope, aligned, the chunk carries that scope's whole line span
 * (`scopeLineRanges`) and how many of its content rows the member takes
 * (`memberRowCounts`). Embedding the example without the setup is what took
 * tests from x1.75 of their source size back towards x1.0; this is the other
 * half — an example a search or `find_symbol` returns is still "runnable in
 * the head".
 *
 * An example inherits every MEMBER of its file's setup chunks whose scope span
 * CONTAINS the example's start line, outermost scope first: lexical setup
 * inheritance, as RSpec `let` / `before` and Jest `beforeEach` define it, read
 * off line numbers without parsing a single id. Only those members' rows are
 * rendered, sliced out of the pack (`slicePack`): a sibling scope packed into
 * the same chunk has a span that never contains the example, so its setup
 * never leaks in.
 *
 * One page → one Qdrant scroll over the setup chunks of every file the page's
 * examples come from. The filter is index-served only: `relativePath` through
 * its text index (the exact text + value pair) and `chunkType` through its
 * keyword index. `chunkType` admits `test` as well as `test_setup` because a
 * scope whose setup runs shared examples is typed `test`; the examples that
 * arm also returns carry no `scopeLineRanges` and are dropped here, client-side,
 * rather than by a condition on an unindexed key.
 *
 * Out of scope: setup that arrives from a definition elsewhere —
 * `include_context`, `shared_examples`, `it_behaves_like` — is not resolved;
 * the delegating line itself sits in its scope's setup chunk and is hydrated
 * as written.
 *
 * Nothing changes for a page without test examples (no fetch), nor for an
 * index chunked before setup chunks carried a scope span (the fetch finds
 * none and every example is returned as it came).
 */

import type { QdrantManager } from "../../adapters/qdrant/client.js";
import { exactMatchOnTextIndexed } from "../../adapters/qdrant/filters/text-indexed-exact.js";
import { TEST_SCOPE_PARENT_TYPE } from "../../contracts/types/chunker.js";

/** Ceiling on chunks the setup scroll reads per page: setup windows plus the examples the `test` arm brings. */
const SETUP_SCROLL_LIMIT = 4096;

/** Payload keys the hydration reads off a setup chunk. */
const SETUP_PAYLOAD_KEYS = ["relativePath", "startLine", "scopeLineRanges", "memberRowCounts", "content"];

/** A setup chunk's scope is typed `test` when one of its lines runs shared examples. */
const SETUP_CHUNK_TYPES = ["test_setup", "test"];

const SPLIT_PART = /#part(\d+)$/;

interface HydratableResult {
  payload?: Record<string, unknown>;
}

interface LineRange {
  start: number;
  end: number;
}

/** One scope's setup, sliced out of its pack: the scope's span, the pack's container header, its own rows. */
interface SetupMember {
  scope: LineRange;
  header: string[];
  rows: string[];
}

export class TestSetupHydrator {
  constructor(private readonly qdrant: Pick<QdrantManager, "scrollFiltered">) {}

  /**
   * The same results, each test example carrying its setup chain in front of
   * its own content. Results are copied, never mutated; an example with no
   * enclosing setup in the index is returned as it came. The `#partN` windows
   * of one oversized example are hydrated once, on the earliest part the page
   * holds.
   */
  async hydrate<R extends HydratableResult>(results: R[], collectionName: string): Promise<R[]> {
    const examples = results.map(exampleOf);
    const files = new Set(examples.flatMap((e) => (e ? [e.relativePath] : [])));
    if (files.size === 0) return results;

    const points = await this.qdrant.scrollFiltered(
      collectionName,
      setupFilter([...files]),
      SETUP_SCROLL_LIMIT,
      undefined,
      SETUP_PAYLOAD_KEYS,
    );
    const membersByFile = setupMembers(points);
    const hydratedOn = firstPartOnPage(examples);

    return results.map((result, i) => {
      const example = examples[i];
      if (!example || hydratedOn.get(baseKey(example)) !== i) return result;
      const chain = enclosingMembers(membersByFile.get(example.relativePath) ?? [], example.startLine);
      if (chain.length === 0) return result;
      return {
        ...result,
        payload: {
          ...result.payload,
          content: prependSetup(example.content, chain),
        },
      };
    });
  }
}

interface TestExampleView {
  relativePath: string;
  symbolId: string;
  startLine: number;
  content: string;
}

/** A test example chunk (or tiny group) — the only chunks that inherit setup. */
function exampleOf({ payload }: HydratableResult): TestExampleView | undefined {
  if (payload?.parentType !== TEST_SCOPE_PARENT_TYPE) return undefined;
  const { relativePath, symbolId, startLine, content } = payload;
  if (typeof relativePath !== "string" || typeof startLine !== "number" || typeof content !== "string") {
    return undefined;
  }
  return { relativePath, symbolId: typeof symbolId === "string" ? symbolId : "", startLine, content };
}

/** The example a `#partN` window belongs to, scoped to its file. */
function baseKey(example: TestExampleView): string {
  return `${example.relativePath}\u0000${example.symbolId.replace(SPLIT_PART, "")}`;
}

/** Per example, the page index that carries its setup: its earliest part (by line) on the page. */
function firstPartOnPage(examples: (TestExampleView | undefined)[]): Map<string, number> {
  const chosen = new Map<string, number>();
  examples.forEach((example, i) => {
    if (!example) return;
    const key = baseKey(example);
    const current = chosen.get(key);
    if (current === undefined || example.startLine < (examples[current] as TestExampleView).startLine) {
      chosen.set(key, i);
    }
  });
  return chosen;
}

/** Every setup chunk (both chunk types) of the given files — index-served conditions only. */
function setupFilter(relativePaths: string[]): Record<string, unknown> {
  return {
    must: [{ key: "chunkType", match: { any: SETUP_CHUNK_TYPES } }],
    should: relativePaths.map((relativePath) => ({ must: exactMatchOnTextIndexed("relativePath", relativePath) })),
  };
}

/**
 * The setup MEMBERS per file. A setup chunk packs the setup of several scopes;
 * its windows (one, or the `#partN` windows the engine cut it into — each
 * repeats the per-member arrays, so those arrays are the key and no id is
 * parsed) are reassembled in line order and sliced into one entry per member.
 * Anything without the arrays (an example, a setup chunk of an older index) is
 * dropped, and so is a pack whose rows do not add up.
 */
function setupMembers(points: { payload: Record<string, unknown> }[]): Map<string, SetupMember[]> {
  const packs = new Map<
    string,
    { relativePath: string; scopes: LineRange[]; rowCounts: number[]; windows: { line: number; content: string }[] }
  >();
  for (const { payload } of points) {
    const { relativePath, startLine, scopeLineRanges, memberRowCounts, content } = payload;
    if (typeof relativePath !== "string" || typeof content !== "string") continue;
    if (!Array.isArray(scopeLineRanges) || !scopeLineRanges.every(isLineRange)) continue;
    if (!Array.isArray(memberRowCounts) || memberRowCounts.length !== scopeLineRanges.length) continue;
    if (!memberRowCounts.every((n) => Number.isInteger(n) && (n as number) > 0)) continue;
    const key = `${relativePath}\u0000${JSON.stringify(scopeLineRanges)}\u0000${JSON.stringify(memberRowCounts)}`;
    const pack = packs.get(key) ?? {
      relativePath,
      scopes: scopeLineRanges,
      rowCounts: memberRowCounts as number[],
      windows: [],
    };
    pack.windows.push({ line: typeof startLine === "number" ? startLine : 0, content });
    packs.set(key, pack);
  }
  const byFile = new Map<string, SetupMember[]>();
  for (const { relativePath, scopes, rowCounts, windows } of packs.values()) {
    const sliced = slicePack(
      windows.sort((a, b) => a.line - b.line).map((w) => w.content),
      rowCounts,
    );
    if (!sliced) continue;
    const list = byFile.get(relativePath) ?? [];
    list.push(...scopes.map((scope, i) => ({ scope, header: sliced.header, rows: sliced.members[i] })));
    byFile.set(relativePath, list);
  }
  return byFile;
}

/**
 * A pack's windows → the container header and each member's rows.
 *
 * The kernel stores the members' own rows back to back; the engine prepends
 * the container header (zero or more rows), and when it cuts a pack into
 * `#partN` windows it repeats that header on every window — or, when the
 * header is too large to repeat, puts it on the first window only. Both
 * layouts are recognised from the row arithmetic: the rows that are not
 * members' rows are the header, and they must be identical where they repeat.
 * A pack that fits neither (a row the engine character-sliced) returns
 * nothing rather than a slice that might render a sibling's setup.
 */
function slicePack(windows: string[], rowCounts: number[]): { header: string[]; members: string[][] } | undefined {
  const rowsOf = windows.map((w) => w.split("\n"));
  const memberRows = rowCounts.reduce((sum, n) => sum + n, 0);
  const totalRows = rowsOf.reduce((sum, rows) => sum + rows.length, 0);
  const extra = totalRows - memberRows;
  if (extra < 0) return undefined;

  let header: string[] | undefined;
  let body: string[] = [];
  if (extra % rowsOf.length === 0) {
    const perWindow = extra / rowsOf.length;
    const first = rowsOf[0].slice(0, perWindow);
    if (rowsOf.every((rows) => rows.length > perWindow && first.every((row, i) => rows[i] === row))) {
      header = first;
      body = rowsOf.flatMap((rows) => rows.slice(perWindow));
    }
  }
  if (header === undefined && rowsOf[0].length > extra) {
    header = rowsOf[0].slice(0, extra);
    body = [...rowsOf[0].slice(extra), ...rowsOf.slice(1).flat()];
  }
  if (header === undefined) return undefined;

  const members: string[][] = [];
  let offset = 0;
  for (const count of rowCounts) {
    members.push(body.slice(offset, offset + count));
    offset += count;
  }
  return { header, members };
}

function isLineRange(value: unknown): value is LineRange {
  if (!value || typeof value !== "object") return false;
  const { start, end } = value as Record<string, unknown>;
  return typeof start === "number" && typeof end === "number";
}

/** The members whose scope contains `line`, outermost first (earlier start, then the wider span). */
function enclosingMembers(members: SetupMember[], line: number): SetupMember[] {
  return members
    .filter(({ scope }) => scope.start <= line && line <= scope.end)
    .sort((a, b) => a.scope.start - b.scope.start || b.scope.end - a.scope.end);
}

/**
 * The example's content with the members' setup rows inserted after the
 * leading rows it shares with the setup's container header — the header(s)
 * the engine prepends to every chunk of the file — so it reads header, setup
 * outermost first, example.
 */
function prependSetup(content: string, chain: SetupMember[]): string {
  const exampleLines = content.split("\n");
  const insertAt = Math.min(...chain.map(({ header }) => sharedLeadingRows(header, exampleLines)));
  const bodies = chain.flatMap(({ rows }) => rows);
  return [...exampleLines.slice(0, insertAt), ...bodies, ...exampleLines.slice(insertAt)].join("\n");
}

/** Leading rows the setup header and the example have in common. */
function sharedLeadingRows(headerLines: string[], exampleLines: string[]): number {
  let shared = 0;
  while (shared < headerLines.length && shared < exampleLines.length && headerLines[shared] === exampleLines[shared]) {
    shared++;
  }
  return shared;
}
