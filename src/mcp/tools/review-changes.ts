/**
 * `review_changes` MCP tool (bd tea-rags-mcp-89k7k.1.4, F3): every diff-scoped
 * report over ONE working-tree change, in one call. Registered under the
 * codegraph family's provider gate (the review's graph sections need the
 * codegraph; the naming section ships with the same wiring).
 *
 * Schema contract: the `sections` enum is DERIVED from the live
 * section-provider registry (`reviewSectionIds` via the public barrel) — an id
 * with no provider is rejected at the boundary, so an agent asking for a
 * section never has to guess whether it ran. No try/catch in the handler: the
 * error middleware owns failures.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ReviewChangesRequest } from "../../core/api/public/dto/index.js";
import { CODEGRAPH_SYMBOLS_PROVIDER_KEY, reviewSectionIds, type App } from "../../core/api/public/index.js";
import { formatMcpText, type McpToolResult } from "../format.js";
import type { RegisterToolFn } from "../middleware/error-handler.js";
import { collectionPathFields } from "./codegraph.js";

const REVIEW_CHANGES_DESCRIPTION =
  "Review one working-tree change: every diff-scoped report in one call, sections keyed by id. " +
  "Reads the change once — files under cap 200, untracked included; changes.base (default HEAD) resolved to its " +
  "merge-base with HEAD = what THIS branch changed; path beside project = linked worktree of the same repo. " +
  "sections = ALLOWLIST, default all registered; unknown id = error; a section NOT requested is OMITTED from the " +
  "map, a requested one whose substrate is missing answers built:false+reason — absence is not not-built. " +
  "naming: declarations the change adds, judged against project vocabulary (the naming-lexicon review, verbatim). " +
  "incompleteChange: co-change partners of the diff's files the diff does NOT touch (support, confidence, " +
  "lastCoChangeAt; cap 50). cohesion: per changed file, symbol co-change clusters + split candidates; a file with " +
  "no data = notJudged noCohesionData, never zero (cap 50 reports). architecture: the diff's added edges judged by " +
  "the boundary detectors (stableDependencies, leakingAbstraction, cycles, mainSequence delta, silentCoupling; " +
  "findings cap 100, per-detector statuses). " +
  "Envelope: workTree, base, mergeBase, changedFiles, skipped+truncated, indexLag, notices (an empty diff names the " +
  "trees and bases it did not look at).";

const ReviewChangesInputShape = {
  ...collectionPathFields(),
  changes: z
    .object({ base: z.string().optional().describe("Base ref; default HEAD. Resolved to its merge-base with HEAD.") })
    .optional()
    .describe("Review the working tree's change against this base."),
  files: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe("Review these files only; a listed file with no diff is reviewed whole."),
  sections: z
    .array(z.enum(reviewSectionIds))
    .min(1)
    .optional()
    .describe("Section allowlist, default all registered. Unknown id = error; not requested = omitted."),
};

/** Compiled once — a ZodObject like `get_naming_lexicon`'s, so the boundary parses the whole shape. */
const ReviewChangesInputSchema = z.object(ReviewChangesInputShape);

export function registerReviewChangesTool(server: McpServer, deps: { app: App; register: RegisterToolFn }): void {
  // Provider gating — same family as registerCodegraphTools: without the
  // codegraph provider there is no review substrate, and the tool must not
  // appear in `tools/list`.
  if (!deps.app.hasProvider(CODEGRAPH_SYMBOLS_PROVIDER_KEY)) return;

  deps.register(
    server,
    "review_changes",
    {
      title: "Review Changes",
      description: REVIEW_CHANGES_DESCRIPTION,
      inputSchema: ReviewChangesInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (request: unknown): Promise<McpToolResult> =>
      formatMcpText(JSON.stringify(await deps.app.reviewChanges(request as ReviewChangesRequest), null, 2)),
  );
}
