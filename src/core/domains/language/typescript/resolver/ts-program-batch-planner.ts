/**
 * Packs the TypeScript resolver's roots into closure batches — the unit a
 * `ts.Program` is built over once the whole-project Program no longer fits
 * (bd tea-rags-mcp-vtuu4).
 *
 * The whole Program on taxdome held 24,772 files and 117.6 MB of source text,
 * and an OOM heap profile put it at ~5.4 GB. The spike behind this module
 * measured what that heap is made of: AST + binder state scale with source
 * TEXT (≈ 28–31 MB of heap per MB), the checker with the CALL SITES it is
 * asked about (≈ 17–34 KB each on top of ≈ 110 MB fixed). File count is a
 * proxy for neither. So a batch is bounded on exactly those two axes:
 *
 * - the text of the union of its roots' forward closures, prelude included,
 *   stays under {@link TSProgramBatchPlannerOptions.textBudgetBytes};
 * - the call sites of the roots it resolves stay under
 *   {@link TSProgramBatchPlannerOptions.callSiteCap}.
 *
 * Every root is resolved by a Program that holds its FULL forward closure —
 * the union is closed under import, so nothing a root reaches is ever cut.
 * That is what keeps resolution identical to the whole Program except where a
 * file's types depend on a declaration its closure does not reach: a GLOBAL.
 * The prelude (see `ts-program-import-graph.ts`) carries those into every
 * batch.
 *
 * Roots are packed in DFS postorder from the entry roots (in-degree zero,
 * largest closure first), with a lookahead window over the pending order. The
 * spike measured 5–30% less cold parse than directory order: consecutive
 * batches share most of their closures, and a shared parse cache turns that
 * overlap into hits (80–95% on taxdome).
 *
 * A root whose own closure (plus the prelude) exceeds the text budget is
 * OVERSIZE: it is not packed, and the caller resolves it alone, last, over its
 * full closure (4 roots / 151 calls on taxdome at the 40 MB default).
 *
 * Pure: a graph in, a plan out, no I/O. `ts-program-import-graph.ts` builds the
 * graph.
 */

import type { TSProgramImportGraph } from "./ts-program-import-graph.js";

/**
 * Default text budget of one batch, prelude included: 40 MiB.
 *
 * Sized on the spike's sequential run over taxdome — 33 Programs, max live heap
 * 1,881 MB, retained between batches ≤ 1,445 MB, 418,216 of 418,367 call sites
 * covered by batches. 20 MiB (the rejected 1 GB target) built 149 Programs,
 * 3.7x the cold parse, and turned 857 roots holding 19% of the calls oversize.
 */
export const TS_PROGRAM_BATCH_TEXT_BYTES_DEFAULT = 40 * 1024 * 1024;
/** Default call-site cap of one batch: 15,000 — the checker term's bound, see the module docblock. */
export const TS_PROGRAM_BATCH_CALL_SITES_DEFAULT = 15_000;
/**
 * How many consecutive pending roots the packer tries after the last one that
 * fitted before it closes a batch. The spike's value: past ~200 misses the
 * remaining roots of the current neighbourhood no longer fit and scanning
 * further only costs time.
 */
const LOOKAHEAD_MISSES = 200;

export interface TSProgramBatchPlannerOptions {
  /** Source text one batch's Program may hold, prelude included. */
  readonly textBudgetBytes: number;
  /** Call sites one batch may resolve. */
  readonly callSiteCap: number;
}

/** One root the plan must resolve, with the call sites pass-1 counted in it. */
export interface TSProgramBatchRoot {
  /** Compiler path (forward slashes), as the graph names it. */
  readonly fileName: string;
  readonly callSites: number;
}

/** The files every batch Program is built with, whatever roots it packs. */
export interface TSProgramBatchPrelude {
  /** The seeds — what a Program is handed as root names. */
  readonly rootNames: readonly string[];
  /** The seeds' forward closure: the parses pinned for the whole run. */
  readonly files: readonly string[];
  readonly textBytes: number;
}

export interface TSProgramBatch {
  /** Roots the packer chose; the Program is built over prelude + these. */
  readonly rootNames: readonly string[];
  /** Roots whose call sites this batch resolves — every root in its closure union not resolved earlier. */
  readonly resolves: readonly string[];
  /** Source text of the closure union, prelude included. */
  readonly textBytes: number;
  /** Call sites of {@link resolves}. */
  readonly callSites: number;
}

/** A root resolved alone, last, over its full closure. */
export interface TSProgramOversizeRoot {
  readonly rootName: string;
  /** Text of the root's own closure plus the prelude — what its Program will hold. */
  readonly textBytes: number;
  readonly callSites: number;
}

