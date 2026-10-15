#!/usr/bin/env tsx
/**
 * Edge-precision sampler and scorer for the residual live validation (bd
 * tea-rags-mcp-2m83f.24, section A).
 *
 *   npx tsx scripts/residual-sample.ts sample --project taxdome --n 200 --seed 1 --out /tmp/sample.jsonl
 *   npx tsx scripts/residual-sample.ts score /tmp/labelled.jsonl [--oracle /tmp/oracle.jsonl] [--target 0.93] [--json]
 *
 * sample: --from edges (default — the applied model edges, p >= the run's
 * threshold) | verdicts (latest verdict of every current site, any p — needed
 * for an honest sweep below the threshold). Each JSONL row carries the site
 * (method source window with the call line marked `>>`, receiver, menu,
 * chosen target, p) and `label: null` for the labeller to fill with the true
 * target symbol id, or "none" when no candidate is right. Optional
 * `spotLabel` = a second labeller's answer.
 * score: precision overall / per stratum / per dimension, 5-bin calibration
 * + ECE, sweep 0.5..0.95 with the recommended threshold, spot-check agreement,
 * and with --oracle (JSONL of {truth, menu, pick, p}) the recall proxy at
 * --threshold (default 0.7).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openResidualSources, resolveResidualSourcePaths } from "./lib/residual-graph-source.js";
import {
  calibration,
  menuBucket,
  pBucket,
  PRECISION_TARGET,
  recallProxy,
  receiverShape,
  scoreLabelledEdges,
  stratifiedSample,
  thresholdSweep,
  type LabelledEdge,
  type OracleSite,
} from "./lib/residual-sample-core.js";

/** Lines of method source kept around the call line. */
const SOURCE_WINDOW = 60;

