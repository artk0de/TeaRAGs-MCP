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
} from "../../core/api/public/index.js";
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
  "incompleteChange: co-change partners of the diff's files the diff does NOT touch — findings pass the " +
  "co-change significance gate (Poisson test vs configuration null n_p*n_q*Qs/M^2, BH q=0.05 over every pair " +
  "touching the diff, history minus the diff's own commits; summary cochangeSignificance + notSignificant), then " +
  "Wilson strength and the majority-floored Otsu cut over the corpus; partnerKind " +
  "test-first, generated + version manifests excluded (versionManifestPairs); structurallyLinked ranks above history-only; cap 50; a missing test partner whose source a touched test " +
  "has as SUBJECT — top scope's leading identifier = a symbol the source declares, and it imports the source, read " +
  "from the working tree — is a coveredPartners note naming that test, not a finding). cohesion: per changed " +
  "file, symbol co-change clusters + split candidates; a file with " +
  "no data = notJudged noCohesionData, never zero (cap 50 reports). architecture: the diff's added edges judged by " +
  "the boundary detectors (stableDependencies, leakingAbstraction, cycles, mainSequence delta, silentCoupling, " +
  "facadeContract, layeringBackEdge = added edge from lower inferred level up, evidence levels + closesKnot; " +
  "parent->own subdir never; hubLike = added edges carry component past get_architecture_report's hub cuts, Ca/Ce " +
  "before+after, Ce excludes foundation edges); a finding = endpoints (typed by kind, get_architecture_report's endpoint fields) + structured " +
  "evidence + subject (endpoints as text) + detail + optional remedy (dry-run-verified edge fix: retargetImport [+addExport] | " +
  "restoreExport; absent = no cheap fix); each family ranked costliest-first before the cap by maintenanceCost (get_architecture_report's " +
  "shrunken mean over the files the finding names, n0 estimated over this review's findings; <2 measured = 0.5; absent = no git readings); findings cap 100, family-aware — every family keeps >=1 slot; per-family truncated rides each " +
  "detector row, findingCount stays the family's FULL total, rows reconcile findingCount = listed + truncated + persistingCount. " +
  "findings = what the change INTRODUCED + any finding carrying a remedy; the rest collapse into change = {introducedCount, " +
  "nonLocal (introduced violations no listed finding carries = effect away from the diff, e.g. SDP between untouched " +
  "components — triage like findings), resolved, persisting ({family, subject}, no evidence — not the change's), indexLag?, " +
  "maybeAlreadyCommitted (index lacks the merge-base: introduced may hold already-committed edits)} — full detector set " +
  "judged on index vs index+tree edges, keyed by endpoints, renames canonicalized; silentCoupling, shotgunSurgery, norms " +
  "read git/type history no edge overlay moves, splitCandidates merge verdicts too = persisting by construction. " +
  "tier (get_architecture_report's impact tier: structural | active | critical) rides findings and change entries — " +
  "introduced = overlaid run's, else base run's; absent = family untierable or no co-change history; pairs touching " +
  "the diff judged without the diff's own commits. change.touchedActive ({family, subject, tier}) = persisting " +
  "active/critical violations the diff touches (finding names it or changed file on a carrying edge) — lifted out " +
  "of persisting (a lifted finding stays in its row's persistingCount): edit lands on a live cascade. " +
  "Detector rows also carry exclusions: mainSequence excludedLowConnectionCount (small-N components below the " +
  "connection floor), mainSequence excludedFlapCount (|ΔD| ≤ 0.02 moves, not findings), silentCoupling excluded block (the production taxonomy's counters) — a zero over excluded " +
  "classes is not a clean pass; silentCoupling pairs sharing an endpoint list as ONE finding (partners[] = every " +
  "pair, evidence.topPartners = 3 strongest with expected support λ, drillDown = ready find_co_changed call) — its row's " +
  "findingCount counts pairs, groupedFindingCount the findings (= listed + truncated); foundationTerminal:true on a D-delta finding = every contributing edge ends in " +
  "an abstract L0 foundation, entryPoint:true = touched component holds a facade nothing imports (an entry) — placement, not defect, " +
  "preExisting:true on a cycles/leakingAbstraction finding = the index already holds that edge — the diff touches " +
  "a file on it, did not add it; on layeringBackEdge = another edge already carried the component pair; on hubLike = already a hub before (listed only with a remedy, else in change.persisting). scopeSkippedFiles rides section envelopes (incompleteChange, " +
  "cohesion) and architecture detector rows = files the 200-cap skipped while judged; present = verdict PARTIAL — " +
  "a zero findingCount over them is never a clean pass. " +
  "norms: each file edge the change ADDS (absent at merge-base) judged by get_architecture_report's dependency-norm " +
  "ledgers over the INDEXED graph (change's own edges never precedent): MISFIT = against role pair's established " +
  "direction, expectedPath = that direction + support; CONFORMS; NEW_PATTERN = pair with no history; UNJUDGED + reason " +
  "(notIndexed = new file, untypedRole, weakRole + weakSide source|target|both, crossLanguage). exclusionsUnchecked = report exclusion classes not " +
  "evaluated (no call data on added edges). MISFIT first, cap 100 + truncated; verdictCounts + unjudgedReasonCounts pre-cap; " +
  "removedEdgeCount count only; test/tooling edges = nonProductionEdgeCount. " +
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
