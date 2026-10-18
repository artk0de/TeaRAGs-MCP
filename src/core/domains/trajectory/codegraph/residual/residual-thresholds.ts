/**
 * Where a residual pass takes its accept thresholds from (bd tea-rags-mcp-2m83f.62):
 * the stored per-language calibration when it was asked under the run's model
 * and question fold, else — when the source may calibrate — a calibration asked
 * and fitted after the run's own asking, against the run's answer mix, and
 * stored for the next run. A stratum the fit left `null` keeps its default.
 */
import type {
  ResidualCalibrationRow,
  ResidualCalibrationStratum,
} from "../../../../contracts/types/codegraph-residual.js";
import type { GraphDbClient } from "../../../../contracts/types/codegraph-storage.js";
import type { CalibrationAnswer } from "./calibration-answer.js";
import {
  fitResidualThresholds,
  validResidualCalibration,
  type ResidualAnswerMix,
  type ResidualThresholdFit,
  type StratumFit,
} from "./residual-calibration-fit.js";

/** A calibration as a pass applies it: a fit per stratum, `null` = keep the default. */
export type ResidualCalibratedThresholds = Pick<ResidualThresholdFit, "block1" | "fullMenu" | "none" | "pi">;

/** What a stored calibration must match: the provider (at its served version, when asking) and the question fold. */
export interface ResidualCalibrationKey {
  providerId: string;
  /** Absent in a `cacheOnly` run, which serves no model: any version of the provider matches. */
  servedVersion?: string;
  templateHash: string;
}

/** The run a calibration is fitted for. */
export interface ResidualCalibrationRun {
  language: string;
  key: ResidualCalibrationKey;
  mix: ResidualAnswerMix;
  graphFingerprint: string;
}

export interface ResidualThresholdSource {
  /** The stored calibration valid for `key`, or `undefined`. */
  stored: (language: string, key: ResidualCalibrationKey) => Promise<ResidualCalibratedThresholds | undefined>;
  /** Asks, fits and stores a calibration; throws when it cannot. Absent — the source only reads. */
  calibrate?: (run: ResidualCalibrationRun) => Promise<ResidualCalibratedThresholds>;
}

/** `cg_residual_calibration.model`: the provider id at its served version. */
export function calibrationModel(key: Required<ResidualCalibrationKey>): string {
  return `${key.providerId}@${key.servedVersion}`;
}

const STRATA: readonly ResidualCalibrationStratum[] = ["block1", "fullMenu", "none"];

/** Thresholds stored in the graph's `cg_residual_calibration`; `ask` set — the source may calibrate. */
export class StoredResidualThresholds implements ResidualThresholdSource {
  readonly calibrate?: (run: ResidualCalibrationRun) => Promise<ResidualCalibratedThresholds>;

  constructor(
    private readonly graphDb: Pick<GraphDbClient, "readResidualCalibration" | "writeResidualCalibration">,
    ask?: () => Promise<readonly CalibrationAnswer[]>,
    private readonly now: () => number = Date.now,
  ) {
    if (ask !== undefined) this.calibrate = async (run) => this.fitAndStore(run, await ask());
  }

  async stored(language: string, key: ResidualCalibrationKey): Promise<ResidualCalibratedThresholds | undefined> {
    const rows = await this.graphDb.readResidualCalibration(language);
    const model =
      key.servedVersion === undefined
        ? rows.find((r) => r.model.startsWith(`${key.providerId}@`))?.model
        : calibrationModel({ ...key, servedVersion: key.servedVersion });
    if (model === undefined) return undefined;
    const valid = validResidualCalibration(rows, { model, templateHash: key.templateHash });
    return valid === null ? undefined : fromRows(valid);
  }

  private async fitAndStore(
    run: ResidualCalibrationRun,
    records: readonly CalibrationAnswer[],
  ): Promise<ResidualCalibratedThresholds> {
    if (run.key.servedVersion === undefined) throw new Error("a calibration needs the served model version");
    const fit = fitResidualThresholds(records, run.mix);
    const model = calibrationModel({ ...run.key, servedVersion: run.key.servedVersion });
    const createdAt = this.now();
    const rows = STRATA.map(
      (stratum): ResidualCalibrationRow => ({
        language: run.language,
        stratum,
        threshold: fit[stratum]?.threshold ?? null,
        lowerBound: fit[stratum]?.lowerBound ?? null,
        n: fit[stratum]?.n ?? records.length,
        pi: fit.pi,
        noneRates: fit.noneRates,
        model,
        templateHash: run.key.templateHash,
        graphFingerprint: run.graphFingerprint,
        createdAt,
      }),
    );
    await this.graphDb.writeResidualCalibration(run.language, rows);
    return { block1: fit.block1, fullMenu: fit.fullMenu, none: fit.none, pi: fit.pi };
  }
}

function fromRows(rows: readonly ResidualCalibrationRow[]): ResidualCalibratedThresholds {
  const of = (stratum: ResidualCalibrationStratum): StratumFit | null => {
    const row = rows.find((r) => r.stratum === stratum);
    if (row?.threshold === null || row?.threshold === undefined) return null;
    return { threshold: row.threshold, lowerBound: row.lowerBound ?? 0, n: row.n };
  };
  return { block1: of("block1"), fullMenu: of("fullMenu"), none: of("none"), pi: rows[0]?.pi ?? null };
}