interface SampledRow {
  site_key: string;
  source_rel_path: string;
  method_symbol_id: string;
  method_start_line: number | bigint;
  method_end_line: number | bigint;
  line: number | bigint;
  call_column: number | bigint;
  receiver_text: string;
  member: string;
  kind: string;
  candidates: string;
  menu_hash: string;
  chosen: string | null;
  p: number | null;
  model: string | null;
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const readJsonl = <T>(path: string): T[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);

/** The method's lines around the call (call line marked `>>`), and its head — the `def` the receiver's shape is judged from. */
function methodWindow(root: string | undefined, row: SampledRow): { window: string; head: string } {
  if (!root) return { window: "", head: "" };
  let text: string;
  try {
    text = readFileSync(join(root, row.source_rel_path), "utf8");
  } catch {
    return { window: "<source file missing>", head: "" };
  }
  const lines = text.split("\n");
  const start = Number(row.method_start_line);
  const end = Number(row.method_end_line);
  const call = Number(row.line);
  const from = Math.max(start, Math.min(call - SOURCE_WINDOW / 2, end - SOURCE_WINDOW + 1));
  const to = Math.min(end, from + SOURCE_WINDOW - 1);
  const window = lines.slice(from - 1, to).map((line, i) => `${from + i === call ? ">>" : "  "} ${from + i} ${line}`);
  return {
    window: `${from > start ? "   …\n" : ""}${window.join("\n")}${to < end ? "\n   …" : ""}`,
    head: lines.slice(start - 1, Math.min(end, start + 4)).join("\n"),
  };
}

async function readRows(
  from: string,
  graphRows: () => Promise<SampledRow[]>,
  verdictRows: () => Promise<SampledRow[]>,
) {
  if (from === "edges") return graphRows();
  if (from === "verdicts") return verdictRows();
  throw new Error(`--from must be edges or verdicts, got ${from}`);
}

async function sample(): Promise<void> {
  const paths = await resolveResidualSourcePaths({
    project: argValue("--project"),
    graphDb: argValue("--graph-db"),
    verdictDb: argValue("--verdict-db"),
    generation: argValue("--generation"),
    projectRoot: argValue("--project-root"),
  });
  const sources = await openResidualSources(paths);
  try {
    const siteColumns = `s.site_key, s.source_rel_path, s.method_symbol_id, s.method_start_line, s.method_end_line, s.line,
                         s.call_column, s.receiver_text, s.member, s.kind, s.candidates, s.menu_hash`;
    const rows = await readRows(
      argValue("--from") ?? "edges",
      async () =>
        sources.graph.queryAll<SampledRow>(
          `SELECT ${siteColumns}, e.target_symbol_id AS chosen, e.p, e.model
             FROM cg_symbols_edges_method e
             JOIN cg_residual_call_sites s ON s.site_key = e.site_key AND s.source_rel_path = e.source_rel_path
            WHERE e.origin = 'model'`,
        ),
      async () => {
        if (!sources.verdicts) throw new Error("the project has no verdict store");
        const sites = await sources.graph.queryAll<SampledRow>(
          `SELECT ${siteColumns}, NULL AS chosen, NULL AS p, NULL AS model
             FROM cg_residual_call_sites s WHERE NOT s.menu_overflow`,
        );
        const verdicts = await sources.verdicts.queryAll<{
          site_key: string;
          menu_hash: string;
          pick: string;
          p: number;
          model: string;
        }>(
          `SELECT site_key, menu_hash, pick, p, model FROM residual_verdicts
           QUALIFY row_number() OVER (PARTITION BY site_key, menu_hash ORDER BY created_at DESC, model_version DESC) = 1`,
        );
        const byKey = new Map(verdicts.map((v) => [`${v.site_key}\u0000${v.menu_hash}`, v]));
        return sites.flatMap((site) => {
          const v = byKey.get(`${site.site_key}\u0000${site.menu_hash}`);
          return v ? [{ ...site, chosen: v.pick, p: v.p, model: v.model }] : [];
        });
      },
    );
    const candidates = rows.map((row) => {
      const { window: source, head } = methodWindow(paths.projectRoot, row);
      const menu = JSON.parse(row.candidates) as string[];
      const shape = receiverShape(row.receiver_text, head);
      const p = row.p ?? 0;
      const stratum = [row.kind, pBucket(p), menuBucket(menu.length), shape].join("|");
      return {
        id: `${row.source_rel_path}#${row.site_key}`,
        stratum,
        kind: row.kind,
        pBucket: pBucket(p),
        menuBucket: menuBucket(menu.length),
        receiverShape: shape,
        siteKey: row.site_key,
        sourceRelPath: row.source_rel_path,
        line: Number(row.line),
        column: Number(row.call_column),
        methodSymbolId: row.method_symbol_id,
        receiverText: row.receiver_text,
        member: row.member,
        menu,
        chosen: row.chosen ?? "",
        p,
        model: row.model,
        source,
        label: null,
      };
    });
    const picked = stratifiedSample(candidates, Number(argValue("--n") ?? "200"), Number(argValue("--seed") ?? "1"));
    const jsonl = picked.map((row) => JSON.stringify(row)).join("\n");
    const out = argValue("--out");
    if (out) writeFileSync(out, `${jsonl}\n`);
    else process.stdout.write(`${jsonl}\n`);
    const strata = new Set(candidates.map((c) => c.stratum)).size;
    process.stderr.write(`pool ${candidates.length} in ${strata} strata -> sampled ${picked.length}\n`);
  } finally {
    await sources.close();
  }
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

function score(): void {
  const path = process.argv[3];
  if (!path) {
    throw new Error("usage: residual-sample.ts score <labelled.jsonl> [--oracle <jsonl>] [--target 0.93] [--json]");
  }
  const edges = readJsonl<LabelledEdge>(path);
  const target = Number(argValue("--target") ?? PRECISION_TARGET);
  const threshold = Number(argValue("--threshold") ?? "0.7");
  const oraclePath = argValue("--oracle");
  const report = {
    score: scoreLabelledEdges(edges),
    calibration: calibration(edges),
    sweep: thresholdSweep(edges, target),
    ...(oraclePath ? { recall: { threshold, ...recallProxy(readJsonl<OracleSite>(oraclePath), threshold) } } : {}),
  };
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const { score: s, calibration: c, sweep } = report;
  const lines = [
    `labelled ${s.labelled}  precision ${percent(s.precision)}  ECE ${c.ece.toFixed(3)}`,
    `spot-check agreement ${s.spotCheck.agree}/${s.spotCheck.n} (${percent(s.spotCheck.agreement)})`,
    "strata below 0.80:",
    ...Object.entries(s.byStratum)
      .filter(([, cell]) => cell.precision < 0.8)
      .map(([stratum, cell]) => `  ${stratum}  ${cell.correct}/${cell.n}`),
    ...Object.entries(s.byDimension).map(
      ([dimension, cells]) =>
        `${dimension}: ${Object.entries(cells)
          .map(([key, cell]) => `${key} ${percent(cell.precision)} (n=${cell.n})`)
          .join(", ")}`,
    ),
    "calibration:",
    ...c.bins.map(
      (bin) => `  [${bin.lo}, ${bin.hi})  n=${bin.n}  meanP ${bin.meanP.toFixed(3)}  acc ${bin.accuracy.toFixed(3)}`,
    ),
    "sweep:",
    ...sweep.rows.map(
      (row) =>
        `  p>=${row.threshold}  kept ${row.kept} (${percent(row.keptShare)})  precision ${percent(row.precision)}`,
    ),
    `recommended threshold (precision >= ${target}): ${sweep.recommended ?? "none"}`,
    ...(report.recall
      ? [
          `recall proxy @${report.recall.threshold}: ${report.recall.recovered}/${report.recall.eligible} ` +
            `(${percent(report.recall.recall)}), wrong edges ${report.recall.wrongEdges}`,
        ]
      : []),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "sample") return sample();
  if (command === "score") {
    score();
    return;
  }
  throw new Error("usage: residual-sample.ts sample|score ... (see the file header)");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
