/**
 * TestSetupHydrator — puts a test example's setup back in front of it when
 * explore returns it (bd tea-rags-mcp-5xpq4).
 *
 * The test-scope chunker stores each scope's own setup ONCE, as a chunk named
 * after the scope, and lists on every example the scopes whose setup it runs
 * under (`setupScopeIds`, root to leaf). Embedding the example without the
 * setup is what took tests from x1.75 of their source size back towards x1.0;
 * this is the other half — an example a search or `find_symbol` returns is
 * still "runnable in the head".
 *
 * One page → one Qdrant scroll: the setup ids of every example on the page are
 * collected, deduplicated per file, and fetched together. A setup chunk is
 * matched by file AND id, never by id alone — two spec files can both hold
 * `User.RSpec.describe User`. An oversized setup chunk was cut by the engine
 * into `<scopeId>#partN` windows parented to the scope id, so the scroll asks
 * both `symbolId` and `parentSymbolId`, and the client keeps only the scope's
 * own chunk and its windows (the parent arm also returns the scope's examples).
 *
 * A chunk without `setupScopeIds` — every non-test chunk, and every test chunk
 * of an index chunked before the field existed — passes through untouched and
 * costs nothing.
 */

import type { QdrantManager } from "../../adapters/qdrant/client.js";
import { symbolIdTextToken } from "../../adapters/qdrant/filters/symbolid-text-token.js";
import { exactMatchOnTextIndexed } from "../../adapters/qdrant/filters/text-indexed-exact.js";
import { TEST_SCOPE_PARENT_TYPE } from "../../contracts/types/chunker.js";

/** Ceiling on setup chunks per page — parts included; a page holds tens. */
const SETUP_SCROLL_LIMIT = 1024;

/** Payload keys the hydration reads off a setup chunk. */
const SETUP_PAYLOAD_KEYS = ["symbolId", "relativePath", "content"];

const SPLIT_PART = /#part(\d+)$/;

interface HydratableResult {
  payload?: Record<string, unknown>;
}

export class TestSetupHydrator {
  constructor(private readonly qdrant: Pick<QdrantManager, "scrollFiltered">) {}

  /**
   * The same results, each test example carrying its setup chain in front of
   * its own content. Results are copied, never mutated; an example whose setup
   * is absent from the index is returned as it came.
   */
  async hydrate<R extends HydratableResult>(results: R[], collectionName: string): Promise<R[]> {
    const wanted = new Map<string, Set<string>>();
    for (const result of results) {
      const link = setupLinkOf(result);
      if (!link) continue;
      const ids = wanted.get(link.relativePath) ?? new Set<string>();
      for (const id of link.setupScopeIds) ids.add(id);
      wanted.set(link.relativePath, ids);
    }
    if (wanted.size === 0) return results;

    const points = await this.qdrant.scrollFiltered(
      collectionName,
      setupFilter(wanted),
      SETUP_SCROLL_LIMIT,
      undefined,
      SETUP_PAYLOAD_KEYS,
    );
    const windows = setupWindows(points, wanted);

    return results.map((result) => {
      const link = setupLinkOf(result);
      if (!link) return result;
      const chain = link.setupScopeIds.flatMap((id) => windows.get(setupKey(link.relativePath, id)) ?? []);
      if (chain.length === 0) return result;
      return { ...result, payload: { ...result.payload, content: prependSetup(link.content, chain) } };
    });
  }
}

interface SetupLink {
  relativePath: string;
  setupScopeIds: string[];
  content: string;
}

function setupLinkOf({ payload }: HydratableResult): SetupLink | undefined {
  if (!payload) return undefined;
  const { setupScopeIds, relativePath, content } = payload;
  if (!Array.isArray(setupScopeIds) || setupScopeIds.length === 0) return undefined;
  if (typeof relativePath !== "string" || typeof content !== "string") return undefined;
  return {
    relativePath,
    setupScopeIds: setupScopeIds.filter((id): id is string => typeof id === "string"),
    content,
  };
}

function setupKey(relativePath: string, scopeId: string): string {
  return `${relativePath}\u0000${scopeId}`;
}

/**
 * Per file, the scope chunks by exact id or their `#partN` windows by parent
 * id. A setup chunk is a `test_setup`, or a `test` when its scope runs shared
 * examples — never an example, which `parentType` marks.
 */
function setupFilter(wanted: Map<string, Set<string>>): Record<string, unknown> {
  return {
    must: [{ key: "chunkType", match: { any: ["test_setup", "test"] } }],
    must_not: [{ key: "parentType", match: { value: TEST_SCOPE_PARENT_TYPE } }],
    should: [...wanted].map(([relativePath, ids]) => ({
      must: exactMatchOnTextIndexed("relativePath", relativePath),
      should: [...ids].flatMap((id) => [
        { must: exactMatchOnTextIndexed("symbolId", id, symbolIdTextToken(id)) },
        { must: exactMatchOnTextIndexed("parentSymbolId", id, symbolIdTextToken(id)) },
      ]),
    })),
  };
}

/**
 * The setup windows per (file, scope id), in part order: the scope's own chunk,
 * or the `#partN` windows the engine cut it into. Anything else the scroll
 * brought back — an example under the scope — is dropped here.
 */
function setupWindows(
  points: { payload: Record<string, unknown> }[],
  wanted: Map<string, Set<string>>,
): Map<string, string[]> {
  const windows = new Map<string, { part: number; content: string }[]>();
  for (const { payload } of points) {
    const { relativePath, symbolId, content } = payload;
    if (typeof relativePath !== "string" || typeof symbolId !== "string" || typeof content !== "string") continue;
    const part = SPLIT_PART.exec(symbolId);
    const scopeId = part ? symbolId.slice(0, part.index) : symbolId;
    if (!wanted.get(relativePath)?.has(scopeId)) continue;
    const key = setupKey(relativePath, scopeId);
    const list = windows.get(key) ?? [];
    list.push({ part: part ? Number(part[1]) : 0, content });
    windows.set(key, list);
  }
  return new Map([...windows].map(([key, list]) => [key, list.sort((a, b) => a.part - b.part).map((w) => w.content)]));
}

/**
 * The example's content with the setup windows inserted after the leading rows
 * every chunk of the file shares — the container header(s) the engine
 * prepends — so it reads header, setup outermost first, example. Each window
 * carries its own copy of those rows, which is dropped.
 */
function prependSetup(content: string, setupWindowsInOrder: string[]): string {
  const exampleLines = content.split("\n");
  let insertAt = exampleLines.length;
  const bodies: string[] = [];
  for (const window of setupWindowsInOrder) {
    const lines = window.split("\n");
    const shared = sharedLeadingRows(lines, exampleLines);
    insertAt = Math.min(insertAt, shared);
    bodies.push(...lines.slice(shared));
  }
  return [...exampleLines.slice(0, insertAt), ...bodies, ...exampleLines.slice(insertAt)].join("\n");
}

/** Leading rows two texts have in common, always leaving the window one row of its own. */
function sharedLeadingRows(windowLines: string[], exampleLines: string[]): number {
  let shared = 0;
  while (
    shared < windowLines.length - 1 &&
    shared < exampleLines.length &&
    windowLines[shared] === exampleLines[shared]
  ) {
    shared++;
  }
  return shared;
}
