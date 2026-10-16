/**
 * Residual-resolution verdict cache (codegraph residual resolution, wave 1).
 *
 * One DuckDB file per logical collection, outside every codegraph generation,
 * so `--force` and a generation swap never touch it; removed only with the
 * collection's footprint. Opened directly by the residual pass under the
 * collection's IndexingLock — never through the codegraph daemon.
 */
import { join } from "node:path";

import type { ResidualVerdict } from "../../contracts/types/codegraph-residual.js";
import { DuckDbGraphSession } from "./graph-session.js";

const CHUNK_ROWS = 200;
const DAY_MS = 86_400_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS residual_verdicts (
  site_key         VARCHAR NOT NULL,
  menu_hash        VARCHAR NOT NULL,
  model            VARCHAR NOT NULL,
  model_version    VARCHAR NOT NULL,
  pick             VARCHAR NOT NULL,
  p                DOUBLE  NOT NULL,
  probabilities    VARCHAR NOT NULL,
  question_payload VARCHAR NOT NULL,
  created_at       BIGINT  NOT NULL,
  last_seen_at     BIGINT  NOT NULL,
  PRIMARY KEY (site_key, menu_hash, model, model_version)
)`;

const COLUMNS = [
  "site_key",
  "menu_hash",
  "model",
  "model_version",
  "pick",
  "p",
  "probabilities",
  "question_payload",
  "created_at",
  "last_seen_at",
] as const;

interface VerdictRow {
  site_key: string;
  menu_hash: string;
  model: string;
  model_version: string;
  pick: string;
  p: number;
  probabilities: string;
  question_payload: string;
  created_at: number | bigint;
  last_seen_at: number | bigint;
}

function toVerdict(r: VerdictRow): ResidualVerdict {
  return {
    siteKey: r.site_key,
    menuHash: r.menu_hash,
    model: r.model,
    modelVersion: r.model_version,
    pick: r.pick,
    p: r.p,
    probabilities: JSON.parse(r.probabilities) as Record<string, number>,
    questionPayload: r.question_payload,
    createdAt: Number(r.created_at),
    lastSeenAt: Number(r.last_seen_at),
  };
}

export class ResidualVerdictStore {
  private constructor(private readonly session: DuckDbGraphSession) {}

  static pathFor(rootDir: string, logicalName: string): string {
    return join(rootDir, "residual-verdicts", `${logicalName}.duckdb`);
  }

  static async open(rootDir: string, logicalName: string): Promise<ResidualVerdictStore> {
    const session = new DuckDbGraphSession({
      path: ResidualVerdictStore.pathFor(rootDir, logicalName),
    });
    await session.open();
    await session.exec(SCHEMA);
    return new ResidualVerdictStore(session);
  }

  /**
   * A READ_ONLY handle for a reader in another process (the working-tree graph
   * build). Readers share the file; a process holding it READ_WRITE (a running
   * pass) makes this open fail, and this handle makes that pass's open fail
   * while it lives — so a reader closes it as soon as it has read.
   */
  static async openReadOnly(rootDir: string, logicalName: string): Promise<ResidualVerdictStore> {
    const session = new DuckDbGraphSession({
      path: ResidualVerdictStore.pathFor(rootDir, logicalName),
      accessMode: "READ_ONLY",
    });
    await session.open();
    return new ResidualVerdictStore(session);
  }

  async find(keys: { siteKey: string; menuHash: string; modelVersion: string }[]): Promise<ResidualVerdict[]> {
    const verdicts: ResidualVerdict[] = [];
    for (let i = 0; i < keys.length; i += CHUNK_ROWS) {
      const chunk = keys.slice(i, i + CHUNK_ROWS);
      const rows = await this.session.queryAll<VerdictRow>(
        `SELECT v.${COLUMNS.join(", v.")}
           FROM residual_verdicts v
           JOIN (VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}) AS k(site_key, menu_hash, model_version)
             ON v.site_key = k.site_key AND v.menu_hash = k.menu_hash AND v.model_version = k.model_version
          ORDER BY v.site_key, v.model`,
        chunk.flatMap((k) => [k.siteKey, k.menuHash, k.modelVersion]),
      );
      verdicts.push(...rows.map(toVerdict));
    }
    return verdicts;
  }

  /** The newest verdict of `model` per (site, menu), whatever model version answered it. */
  async findLatest(keys: { siteKey: string; menuHash: string }[], model: string): Promise<ResidualVerdict[]> {
    const verdicts: ResidualVerdict[] = [];
    for (let i = 0; i < keys.length; i += CHUNK_ROWS) {
      const chunk = keys.slice(i, i + CHUNK_ROWS);
      const rows = await this.session.queryAll<VerdictRow>(
        `SELECT v.${COLUMNS.join(", v.")}
           FROM residual_verdicts v
           JOIN (VALUES ${chunk.map(() => "(?, ?)").join(", ")}) AS k(site_key, menu_hash)
             ON v.site_key = k.site_key AND v.menu_hash = k.menu_hash
          WHERE v.model = ?
        QUALIFY row_number() OVER (PARTITION BY v.site_key, v.menu_hash ORDER BY v.created_at DESC, v.model_version DESC) = 1
          ORDER BY v.site_key, v.menu_hash`,
        [...chunk.flatMap((k) => [k.siteKey, k.menuHash]), model],
      );
      verdicts.push(...rows.map(toVerdict));
    }
    return verdicts;
  }

  async put(verdicts: ResidualVerdict[]): Promise<void> {
    const byKey = new Map<string, ResidualVerdict>();
    for (const v of verdicts) byKey.set([v.siteKey, v.menuHash, v.model, v.modelVersion].join("\u0000"), v);
    const rows = [...byKey.values()];
    const tuple = `(${COLUMNS.map(() => "?").join(", ")})`;
    await this.session.transaction(async () => {
      for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
        const chunk = rows.slice(i, i + CHUNK_ROWS);
        await this.session.run(
          `INSERT INTO residual_verdicts (${COLUMNS.join(", ")}) VALUES ${chunk.map(() => tuple).join(", ")}
           ON CONFLICT (site_key, menu_hash, model, model_version) DO UPDATE SET
             pick = excluded.pick,
             p = excluded.p,
             probabilities = excluded.probabilities,
             question_payload = excluded.question_payload,
             last_seen_at = excluded.last_seen_at`,
          chunk.flatMap((v) => [
            v.siteKey,
            v.menuHash,
            v.model,
            v.modelVersion,
            v.pick,
            v.p,
            JSON.stringify(v.probabilities),
            v.questionPayload,
            v.createdAt,
            v.lastSeenAt,
          ]),
        );
      }
    });
  }

  async touch(siteKeys: string[], model: string, now: number): Promise<void> {
    const unique = [...new Set(siteKeys)];
    for (let i = 0; i < unique.length; i += CHUNK_ROWS) {
      const chunk = unique.slice(i, i + CHUNK_ROWS);
      await this.session.run(
        `UPDATE residual_verdicts SET last_seen_at = ? WHERE model = ? AND site_key IN (${chunk.map(() => "?").join(", ")})`,
        [now, model, ...chunk],
      );
    }
  }

  /** Delete verdicts unseen for longer than `retentionDays`; resolves to the rows deleted. */
  async expire(retentionDays: number, now: number): Promise<number> {
    const cutoff = now - retentionDays * DAY_MS;
    return this.session.transaction(async () => {
      const [counted] = await this.session.queryAll<{ n: number | bigint }>(
        "SELECT COUNT(*) AS n FROM residual_verdicts WHERE last_seen_at < ?",
        [cutoff],
      );
      await this.session.run("DELETE FROM residual_verdicts WHERE last_seen_at < ?", [cutoff]);
      return Number(counted?.n ?? 0);
    });
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}
