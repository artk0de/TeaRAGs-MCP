/**
 * MigrationCorpusQuery — find_symbol's read path over the migration corpus
 * (bd tea-rags-mcp-nplgm), the `<collection>_migrations` companion that
 * `scope: "migrations"` searches.
 *
 * Two addresses, both answered by payload scroll — no query embedding:
 *   - `table:<name>`  → every `change`/`up` operation on the table, folded into
 *     its current state by the injected Rails fold (language domain, wired by
 *     the API layer so explore never imports it);
 *   - `migration:<path>:<op>:<n>` → that operation's chunk, the drill target of
 *     the state's provenance ids.
 *
 * The corpus splits an operation longer than the chunk budget into
 * `#partN` points, each later part prefixed with the operation's first line;
 * both addresses read the operation reassembled.
 */

import { exactMatchOnTextIndexed } from "../../../adapters/qdrant/filters/text-indexed-exact.js";
import type { QdrantCollectionCatalog, QdrantPointReader } from "../../../adapters/qdrant/ports.js";
import { INDEXING_METADATA_ID } from "../../../contracts/constants.js";
import type {
  RailsMigrationOperation,
  RailsTableMigrationFold,
  RailsTableState,
} from "../../../contracts/types/rails-table-state.js";

export const RAILS_TABLE_ID_PREFIX = "table:";
export const MIGRATION_ID_PREFIX = "migration:";

/** Upper bound on corpus points read for one address — far above any table's migration history. */
const MIGRATION_SCROLL_LIMIT = 10_000;

const OPERATION_PAYLOAD_KEYS = [
  "relativePath",
  "symbolId",
  "startLine",
  "endLine",
  "version",
  "operation",
  "direction",
  "table",
  "columns",
  "content",
];

export interface MigrationOperationPoint {
  id: string | number;
  payload: Record<string, unknown>;
}

export type MigrationCorpusTableAnswer =
  | { kind: "state"; state: RailsTableState }
  | { kind: "noCorpus" }
  | { kind: "noOperations" };

const PART_SUFFIX = /#part(\d+)$/;

/** A string payload value; anything else reads as empty. */
function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Points of one operation, `#partN` parts joined back into the operation's text. */
function reassembleOperations(points: readonly MigrationOperationPoint[]): MigrationOperationPoint[] {
  const groups = new Map<string, MigrationOperationPoint[]>();
  for (const point of points) {
    const symbolId = typeof point.payload.symbolId === "string" ? point.payload.symbolId : String(point.id);
    const base = symbolId.replace(PART_SUFFIX, "");
    groups.set(base, [...(groups.get(base) ?? []), point]);
  }
  return [...groups.entries()].map(([symbolId, parts]) => {
    if (parts.length === 1 && parts[0].payload.symbolId === symbolId) return parts[0];
    const ordered = [...parts].sort((left, right) => partNumber(left) - partNumber(right));
    const first = textOf(ordered[0].payload.content);
    const prefix = `${first.split("\n")[0]}\n`;
    const content = [
      first,
      ...ordered.slice(1).map((part) => {
        const text = textOf(part.payload.content);
        return text.startsWith(prefix) ? text.slice(prefix.length) : text;
      }),
    ].join("\n");
    const last = ordered[ordered.length - 1].payload;
    return {
      id: ordered[0].id,
      payload: { ...ordered[0].payload, symbolId, content, endLine: last.endLine ?? ordered[0].payload.endLine },
    };
  });
}

function partNumber(point: MigrationOperationPoint): number {
  const symbolId = typeof point.payload.symbolId === "string" ? point.payload.symbolId : "";
  return Number(PART_SUFFIX.exec(symbolId)?.[1] ?? 0);
}

function toOperation(point: MigrationOperationPoint): RailsMigrationOperation {
  const { payload } = point;
  return {
    symbolId: textOf(payload.symbolId),
    ...(typeof payload.version === "string" ? { version: payload.version } : {}),
    operation: textOf(payload.operation),
    ...(typeof payload.direction === "string" ? { direction: payload.direction } : {}),
    ...(typeof payload.table === "string" ? { table: payload.table } : {}),
    columns: Array.isArray(payload.columns) ? payload.columns.map(String) : [],
    content: textOf(payload.content),
  };
}

export class MigrationCorpusQuery {
  constructor(
    private readonly qdrant: Pick<QdrantCollectionCatalog, "collectionExists"> &
      Pick<QdrantPointReader, "scrollFiltered" | "getPoint">,
    private readonly foldTable: RailsTableMigrationFold,
  ) {}

  /** `table:<name>` — the table's current state, or why there is none. */
  async tableState(migrationCollection: string, table: string): Promise<MigrationCorpusTableAnswer> {
    if (!(await this.ensureReadable(migrationCollection))) return { kind: "noCorpus" };
    const [onTable, executes] = await Promise.all([
      this.scroll(migrationCollection, { must: [{ key: "table", match: { value: table } }] }),
      // Raw SQL has no table in its payload; the ones naming the table are
      // reported as unfolded rather than silently missing.
      this.scroll(migrationCollection, { must: [{ key: "operation", match: { value: "execute" } }] }),
    ]);
    const mentioning = executes.filter((point) => textOf(point.payload.content).includes(table));
    const operations = reassembleOperations([...onTable, ...mentioning]).map(toOperation);
    if (operations.length === 0) return { kind: "noOperations" };
    return { kind: "state", state: this.foldTable(table, operations) };
  }

  /** `migration:<path>:<op>:<n>` — that operation's chunk, parts reassembled; empty when absent. */
  async operation(migrationCollection: string, symbolId: string): Promise<MigrationOperationPoint[]> {
    if (!(await this.ensureReadable(migrationCollection))) return [];
    const base = symbolId.replace(PART_SUFFIX, "");
    const relativePath = /^migration:(.*):[^:]+:\d+$/.exec(base)?.[1];
    if (!relativePath) return [];
    const points = await this.scroll(migrationCollection, {
      must: exactMatchOnTextIndexed("relativePath", relativePath),
    });
    return reassembleOperations(
      points.filter((point) => textOf(point.payload.symbolId).replace(PART_SUFFIX, "") === base),
    );
  }

  /** False when the corpus was never built; throws while an update is in flight, as `scope: "migrations"` does. */
  private async ensureReadable(migrationCollection: string): Promise<boolean> {
    if (!(await this.qdrant.collectionExists(migrationCollection))) return false;
    const marker = await this.qdrant.getPoint(migrationCollection, INDEXING_METADATA_ID);
    if (marker === null || (marker && marker.payload?.indexingComplete !== true)) {
      throw new Error("Migration corpus update is incomplete; retry indexing before reading migrations");
    }
    return true;
  }

  private async scroll(collection: string, filter: Record<string, unknown>): Promise<MigrationOperationPoint[]> {
    return this.qdrant.scrollFiltered(collection, filter, MIGRATION_SCROLL_LIMIT, undefined, OPERATION_PAYLOAD_KEYS);
  }
}
