/**
 * Unit + property tests for the shared `assignCallsToInnermostChunks` kernel
 * helper (tea-rags-mcp-d77bl follow-on).
 *
 * Before this change the SAME 26-line brute-force implementation (O(calls x
 * chunks) per file — a full linear scan of every chunk for every call) was
 * duplicated byte-identical in three walkers:
 *   - `typescript/walker/walker.ts`
 *   - `javascript/walker/walker.ts`
 *   - `ruby/walker/chunk-extractions.ts`
 *
 * `collectSymbols` (kernel/collect-symbols.ts) walks the AST pre-order and
 * pushes a symbol's range BEFORE descending into its children, so the
 * `chunks[]` array a walker receives is always (a) sorted by `startLine`
 * (documented on `ExtractInput.chunks` in every walker) AND (b) a valid
 * containment forest — any two ranges are either disjoint or one strictly
 * contains the other, never a partial "crossing" overlap. That is exactly
 * the invariant a stack-based single sweep needs to replace the O(N x C)
 * scan with O(N log N + C) (sort the calls once, then walk both arrays with
 * a stack of "currently open" chunks).
 *
 * `referenceAssign` below is the OLD brute-force body, kept here verbatim as
 * the ground truth. The property tests run both implementations over the
 * same generated fixtures and assert byte-identical Map output (including
 * per-bucket call ORDER, which the new implementation preserves by resolving
 * bucket assignment in startLine order but re-emitting in original `calls[]`
 * order) before the duplicated bodies are deleted from the three walkers.
 */
import { describe, expect, it } from "vitest";

import { assignCallsToInnermostChunks } from "../../../../../src/core/domains/language/kernel/assign-calls-to-chunks.js";

interface CallLike {
  callText: string;
  receiver: string | null;
  member: string;
  startLine: number;
}

interface ChunkLike {
  startLine: number;
  endLine: number;
  scope: string[];
}

/** Ground truth: the pre-refactor brute-force body, verbatim. */
function referenceAssign(calls: CallLike[], chunks: ChunkLike[]): Map<number, CallLike[]> {
  const out = new Map<number, CallLike[]>();
  for (const call of calls) {
    let bestIdx = -1;
    let bestSpan = Number.POSITIVE_INFINITY;
    let bestDepth = -1;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (call.startLine < c.startLine || call.startLine > c.endLine) continue;
      const span = c.endLine - c.startLine;
      const depth = c.scope.length;
      if (span < bestSpan || (span === bestSpan && depth > bestDepth)) {
        bestIdx = i;
        bestSpan = span;
        bestDepth = depth;
      }
    }
    if (bestIdx === -1) continue;
    const bucket = out.get(bestIdx);
    if (bucket) bucket.push(call);
    else out.set(bestIdx, [call]);
  }
  return out;
}

function call(startLine: number, id: string): CallLike {
  return { callText: `${id}()`, receiver: null, member: id, startLine };
}

function chunk(startLine: number, endLine: number, scope: string[]): ChunkLike {
  return { startLine, endLine, scope };
}

