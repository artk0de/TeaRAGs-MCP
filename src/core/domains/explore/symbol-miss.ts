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
import {
  containerMemberMessage,
  findContainerMembers,
  rankByNamespaceProximity,
  type NamesakeCandidate,
} from "./member-miss.js";
import type { SymbolSearchStrategy } from "./strategies/symbol.js";
import type { ExploreContext } from "./strategies/types.js";
import { swapSeparator, UNKNOWN_SYMBOL_HINT } from "./symbol-batch.js";

const MAX_SUGGESTIONS = 5;
/** How many same-named ids are ranked by namespace proximity before the first MAX_SUGGESTIONS are kept. */
const NAMESAKE_POOL = 50;
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
    const container = await findContainerMembers(address, this.strategyFor, ctx);
    if (container) {
      return {
        reason: "unknownSymbol",
        message: `${address} is not an indexed symbol id; ${containerMemberMessage(container)}.`,
        suggestions: container.memberIds,
      };
    }
    const shortName = /([^#.:]+)$/.exec(address)?.[1];
    const named =
      shortName && shortName !== address ? await this.namesakes(shortName, { ...probeCtx, limit: NAMESAKE_POOL }) : [];
    const suggestions = rankByNamespaceProximity(
      address,
      named.filter((namesake) => namesake.symbolId !== address),
    ).slice(0, MAX_SUGGESTIONS);
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
    return [...new Set((await this.namesakes(symbol, ctx)).map((namesake) => namesake.symbolId))];
  }

  /** The ids the strategy answers `symbol` with, each with its file; a failing probe yields none. */
  private async namesakes(symbol: string, ctx: ExploreContext): Promise<NamesakeCandidate[]> {
    try {
      const rows = await this.strategyFor(symbol).execute(ctx);
      return rows.flatMap((row) => {
        const symbolId = row.payload?.symbolId;
        const relativePath = row.payload?.relativePath;
        return typeof symbolId === "string"
          ? [{ symbolId, ...(typeof relativePath === "string" ? { relativePath } : {}) }]
          : [];
      });
    } catch {
      return [];
    }
  }
}
