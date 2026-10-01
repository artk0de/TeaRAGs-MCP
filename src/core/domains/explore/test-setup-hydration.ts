/**
 * TestSetupHydrator — puts a test example's setup back in front of it when
 * explore returns it (bd tea-rags-mcp-5xpq4).
 *
 * The test-scope chunker stores each scope's own setup ONCE, as a chunk that
 * carries the line span of its whole scope (`scopeLineRange`). Embedding the
 * example without the setup is what took tests from x1.75 of their source size
 * back towards x1.0; this is the other half — an example a search or
 * `find_symbol` returns is still "runnable in the head".
 *
 * An example inherits every setup chunk of its file whose scope span CONTAINS
 * the example's start line, outermost scope first: lexical setup inheritance,
 * as RSpec `let` / `before` and Jest `beforeEach` define it, read off line
 * numbers without parsing a single id. A sibling scope's span never contains
 * the example, so its setup never leaks in.
 *
 * One page → one Qdrant scroll over the setup chunks of every file the page's
 * examples come from. The filter is index-served only: `relativePath` through
 * its text index (the exact text + value pair) and `chunkType` through its
 * keyword index. `chunkType` admits `test` as well as `test_setup` because a
 * scope whose setup runs shared examples is typed `test`; the examples that
 * arm also returns carry no `scopeLineRange` and are dropped here, client-side,
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
const SETUP_PAYLOAD_KEYS = ["relativePath", "startLine", "scopeLineRange", "content"];

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

/** One scope's setup: its span and its windows' content in line order. */
interface ScopeSetup {
  scope: LineRange;
  windows: string[];
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
    const setupsByFile = scopeSetups(points);
    const hydratedOn = firstPartOnPage(examples);

    return results.map((result, i) => {
      const example = examples[i];
      if (!example || hydratedOn.get(baseKey(example)) !== i) return result;
      const chain = enclosingSetups(setupsByFile.get(example.relativePath) ?? [], example.startLine);
      if (chain.length === 0) return result;
      return {
        ...result,
        payload: {
          ...result.payload,
          content: prependSetup(
            example.content,
            chain.flatMap((s) => s.windows),
          ),
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
 * The setup scopes per file, each with its windows in line order. A setup
 * chunk split into `#partN` windows repeats its scope span on every window, so
 * the span is the key — no id is parsed. Anything without a span (an example,
 * a setup chunk of an older index) is dropped.
 */
function scopeSetups(points: { payload: Record<string, unknown> }[]): Map<string, ScopeSetup[]> {
  const byScope = new Map<
    string,
    { relativePath: string; scope: LineRange; parts: { line: number; content: string }[] }
  >();
  for (const { payload } of points) {
    const { relativePath, startLine, scopeLineRange, content } = payload;
    if (typeof relativePath !== "string" || typeof content !== "string" || !isLineRange(scopeLineRange)) continue;
    const key = `${relativePath}\u0000${scopeLineRange.start}:${scopeLineRange.end}`;
    const entry = byScope.get(key) ?? { relativePath, scope: scopeLineRange, parts: [] };
    entry.parts.push({ line: typeof startLine === "number" ? startLine : 0, content });
    byScope.set(key, entry);
  }
  const byFile = new Map<string, ScopeSetup[]>();
  for (const { relativePath, scope, parts } of byScope.values()) {
    const list = byFile.get(relativePath) ?? [];
    list.push({ scope, windows: parts.sort((a, b) => a.line - b.line).map((p) => p.content) });
    byFile.set(relativePath, list);
  }
  return byFile;
}

function isLineRange(value: unknown): value is LineRange {
  if (!value || typeof value !== "object") return false;
  const { start, end } = value as Record<string, unknown>;
  return typeof start === "number" && typeof end === "number";
}

/** The setups whose scope contains `line`, outermost first (earlier start, then the wider span). */
function enclosingSetups(setups: ScopeSetup[], line: number): ScopeSetup[] {
  return setups
    .filter(({ scope }) => scope.start <= line && line <= scope.end)
    .sort((a, b) => a.scope.start - b.scope.start || b.scope.end - a.scope.end);
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
