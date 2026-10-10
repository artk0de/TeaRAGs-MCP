import {
  MAIN_SEQUENCE_STABLE_CONCRETE_CALM_REASON,
  MAIN_SEQUENCE_UNOBSERVABLE_REASON,
  type MainSequenceReport,
} from "../../../../domains/trajectory/codegraph/symbols/index.js";
import type { ArchitectureViolation, MainSequenceReportSummary } from "../../../public/dto/architecture.js";
import { round3 } from "./architecture-report-value-format.js";

/** The per-file reading the volatility gate averages — named in the summary. */
const MAIN_SEQUENCE_VOLATILITY_SIGNAL = "git.file.commitCount";

export function summariseMainSequence(report: MainSequenceReport): MainSequenceReportSummary {
  const { summary } = report;
  return {
    judgedComponentCount: summary.judgedComponentCount,
    violationCount: summary.violationCount,
    painCount: summary.painCount,
    uselessnessCount: summary.uselessnessCount,
    meanDistance: round3(summary.meanDistance),
    distanceThreshold: round3(summary.distanceThreshold),
    distanceThresholdMethod: summary.distanceThresholdMethod,
    ...(summary.distanceSeparability === undefined
      ? {}
      : { distanceSeparability: round3(summary.distanceSeparability) }),
    minConnectionCount: summary.minConnectionCount,
    minTypeCount: summary.minTypeCount,
    abstractTypeShareByLanguage: Object.fromEntries(
      Object.entries(summary.abstractTypeShareByLanguage).map(([language, share]) => [language, round3(share)]),
    ),
    excluded: { ...summary.excluded },
    exclusionReasons: {
      unobservableAbstractness: MAIN_SEQUENCE_UNOBSERVABLE_REASON,
      stableConcreteCalm: MAIN_SEQUENCE_STABLE_CONCRETE_CALM_REASON,
    },
    ...(summary.volatility
      ? {
          volatility: {
            signal: MAIN_SEQUENCE_VOLATILITY_SIGNAL,
            threshold: round3(summary.volatility.threshold),
            thresholdMethod: summary.volatility.thresholdMethod,
            ...(summary.volatility.separability === undefined
              ? {}
              : { separability: round3(summary.volatility.separability) }),
            fileMedian: round3(summary.volatility.fileMedian),
            measuredComponentCount: summary.volatility.measuredComponentCount,
          },
        }
      : {}),
    ...(summary.scope ? { outOfScopeComponentCount: summary.scope.outOfScopeComponentCount } : {}),
  };
}

export function mainSequenceViolations(report: MainSequenceReport, limit: number): ArchitectureViolation[] {
  return report.violations.slice(0, limit).map(
    (v): ArchitectureViolation => ({
      detector: "mainSequence",
      component: v.component,
      componentKind: v.kind,
      facadeRelPath: v.facadeRelPath,
      evidence: {
        zone: v.zone,
        distance: v.distance,
        abstractness: v.abstractness,
        instability: v.instability,
        abstractTypeCount: v.abstractTypeCount,
        concreteTypeCount: v.concreteTypeCount,
        afferentCount: v.afferentCount,
        efferentCount: v.efferentCount,
        fileCount: v.fileCount,
        unmeasuredFileCount: v.unmeasuredFileCount,
        ...(v.entryPoint ? { entryPoint: v.entryPoint } : {}),
        ...(v.volatility
          ? {
              volatility: {
                value: round3(v.volatility.value),
                measuredFileCount: v.volatility.measuredFileCount,
                threshold: round3(v.volatility.threshold),
                label: v.volatility.label,
              },
            }
          : {}),
      },
    }),
  );
}
