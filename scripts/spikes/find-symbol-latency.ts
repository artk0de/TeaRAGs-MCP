/**
 * find-symbol-latency.ts (bd tea-rags-mcp-4qdj0)
 *
 * Times the REAL MCP server (spawned by stdio, the production path) on the
 * find_symbol call shapes the GruntWorx A bench actually issued against
 * taxdome-worktree-navmaster: single symbol, small/large `symbols[]` batches,
 * file outline, directory listing. Wall time per call, mean + max per shape.
 *
 * Usage:
 *   npx tsx scripts/spikes/find-symbol-latency.ts [--server <path to build/index.js>]
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = (() => {
  const i = process.argv.indexOf("--server");
  return i >= 0 ? process.argv[i + 1] : new URL("../../build/index.js", import.meta.url).pathname;
})();

const PROJECT = "taxdome-worktree-navmaster";
const PATH = "/Users/Shared/nav-ab/repo-master";

/** Real ids from the GruntWorx A proxy audit (largest batch = 17 ids). */
const BIG_BATCH = [
  "TaxPreparation::TaxAutomations::Instead::Connection",
  "TaxPreparation::TaxAutomations::Instead::Document",
  "TaxPreparation::TaxAutomations::Instead::Entity",
  "TaxPreparation::TaxAutomations::Connections::Create",
  "TaxPreparation::TaxAutomations::Connections::Disconnect",
  "TaxPreparation::TaxAutomations::Connections::Index",
  "TaxPreparation::TaxAutomations::Connections::Update",
  "TaxPreparation::TaxAutomations::ConnectionsController",
  "TaxPreparation::TaxAutomations::Document",
  "TaxPreparation::TaxAutomations::DocumentsController",
  "TaxPreparation::TaxAutomations::ExportAutomation",
  "TaxPreparation::TaxAutomations::ExportRun",
  "TaxPreparation::TaxAutomations::InstallersController",
  "TaxPreparation::TaxAutomations::Registry",
  "TaxPreparation::TaxAutomations::RunsController",
  "TaxPreparation::TaxAutomations::Schedule",
  "TaxPreparation::TaxAutomations::Task",
];

const SHAPES: [string, Record<string, unknown>][] = [
  ["single symbol", { symbol: "ApplicationController", project: PROJECT, path: PATH, limit: 5 }],
  ["single FQN", { symbol: "TaxPreparation::TaxAutomations::Registry", project: PROJECT, path: PATH }],
  ["batch 5", { symbols: BIG_BATCH.slice(0, 5), project: PROJECT, path: PATH }],
  ["batch 17", { symbols: BIG_BATCH, project: PROJECT, path: PATH }],
  [
    "batch 17 same",
    { symbols: Array.from({ length: 17 }, () => "ApplicationController"), project: PROJECT, path: PATH },
  ],
  [
    "file outline",
    { relativePath: "app/models/tax_preparation/tax_automations/registry.rb", project: PROJECT, path: PATH },
  ],
  ["dir listing", { relativePath: "app/models/tax_preparation/tax_automations", project: PROJECT, path: PATH }],
];

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      TEA_RAGS_LOG_LEVEL: process.env.TEA_RAGS_LOG_LEVEL ?? "error",
    },
  });
  const client = new Client({ name: "find-symbol-latency-spike", version: "0.0.0" });
  await client.connect(transport);
  process.stderr.write("server connected\n");

  const REPEATS = Number(process.env.REPEATS ?? 5);
  // Warm-up: first call pays registry/embedding/attach cold costs once.
  await client.callTool({
    name: "find_symbol",
    arguments: { symbol: "ApplicationController", project: PROJECT, path: PATH, limit: 3 },
  });

  for (const [label, args] of SHAPES) {
    const times: number[] = [];
    for (let i = 0; i < REPEATS; i++) {
      const t0 = performance.now();
      const res = await client.callTool({ name: "find_symbol", arguments: args });
      const dt = performance.now() - t0;
      times.push(dt);
      if (res.isError) throw new Error(`${label} call failed: ${JSON.stringify(res.content).slice(0, 200)}`);
    }
    const mean = times.reduce((s, t) => s + t, 0) / times.length;
    const max = Math.max(...times);
    console.log(
      `${label.padEnd(14)} mean ${mean.toFixed(0).padStart(5)}ms  max ${max.toFixed(0).padStart(5)}ms  (n=${REPEATS}: ${times.map((t) => t.toFixed(0)).join(", ")})`,
    );
  }
  await client.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
