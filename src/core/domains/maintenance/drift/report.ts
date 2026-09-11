/**
 * IndexDriftReporter — fans one collection out over every drift monitor and
 * folds what they find into ONE report carrying ONE command.
 *
 * The monitors stay stateless about who has been told: consumption ("this
 * process has already shown THIS report for this collection") lives here, so a
 * search response carries each distinct warning once per server session and
 * again after each index run resets it (spec decision 13).
 */

import { resolveCollectionName, validatePath } from "../../../infra/collection-name.js";
import type { IndexDriftAxis, IndexDriftFinding, IndexDriftMonitor } from "./monitor.js";
import { foldIndexDriftRemedies, renderIndexDriftRemedy, type IndexDriftRemedy } from "./remedy.js";

export interface IndexDriftReport {
  findings: readonly IndexDriftFinding[];
  remedy: IndexDriftRemedy;
  /** Registry name of the collection, when one is registered — fills `--project`. */
  projectAlias?: string;
}

const AXIS_TITLE: Record<IndexDriftAxis, string> = {
  payloadKeys: "Payload keys",
  languageVersions: "Language versions",
  env: "Indexing env",
  commit: "Working tree",
};

/** Separates the collection name from the report signature; neither can contain it. */
const SIGNATURE_SEPARATOR = "\u0000";

export class IndexDriftReporter {
  /** `<collection>\u0000<rendered report>` for every report already shown. */
  private readonly consumed = new Set<string>();

  constructor(
    private readonly monitors: readonly IndexDriftMonitor[],
    private readonly resolveAlias: (collectionName: string) => string | undefined = () => undefined,
    /**
     * The path → collection rule a SEARCH resolves by, injected because it
     * consults the project registry and this domain may not reach the api layer
     * (`createPathCollectionResolver`, bd tea-rags-mcp-waj6k). The default is
     * that rule's own fallback — the path hash — which is what an unregistered
     * path resolves to either way.
     */
    private readonly resolveCollectionForPath: (path: string) => Promise<string> = async (path) =>
      resolveCollectionName(await validatePath(path)),
  ) {}

  checkByCollectionName(collectionName: string): IndexDriftReport | null {
    const findings = this.monitors.flatMap((monitor) => monitor.check(collectionName));
    if (findings.length === 0) return null;
    const projectAlias = this.resolveAlias(collectionName);
    return {
      findings,
      remedy: foldIndexDriftRemedies(findings.map((f) => f.remedy)),
      ...(projectAlias ? { projectAlias } : {}),
    };
  }

  /**
   * Every time, for callers whose job is to INSPECT rather than to ride along
   * with an answer — `get_index_status`, and anything else a reader invokes on
   * purpose to ask "what is the state of this index".
   *
   * Consuming there would be doubly wrong: the second `get_index_status` would
   * read clean, and the spent warning would be the one the next search was
   * owed.
   */
  async checkByPath(path: string): Promise<IndexDriftReport | null> {
    const collectionName = await this.resolvePath(path);
    return collectionName === null ? null : this.checkByCollectionName(collectionName);
  }

  /**
   * Once per collection per REPORT, until `reset` — the path-addressed search.
   *
   * Keying by collection alone spent the warning on whatever the first check
   * happened to find: a clean check silenced the next search that actually had
   * something to say, and a report that grew a finding after the first warning
   * never reached anyone until an index run reset it. Keying by what the reader
   * would SEE fixes both — a clean check consumes nothing, and a changed report
   * is a report nobody has been shown.
   */
  async checkAndConsume(path: string): Promise<IndexDriftReport | null> {
    const collectionName = await this.resolvePath(path);
    return collectionName === null ? null : this.checkAndConsumeByCollectionName(collectionName);
  }

  /**
   * The collection-addressed search, which consumes for the same reason the
   * path-addressed one does: a request that names its collection outright is
   * still a search riding a warning along with an answer, not an inspection.
   */
  checkAndConsumeByCollectionName(collectionName: string): IndexDriftReport | null {
    const report = this.checkByCollectionName(collectionName);
    if (report === null) return null;
    const signature = `${collectionName}${SIGNATURE_SEPARATOR}${formatIndexDriftReport(report)}`;
    if (this.consumed.has(signature)) return null;
    this.consumed.add(signature);
    return report;
  }

  /**
   * Called by `IndexingOps` after the stamps of a run are written (spec decision
   * 13). Every signature recorded for the collection goes, not just the most
   * recent one: the run rewrote the stamps all of them were computed against.
   */
  reset(collectionName: string): void {
    const prefix = `${collectionName}${SIGNATURE_SEPARATOR}`;
    for (const signature of this.consumed) {
      if (signature.startsWith(prefix)) this.consumed.delete(signature);
    }
  }

  /**
   * The one place a path becomes a collection name, so the consuming and
   * non-consuming checks cannot drift apart on which key they mean — and, with
   * the injected resolver, cannot drift apart from the collection the search
   * that carries the report actually queried. Null when the path cannot be
   * resolved at all — an unreadable path is not a drift report.
   */
  private async resolvePath(path: string): Promise<string | null> {
    try {
      return await this.resolveCollectionForPath(path);
    } catch {
      return null;
    }
  }
}

export function formatIndexDriftReport(report: IndexDriftReport): string {
  const byAxis = new Map<IndexDriftAxis, IndexDriftFinding[]>();
  for (const finding of report.findings) {
    byAxis.set(finding.axis, [...(byAxis.get(finding.axis) ?? []), finding]);
  }
  const lines: string[] = [];
  for (const [axis, findings] of byAxis) {
    lines.push(`${AXIS_TITLE[axis]}:`);
    for (const finding of findings) {
      lines.push(
        `  ${finding.subject}: ${finding.indexed} → ${finding.current}${finding.note ? ` (${finding.note})` : ""}`,
      );
    }
  }
  lines.push(renderIndexDriftRemedy(report.remedy, report.projectAlias));
  return lines.join("\n");
}
