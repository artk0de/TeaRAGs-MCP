/**
 * The cheap repair of a diff finding (bd tea-rags-mcp-89k7k.1.19.5, spec D2 /
 * D10 and its "Candidate target per family" table). A remedy is an EDGE edit
 * only — one existing import of a changed file pointed elsewhere, plus at most
 * one export line in one facade — and it is emitted only after the what-if
 * re-judgement over the edited overlay showed the finding gone and no finding
 * the diff did not already have (identity = `diffDetectorFindingKey`, the
 * detector + endpoints fingerprint). It is a verified repair, not a hint.
 *
 * Declines (undefined) when the import's names are unknown or whole-module, a
 * name has no export table or more than one declaration, the candidate does
 * not export every name, or every dry-run adds a finding or keeps this one.
 * silentCoupling and splitCandidates have no remedy: the agent decides.
 */

import { diffDetectorFindingKey } from "../../../../contracts/types/architecture-finding-key.js";
import type {
  DiffDetectorFamily,
  DiffDetectorFinding,
  DiffDetectorStatus,
  DiffFindingRemedy,
} from "../../../../contracts/types/diff-detector-finding.js";
import type { ReviewEdgeOverlay } from "../../../../domains/trajectory/codegraph/symbols/index.js";
import type { DiffEdgeEdit, DiffRejudge, ExportTableReader } from "./diff-family-detector.js";
import { WHOLE_MODULE_EXPORT_NAME } from "./shared.js";

type RetargetImportRemedy = Extract<DiffFindingRemedy, { kind: "retargetImport" }>;

export class DiffFindingRemedyResolver {
  constructor(
    private readonly deps: {
      /** The review's overlay — the changed files' imports and the names each takes. */
      overlay: ReviewEdgeOverlay;
      exports: ExportTableReader;
      rejudge: DiffRejudge;
    },
  ) {}

  /**
   * The first candidate the dry-run verifies, in the family's candidate order;
   * undefined = none qualifies. `findings` = every finding of the same run.
   */
  resolve(finding: DiffDetectorFinding, findings: readonly DiffDetectorFinding[]): DiffFindingRemedy | undefined {
    return this.candidatesOf(finding).find((remedy) => this.verified(finding, findings, remedy));
  }

  private candidatesOf(finding: DiffDetectorFinding): DiffFindingRemedy[] {
    switch (finding.detector) {
      case "leakingAbstraction":
        return this.retargetToFacade(
          finding.endpoints.sourceRelPath,
          finding.endpoints.targetRelPath,
          finding.evidence.facadeRelPath,
        );
      case "stableDependencies":
      case "layeringBackEdge":
        return this.retargetToDeclarer(finding.endpoints.sourceRelPath, finding.endpoints.targetRelPath, new Set());
      case "cycles":
        return this.retargetToDeclarer(
          finding.endpoints.sourceRelPath,
          finding.endpoints.targetRelPath,
          new Set(finding.evidence.path),
        );
      case "mainSequence":
        return finding.evidence.edges.flatMap((edge) =>
          this.retargetToDeclarer(edge.sourceRelPath, edge.targetRelPath, new Set()),
        );
      case "hubLike":
        return finding.evidence.edges.flatMap((edge) =>
          this.retargetToReachedExporter(edge.sourceRelPath, edge.targetRelPath),
        );
      case "facadeContract":
        return [
          {
            kind: "restoreExport",
            facadeRelPath: finding.endpoints.relPath,
            names: finding.evidence.droppedNames.map(({ name }) => name),
          },
        ];
      case "silentCoupling":
      case "splitCandidates":
        return [];
    }
  }

  /** leakingAbstraction: the facade the source already uses, plus the export line it lacks. */
  private retargetToFacade(source: string, from: string, facade: string): RetargetImportRemedy[] {
    const names = this.importedNamesOf(source, from);
    const declarers = names === undefined ? undefined : this.uniqueDeclarersOf(names);
    const surface = this.deps.exports.indexedSurfaceOf(facade);
    if (names === undefined || declarers === undefined || surface === undefined) return [];
    const missing = names.filter((name) => declarers.get(name) !== facade && !surface.includes(name));
    return [
      {
        ...retarget(source, from, facade, names),
        ...(missing.length > 0 ? { addExport: { facadeRelPath: facade, names: missing } } : {}),
      },
    ];
  }

  /**
   * stableDependencies / layeringBackEdge / cycles / mainSequence: the one file
   * declaring every name the import takes through a re-export — never the
   * target itself, never a file on `offLimits` (a cycle's own path).
   */
  private retargetToDeclarer(source: string, from: string, offLimits: ReadonlySet<string>): RetargetImportRemedy[] {
    const names = this.importedNamesOf(source, from);
    const declarers = names === undefined ? undefined : this.uniqueDeclarersOf(names);
    if (names === undefined || declarers === undefined) return [];
    const files = new Set(declarers.values());
    if (files.size !== 1) return [];
    const [to] = files;
    if (to === from || offLimits.has(to)) return [];
    return [retarget(source, from, to, names)];
  }

