/**
 * The `naming` review section (bd tea-rags-mcp-89k7k.1.4, F3 slice 1): the
 * `get_naming_lexicon` diff review, verbatim. This section owns NO judgement —
 * it forwards the diff request and spreads the returned `.review`, so field
 * parity with the endpoint holds for free, and the lexicon's own degradation
 * (its notices, its `notJudged*` accounting) is the answer rather than a
 * re-derivation here.
 *
 * DOUBLE READ, accepted for this slice: the orchestration read the diff once
 * (F0) and the lexicon re-reads it itself — `getNamingLexicon` cannot consume
 * a pre-read `DiffScopeRead` yet. The cost is one extra `git diff` per
 * `review_changes` call; removable when the lexicon accepts a scope directly
 * (tracked with the endpoint diff-mode removal, after F4).
 */

import type { ReviewSectionProvider } from "./review-section-provider.js";

export const namingSectionProvider: ReviewSectionProvider = {
  id: "naming",

  isBuilt: (context) =>
    context.lexiconOps === undefined
      ? { built: false, reason: "naming lexicon not wired (codegraph disabled)" }
      : { built: true },

  run: async (context) => {
    const { lexiconOps } = context;
    if (lexiconOps === undefined) return { built: false, reason: "naming lexicon not wired (codegraph disabled)" };
    const result = await lexiconOps.getNamingLexicon({
      ...context.addressing,
      changes: context.diffRequest.base !== undefined ? { base: context.diffRequest.base } : {},
      ...(context.diffRequest.files !== undefined ? { files: [...context.diffRequest.files] } : {}),
    });
    const { review } = result;
    if (review === undefined) return { built: false, reason: "the naming lexicon returned no review" };
    return { ...review };
  },
};
