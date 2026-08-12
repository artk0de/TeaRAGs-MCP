import type { CallRef } from "../../../contracts/types/codegraph.js";

/** The subset of a chunk's shape this pass needs — same shape every walker's `ExtractInput.chunks` carries. */
export interface ChunkRange {
  startLine: number;
  endLine: number;
  scope: string[];
}

/**
 * Assign each call to exactly ONE chunk — the smallest containing line
 * range. Tie-breaker: deeper scope (longer `scope[]`) wins, so a method-
 * level chunk beats its enclosing class/module when both happen to span
 * the same number of lines.
 *
 * Returns a Map keyed by chunk index -> CallRef[], preserving each bucket's
 * calls in their ORIGINAL relative order from `calls[]` (not sorted). Chunks
 * with no calls have no entry (caller defaults to `[]`). Calls whose
 * startLine falls outside every chunk are dropped silently — matches the
 * pre-refactor behaviour of the three walker-local copies this replaces
 * (tea-rags-mcp-d77bl follow-on: TS `walker.ts`, JS `walker.ts`, Ruby
 * `chunk-extractions.ts` carried the SAME 26-line body, each doing a full
 * O(chunks) linear scan per call — O(calls x chunks) per file).
 *
 * ## Why this is NOT a naive "assume chunks[] is sorted" sweep
 *
 * `chunks` is the `symbolRanges` produced by `collectSymbols`
 * (kernel/collect-symbols.ts). Its walk is pre-order for the common case — a
 * node's own range is pushed before its children — so `chunks[]` is USUALLY
 * both sorted by `startLine` and a proper containment forest (a stack-based
 * single sweep would have sufficed). But `collectSymbols` also has a
 * `syntheticConstructorIfMissing` path: after walking a class's children in
 * full, it appends a synthetic `Class#constructor` entry stamped at the
 * CLASS's own `[startLine, endLine]` — an entry whose `startLine` can be
 * EARLIER than several already-emitted children, landing it LATER in array
 * order than its own startLine would sort to (verified empirically: a class
 * with no explicit constructor and 2+ methods reproduces this — see
 * `tests/core/domains/language/kernel/assign-calls-to-chunks.test.ts`,
 * "synthetic-constructor out-of-order regression"). Two things follow:
 *
 *   1. `chunks[]` array order is NOT reliably `startLine`-sorted — this
 *      function sorts a small INDEX array up front (stable, so genuine
 *      same-startLine ties keep their original relative order) rather than
 *      trusting caller order, exactly as it already must for `calls[]`
 *      (whose collection order is not line-ascending either).
 *   2. The synthetic constructor's range is a byte-identical DUPLICATE of
 *      its class's own range (not a smaller nested sub-range), so at any
 *      line inside that class two chunks with EQUAL span but different scope
 *      depth are simultaneously "open" — the brute-force reference breaks
 *      that as a same-span tie (deeper scope wins), so this function must
 *      too. A monotonic-non-increasing-span assumption over the open-chunk
 *      stack (which would let the tie-break scan stop at the first larger
 *      span) is NOT safe against this — the best-pick step below scans the
 *      full stack every time instead of assuming the top is already
 *      smallest.
 *
 * With those two fixes the algorithm is still O(N log N + C log C + sum of
 * per-call stack scans): the stack only ever holds chunks whose range
 * currently contains the sweep position, bounded by real nesting depth (plus
 * a small constant for coincident synthetic duplicates) — not by the file's
 * total chunk count `C`, which is what made the brute-force version
 * quadratic on large files.
 *
 * `calls[]` is NOT guaranteed sorted either (the walk order that collects
 * call sites is not always strictly line-ascending — e.g. default-parameter
 * expressions vs. body statements), so this sorts a small index array first
 * and resolves assignment in that order, then re-emits into the output
 * buckets in the ORIGINAL `calls[]` order — preserving the exact behaviour
 * of the brute-force version, which iterated `calls[]` once and pushed to
 * buckets in encounter order.
 */
export function assignCallsToInnermostChunks(calls: CallRef[], chunks: ChunkRange[]): Map<number, CallRef[]> {
  const out = new Map<number, CallRef[]>();
  const n = calls.length;
  const c = chunks.length;
  if (n === 0 || c === 0) return out;

  const callOrder = Array.from({ length: n }, (_, i) => i);
  callOrder.sort((a, b) => calls[a].startLine - calls[b].startLine);

  const chunkOrder = Array.from({ length: c }, (_, i) => i);
  chunkOrder.sort((a, b) => chunks[a].startLine - chunks[b].startLine);

  const bestIdxForCall = new Array<number>(n).fill(-1);
  const stack: number[] = []; // original chunk indices, push order (outer-ish -> inner-ish)
  let chunkPtr = 0;

  for (const callIdx of callOrder) {
    const line = calls[callIdx].startLine;
    // Prune chunks the sweep has fully moved past. Safe to pop only from the
    // top: pushing in startLine order keeps span non-increasing bottom -> top
    // for every case except the coincident-duplicate one above, and that case
    // keeps span EQUAL (never larger), so this still holds. The best-pick
    // scan below double-checks `endLine >= line` regardless, so an imperfect
    // pop here would cost a wasted scan slot, never a wrong answer.
    while (stack.length > 0 && chunks[stack[stack.length - 1]].endLine < line) {
      stack.pop();
    }
    while (chunkPtr < c && chunks[chunkOrder[chunkPtr]].startLine <= line) {
      const idx = chunkOrder[chunkPtr];
      if (chunks[idx].endLine >= line) stack.push(idx);
      chunkPtr++;
    }
    // Full scan, no early exit: do NOT assume the stack's span is
    // monotonic — the synthetic-constructor case above can put a
    // same-span-but-shallower entry above a smaller genuinely-nested one.
    let bestIdx = -1;
    let bestSpan = Number.POSITIVE_INFINITY;
    let bestDepth = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      const chunk = chunks[stack[i]];
      if (chunk.endLine < line) continue; // stale entry not yet popped — ignore, don't select
      const span = chunk.endLine - chunk.startLine;
      const depth = chunk.scope.length;
      if (span < bestSpan || (span === bestSpan && depth > bestDepth)) {
        bestIdx = stack[i];
        bestSpan = span;
        bestDepth = depth;
      }
    }
    bestIdxForCall[callIdx] = bestIdx;
  }

  for (let i = 0; i < n; i++) {
    const bestIdx = bestIdxForCall[i];
    if (bestIdx === -1) continue;
    const bucket = out.get(bestIdx);
    if (bucket) bucket.push(calls[i]);
    else out.set(bestIdx, [calls[i]]);
  }
  return out;
}
