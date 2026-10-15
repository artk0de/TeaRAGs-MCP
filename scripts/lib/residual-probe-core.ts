/**
 * Read-only state of residual resolution in one codegraph database and its
 * verdict store (bd tea-rags-mcp-2m83f.24, sections B and C): residual rows,
 * model edges, orphaned model edges, verdict-store age and coverage, the
 * derived-stale marker and the most-called targets — plus the diff of two
 * snapshots and the per-scenario checks over it.
 */
import { createHash } from "node:crypto";

import { pBucket } from "./residual-sample-core.js";

/** What the probe needs of a DuckDB connection — `DuckDbGraphSession` opened READ_ONLY. */
export interface ResidualStateReader {
  queryAll: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
}

export interface OrphanSample {
  siteKey: string | null;
  sourceRelPath: string;
  sourceSymbolId: string;
  targetSymbolId: string;
}

type OrphanKind =
  | "sourceFileMissing"
  | "targetSymbolMissing"
  | "targetPathStale"
  | "siteNotResidual"
  | "siteOverflow"
  | "targetNotInMenu";

export interface ResidualSnapshot {
  takenAt: number;
  label?: string;
  /** The threshold `verdicts.keptAtThreshold` was counted at. */
  threshold: number;
  source?: { graphDb: string; verdictDb: string | null; readVia: "direct" | "daemon-snapshot" };
  residualSites: {
    total: number;
    byKind: Record<string, number>;
    menuOverflow: number;
    distinctMenuHashes: number;
  };
  modelEdges: {
    total: number;
    byModel: Record<string, number>;
    byPBucket: Record<string, number>;
    /** sha256 over the sorted edge keys — equal hash, equal edge set. */
    edgeSetHash: string;
    /** `source_rel_path|source_symbol_id|call_expression|target_symbol_id|model`, sorted. */
    edgeKeys: string[];
  };
  orphans: {
    total: number;
    /** Source file has no `cg_symbols_files` row. */
    sourceFileMissing: number;
    /** Source file absent from the project tree; null when no tree was given. */
    sourceFileMissingOnDisk: number | null;
    /** No `cg_symbols` row declares the target id. */
    targetSymbolMissing: number;
    /** The id survives elsewhere but not at the edge's `target_rel_path`. */
    targetPathStale: number;
    /** No residual row carries the edge's site key in its source file. */
    siteNotResidual: number;
    siteOverflow: number;
    targetNotInMenu: number;
    samples: Record<OrphanKind, OrphanSample[]>;
  };
  /** Null when the project has no verdict store. */
  verdicts: {
    rows: number;
    distinctModels: number;
    byModel: Record<string, number>;
    oldestCreatedAt: number | null;
    newestCreatedAt: number | null;
    oldestLastSeenAt: number | null;
    newestLastSeenAt: number | null;
    /** Current non-overflow sites with a verdict on their current menu hash. */
    sitesCovered: number;
    sitesUncovered: number;
    /** Covered sites whose latest verdict reaches `threshold` and picks from the menu — the edges a cache-only re-apply would write. */
    keptAtThreshold: number;
    /** Model edges whose site has no verdict on its current menu. */
    edgesWithoutVerdict: number;
  } | null;
  derived: { stale: boolean; metricsRows: number; cycleRows: number };
  hubs: { symbolId: string; staticFanIn: number; modelFanIn: number; pageRank: number }[];
}

export interface SnapshotInput {
  graph: ResidualStateReader;
  verdicts?: ResidualStateReader;
  now: number;
  threshold: number;
  hubLimit: number;
  /** Whether a project-relative path exists in the working tree. */
  fileExists?: (relPath: string) => boolean;
  label?: string;
}

const SAMPLE_LIMIT = 5;

interface SiteRow {
  site_key: string;
  source_rel_path: string;
  kind: string;
  candidates: string;
  menu_hash: string;
  menu_overflow: boolean;
}

