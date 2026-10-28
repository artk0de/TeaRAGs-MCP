import { homedir } from "node:os";
import { join } from "node:path";

import { resolveRegistryEnvCodeDefaults } from "../../bootstrap/config/index.js";
import type { FootprintCensusRow } from "../../bootstrap/footprint-census.js";
import type { FootprintPurgeDeps } from "../../bootstrap/footprint-purge.js";
import {
  collectionHoldsCodegraphData,
  CollectionRegistry,
  ProjectRegistryOps,
  resolveDomainEnvCodeDefaults,
} from "../../core/api/index.js";
import { chunkPointsFilter, QdrantManager } from "../../core/api/public/index.js";

export interface FootprintDoctorArgs {
  json?: boolean;
  /** Purge what the census found; without it the run only reports. */
  fix?: boolean;
}

/** The purge saga's roles plus the census reads (chunk-filtered count, build-lease probe). */
type FootprintDoctorQdrant = FootprintPurgeDeps["qdrant"] & Pick<QdrantManager, "countPoints" | "getPoint">;

export interface FootprintDoctorDeps {
  qdrant: FootprintDoctorQdrant;
}

/** One table row's verdict: what the fix did, or would do, with the finding. */
type FootprintVerdict = "would purge" | "purged" | `kept — ${string}` | `failed — ${string}`;

interface FootprintVerdictRow {
  row: FootprintCensusRow;
  verdict: FootprintVerdict;
}

/** Store leftovers cleared between two progress lines on stderr. */
const STORE_LEFTOVER_PROGRESS_EVERY = 1000;

/** Rows printed per class before the table folds the rest into a count. */
const FOOTPRINT_ROWS_PER_CLASS = 20;

function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

function formatFootprintTable(rows: readonly FootprintVerdictRow[]): string {
  const header = ["class", "physical", "logical", "chunks", "size", "reason", "verdict"];
  const shown: string[][] = [];
  const folded = new Map<string, number>();
  const perClass = new Map<string, number>();
  for (const { row, verdict } of rows) {
    const seen = (perClass.get(row.findingClass) ?? 0) + 1;
    perClass.set(row.findingClass, seen);
    if (seen > FOOTPRINT_ROWS_PER_CLASS) {
      folded.set(row.findingClass, (folded.get(row.findingClass) ?? 0) + 1);
      continue;
    }
    shown.push([
      row.findingClass,
      row.physicalName ?? "-",
      row.logicalName,
      row.chunks === null ? "-" : String(row.chunks),
      formatBytes(row.bytesOnDisk),
      row.reason,
      verdict,
    ]);
  }
  const widths = header.map((h, i) => Math.max(h.length, ...shown.map((cells) => cells[i]?.length ?? 0)));
  const line = (cells: string[]): string =>
    `${cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd()}\n`;
  let out = line(header) + shown.map(line).join("");
  for (const [findingClass, count] of folded) {
    out += `… ${count} more ${findingClass} row(s) — 'tea-rags doctor --footprints --json' lists all\n`;
  }
  return out;
}

async function defaultQdrantClient(): Promise<QdrantManager> {
  const { parseAppConfig } = await import("../../bootstrap/config/index.js");
  const { resolveQdrantUrl } = await import("../../core/api/public/index.js");
  const config = parseAppConfig();
  const resolution = await resolveQdrantUrl(config.qdrantUrl, config.paths.appData);
  return new QdrantManager(resolution.url, config.qdrantApiKey);
}

/**
 * `tea-rags doctor --footprints [--fix]`: every collection footprint nothing
 * uses any more, as a review table; `--fix` purges each one through
 * `CollectionFootprintPurger` — a whole collection by logical name only when
 * nothing live answers to it, a stale generation of a live project by its
 * physical name (`purgeGeneration`). A registration leaves the registry only
 * once its purge reported no failure, so a failed sweep can be retried.
 */