export interface TSProgramBatchPlan {
  readonly prelude: TSProgramBatchPrelude;
  readonly batches: readonly TSProgramBatch[];
  readonly oversize: readonly TSProgramOversizeRoot[];
}

export class TSProgramBatchPlanner {
  constructor(private readonly options: TSProgramBatchPlannerOptions) {}

  plan(graph: TSProgramImportGraph, roots: readonly TSProgramBatchRoot[]): TSProgramBatchPlan {
    return new BatchPacking(graph, roots, this.options).run();
  }
}

/** One planning run's working state — scratch arrays sized to the graph. */
class BatchPacking {
  private readonly nodeCount: number;
  private readonly textOf: Float64Array;
  private readonly callsOf: Float64Array;
  private readonly isRoot: Uint8Array;
  private readonly covered: Uint8Array;
  /** Generation-stamped membership of the batch being packed. */
  private readonly inBatch: Uint32Array;
  private batchGeneration = 0;
  /** Generation-stamped visit marks for the closure walks. */
  private readonly visited: Uint32Array;
  private visitGeneration = 0;

  constructor(
    private readonly graph: TSProgramImportGraph,
    private readonly roots: readonly TSProgramBatchRoot[],
    private readonly options: TSProgramBatchPlannerOptions,
  ) {
    this.nodeCount = graph.nodes.length;
    this.textOf = Float64Array.from(graph.nodes, (node) => node.textBytes);
    this.callsOf = new Float64Array(this.nodeCount);
    this.isRoot = new Uint8Array(this.nodeCount);
    this.covered = new Uint8Array(this.nodeCount);
    this.inBatch = new Uint32Array(this.nodeCount);
    this.visited = new Uint32Array(this.nodeCount);
  }

  run(): TSProgramBatchPlan {
    const indexOf = new Map(this.graph.nodes.map((node, index) => [node.fileName, index]));
    for (const root of this.roots) {
      const index = indexOf.get(root.fileName);
      if (index === undefined) continue;
      this.isRoot[index] = 1;
      this.callsOf[index] += root.callSites;
    }

    const preludeSeeds = this.graph.preludeSeeds.filter((seed) => seed >= 0 && seed < this.nodeCount);
    const preludeNodes = this.closureOf(preludeSeeds);
    const preludeText = sumOf(preludeNodes, this.textOf);
    const prelude: TSProgramBatchPrelude = {
      rootNames: preludeSeeds.map((seed) => this.graph.nodes[seed].fileName),
      files: preludeNodes.map((node) => this.graph.nodes[node].fileName),
      textBytes: preludeText,
    };

    const closureText = new Float64Array(this.nodeCount);
    for (let node = 0; node < this.nodeCount; node++) {
      if (this.isRoot[node]) closureText[node] = sumOf(this.closureOf([node]), this.textOf);
    }
    const order = this.postorder(closureText);

    const batches: TSProgramBatch[] = [];
    const oversize: TSProgramOversizeRoot[] = [];
    let position = 0;
    for (;;) {
      while (position < order.length && this.covered[order[position]]) position++;
      if (position >= order.length) break;
      const batch = this.packFrom(order, position, preludeNodes, preludeText, closureText, oversize);
      if (batch !== null) batches.push(batch);
    }
    return { prelude, batches, oversize };
  }

  /**
   * One batch opened at `order[position]`, or `null` when that root turned out
   * oversize (recorded in `oversize` and covered, so the caller moves on).
   */
  private packFrom(
    order: readonly number[],
    position: number,
    preludeNodes: readonly number[],
    preludeText: number,
    closureText: Float64Array,
    oversize: TSProgramOversizeRoot[],
  ): TSProgramBatch | null {
    const { textBudgetBytes, callSiteCap } = this.options;
    this.batchGeneration += 1;
    const generation = this.batchGeneration;
    const members: number[] = [];
    let text = 0;
    let calls = 0;
    const admit = (nodes: readonly number[]): void => {
      for (const node of nodes) {
        if (this.inBatch[node] === generation) continue;
        this.inBatch[node] = generation;
        members.push(node);
        text += this.textOf[node];
        if (this.isRoot[node] && !this.covered[node]) calls += this.callsOf[node];
      }
    };
    admit(preludeNodes);

    const chosen: number[] = [];
    let misses = 0;
    for (let k = position; k < order.length && misses < LOOKAHEAD_MISSES; k++) {
      const root = order[k];
      if (this.covered[root] || this.inBatch[root] === generation) continue;
      const marginal = this.marginalOf(root, textBudgetBytes - text);
      if (marginal.fits && calls + marginal.calls <= callSiteCap) {
        admit(marginal.nodes);
        chosen.push(root);
        misses = 0;
        continue;
      }
      if (chosen.length === 0 && k === position) {
        if (preludeText + closureText[root] > textBudgetBytes) {
          this.covered[root] = 1;
          oversize.push({
            rootName: this.graph.nodes[root].fileName,
            textBytes: preludeText + closureText[root],
            callSites: this.callsOf[root],
          });
          return null;
        }
        // It fits the text budget on its own but not the call cap: a batch of
        // its own is the only place it can go, and skipping it would leave the
        // packer re-opening the same position forever.
        if (marginal.fits) {
          admit(marginal.nodes);
          chosen.push(root);
          break;
        }
      }
      misses += 1;
    }

    const resolves: string[] = [];
    let resolvedCalls = 0;
    for (const node of members) {
      if (!this.isRoot[node] || this.covered[node]) continue;
      this.covered[node] = 1;
      resolves.push(this.graph.nodes[node].fileName);
      resolvedCalls += this.callsOf[node];
    }
    return {
      rootNames: chosen.map((root) => this.graph.nodes[root].fileName),
      resolves,
      textBytes: text,
      callSites: resolvedCalls,
    };
  }

