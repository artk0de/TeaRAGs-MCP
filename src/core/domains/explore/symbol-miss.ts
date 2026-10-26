/**
 * SymbolMissExplainer — why a single find_symbol `symbol` answered nothing
 * (agent turn economy N6). An empty `results` read as "tea-rags does not know
 * this" sends the agent to the shell, so the miss carries `unknownSymbol` and,
 * when the address was only written wrong, the id that does exist:
 *
 * 1. the other `#`/`.` separator, 2. the parent of a `#partN` window id,
 * 3. ids defined under the address's short name.
 *
 * Probes go through the same SymbolSearchStrategy the request used, so they see
 * the same index and working tree. Runs only after the direct lookup came back
 * empty. A failing probe never fails the answer — the suggestion it would have
 * supplied is left out. The batch drill keeps its own `missing[]`.
 */

import type { EmptyAnswerExplanation } from "../../contracts/types/empty-answer.js";
import type { SymbolSearchStrategy } from "./strategies/symbol.js";
import type { ExploreContext } from "./strategies/types.js";
import { swapSeparator, UNKNOWN_SYMBOL_HINT } from "./symbol-batch.js";

const MAX_SUGGESTIONS = 5;
const PART_SUFFIX = /^(.+)#part\d+$/;

export class SymbolMissExplainer {
  constructor(private readonly strategyFor: (symbol: string) => SymbolSearchStrategy) {}

  async explain(address: string, ctx: ExploreContext): Promise<EmptyAnswerExplanation> {
    const probeCtx: ExploreContext = { ...ctx, metaOnly: true, limit: MAX_SUGGESTIONS, offset: 0 };
    const exact = [swapSeparator(address), PART_SUFFIX.exec(address)?.[1]].filter(
      (candidate): candidate is string => candidate !== undefined,
    );
    for (const candidate of exact) {
      const ids = await this.symbolIds(candidate, probeCtx);
      if (ids.includes(candidate)) {
        return {
          reason: "unknownSymbol",
          message: `${address} is not an indexed symbol id; ${candidate} is — retry with it.`,
          suggestions: [candidate],
        };
      }
    }
    const shortName = /([^#.:]+)$/.exec(address)?.[1];
    const named = shortName && shortName !== address ? await this.symbolIds(shortName, probeCtx) : [];
    const suggestions = named.filter((id) => id !== address).slice(0, MAX_SUGGESTIONS);
    return {
      reason: "unknownSymbol",
      message:
        suggestions.length > 0
          ? `${address} is not an indexed symbol id; suggestions = ids defined under "${shortName}".`
          : `${address} is not an indexed symbol id — ${UNKNOWN_SYMBOL_HINT}.`,
      ...(suggestions.length > 0 ? { suggestions } : {}),
    };
  }

  /** Distinct symbolIds the strategy answers `symbol` with; a failing probe yields none. */
  private async symbolIds(symbol: string, ctx: ExploreContext): Promise<string[]> {
    try {
      const rows = await this.strategyFor(symbol).execute(ctx);
      const ids = rows.map((r) => r.payload?.symbolId).filter((id): id is string => typeof id === "string");
      return [...new Set(ids)];
    } catch {
      return [];
    }
  }
}