interface ModelEdgeDbRow {
  source_rel_path: string;
  source_symbol_id: string;
  call_expression: string;
  target_symbol_id: string;
  target_rel_path: string;
  model: string;
  p: number | null;
  site_key: string | null;
  file_known: boolean;
  symbol_known: boolean;
  symbol_at_path: boolean;
}

interface VerdictDbRow {
  site_key: string;
  menu_hash: string;
  model: string;
  pick: string;
  p: number;
  created_at: number | bigint;
  last_seen_at: number | bigint;
}

const tally = (values: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
};

const count = async (reader: ResidualStateReader, sql: string): Promise<number> =>
  Number((await reader.queryAll<{ n: number | bigint }>(sql))[0]?.n ?? 0);

const siteId = (relPath: string, siteKey: string): string => `${relPath}\u0000${siteKey}`;

function orphansOf(
  edges: readonly ModelEdgeDbRow[],
  sites: ReadonlyMap<string, SiteRow>,
  fileExists?: (relPath: string) => boolean,
): ResidualSnapshot["orphans"] {
  const samples: Record<OrphanKind, OrphanSample[]> = {
    sourceFileMissing: [],
    targetSymbolMissing: [],
    targetPathStale: [],
    siteNotResidual: [],
    siteOverflow: [],
    targetNotInMenu: [],
  };
  const counts: Record<OrphanKind, number> = {
    sourceFileMissing: 0,
    targetSymbolMissing: 0,
    targetPathStale: 0,
    siteNotResidual: 0,
    siteOverflow: 0,
    targetNotInMenu: 0,
  };
  let orphaned = 0;
  let missingOnDisk = 0;
  for (const edge of edges) {
    const site = edge.site_key === null ? undefined : sites.get(siteId(edge.source_rel_path, edge.site_key));
    const kinds: OrphanKind[] = [];
    if (!edge.file_known) kinds.push("sourceFileMissing");
    if (!edge.symbol_known) kinds.push("targetSymbolMissing");
    else if (!edge.symbol_at_path) kinds.push("targetPathStale");
    if (site === undefined) kinds.push("siteNotResidual");
    else if (site.menu_overflow) kinds.push("siteOverflow");
    else if (!(JSON.parse(site.candidates) as string[]).includes(edge.target_symbol_id)) kinds.push("targetNotInMenu");
    if (fileExists && !fileExists(edge.source_rel_path)) missingOnDisk++;
    if (kinds.length > 0) orphaned++;
    for (const kind of kinds) {
      counts[kind]++;
      if (samples[kind].length < SAMPLE_LIMIT) {
        samples[kind].push({
          siteKey: edge.site_key,
          sourceRelPath: edge.source_rel_path,
          sourceSymbolId: edge.source_symbol_id,
          targetSymbolId: edge.target_symbol_id,
        });
      }
    }
  }
  return {
    total: orphaned,
    ...counts,
    sourceFileMissingOnDisk: fileExists ? missingOnDisk : null,
    samples,
  };
}

/** Latest verdict per `(site_key, menu_hash)` — the one a re-apply reads. */
function latestVerdicts(rows: readonly VerdictDbRow[]): Map<string, VerdictDbRow> {
  const latest = new Map<string, VerdictDbRow>();
  for (const row of rows) {
    const key = `${row.site_key}\u0000${row.menu_hash}`;
    const held = latest.get(key);
    if (held === undefined || Number(row.created_at) > Number(held.created_at)) latest.set(key, row);
  }
  return latest;
}

