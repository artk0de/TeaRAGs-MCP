#!/usr/bin/env tsx
/**
 * Read-only probe of residual resolution state for the live validation (bd
 * tea-rags-mcp-2m83f.24). Never writes: the graph and the verdict store open
 * READ_ONLY, a daemon-held graph is read through a daemon snapshot.
 *
 *   npx tsx scripts/residual-probe.ts snapshot --project taxdome --label b1 --out /tmp/b1.json
 *   npx tsx scripts/residual-probe.ts snapshot --graph-db <file.duckdb> [--verdict-db <file.duckdb>] [--project-root <dir>]
 *   npx tsx scripts/residual-probe.ts diff /tmp/b1.json /tmp/b2.json --scenario B2
 *
 * snapshot flags: --threshold <p> (default 0.7)  --hubs <n> (default 20)  --generation <code_x_vN>
 *                 --codegraph-root <dir>  --no-disk-check
 *                 --build <dir>  compiled build the daemon client loads from (default ./build; run `npm run build` first)
 * diff: prints the delta JSON, then one PASS/FAIL line per scenario check; exit 1 on any FAIL.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openResidualSources, resolveResidualSourcePaths } from "./lib/residual-graph-source.js";
import {
  diffResidualSnapshots,
  evaluateScenario,
  formatScenarioChecks,
  SCENARIO_IDS,
  takeResidualSnapshot,
  type ResidualSnapshot,
} from "./lib/residual-probe-core.js";

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_HUBS = 20;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function snapshot(): Promise<void> {
  const paths = await resolveResidualSourcePaths({
    project: argValue("--project"),
    graphDb: argValue("--graph-db"),
    verdictDb: argValue("--verdict-db"),
    generation: argValue("--generation"),
    projectRoot: argValue("--project-root"),
    codegraphRoot: argValue("--codegraph-root"),
  });
  const sources = await openResidualSources(paths, { buildDir: argValue("--build") });
  const root = process.argv.includes("--no-disk-check") ? undefined : paths.projectRoot;
  try {
    const state = await takeResidualSnapshot({
      graph: sources.graph,
      verdicts: sources.verdicts,
      now: Date.now(),
      threshold: Number(argValue("--threshold") ?? DEFAULT_THRESHOLD),
      hubLimit: Number(argValue("--hubs") ?? DEFAULT_HUBS),
      ...(root ? { fileExists: (relPath: string) => existsSync(join(root, relPath)) } : {}),
      ...(argValue("--label") ? { label: argValue("--label") } : {}),
    });
    const out: ResidualSnapshot = {
      ...state,
      source: { graphDb: paths.graphDb, verdictDb: paths.verdictDb, readVia: sources.readVia },
    };
    const json = `${JSON.stringify(out, null, 2)}\n`;
    const target = argValue("--out");
    if (target) writeFileSync(target, json);
    else process.stdout.write(json);
    const { edgeKeys: _keys, ...edgeSummary } = out.modelEdges;
    process.stderr.write(
      `residual sites ${out.residualSites.total} (overflow ${out.residualSites.menuOverflow}), model edges ${edgeSummary.total} ` +
        `[${edgeSummary.edgeSetHash}], orphans ${out.orphans.total}, verdicts ${out.verdicts?.rows ?? "none"}, ` +
        `derived stale ${String(out.derived.stale)}, read via ${sources.readVia}\n`,
    );
  } finally {
    await sources.close();
  }
}

const readSnapshot = (path: string): ResidualSnapshot => JSON.parse(readFileSync(path, "utf8")) as ResidualSnapshot;

function diff(): void {
  const [, , , beforePath, afterPath] = process.argv;
  if (!beforePath || !afterPath) {
    throw new Error(`usage: residual-probe.ts diff <before.json> <after.json> [--scenario ${SCENARIO_IDS.join("|")}]`);
  }
  const before = readSnapshot(beforePath);
  const after = readSnapshot(afterPath);
  const delta = diffResidualSnapshots(before, after);
  process.stdout.write(
    `${JSON.stringify(
      { ...delta, edgesAdded: delta.edgesAdded.slice(0, 20), edgesRemoved: delta.edgesRemoved.slice(0, 20) },
      null,
      2,
    )}\n`,
  );
  const scenario = argValue("--scenario");
  if (!scenario) return;
  const checks = evaluateScenario(scenario, before, after);
  process.stdout.write(formatScenarioChecks(checks));
  if (checks.some((c) => !c.pass)) process.exitCode = 1;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "snapshot") return snapshot();
  if (command === "diff") {
    diff();
    return;
  }
  throw new Error("usage: residual-probe.ts snapshot|diff ... (see the file header)");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