/** Assert both implementations produce the identical Map — keys AND per-bucket order. */
function assertSameAssignment(calls: CallLike[], chunks: ChunkLike[]): void {
  const expected = referenceAssign(calls, chunks);
  const actual = assignCallsToInnermostChunks(calls, chunks);
  expect(actual.size).toBe(expected.size);
  const expectedEntries = [...expected.entries()].sort((a, b) => a[0] - b[0]);
  const actualEntries = [...actual.entries()].sort((a, b) => a[0] - b[0]);
  expect(actualEntries).toEqual(expectedEntries);
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — no fast-check dependency in this project;
// a small seeded generator gives repeatable "random" nested-chunk fixtures
// without adding one just for this test.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a random containment FOREST of chunks (the only shape the walker's
 * `chunks[]` ever takes — see `collectSymbols`'s pre-order guarantee) over a
 * `[1, totalLines]` line range, plus a random set of calls at random lines
 * (some inside chunks, some in the gaps between/before/after every chunk).
 * Returns chunks already in the pre-order (startLine-ascending) shape a real
 * walker would hand in.
 */
function buildNestedFixture(
  rand: () => number,
  totalLines: number,
  maxDepth: number,
): { chunks: ChunkLike[]; calls: CallLike[] } {
  const chunks: ChunkLike[] = [];
  let callSeq = 0;
  const calls: CallLike[] = [];

  const emitCallsIn = (from: number, to: number, count: number): void => {
    for (let i = 0; i < count; i++) {
      const line = from + Math.floor(rand() * (to - from + 1));
      calls.push(call(line, `c${callSeq++}`));
    }
  };

  // Recursively carve [start, end] into a chunk plus nested children,
  // pre-order emitting the parent before its children (matches collectSymbols).
  const recurse = (start: number, end: number, scope: string[], depth: number): void => {
    if (start > end) return;
    chunks.push(chunk(start, end, scope));
    emitCallsIn(start, end, Math.floor(rand() * 2)); // 0-1 calls directly in this chunk
    if (depth >= maxDepth || end - start < 2) return;
    // Split the remaining interior into 1-3 disjoint (possibly gapped) children.
    const childCount = 1 + Math.floor(rand() * 3);
    let cursor = start + 1;
    for (let i = 0; i < childCount && cursor < end; i++) {
      const remaining = end - cursor;
      const span = Math.max(0, Math.floor(rand() * Math.min(remaining, 4)));
      const childStart = cursor;
      const childEnd = Math.min(end - 1, childStart + span);
      if (childEnd > childStart) {
        recurse(childStart, childEnd, [...scope, `s${depth}_${i}`], depth + 1);
      }
      cursor = childEnd + 2; // leave a gap line between siblings for gap-call coverage
    }
  };

  // A handful of TOP-LEVEL (sibling, disjoint) trees across the file.
  let cursor = 1;
  let top = 0;
  while (cursor < totalLines) {
    const span = 3 + Math.floor(rand() * 8);
    const start = cursor;
    const end = Math.min(totalLines, start + span);
    recurse(start, end, [`top${top++}`], 1);
    cursor = end + 2; // gap between top-level trees
  }

  // Calls scattered anywhere in [1, totalLines] — including gaps and past the end.
  emitCallsIn(1, totalLines + 3, 10);

  return { chunks, calls };
}

describe("assignCallsToInnermostChunks (kernel)", () => {
  it("assigns a call to the single containing chunk", () => {
    const chunks = [chunk(1, 10, ["A"])];
    const calls = [call(5, "x")];
    assertSameAssignment(calls, chunks);
    const result = assignCallsToInnermostChunks(calls, chunks);
    expect(result.get(0)?.map((c) => c.member)).toEqual(["x"]);
  });

  it("picks the innermost (smallest-span) chunk when nested", () => {
    // class A { method m() { foo() } } — class chunk [1,10], method chunk [2,4]
    const chunks = [chunk(1, 10, ["A"]), chunk(2, 4, ["A", "m"])];
    const calls = [call(3, "foo")];
    assertSameAssignment(calls, chunks);
    const result = assignCallsToInnermostChunks(calls, chunks);
    expect(result.get(1)?.map((c) => c.member)).toEqual(["foo"]);
    expect(result.get(0)).toBeUndefined();
  });

  it("breaks equal-span ties by deeper scope (deepest wins)", () => {
    // A one-line-body method whose chunk is coextensive with its own class
    // chunk — both span [2,2], class scope depth 1, method scope depth 2.
    const chunks = [chunk(2, 2, ["A"]), chunk(2, 2, ["A", "m"])];
    const calls = [call(2, "x")];
    assertSameAssignment(calls, chunks);
    const result = assignCallsToInnermostChunks(calls, chunks);
    expect(result.get(1)?.map((c) => c.member)).toEqual(["x"]);
  });

  it("drops calls whose startLine falls outside every chunk", () => {
    const chunks = [chunk(5, 10, ["A"])];
    const calls = [call(1, "before"), call(20, "after")];
    assertSameAssignment(calls, chunks);
    const result = assignCallsToInnermostChunks(calls, chunks);
    expect(result.size).toBe(0);
  });

  it("assigns a call landing in a gap BETWEEN two sibling (disjoint) chunks to neither", () => {
    const chunks = [chunk(1, 3, ["A"]), chunk(6, 8, ["B"])];
    const calls = [call(4, "gap"), call(2, "inA"), call(7, "inB")];
    assertSameAssignment(calls, chunks);
    const result = assignCallsToInnermostChunks(calls, chunks);
    expect(result.get(0)?.map((c) => c.member)).toEqual(["inA"]);
    expect(result.get(1)?.map((c) => c.member)).toEqual(["inB"]);
  });

  it("handles three levels of nesting (module > class > method)", () => {
    const chunks = [chunk(1, 20, ["M"]), chunk(2, 15, ["M", "C"]), chunk(3, 6, ["M", "C", "m"])];
    const calls = [call(4, "inMethod"), call(10, "inClass"), call(18, "inModule")];
    assertSameAssignment(calls, chunks);
    const result = assignCallsToInnermostChunks(calls, chunks);
    expect(result.get(2)?.map((c) => c.member)).toEqual(["inMethod"]);
    expect(result.get(1)?.map((c) => c.member)).toEqual(["inClass"]);
    expect(result.get(0)?.map((c) => c.member)).toEqual(["inModule"]);
  });

  it("preserves each bucket's ORIGINAL relative call order even when calls[] is not sorted by startLine", () => {
    const chunks = [chunk(1, 10, ["A"])];
    // Out-of-line-order input — the walk order that collects calls is not
    // guaranteed to be strictly line-ascending (e.g. default-value
    // expressions vs. body statements).
    const calls = [call(8, "second"), call(3, "first"), call(6, "third")];
    assertSameAssignment(calls, chunks);
    const result = assignCallsToInnermostChunks(calls, chunks);
    // Reference (and therefore expected) order is the ORIGINAL calls[] order,
    // not startLine order.
    expect(result.get(0)?.map((c) => c.member)).toEqual(["second", "first", "third"]);
  });

  it("returns an empty map for no calls or no chunks", () => {
    expect(assignCallsToInnermostChunks([], [chunk(1, 5, [])]).size).toBe(0);
    expect(assignCallsToInnermostChunks([call(1, "x")], []).size).toBe(0);
    expect(assignCallsToInnermostChunks([], []).size).toBe(0);
  });

  it("regression: a synthetic Class#constructor chunk (same range as its class, appended AFTER the class's other children) does not shadow a genuinely-nested method chunk", () => {
    // Reproduces the EXACT shape collectSymbols emits for a class with no
    // explicit constructor (bd tea-rags-mcp-vw1u's syntheticConstructorIfMissing):
    // the synthetic ctor is stamped at the CLASS's own [startLine, endLine] but
    // appended to the array AFTER the class's real children — so array order is
    // [Service(7-24), helper2(9-11), run(12-23), constructor(7-24)], NOT sorted
    // by startLine (constructor's startLine 7 is earlier than helper2's 9 and
    // run's 12, yet it sits last in the array). This caught a real bug in an
    // earlier version of assignCallsToInnermostChunks: a naive sweep that trusts
    // array order for chunkPtr advancement never revisits chunk 3 for early
    // calls, and a sweep that assumes the open-chunk stack's span is monotonic
    // picks the coincident-duplicate-span constructor chunk over the genuinely
    // smaller `run` chunk once both are open together.
    const chunks = [
      chunk(7, 24, []), // Service (class)
      chunk(9, 11, ["Service"]), // Service#helper2
      chunk(12, 23, ["Service"]), // Service#run
      chunk(7, 24, ["Service"]), // Service#constructor (synthetic, SAME range as Service, appended last)
    ];
    const calls = [
      call(8, "newDep"), // class-body field init, before any method — brute force: Service(span17,depth0) vs constructor(span17,depth1) tie -> constructor wins
      call(13, "newWidget"), // inside run — smallest span (11) wins outright over both span-17 candidates
      call(19, "wRender"), // inside run
      call(21, "rGo"), // inside run
    ];
    assertSameAssignment(calls, chunks);
    const result = assignCallsToInnermostChunks(calls, chunks);
    // field-init call attributes to the synthetic constructor chunk (index 3),
    // not the bare class chunk (index 0) — deeper scope breaks the span tie.
    expect(result.get(3)?.map((c) => c.member)).toEqual(["newDep"]);
    expect(result.get(0)).toBeUndefined();
    // calls inside `run` attribute to `run` (index 2), NOT to the
    // coincident-duplicate-span constructor chunk (index 3).
    expect(result.get(2)?.map((c) => c.member)).toEqual(["newWidget", "wRender", "rGo"]);
  });

  describe("property: matches the brute-force reference over generated nested fixtures", () => {
    for (let seed = 1; seed <= 40; seed++) {
      it(`seed ${seed}`, () => {
        const rand = mulberry32(seed * 104729);
        const totalLines = 20 + Math.floor(rand() * 180);
        const maxDepth = 2 + Math.floor(rand() * 4);
        const { chunks, calls } = buildNestedFixture(rand, totalLines, maxDepth);
        assertSameAssignment(calls, chunks);
      });
    }
  });
});