async function verdictState(
  reader: ResidualStateReader,
  sites: readonly SiteRow[],
  edges: readonly ModelEdgeDbRow[],
  threshold: number,
): Promise<NonNullable<ResidualSnapshot["verdicts"]>> {
  const rows = await reader.queryAll<VerdictDbRow>(
    "SELECT site_key, menu_hash, model, pick, p, created_at, last_seen_at FROM residual_verdicts",
  );
  const latest = latestVerdicts(rows);
  const live = sites.filter((site) => !site.menu_overflow);
  const covered = live.filter((site) => latest.has(`${site.site_key}\u0000${site.menu_hash}`));
  const kept = covered.filter((site) => {
    const v = latest.get(`${site.site_key}\u0000${site.menu_hash}`);
    return v !== undefined && v.p >= threshold && (JSON.parse(site.candidates) as string[]).includes(v.pick);
  });
  const menuOf = new Map(sites.map((site) => [siteId(site.source_rel_path, site.site_key), site.menu_hash]));
  const edgesWithoutVerdict = edges.filter((edge) => {
    const menu = edge.site_key === null ? undefined : menuOf.get(siteId(edge.source_rel_path, edge.site_key));
    return menu === undefined || !latest.has(`${edge.site_key}\u0000${menu}`);
  }).length;
  const times = (pick: (row: VerdictDbRow) => number | bigint): number[] => rows.map((row) => Number(pick(row)));
  const created = times((row) => row.created_at);
  const seen = times((row) => row.last_seen_at);
  const byModel = tally(rows.map((row) => row.model));
  return {
    rows: rows.length,
    distinctModels: Object.keys(byModel).length,
    byModel,
    oldestCreatedAt: created.length ? Math.min(...created) : null,
    newestCreatedAt: created.length ? Math.max(...created) : null,
    oldestLastSeenAt: seen.length ? Math.min(...seen) : null,
    newestLastSeenAt: seen.length ? Math.max(...seen) : null,
    sitesCovered: covered.length,
    sitesUncovered: live.length - covered.length,
    keptAtThreshold: kept.length,
    edgesWithoutVerdict,
  };
}

async function hubsOf(graph: ResidualStateReader, limit: number): Promise<ResidualSnapshot["hubs"]> {
  const rows = await graph.queryAll<{
    symbol_id: string;
    static_fan_in: number | bigint;
    model_fan_in: number | bigint;
    page_rank: number | null;
  }>(
    `SELECT e.target_symbol_id AS symbol_id,
            COUNT(*) FILTER (WHERE e.origin IS NULL) AS static_fan_in,
            COUNT(*) FILTER (WHERE e.origin = 'model') AS model_fan_in,
            (SELECT MAX(m.page_rank) FROM cg_symbols_metrics m WHERE m.symbol_id = e.target_symbol_id) AS page_rank
       FROM cg_symbols_edges_method e
      WHERE e.target_symbol_id IS NOT NULL
      GROUP BY e.target_symbol_id
      ORDER BY COUNT(*) DESC, e.target_symbol_id
      LIMIT ${Math.max(0, Math.floor(limit))}`,
  );
  return rows.map((row) => ({
    symbolId: row.symbol_id,
    staticFanIn: Number(row.static_fan_in),
    modelFanIn: Number(row.model_fan_in),
    pageRank: Number(row.page_rank ?? 0),
  }));
}