  /**
   * hubLike: a file the source ALREADY imports that exports every name, so
   * the retarget reaches no component the source did not already depend on.
   */
  private retargetToReachedExporter(source: string, from: string): RetargetImportRemedy[] {
    const names = this.importedNamesOf(source, from);
    const declarers = names === undefined ? undefined : this.uniqueDeclarersOf(names);
    if (names === undefined || declarers === undefined) return [];
    const reached = [...new Set(this.deps.overlay.edgesFrom(source).map((edge) => edge.targetRelPath))]
      .filter((target) => target !== from)
      .sort();
    return reached
      .filter((target) => {
        const surface = this.deps.exports.indexedSurfaceOf(target);
        return names.every((name) => declarers.get(name) === target || surface?.includes(name) === true);
      })
      .map((to) => retarget(source, from, to, names));
  }

  /** The names `source`'s import of `from` takes; undefined when unrecorded, empty or whole-module. */
  private importedNamesOf(source: string, from: string): string[] | undefined {
    const names = this.deps.overlay.edgesFrom(source).find((edge) => edge.targetRelPath === from)?.importedExportNames;
    if (names === undefined || names.length === 0 || names.includes(WHOLE_MODULE_EXPORT_NAME)) return undefined;
    return [...names];
  }

  /** Each name's one declaring file; undefined when a name has no export table or more than one declaration. */
  private uniqueDeclarersOf(names: readonly string[]): Map<string, string> | undefined {
    const declarers = new Map<string, string>();
    for (const name of names) {
      const files = this.deps.exports.declarersOf(name);
      if (files?.length !== 1) return undefined;
      declarers.set(name, files[0]);
    }
    return declarers;
  }

  /** The dry-run: the finding gone and every finding after the edit one the diff already had. */
  private verified(
    finding: DiffDetectorFinding,
    findings: readonly DiffDetectorFinding[],
    remedy: DiffFindingRemedy,
  ): boolean {
    const before = new Set(findings.map(diffDetectorFindingKey));
    const after = this.deps.rejudge(editsOf(remedy)).findings.map(diffDetectorFindingKey);
    return !after.includes(diffDetectorFindingKey(finding)) && after.every((key) => before.has(key));
  }
}

/** The families the resolver never repairs — the agent decides by the family's repair file (spec D2). */
const AGENT_DECIDED_FAMILIES: ReadonlySet<DiffDetectorFamily> = new Set(["silentCoupling", "splitCandidates"]);

/**
 * One run's findings with the resolver's `remedy` stamped on (bd
 * tea-rags-mcp-89k7k.1.19.6). Only findings of a family that can carry a
 * remedy reach the resolver, so the dry-run cost stays bounded by the
 * repairable findings. A resolver throw never fails the pass: the finding
 * keeps no remedy and its family's status row carries the `reason`.
 */
export function stampDiffFindingRemedies(
  result: { findings: readonly DiffDetectorFinding[]; detectors: readonly DiffDetectorStatus[] },
  resolver: Pick<DiffFindingRemedyResolver, "resolve">,
): { findings: DiffDetectorFinding[]; detectors: DiffDetectorStatus[] } {
  const failures = new Map<DiffDetectorFamily, string>();
  const findings = result.findings.map((finding) => {
    if (AGENT_DECIDED_FAMILIES.has(finding.detector)) return finding;
    try {
      const remedy = resolver.resolve(finding, result.findings);
      return remedy === undefined ? finding : { ...finding, remedy };
    } catch (error) {
      if (!failures.has(finding.detector)) {
        failures.set(
          finding.detector,
          `remedy resolver failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return finding;
    }
  });
  const detectors = result.detectors.map((status) => {
    const failure = failures.get(status.detector);
    if (failure === undefined) return status;
    return { ...status, reason: status.reason === undefined ? failure : `${status.reason}; ${failure}` };
  });
  return { findings, detectors };
}

function retarget(source: string, from: string, to: string, names: string[]): RetargetImportRemedy {
  return { kind: "retargetImport", sourceRelPath: source, fromRelPath: from, toRelPath: to, importedNames: names };
}

/** The remedy as what-if edits — the seam knows edges and exports, never remedies. */
function editsOf(remedy: DiffFindingRemedy): DiffEdgeEdit[] {
  if (remedy.kind === "restoreExport") {
    return [{ addExport: { facadeRelPath: remedy.facadeRelPath, names: remedy.names } }];
  }
  return [
    { replace: { source: remedy.sourceRelPath, from: remedy.fromRelPath, to: remedy.toRelPath } },
    ...(remedy.addExport !== undefined ? [{ addExport: remedy.addExport }] : []),
  ];
}
