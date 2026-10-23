/**
 * Eval gate for the columnar response shape (zn0fg).
 *
 * Each arm = a checkout root holding `build/` (the MCP server) and
 * `.claude-plugin/tea-rags` (the guidance the agent loads). Per case the agent
 * makes one prescribed tea-rags call through Claude Code — so the answer reaches
 * it exactly as in a session — and reads a value off it. Truth comes from the
 * same call made directly against that arm's build, read through the record
 * view (column tables folded back into records), so both arms grade alike.
 *
 *   ARMS="row=/abs/base,columnar=/abs/worktree" TREE=/abs/worktree RUNS=3 CONC=4 \
 *     npx tsx scripts/columnar-response-eval.ts
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { foldColumnTables } from "../src/core/api/index.js";

interface Case {
  id: string;
  call: string;
  question: string;
  grade: "exact" | "number" | "set" | "braceSet";
  separator?: string;
}

interface ResultRow {
  score: number;
  payload: {
    relativePath: string;
    symbolId: string;
    parentSymbolId: string;
    chunkType: string;
    startLine: number;
    endLine: number;
  };
  rankingOverlay: { chunk: Record<string, { label: string }> };
}

/** Record view of any case answer; each truth reader touches only its own tool's fields. */
interface Answer {
  results: ResultRow[];
  workingTree: { changedFiles: number };
  callers: { sourceRelPath: string; callExpression: string }[];
  paths: { steps: { relativePath: string }[] }[];
}

type CallTool = (tool: string, args: Record<string, unknown>) => Promise<Answer>;

function rowIn(answer: Answer, relativePath: string): ResultRow {
  const row = answer.results.find((r) => r.payload.relativePath === relativePath);
  if (!row) throw new Error(`no result in ${relativePath}`);
  return row;
}

/** Truth per case id, read off the record view of the case's call (`d`). */
const TRUTH: Record<string, (d: Answer, call: CallTool) => Promise<unknown>> = {
  "row-field": async (d) => d.results[2].payload.relativePath,
  score: async (d) => Math.round(d.results[1].score * 1000) / 1000,
  "overlay-label": async (d) => d.results[3].rankingOverlay.chunk.bugFixRate.label,
  "part-parent": async (d, call) =>
    (await call("find_symbol", { symbol: d.results[4].payload.parentSymbolId })).results[0].payload.endLine,
  // A short name can live in several files: keep the hit from row 4's own file.
  "drill-symbol": async (d, call) =>
    rowIn(await call("find_symbol", { symbol: d.results[3].payload.symbolId }), d.results[3].payload.relativePath)
      .payload.startLine,
  "path-pattern": async (d) => [...new Set(d.results.slice(0, 5).map((r) => r.payload.relativePath))],
  "filter-column": async (d) =>
    d.results.filter((r) => r.payload.chunkType === "function").map((r) => r.payload.symbolId),
  "distinct-files": async (d) => new Set(d.results.map((r) => r.payload.relativePath)).size,
  envelope: async (d) => `${d.workingTree.changedFiles}|${d.results[0].payload.relativePath}`,
  "callers-field": async (d) => d.callers[3].sourceRelPath,
  "callers-filter": async (d) =>
    d.callers.filter((c) => c.sourceRelPath.endsWith("collection.ts")).map((c) => c.callExpression),
  "trace-step": async (d) => d.paths[0].steps[d.paths[0].steps.length - 1].relativePath,
};

interface Suite {
  calls: Record<string, [string, Record<string, unknown>]>;
  cases: Case[];
}

const here = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../.claude-plugin/.benchmarks/columnar-response",
);
const suite = JSON.parse(fs.readFileSync(path.join(here, "cases.json"), "utf8")) as Suite;
const only = process.env.CASES?.split(",");
if (only) suite.cases = suite.cases.filter((c) => only.includes(c.id));
const tree = required("TREE");
const runs = Number(process.env.RUNS ?? 3);
const concurrency = Number(process.env.CONC ?? 4);
const outDir = process.env.OUT ?? path.join(here, "results");
const arms = required("ARMS")
  .split(",")
  .map((pair) => {
    const [name, root] = pair.split("=");
    return { name, root };
  });

const serverEnv = (
  JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8")) as {
    mcpServers: Record<string, { env?: Record<string, string> }>;
  }
).mcpServers["tea-rags"].env;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function serverConfig(root: string) {
  return {
    command: "node",
    args: [path.join(root, "build/cli/index.js"), "server"],
    env: { ...serverEnv, DEBUG: "" },
  };
}

async function computeTruth(root: string): Promise<Record<string, unknown>> {
  const cfg = serverConfig(root);
  const client = new Client({ name: "columnar-eval", version: "0" });
  await client.connect(
    new StdioClientTransport({
      ...cfg,
      env: { ...(process.env as Record<string, string>), ...cfg.env },
      stderr: "ignore",
    }),
  );
  const call: CallTool = async (tool, args) => {
    const res = await client.callTool(
      { name: tool, arguments: { project: "tea-rags", path: tree, ...args } },
      undefined,
      { timeout: 180_000 },
    );
    const text = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");
    return foldColumnTables(res.structuredContent ?? JSON.parse(text)) as Answer;
  };
  const answers: Record<string, Answer> = {};
  for (const [key, [tool, args]] of Object.entries(suite.calls)) answers[key] = await call(tool, args);
  const truth: Record<string, unknown> = {};
  for (const c of suite.cases) {
    truth[c.id] = await TRUTH[c.id](answers[c.call], call);
  }
  await client.close();
  return truth;
}

