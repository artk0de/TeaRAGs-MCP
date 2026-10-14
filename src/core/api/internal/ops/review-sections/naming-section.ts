/**
 * The `naming` review section (bd tea-rags-mcp-89k7k.1.4, F3 slice 1): the
 * `get_naming_lexicon` diff review, verbatim. This section owns NO judgement —
 * it forwards the diff request and spreads the returned `.review`, so field
 * parity with the endpoint holds for free, and the lexicon's own degradation
 * (its notices, its `notJudged*` accounting) is the answer rather than a
 * re-derivation here.
 *
 * The change is read once per review (bd tea-rags-mcp-wijz7): the section
 * hands the orchestration's read (`scope`) to the lexicon, which judges it
 * instead of reading the same diff again.
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
    const result = await lexiconOps.getNamingLexicon(
      {
        ...context.addressing,
        changes: context.diffRequest.base !== undefined ? { base: context.diffRequest.base } : {},
        ...(context.diffRequest.files !== undefined ? { files: [...context.diffRequest.files] } : {}),
      },
      { diff: context.scope },
    );
    const { review } = result;
    if (review === undefined) return { built: false, reason: "the naming lexicon returned no review" };
    return { ...review };
  },
};
