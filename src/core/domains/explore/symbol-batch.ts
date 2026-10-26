/**
 * SymbolBatchDrill — several find_symbol addresses in one call (agent turn
 * economy N1).
 *
 * Each address resolves through its own SymbolSearchStrategy — the exact path
 * a single `symbol:` takes: text-match scroll, working-tree substitution,
 * `#partN` merge, codegraph fallback. Every strategy runs on the SAME context,
 * so they share one working-tree view: the floors they claim accumulate on one
 * marker, which the caller finalizes once for the whole answer. The drill adds
 * only what a batch needs on top: the request per row, the `#`↔`.` retry
 * reported as `resolvedAs`, an ambiguity cap, and the misses.
 */

import type { SymbolBatchMiss } from "../../contracts/types/symbol-batch.js";
import { Semaphore } from "../../primitives/concurrency/index.js";
import type { SymbolSearchStrategy } from "./strategies/symbol.js";
import type { ExploreContext, ExploreResult } from "./strategies/types.js";
import { relativePathOf } from "./working-tree/index.js";

/** The next step an unknown address calls for — shared by a batch miss and a single-symbol `empty`. */
export const UNKNOWN_SYMBOL_HINT = "retry a partial address (Class or bare name), or hybrid_search";

/** Matches one address may answer with; more is a miss asking to qualify it. */
const MAX_MATCHES_PER_ADDRESS = 5;

/** Addresses resolved at once — each one runs two Qdrant scrolls. */
const ADDRESS_CONCURRENCY = 4;

export interface SymbolBatchRow {
  /** The address as the caller wrote it. */
  request: string;
  /** The id that answered, when it differs from `request` only by the `#`/`.` separator. */
  resolvedAs?: string;
  result: ExploreResult;
}

export interface SymbolBatchAnswer {
  rows: SymbolBatchRow[];
  missing: SymbolBatchMiss[];
  /** The first codegraph skip notice any address's strategy recorded. */
  codegraphWarning?: string;
}

export class SymbolBatchDrill {
  constructor(private readonly strategyFor: (symbol: string) => SymbolSearchStrategy) {}

  async execute(addresses: readonly string[], ctx: ExploreContext): Promise<SymbolBatchAnswer> {
    const slots = new Semaphore(ADDRESS_CONCURRENCY);
    const answers = await Promise.all(
      addresses.map(async (address) => {
        const release = await slots.acquire();
        try {
          return await this.resolve(address, ctx);
        } finally {
          release();
        }
      }),
    );
    return {
      rows: answers.flatMap((a) => a.rows),
      missing: answers.flatMap((a) => (a.miss ? [a.miss] : [])),
      ...firstWarning(answers),
    };
  }

  private async resolve(address: string, ctx: ExploreContext): Promise<AddressAnswer> {
    const first = await this.run(address, ctx);
    const swapped = first.results.length === 0 ? swapSeparator(address) : undefined;
    const answer = swapped === undefined ? first : await this.run(swapped, ctx);
    const warning = first.warning ?? answer.warning;
    const { results } = answer;
    if (results.length > MAX_MATCHES_PER_ADDRESS) {
      return {
        rows: [],
        miss: {
          request: address,
          message: `ambiguous: ${results.length} matches — qualify with Class# or pathPattern`,
        },
        warning,
      };
    }
    if (results.length === 0) return { rows: [], miss: await this.missOf(address, ctx), warning };
    return {
      rows: results.map((result) => {
        const resolvedAs = resolvedAsOf(address, result);
        return { request: address, ...(resolvedAs ? { resolvedAs } : {}), result };
      }),
      warning,
    };
  }

  private async run(symbol: string, ctx: ExploreContext): Promise<{ results: ExploreResult[]; warning?: string }> {
    const strategy = this.strategyFor(symbol);
    const results = await strategy.execute(ctx);
    return { results, warning: strategy.codegraphWarning };
  }

  /**
   * Why nothing answered `address`. When the tree deleted files, the index is
   * asked without the overlay — never to answer, only to say whether the
   * address lived in a file the tree deleted.
   */
  private async missOf(address: string, ctx: ExploreContext): Promise<SymbolBatchMiss> {
    const deleted = ctx.workingTreeView?.deletedPaths;
    if (deleted && deleted.size > 0) {
      const { workingTreeView: _view, ...indexCtx } = ctx;
      const indexed = await this.strategyFor(address).execute({ ...indexCtx, metaOnly: true });
      if (indexed.some((row) => deleted.has(relativePathOf(row.payload)))) {
        return { request: address, message: "deleted in the working tree", treeState: "deleted" };
      }
    }
    return {
      request: address,
      message: `unknown symbol — ${UNKNOWN_SYMBOL_HINT}`,
    };
  }
}

interface AddressAnswer {
  rows: SymbolBatchRow[];
  miss?: SymbolBatchMiss;
  warning?: string;
}

function firstWarning(answers: readonly AddressAnswer[]): { codegraphWarning?: string } {
  const warning = answers.find((a) => a.warning !== undefined)?.warning;
  return warning === undefined ? {} : { codegraphWarning: warning };
}

/** `Foo.bar` ↔ `Foo#bar` on the last separator; undefined for a bare name or a `::` tail. */
export function swapSeparator(address: string): string | undefined {
  const match = /^(.+)([#.])([^#.:]+)$/.exec(address);
  if (!match) return undefined;
  const [, owner, separator, member] = match;
  return `${owner}${separator === "#" ? "." : "#"}${member}`;
}

/** The answering id when it is `address` under the other `#`/`.` separator. */
function resolvedAsOf(address: string, result: ExploreResult): string | undefined {
  const symbolId = result.payload?.symbolId;
  if (typeof symbolId !== "string" || symbolId === address) return undefined;
  const separatorBlind = (id: string): string => id.replace(/[#.]/g, "#");
  return separatorBlind(symbolId) === separatorBlind(address) ? symbolId : undefined;
}