  /**
   * What adding `root` would add to the current batch: the part of its closure
   * not already in it, its text and the uncovered call sites in it.
   *
   * The walk prunes at batch members because the batch is closed under import
   * — a member's whole closure is already in — so it touches only the new part
   * of the graph. It stops early once the new text alone exceeds `room`.
   */
  private marginalOf(root: number, room: number): { fits: boolean; nodes: number[]; calls: number } {
    const generation = this.batchGeneration;
    this.visitGeneration += 1;
    const mark = this.visitGeneration;
    const nodes: number[] = [];
    let text = 0;
    let calls = 0;
    const stack = [root];
    this.visited[root] = mark;
    while (stack.length > 0) {
      const node = stack.pop() as number;
      if (this.inBatch[node] === generation) continue;
      nodes.push(node);
      text += this.textOf[node];
      if (this.isRoot[node] && !this.covered[node]) calls += this.callsOf[node];
      if (text > room) return { fits: false, nodes, calls };
      for (const next of this.graph.nodes[node].imports) {
        if (this.visited[next] === mark) continue;
        this.visited[next] = mark;
        stack.push(next);
      }
    }
    return { fits: true, nodes, calls };
  }

  /** Forward closure of `seeds`, seeds first, in discovery order. */
  private closureOf(seeds: readonly number[]): number[] {
    this.visitGeneration += 1;
    const mark = this.visitGeneration;
    const out: number[] = [];
    const stack: number[] = [];
    for (const seed of seeds) {
      if (this.visited[seed] === mark) continue;
      this.visited[seed] = mark;
      out.push(seed);
      stack.push(seed);
    }
    while (stack.length > 0) {
      const node = stack.pop() as number;
      for (const next of this.graph.nodes[node].imports) {
        if (this.visited[next] === mark) continue;
        this.visited[next] = mark;
        out.push(next);
        stack.push(next);
      }
    }
    return out;
  }

  /**
   * Roots in DFS postorder over the import graph, started from the entry roots
   * (in-degree zero) before the rest, largest closure first, then by name so
   * the plan is deterministic.
   */
  private postorder(closureText: Float64Array): number[] {
    const inDegree = new Uint32Array(this.nodeCount);
    for (const node of this.graph.nodes) for (const next of node.imports) inDegree[next] += 1;
    const starts: number[] = [];
    for (let node = 0; node < this.nodeCount; node++) if (this.isRoot[node]) starts.push(node);
    starts.sort(
      (a, b) =>
        (inDegree[a] === 0 ? 0 : 1) - (inDegree[b] === 0 ? 0 : 1) ||
        closureText[b] - closureText[a] ||
        compareStrings(this.graph.nodes[a].fileName, this.graph.nodes[b].fileName),
    );

    const seen = new Uint8Array(this.nodeCount);
    const order: number[] = [];
    for (const start of starts) {
      if (seen[start]) continue;
      seen[start] = 1;
      const stack: [number, number][] = [[start, 0]];
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        const { imports } = this.graph.nodes[top[0]];
        if (top[1] < imports.length) {
          const next = imports[top[1]];
          top[1] += 1;
          if (!seen[next]) {
            seen[next] = 1;
            stack.push([next, 0]);
          }
          continue;
        }
        stack.pop();
        if (this.isRoot[top[0]]) order.push(top[0]);
      }
    }
    return order;
  }
}

function sumOf(nodes: readonly number[], weights: Float64Array): number {
  let total = 0;
  for (const node of nodes) total += weights[node];
  return total;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
