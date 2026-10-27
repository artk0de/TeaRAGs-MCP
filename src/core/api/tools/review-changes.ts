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

import {
  CODEGRAPH_SYMBOLS_PROVIDER_KEY,
  type App,
  type ReviewChangesRequest,
  type ReviewSectionId,
} from "../public/index.js";
import { collectionPathFields } from "./codegraph.js";
import { formatMcpResponse, type McpToolResult, type WorkingTreeCallAddress } from "./format.js";
import type { RegisterToolFn } from "./middleware/error-handler.js";

/**
 * Call contract only; how to read each section (gates, caps, change block,
 * flags, norms verdicts) lives in tea-rags://guide/review (bd tea-rags-mcp-0y5oj).
 */
const REVIEW_CHANGES_DESCRIPTION =
  "Review one working-tree change: every diff-scoped report in one call, sections keyed by id. " +
  "naming = verdicts on every declaration the change adds — the complete list; never hand-list a diff's " +
  "names into get_naming_lexicon. Reads every changed file, untracked included; changes.base (default HEAD) " +
  "→ its merge-base with HEAD = what THIS branch changed; path beside project = linked worktree. " +
  "sections = allowlist, default all; unknown id = error; not requested = omitted; substrate missing = " +
  "built:false+reason. Read tea-rags://guide/review to interpret the answer.";

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
      formatMcpResponse(
        await deps.app.reviewChanges(request as ReviewChangesRequest),
        [],
        request as WorkingTreeCallAddress,
      ),
  );
}
