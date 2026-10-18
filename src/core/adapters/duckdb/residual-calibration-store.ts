/**
 * Per-repo Kev accept thresholds (`cg_residual_calibration`, migration 065,
 * bd tea-rags-mcp-2m83f.62): one row per language and stratum, replaced as a
 * whole per language so a calibration is never half old, half new.
 */
import type {
  CodegraphResidualCalibrationStore,
  ResidualCalibrationNoneRates,
  ResidualCalibrationRow,
  ResidualCalibrationStratum,
} from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";

interface CalibrationDbRow {
  language: string;
  stratum: string;
  threshold: number | null;
  lower_bound: number | null;
  n: number;
  pi: number | null;
  none_rates: string | null;
  model: string;
  template_hash: string;
  graph_fingerprint: string;
  created_at: bigint | number;
}

export class DuckDbResidualCalibrationStore implements CodegraphResidualCalibrationStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  async readResidualCalibration(language: string): Promise<ResidualCalibrationRow[]> {
    const rows = await this.session.queryAll<CalibrationDbRow>(
      `SELECT language, stratum, threshold, lower_bound, n, pi, none_rates, model, template_hash,
              graph_fingerprint, created_at
         FROM cg_residual_calibration
        WHERE language = ?
        ORDER BY stratum`,
      [language],
    );
    return rows.map((r) => ({
      language: r.language,
      stratum: r.stratum as ResidualCalibrationStratum,
      threshold: r.threshold,
      lowerBound: r.lower_bound,
      n: Number(r.n),
      pi: r.pi,
      noneRates: r.none_rates === null ? null : (JSON.parse(r.none_rates) as ResidualCalibrationNoneRates),
      model: r.model,
      templateHash: r.template_hash,
      graphFingerprint: r.graph_fingerprint,
      createdAt: Number(r.created_at),
    }));
  }

  async writeResidualCalibration(language: string, rows: readonly ResidualCalibrationRow[]): Promise<void> {
    await this.session.transaction(async () => {
      await this.session.run("DELETE FROM cg_residual_calibration WHERE language = ?", [language]);
      if (rows.length === 0) return;
      await this.session.run(
        `INSERT INTO cg_residual_calibration (language, stratum, threshold, lower_bound, n, pi, none_rates, model,
                                              template_hash, graph_fingerprint, created_at)
         VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
        rows.flatMap((r) => [
          language,
          r.stratum,
          r.threshold,
          r.lowerBound,
          r.n,
          r.pi,
          r.noneRates === null ? null : JSON.stringify(r.noneRates),
          r.model,
          r.templateHash,
          r.graphFingerprint,
          r.createdAt,
        ]),
      );
    });
  }
}
