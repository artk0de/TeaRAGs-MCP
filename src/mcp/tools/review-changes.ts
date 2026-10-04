/**
 * `review_changes` MCP tool (bd tea-rags-mcp-89k7k.1.4, F3): every diff-scoped
 * report over ONE working-tree change, in one call. Registered under the
 * codegraph family's provider gate (the review's graph sections need the
 * codegraph; the naming section ships with the same wiring).
 *
 * Schema contract: the `sections` enum is DERIVED from the live
 * section-provider registry, read through the App (`app.reviewSectionIds()`,
 * Uniform Access — bd tea-rags-mcp-89k7k.9, moved off the public barrel by
 * tea-rags-mcp-89k7k.22) — an id
 * with no provider is rejected at the boundary, so an agent asking for a
 * section never has to guess whether it ran. No try/catch in the handler: the
 * error middleware owns failures.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ReviewChangesRequest, ReviewSectionId } from "../../core/api/public/dto/index.js";
import { CODEGRAPH_SYMBOLS_PROVIDER_KEY, type App } from "../../core/api/public/index.js";
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
  "the boundary detectors (stableDependencies, leakingAbstraction, cycles, mainSequence delta, silentCoupling, " +
  "facadeContract); findings cap 100, family-aware — every family keeps >=1 slot; per-family truncated rides each " +
  "detector row, findingCount stays the family's FULL total, rows reconcile findingCount = listed + truncated. " +
  "Detector rows also carry exclusions: mainSequence excludedLowConnectionCount (small-N components below the " +
  "connection floor), silentCoupling excluded block (the production taxonomy's counters) — a zero over excluded " +
  "classes is not a clean pass; foundationTerminal:true on a D-delta finding = every contributing edge ends at " +
  "contracts/ (triage data, never suppression). scopeSkippedFiles rides section envelopes (incompleteChange, " +
  "cohesion) and architecture detector rows = files the 200-cap skipped while judged; present = verdict PARTIAL — " +
  "a zero findingCount over them is never a clean pass. " +
  "Envelope: workTree, base, mergeBase, changedFiles, skipped+truncated, indexLag, notices (an empty diff names the " +
  "trees and bases it did not look at).";

const reviewChangesInputShape = (sectionIds: readonly [ReviewSectionId, ...ReviewSectionId[]]) => ({
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
    .array(z.enum(sectionIds))
    .min(1)
    .optional()
    .describe("Section allowlist, default all registered. Unknown id = error; not requested = omitted."),
});

export function registerReviewChangesTool(server: McpServer, deps: { app: App; register: RegisterToolFn }): void {
  // Provider gating — same family as registerCodegraphTools: without the
  // codegraph provider there is no review substrate, and the tool must not
  // appear in `tools/list`.
  if (!deps.app.hasProvider(CODEGRAPH_SYMBOLS_PROVIDER_KEY)) return;

  // Compiled once per registration — a ZodObject like `get_naming_lexicon`'s,
  // so the boundary parses the whole shape. The sections enum reads the live
  // provider registry through the App, so it can only name ids that run.
  const ReviewChangesInputSchema = z.object(reviewChangesInputShape(deps.app.reviewSectionIds()));

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
