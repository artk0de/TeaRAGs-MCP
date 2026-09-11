/**
 * IndexDriftReporter — fans one collection out over every drift monitor and
 * folds what they find into ONE report carrying ONE command.
 *
 * The monitors stay stateless about who has been told: consumption ("this
 * process has already warned about this collection") lives here, so a search
 * response carries the warning once per server session and again after each
 * index run resets it (spec decision 13).
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

export class IndexDriftReporter {
  private readonly consumed = new Set<string>();

  constructor(
    private readonly monitors: readonly IndexDriftMonitor[],
    private readonly resolveAlias: (collectionName: string) => string | undefined = () => undefined,
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
   * Once per collection per process, until `reset` — a search response carries
   * the warning one time per server session, and again after each index run.
   */
  async checkAndConsume(path: string): Promise<IndexDriftReport | null> {
    let collectionName: string;
    try {
      collectionName = resolveCollectionName(await validatePath(path));
    } catch {
      return null;
    }
    if (this.consumed.has(collectionName)) return null;
    this.consumed.add(collectionName);
    return this.checkByCollectionName(collectionName);
  }

  /** Called by `IndexingOps` after the stamps of a run are written (spec decision 13). */
  reset(collectionName: string): void {
    this.consumed.delete(collectionName);
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
