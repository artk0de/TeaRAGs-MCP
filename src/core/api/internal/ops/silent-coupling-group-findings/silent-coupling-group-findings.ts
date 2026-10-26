/**
 * The grouped silent-coupling finding's shared parts (bd
 * tea-rags-mcp-89k7k.1.14), read by both surfaces that list silent coupling —
 * `get_architecture_report`'s violations and `review_changes`' architecture
 * findings — so one shared endpoint reads the same in both. The partition
 * itself is the domain's `groupSilentCouplingPairs`; this module only shapes a
 * group into what an agent reads: the partners strongest first and the
 * `find_co_changed` call that drills into the file. The subject wording is the
 * finding contract's (`silentCouplingGroupSubject`, contracts/types/
 * diff-detector-finding.ts), rendered from the group's endpoint.
 */

import type {
  SilentCouplingGroupDrillDown,
  SilentCouplingGroupPartner,
} from "../../../../contracts/types/architecture-report.js";
import type { RelPath } from "../../../../contracts/types/codegraph.js";
import {
  silentCouplingPartnerOf,
  type SilentCouplingPairGroup,
} from "../../../../domains/trajectory/codegraph/temporal/index.js";

/** Partners a grouped finding's evidence names; the full list rides `partners`. */
export const SILENT_COUPLING_GROUP_EVIDENCE_PARTNERS = 3;

/** `find_co_changed`'s `limit` ceiling (its MCP schema's `.max`) — the drill call never asks past it. */
export const FIND_CO_CHANGED_LIMIT_MAX = 100;

/** The pair fields a grouped finding reads; both surfaces' pairs carry them. */
export interface SilentCouplingGroupedPair {
  relPathA: RelPath;
  relPathB: RelPath;
  support: number;
  strength: number;
  expectedSupport?: number;
}

/** Every partner of the group, strongest first; support, then path break ties. */
export function silentCouplingGroupPartners(
  group: SilentCouplingPairGroup<SilentCouplingGroupedPair>,
): SilentCouplingGroupPartner[] {
  return group.pairs
    .map(
      (pair): SilentCouplingGroupPartner => ({
        relPath: silentCouplingPartnerOf(pair, group.relPath),
        support: pair.support,
        ...(pair.expectedSupport === undefined ? {} : { expectedSupport: roundTo3(pair.expectedSupport) }),
        strength: pair.strength,
      }),
    )
    .sort(
      (a, b) =>
        b.strength - a.strength ||
        b.support - a.support ||
        (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0),
    );
}

/** The `find_co_changed` call listing `relPath`'s co-change partners, ready to run. */
export function silentCouplingGroupDrillDown(relPath: RelPath, partnerCount: number): SilentCouplingGroupDrillDown {
  return findCoChangedDrillDown(
    [relPath],
    Math.min(partnerCount, FIND_CO_CHANGED_LIMIT_MAX),
    "to list this file's co-change partners",
  );
}

/** The arguments a drill hint names — the row's own `drillDown` fields, never their values. */
const FIND_CO_CHANGED_TEMPLATE_ARGS = "files: drillDown.files, limit: drillDown.limit";

/**
 * A ready `find_co_changed` drill (bd tea-rags-mcp-4c129). The hint is a
 * TEMPLATE over the row's `files` / `limit`, never their values: rows of one
 * detector share it, so the tool view hoists it once instead of repeating each
 * row's file list a second time. `purpose` says what the call lists.
 */
export function findCoChangedDrillDown(files: RelPath[], limit: number, purpose: string): SilentCouplingGroupDrillDown {
  return {
    tool: "find_co_changed",
    files,
    limit,
    hint: `call find_co_changed(${FIND_CO_CHANGED_TEMPLATE_ARGS}) ${purpose}`,
  };
}

/** The drill's hint with its own arguments filled in — for prose that reads one finding alone. */
export function renderFindCoChangedCall(drillDown: SilentCouplingGroupDrillDown): string {
  return drillDown.hint.replace(
    FIND_CO_CHANGED_TEMPLATE_ARGS,
    `files: ${JSON.stringify(drillDown.files)}, limit: ${drillDown.limit}`,
  );
}

function roundTo3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
