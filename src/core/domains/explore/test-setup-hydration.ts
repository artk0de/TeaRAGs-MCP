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
 *
 * Working tree (bd tea-rags-mcp-xi2r9.3): handed the view of a floor strategy,
 * a file the tree touched takes its setup from the tree's rows of that file —
 * the version its examples came from — and never from the index, whose setup
 * belongs to the version the tree replaced. A deleted file has no tree rows,
 * so no setup. Untouched files keep the index scroll.
 */

import type { QdrantManager } from "../../adapters/qdrant/client.js";
import { exactMatchOnTextIndexed } from "../../adapters/qdrant/filters/text-indexed-exact.js";
import { TEST_SCOPE_PARENT_TYPE } from "../../contracts/types/chunker.js";
import { isLineRange, slicePack } from "./test-pack.js";
import type { WorkingTreeView } from "./working-tree/overlay.js";

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
   * holds. With `workingTreeView`, files it touched read their setup from the
   * tree's rows (see the module doc).
   */
  async hydrate<R extends HydratableResult>(
    results: R[],
    collectionName: string,
    workingTreeView?: WorkingTreeView,
  ): Promise<R[]> {
    const examples = results.map(exampleOf);
    const files = new Set(examples.flatMap((e) => (e ? [e.relativePath] : [])));
    if (files.size === 0) return results;

    const fromTree = workingTreeView?.readDeltaChunks ? workingTreeView : undefined;
    const indexFiles = [...files].filter((file) => !fromTree?.touchedPaths.has(file));
    const treeFiles = [...files].filter((file) => fromTree?.touchedPaths.has(file));
    const [indexPoints, treePoints] = await Promise.all([
      indexFiles.length > 0
        ? this.qdrant.scrollFiltered(
            collectionName,
            setupFilter(indexFiles),
            SETUP_SCROLL_LIMIT,
            undefined,
            SETUP_PAYLOAD_KEYS,
          )
        : [],
      treeFiles.length > 0 && fromTree?.readDeltaChunks ? treeSetupPoints(fromTree, new Set(treeFiles)) : [],
    ]);
    const membersByFile = setupMembers([...indexPoints, ...treePoints]);
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

/** The tree's setup rows (both chunk types) of the given touched files — what the index scroll is for the rest. */
async function treeSetupPoints(
  view: WorkingTreeView,
  files: ReadonlySet<string>,
): Promise<{ payload: Record<string, unknown> }[]> {
  const rows = (await view.readDeltaChunks?.()) ?? [];
  return rows.filter(
    ({ payload }) =>
      typeof payload.relativePath === "string" &&
      files.has(payload.relativePath) &&
      SETUP_CHUNK_TYPES.includes(payload.chunkType as string),
  );
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