export async function runFootprintDoctor(args: FootprintDoctorArgs, deps?: FootprintDoctorDeps): Promise<void> {
  const qdrant = deps?.qdrant ?? (await defaultQdrantClient());
  const appDataDir = resolveDataDir();
  const registry = new CollectionRegistry(appDataDir, {
    envCodeDefaults: () => resolveRegistryEnvCodeDefaults(resolveDomainEnvCodeDefaults()),
    codegraphDataProbe: collectionHoldsCodegraphData,
  });
  const ops = new ProjectRegistryOps({ registry });
  const { takeFootprintCensus } = await import("../../bootstrap/footprint-census.js");
  const rows = await takeFootprintCensus({
    qdrant: {
      listCollections: async () => qdrant.listCollections(),
      aliases: qdrant.aliases,
      getPoint: qdrant.getPoint.bind(qdrant),
      countPoints: async (name) => qdrant.countPoints(name, chunkPointsFilter()),
    },
    registry,
    appDataDir,
    isBuildInFlight: ops.isCollectionBuildInFlight.bind(ops),
  });

  const verdicts = args.fix
    ? await purgeFootprints(rows, qdrant, registry, appDataDir)
    : rows.map(
        (row): FootprintVerdictRow => ({
          row,
          verdict: row.blockedBy ? `kept — ${row.blockedBy}` : "would purge",
        }),
      );

  if (args.json) {
    const findings = verdicts.map(({ row, verdict }) => ({ ...row, verdict }));
    process.stdout.write(`${JSON.stringify({ fixed: args.fix === true, findings }, null, 2)}\n`);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write("(no unused collection footprints)\n");
    return;
  }
  process.stdout.write(formatFootprintTable(verdicts));
  if (!args.fix) {
    const purgeable = verdicts.filter((v) => v.verdict === "would purge").length;
    const total = formatBytes(rows.reduce((sum, row) => sum + row.bytesOnDisk, 0));
    process.stdout.write(
      `Dry run — nothing removed. Re-run 'tea-rags doctor --footprints --fix' to purge ${purgeable} footprint(s) (${total} on disk across all rows).\n`,
    );
    return;
  }
  const count = (prefix: string): number => verdicts.filter((v) => v.verdict.startsWith(prefix)).length;
  process.stdout.write(`Purged ${count("purged")} · kept ${count("kept")} · failed ${count("failed")}\n`);
}

async function purgeFootprints(
  rows: readonly FootprintCensusRow[],
  qdrant: FootprintDoctorQdrant,
  registry: CollectionRegistry,
  appDataDir: string,
): Promise<FootprintVerdictRow[]> {
  const { createCollectionFootprintPurger } = await import("../../bootstrap/footprint-purge.js");
  const { readStoreEntries } = await import("../../bootstrap/footprint-census.js");
  const purger = createCollectionFootprintPurger({ qdrant, registry, appDataDir });
  const verdictOf = new Map<FootprintCensusRow, FootprintVerdict>();
  const leftovers: FootprintCensusRow[] = [];
  for (const row of rows) {
    if (row.blockedBy) {
      verdictOf.set(row, `kept — ${row.blockedBy}`);
      continue;
    }
    if (row.findingClass === "store-leftover") {
      leftovers.push(row);
      continue;
    }
    const { action } = row;
    const report =
      action.kind === "generation"
        ? await purger.purgeGeneration({ logicalName: action.logicalName, physicalName: action.physicalName })
        : await purger.purge({ logicalName: action.logicalName, ...(action.path ? { path: action.path } : {}) });
    const [failure] = report.failures;
    if (failure) {
      verdictOf.set(row, `failed — ${failure.artifact} ${failure.target}: ${failure.reason}`);
      continue;
    }
    if (action.kind === "collection" && action.registryEntry) registry.remove(action.registryEntry);
    verdictOf.set(row, "purged");
  }

  // Store-only leftovers go in one batch: Qdrant is read once, not per name.
  if (leftovers.length > 0) {
    const report = await purger.purgeStoreLeftovers(
      leftovers.map((row) => row.logicalName),
      {
        progressEvery: STORE_LEFTOVER_PROGRESS_EVERY,
        onProgress: (done, total) => process.stderr.write(`store leftovers: ${done}/${total}\n`),
        storeEntries: readStoreEntries(appDataDir),
      },
    );
    const failureOf = new Map(report.failures.map((f) => [f.target, f]));
    for (const row of leftovers) {
      const failure = failureOf.get(row.logicalName);
      verdictOf.set(row, failure ? `failed — ${failure.artifact} ${failure.target}: ${failure.reason}` : "purged");
    }
  }
  // A row is purged only when no store file of its collection is left — read
  // back once, not trusted from the artifacts that reported success.
  const remaining = readStoreEntries(appDataDir);
  return rows.map((row) => {
    const verdict = verdictOf.get(row) ?? "purged";
    const left = row.action.kind === "collection" ? remaining.get(row.action.logicalName) : undefined;
    if (verdict !== "purged" || !left || left.length === 0) return { row, verdict };
    const sample = [...left].sort().slice(0, 3).join(", ");
    return { row, verdict: `failed — left ${left.length} file(s): ${sample}${left.length > 3 ? ", …" : ""}` };
  });
}