function prompt(c: Case): string {
  const [tool, args] = suite.calls[c.call];
  return [
    `Call mcp__tea-rags__${tool} exactly once with these arguments:`,
    JSON.stringify({ project: "tea-rags", path: tree, ...args }),
    "Use no other tool unless the question below tells you to.",
    `Question: ${c.question}`,
    "Reply in English. End with one line `ANSWER: <value>` and nothing after it.",
  ].join("\n");
}

interface RunOutcome {
  arm: string;
  caseId: string;
  run: number;
  answer: string | null;
  pass: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
}

async function runAgent(arm: { name: string; root: string }, c: Case): Promise<Omit<RunOutcome, "pass" | "run">> {
  const mcpFile = path.join(outDir, `mcp-${arm.name}.json`);
  const args = [
    "-p",
    prompt(c),
    "--model",
    "sonnet",
    "--plugin-dir",
    path.join(arm.root, ".claude-plugin/tea-rags"),
    "--mcp-config",
    mcpFile,
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--allowedTools",
    "mcp__tea-rags__*",
    "--output-format",
    "json",
    "--no-session-persistence",
  ];
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: tree, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", () => {
      try {
        const out = JSON.parse(stdout) as {
          result?: string;
          total_cost_usd?: number;
          usage?: Record<string, number>;
        };
        const u = out.usage ?? {};
        const match = /ANSWER:\s*(.+)\s*$/m.exec(out.result ?? "");
        resolve({
          arm: arm.name,
          caseId: c.id,
          answer: match ? match[1].trim().replace(/^`|`$/g, "") : null,
          inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          costUsd: out.total_cost_usd ?? 0,
        });
      } catch (err) {
        resolve({
          arm: arm.name,
          caseId: c.id,
          answer: null,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          error: `${(err as Error).message}: ${stdout.slice(0, 300)}`,
        });
      }
    });
  });
}

function normalize(value: string): string {
  return value.trim().replace(/^["'`]|["'`]$/g, "");
}

function grade(c: Case, answer: string | null, truth: unknown): boolean {
  if (answer === null) return false;
  switch (c.grade) {
    case "exact":
      return normalize(answer) === String(truth);
    case "number":
      return Math.abs(Number(normalize(answer)) - Number(truth)) < 0.0005;
    case "set": {
      const got = new Set(
        answer
          .split(c.separator ?? ",")
          .map(normalize)
          .filter(Boolean),
      );
      const want = new Set((truth as string[]).map(String));
      return got.size === want.size && [...want].every((v) => got.has(v));
    }
    case "braceSet": {
      const inner = /\{([^}]*)\}/.exec(answer)?.[1] ?? normalize(answer);
      const got = new Set(inner.split(",").map(normalize).filter(Boolean));
      const want = new Set(truth as string[]);
      return got.size === want.size && [...want].every((v) => got.has(v));
    }
  }
}

async function pool<T>(jobs: (() => Promise<T>)[], size: number): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < jobs.length) {
        const i = next++;
        results[i] = await jobs[i]();
      }
    }),
  );
  return results;
}

fs.mkdirSync(outDir, { recursive: true });
const truthByArm: Record<string, Record<string, unknown>> = {};
for (const arm of arms) {
  fs.writeFileSync(
    path.join(outDir, `mcp-${arm.name}.json`),
    JSON.stringify({ mcpServers: { "tea-rags": serverConfig(arm.root) } }),
  );
  truthByArm[arm.name] = await computeTruth(arm.root);
}
fs.writeFileSync(path.join(outDir, "truth.json"), JSON.stringify(truthByArm, null, 2));

const jobs = arms.flatMap((arm) =>
  suite.cases.flatMap((c) =>
    Array.from({ length: runs }, (_, run) => async (): Promise<RunOutcome> => {
      const outcome = await runAgent(arm, c);
      const result = { ...outcome, run, pass: grade(c, outcome.answer, truthByArm[arm.name][c.id]) };
      process.stdout.write(`${arm.name} ${c.id}#${run} ${result.pass ? "PASS" : "FAIL"} ${outcome.answer ?? "-"}\n`);
      return result;
    }),
  ),
);
const outcomes = await pool(jobs, concurrency);
fs.writeFileSync(path.join(outDir, "runs.json"), JSON.stringify(outcomes, null, 2));

for (const arm of arms) {
  const mine = outcomes.filter((o) => o.arm === arm.name);
  const passed = mine.filter((o) => o.pass).length;
  const avgIn = Math.round(mine.reduce((s, o) => s + o.inputTokens, 0) / mine.length);
  const cost = mine.reduce((s, o) => s + o.costUsd, 0);
  process.stdout.write(
    `SUMMARY ${arm.name}: ${passed}/${mine.length} pass, avg input ${avgIn} tok, cost $${cost.toFixed(2)}\n`,
  );
}