/** A graph last opened by a build before migrations 053/054 has neither the residual table nor edge provenance. */
async function assertResidualSchema(graph: ResidualStateReader): Promise<void> {
  const present = await graph.queryAll<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_name = 'cg_residual_call_sites'
     UNION ALL
     SELECT 'origin' FROM information_schema.columns WHERE table_name = 'cg_symbols_edges_method' AND column_name = 'origin'`,
  );
  if (present.length < 2) {
    throw new Error(
      "the graph predates the residual schema (migrations 053/054 not applied) — open it once with this build " +
        "(any index-codebase run) before probing",
    );
  }
}

export async function takeResidualSnapshot(input: SnapshotInput): Promise<ResidualSnapshot> {
  const { graph } = input;
  await assertResidualSchema(graph);
  const sites = await graph.queryAll<SiteRow>(
    "SELECT site_key, source_rel_path, kind, candidates, menu_hash, menu_overflow FROM cg_residual_call_sites",
  );
  const edges = await graph.queryAll<ModelEdgeDbRow>(
    `SELECT e.source_rel_path, e.source_symbol_id, e.call_expression, e.target_symbol_id, e.target_rel_path,
            e.model, e.p, e.site_key,
            EXISTS (SELECT 1 FROM cg_symbols_files f WHERE f.rel_path = e.source_rel_path) AS file_known,
            EXISTS (SELECT 1 FROM cg_symbols s WHERE s.symbol_id = e.target_symbol_id) AS symbol_known,
            EXISTS (SELECT 1 FROM cg_symbols s
                     WHERE s.symbol_id = e.target_symbol_id AND s.rel_path = e.target_rel_path) AS symbol_at_path
       FROM cg_symbols_edges_method e
      WHERE e.origin = 'model'`,
  );
  const siteIndex = new Map(sites.map((site) => [siteId(site.source_rel_path, site.site_key), site]));
  const edgeKeys = edges
    .map((e) => [e.source_rel_path, e.source_symbol_id, e.call_expression, e.target_symbol_id, e.model].join("|"))
    .sort();
  return {
    takenAt: input.now,
    ...(input.label ? { label: input.label } : {}),
    threshold: input.threshold,
    residualSites: {
      total: sites.length,
      byKind: tally(sites.map((site) => site.kind)),
      menuOverflow: sites.filter((site) => site.menu_overflow).length,
      distinctMenuHashes: new Set(sites.map((site) => site.menu_hash)).size,
    },
    modelEdges: {
      total: edges.length,
      byModel: tally(edges.map((edge) => edge.model)),
      byPBucket: tally(edges.map((edge) => pBucket(edge.p ?? 0))),
      edgeSetHash: createHash("sha256").update(edgeKeys.join("\n")).digest("hex").slice(0, 16),
      edgeKeys,
    },
    orphans: orphansOf(edges, siteIndex, input.fileExists),
    verdicts: input.verdicts ? await verdictState(input.verdicts, sites, edges, input.threshold) : null,
    derived: {
      stale: (await count(graph, "SELECT COUNT(*) AS n FROM cg_derived_stale")) > 0,
      metricsRows: await count(graph, "SELECT COUNT(*) AS n FROM cg_symbols_metrics"),
      cycleRows: await count(graph, "SELECT COUNT(*) AS n FROM cg_symbols_cycles"),
    },
    hubs: await hubsOf(graph, input.hubLimit),
  };
}

export interface SnapshotDiff {
  residualSitesDelta: number;
  menuOverflowDelta: number;
  modelEdgesDelta: number;
  verdictRowsDelta: number | null;
  /** Verdicts written after the earlier snapshot was taken (newest `created_at` moved past it). */
  newVerdictsWritten: boolean | null;
  edgeSetUnchanged: boolean;
  edgesAdded: string[];
  edgesRemoved: string[];
  fanInShifts: { symbolId: string; before: number; after: number; delta: number }[];
}

const FAN_IN_SHIFT_LIMIT = 10;

export function diffResidualSnapshots(before: ResidualSnapshot, after: ResidualSnapshot): SnapshotDiff {
  const had = new Set(before.modelEdges.edgeKeys);
  const has = new Set(after.modelEdges.edgeKeys);
  const fanIn = (snapshot: ResidualSnapshot): Map<string, number> =>
    new Map(snapshot.hubs.map((hub) => [hub.symbolId, hub.staticFanIn + hub.modelFanIn]));
  const fanBefore = fanIn(before);
  const fanAfter = fanIn(after);
  const fanInShifts = [...new Set([...fanBefore.keys(), ...fanAfter.keys()])]
    .map((symbolId) => {
      const b = fanBefore.get(symbolId) ?? 0;
      const a = fanAfter.get(symbolId) ?? 0;
      return { symbolId, before: b, after: a, delta: a - b };
    })
    .filter((shift) => shift.delta !== 0)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.symbolId.localeCompare(y.symbolId))
    .slice(0, FAN_IN_SHIFT_LIMIT);
  const bothVerdicts = before.verdicts !== null && after.verdicts !== null;
  return {
    residualSitesDelta: after.residualSites.total - before.residualSites.total,
    menuOverflowDelta: after.residualSites.menuOverflow - before.residualSites.menuOverflow,
    modelEdgesDelta: after.modelEdges.total - before.modelEdges.total,
    verdictRowsDelta: bothVerdicts ? (after.verdicts?.rows ?? 0) - (before.verdicts?.rows ?? 0) : null,
    newVerdictsWritten: after.verdicts === null ? null : (after.verdicts.newestCreatedAt ?? 0) > before.takenAt,
    edgeSetUnchanged: before.modelEdges.edgeSetHash === after.modelEdges.edgeSetHash,
    edgesAdded: [...has].filter((key) => !had.has(key)),
    edgesRemoved: [...had].filter((key) => !has.has(key)),
    fanInShifts,
  };
}

export interface ScenarioCheck {
  scenario: string;
  check: string;
  pass: boolean;
  detail: string;
}

type Check = (before: ResidualSnapshot, after: ResidualSnapshot, diff: SnapshotDiff) => Omit<ScenarioCheck, "scenario">;

const check =
  (
    name: string,
    holds: (b: ResidualSnapshot, a: ResidualSnapshot, d: SnapshotDiff) => boolean,
    detail: (b: ResidualSnapshot, a: ResidualSnapshot, d: SnapshotDiff) => string,
  ): Check =>
  (b, a, d) => ({ check: name, pass: holds(b, a, d), detail: detail(b, a, d) });

const noOrphans = check(
  "no orphan model edges",
  (_b, a) => a.orphans.total === 0 && (a.orphans.sourceFileMissingOnDisk ?? 0) === 0,
  (_b, a) =>
    `orphans=${a.orphans.total} (file ${a.orphans.sourceFileMissing}, disk ${a.orphans.sourceFileMissingOnDisk ?? "n/a"}, ` +
    `target ${a.orphans.targetSymbolMissing}, stalePath ${a.orphans.targetPathStale}, site ${a.orphans.siteNotResidual}, ` +
    `overflow ${a.orphans.siteOverflow}, offMenu ${a.orphans.targetNotInMenu})`,
);
const edgesBackedByVerdicts = check(
  "every model edge backed by a verdict on its current menu",
  (_b, a) => a.verdicts === null || a.verdicts.edgesWithoutVerdict === 0,
  (_b, a) => `edgesWithoutVerdict=${a.verdicts?.edgesWithoutVerdict ?? "n/a"}`,
);
const edgeSetUnchanged = check(
  "edge set unchanged",
  (_b, _a, d) => d.edgeSetUnchanged,
  (b, a, d) =>
    `hash ${b.modelEdges.edgeSetHash} -> ${a.modelEdges.edgeSetHash}, +${d.edgesAdded.length} -${d.edgesRemoved.length}`,
);
const noNewVerdicts = check(
  "no new verdicts (0 Kev questions)",
  (_b, _a, d) => d.verdictRowsDelta === 0 && d.newVerdictsWritten === false,
  (_b, _a, d) => `rowsDelta=${d.verdictRowsDelta ?? "n/a"}, newestCreatedAfterBefore=${String(d.newVerdictsWritten)}`,
);
const newVerdict = check(
  "at least one new verdict",
  (_b, _a, d) => d.newVerdictsWritten === true,
  (_b, _a, d) => `rowsDelta=${d.verdictRowsDelta ?? "n/a"}, newestCreatedAfterBefore=${String(d.newVerdictsWritten)}`,
);
const fewerResidualRows = check(
  "fewer residual rows",
  (_b, _a, d) => d.residualSitesDelta < 0,
  (_b, _a, d) => `residualSitesDelta=${d.residualSitesDelta}`,
);
const sameResidualRows = check(
  "residual row count unchanged",
  (_b, _a, d) => d.residualSitesDelta === 0,
  (_b, _a, d) => `residualSitesDelta=${d.residualSitesDelta}`,
);
const fewerModelEdges = check(
  "fewer model edges",
  (_b, _a, d) => d.modelEdgesDelta < 0,
  (_b, _a, d) => `modelEdgesDelta=${d.modelEdgesDelta}, removed ${d.edgesRemoved.slice(0, 3).join("; ")}`,
);
const edgesMatchStoredP = check(
  "model edges = verdicts kept at the threshold (re-filtered from stored p)",
  (_b, a) => a.verdicts !== null && a.modelEdges.total === a.verdicts.keptAtThreshold,
  (_b, a) => `edges=${a.modelEdges.total}, keptAtThreshold(${a.threshold})=${a.verdicts?.keptAtThreshold ?? "n/a"}`,
);
const derivedFresh = check(
  "derived tables not stale",
  (_b, a) => !a.derived.stale,
  (_b, a) => `stale=${String(a.derived.stale)}, metricsRows=${a.derived.metricsRows}`,
);
const noResidualPass = check(
  "no residual rows, no model edges",
  (_b, a) => a.residualSites.total === 0 && a.modelEdges.total === 0,
  (_b, a) => `residualSites=${a.residualSites.total}, modelEdges=${a.modelEdges.total}`,
);
const overflowWithoutEdges = check(
  "overflowing sites carry no edge",
  (_b, a) => a.orphans.siteOverflow === 0,
  (_b, a) => `menuOverflow=${a.residualSites.menuOverflow}, edgesOnOverflow=${a.orphans.siteOverflow}`,
);

/**
 * Checks each scenario adds over the always-on invariants (no orphans, every
 * edge backed by a verdict). `before` is the snapshot the scenario starts from
 * — for B8/B9 the B1 baseline, so "counts equal to scenario 1" is the edge-set
 * check.
 */
const SCENARIO_CHECKS: Record<string, readonly Check[]> = {
  B1: [derivedFresh],
  B2: [edgeSetUnchanged, noNewVerdicts, sameResidualRows],
  B3: [edgeSetUnchanged, noNewVerdicts],
  B4: [newVerdict],
  B5: [fewerResidualRows, fewerModelEdges],
  B6: [fewerResidualRows, fewerModelEdges],
  B7: [sameResidualRows],
  B8: [edgeSetUnchanged, noNewVerdicts, sameResidualRows, derivedFresh],
  B9: [edgeSetUnchanged, noNewVerdicts, sameResidualRows, derivedFresh],
  B10: [edgeSetUnchanged],
  B11: [edgeSetUnchanged, noNewVerdicts],
  B12: [noResidualPass],
  C1: [derivedFresh],
  C2: [],
  C3: [],
  C5: [overflowWithoutEdges],
  C9: [],
  C10: [edgesMatchStoredP, noNewVerdicts],
};

export const SCENARIO_IDS = Object.keys(SCENARIO_CHECKS);

export function evaluateScenario(scenario: string, before: ResidualSnapshot, after: ResidualSnapshot): ScenarioCheck[] {
  const checks = SCENARIO_CHECKS[scenario];
  if (checks === undefined) {
    throw new Error(`unknown scenario ${scenario}; known: ${SCENARIO_IDS.join(", ")}`);
  }
  const diff = diffResidualSnapshots(before, after);
  const always = scenario === "B12" ? [] : [noOrphans, edgesBackedByVerdicts];
  return [...always, ...checks].map((run) => ({ scenario, ...run(before, after, diff) }));
}

export function formatScenarioChecks(checks: readonly ScenarioCheck[]): string {
  return checks.map((c) => `${c.pass ? "PASS" : "FAIL"} ${c.scenario} ${c.check} — ${c.detail}\n`).join("");
}
