import type { DependencyNormsReport } from "../../../../domains/trajectory/codegraph/symbols/index.js";
import type { ArchitectureNormsReport, NormArchitectureViolation } from "../../../public/dto/architecture.js";

export function normsDto(report: DependencyNormsReport): ArchitectureNormsReport {
  return {
    summary: { ...report.summary },
    ledgers: report.ledgers.map(({ family, pairCount, significance }) => ({
      family,
      pairCount,
      significance: { ...significance },
    })),
    findings: report.findings.map((f) => ({
      ...f,
      pValue: roundSignificant3(f.pValue),
      establishedDirection: { ...f.establishedDirection },
    })),
  };
}

/** A p-value keeps 3 significant digits — 3 decimals would round every rejected one to 0. */
function roundSignificant3(value: number): number {
  return Number(value.toPrecision(3));
}

export function normsViolations(report: DependencyNormsReport, limit: number): NormArchitectureViolation[] {
  return report.findings.slice(0, limit).map(
    (f): NormArchitectureViolation => ({
      detector: "norms",
      kind: f.kind,
      sourceRelPath: f.sourceRelPath,
      targetRelPath: f.targetRelPath,
      evidence: {
        roleSrc: f.roleSrc,
        roleDst: f.roleDst,
        locality: f.locality,
        callWeight: f.callWeight,
        pairSupport: f.pairSupport,
        pValue: roundSignificant3(f.pValue),
        establishedDirection: { ...f.establishedDirection },
      },
    }),
  );
}
