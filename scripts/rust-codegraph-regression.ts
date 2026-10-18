/**
 * Preparatory offline Rust regression surface (bd tea-rags-mcp-2g2og.23).
 * Capture is a USER-COORDINATED corpus run: take the heavy-measure lock first.
 * No index writes, oracle adapter, cfg evaluator, or parallel resolver.
 *
 * npx tsx scripts/rust-codegraph-regression.ts capture --corpus ripgrep-rust \
 *   --root /portable/ripgrep --out /tmp/baseline.json
 * Repeat with the after build, then (cheap, artifact-only):
 * npx tsx scripts/rust-codegraph-regression.ts compare --before /tmp/baseline.json \
 *   --after /tmp/after.json --policy /tmp/policy.json --out /tmp/diff.json
 * Policy: { maxValidEdgeLoss: 0, maxFalseEdgeGain: 0,
 *   maxCostRatio: { pass2Ms: 1.1 }, adjudications: [{ edge, verdict, reason }] }.
 * Pass --oracle <json> to ingest an independently prepared `oracle` contract;
 * absent input remains not-run. Not a recall claim without independent truth.
 * Capture also writes <out>.edges.tsv with the existing tally formatter.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ChainTallyRunOptions, RunResult } from "./codegraph-chain-tally.js";
import manifest from "./lib/rust-codegraph-corpora.json" with { type: "json" };
import {
  compareRustCodegraphArtifacts,
  rustCodegraphArtifactSchema,
  rustTallySiteKey,
} from "./lib/rust-codegraph-regression.js";
import { formatTallyEdgeDump } from "./lib/tally-edge-dump.js";

export function selectRustCorpus(alias: string, rootOverride?: string) {
  const corpus = manifest.corpora.find((entry) => entry.alias === alias);
  if (!corpus) throw new Error(`unknown corpus: ${alias}`);
  return { ...corpus, root: resolve(rootOverride ?? corpus.root) };
}

type RustTallyRunner = (
  root: string,
  lang: string,
  deferPass: string | null,
  limit: number,
  quiet: boolean,
  dispatch: boolean,
  options: ChainTallyRunOptions,
) => Promise<RunResult>;

export async function captureRustCodegraphArtifact(
  corpus: ReturnType<typeof selectRustCorpus>,
  engine: { commit: string; dirty: boolean },
  runner?: RustTallyRunner,
  seams: {
    readPin?: () => { corpus: { commit: string; dirty: boolean }; engine: { commit: string; dirty: boolean } };
  } = {},
) {
  const readPin =
    seams.readPin ??
    (runner
      ? undefined
      : () => ({
          corpus: {
            commit: git(corpus.root, ["rev-parse", "HEAD"]),
            dirty: git(corpus.root, ["status", "--porcelain"]) !== "",
          },
          engine: {
            commit: git(fileURLToPath(new URL("..", import.meta.url)), ["rev-parse", "HEAD"]),
            dirty: git(fileURLToPath(new URL("..", import.meta.url)), ["status", "--porcelain"]) !== "",
          },
        }));
  const checkPin = () => {
    const pin = readPin?.();
    if (
      pin &&
      (pin.corpus.commit !== corpus.commit ||
        pin.corpus.dirty ||
        pin.engine.commit !== engine.commit ||
        pin.engine.dirty ||
        engine.dirty)
    ) {
      throw new Error("capture pin changed or tree not clean");
    }
  };
  checkPin();
  const options = structuredClone(corpus.options);
  const resolverEnv = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key, value]) => /^(CODEGRAPH_|RUST_|CARGO_)/.test(key) && value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  // Lazy import keeps compare and manifest selection independent of grammars.
  const tally = runner ?? (await import("./codegraph-chain-tally.js")).run;
  const result = await tally(corpus.root, "rust", null, Infinity, true, true, options);
  checkPin();
  if (result.files === 0 || result.rows.length === 0) throw new Error("empty capture: no files or sites");
  if (
    !result.timeOnly ||
    result.edgeDump === undefined ||
    result.timing === undefined ||
    result.kindStats === undefined
  ) {
    throw new Error("Rust capture requires production-only tally, timing, kindStats and edgeDump");
  }
  if (result.parseFailures > 0) throw new Error(`capture parse failures: ${result.parseFailures}`);
  const { loc, ...timing } = result.timing;
  // Set equality between the tally's site rows and the dump's site keys: every
  // site scored must have reached the dump and the dump must carry no site the
  // run never scored. Counts stay free to differ — a fan-out site legitimately
  // dumps one row per pushed edge.
  const rowSiteKeys = [
    ...new Set(
      result.rows.map((row) =>
        rustTallySiteKey({
          relPath: row.relPath,
          line: row.startLine,
          callText: row.callText,
          startColumn: row.startColumn,
        }),
      ),
    ),
  ].sort();
  const siteKeys = [...new Set(result.edgeDump.map(rustTallySiteKey))].sort();
  if (rowSiteKeys.join("\n") !== siteKeys.join("\n")) {
    throw new Error(
      `tally site identity mismatch: rows carry ${rowSiteKeys.length} sites, edge dump carries ${siteKeys.length}`,
    );
  }
  const processors = cpus();
  return rustCodegraphArtifactSchema.parse({
    schemaVersion: 1,
    corpus: { alias: corpus.alias, commit: corpus.commit, config: corpus.config, options },
    engine,
    workload: {
      files: result.files,
      sites: result.rows.length,
      symbols: result.symbols,
      loc,
      siteDigest: createHash("sha256").update(JSON.stringify(siteKeys)).digest("hex"),
      dispatch: true,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuModel: processors[0]?.model ?? "unknown",
      cpuCount: Math.max(processors.length, 1),
      nodeOptions: process.env.NODE_OPTIONS ?? "",
      resolverEnv,
      // Tally contains synchronous passes: a timer here cannot observe contention during them.
      loadMonitoring: {
        status: "insufficient",
        samples: 1,
        maxLoadPerCpu: loadavg()[0] / Math.max(processors.length, 1),
      },
      loadPerCpu: loadavg()[0] / Math.max(processors.length, 1),
    },
    identityScheme: "tally-line-callText-startColumn-v1",
    measurementScope: "fresh-extraction-and-production-resolver",
    chainDrift: {
      status: "not-run",
      reason: "Rust uses --time-only production runner; zero drift is not verification",
    },
    oracle: { status: "not-run", reason: "independent Rust oracle adapter pending" },
    timing,
    kindStats: result.kindStats,
    rows: result.edgeDump,
  });
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
function flag(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`required ${name} <value>`);
  return value;
}
function optionalFlag(args: string[], name: string): string | undefined {
  return args.includes(name) ? flag(args, name) : undefined;
}

export async function rustCodegraphRegressionMain(args: string[]): Promise<number> {
  const [mode, ...flags] = args;
  const allowed =
    mode === "capture"
      ? ["--corpus", "--root", "--out", "--oracle"]
      : ["--before", "--after", "--out", "--policy", "--report-only"];
  if (mode !== "capture" && mode !== "compare") throw new Error("expected capture or compare");
  for (let i = 0; i < flags.length; i += flags[i] === "--report-only" ? 1 : 2) {
    if (flags[i] === "--report-only" && mode === "compare") {
      if (flags.indexOf(flags[i]) !== i) throw new Error(`duplicate option ${flags[i]}`);
      continue;
    }
    if (!allowed.includes(flags[i]) || !flags[i + 1] || flags[i + 1].startsWith("--")) {
      throw new Error(`invalid option ${flags[i]}`);
    }
    if (flags.indexOf(flags[i]) !== i) throw new Error(`duplicate option ${flags[i]}`);
  }
  const out = flag(flags, "--out");
  if (mode === "compare") {
    const policy = optionalFlag(flags, "--policy");
    const reportOnly = flags.includes("--report-only");
    if ((!policy && !reportOnly) || (policy && reportOnly)) {
      throw new Error("require --policy or explicit --report-only, not both");
    }
    const result = compareRustCodegraphArtifacts(
      JSON.parse(readFileSync(flag(flags, "--before"), "utf8")),
      JSON.parse(readFileSync(flag(flags, "--after"), "utf8")),
      policy ? JSON.parse(readFileSync(policy, "utf8")) : {},
    );
    if (policy && !result.gate.enforced) {
      throw new Error("policy must configure at least one enforcing threshold; use --report-only for reports");
    }
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    return result.exitCode;
  }
  const corpus = selectRustCorpus(flag(flags, "--corpus"), optionalFlag(flags, "--root"));
  if (git(corpus.root, ["rev-parse", "HEAD"]) !== corpus.commit) {
    throw new Error("corpus HEAD differs from manifest pin");
  }
  if (git(corpus.root, ["status", "--porcelain"])) throw new Error("corpus must be clean at pinned commit");
  const engineRoot = fileURLToPath(new URL("..", import.meta.url));
  const artifact = await captureRustCodegraphArtifact(corpus, {
    commit: git(engineRoot, ["rev-parse", "HEAD"]),
    dirty: git(engineRoot, ["status", "--porcelain"]) !== "",
  });
  const oraclePath = optionalFlag(flags, "--oracle");
  if (oraclePath) {
    artifact.oracle = rustCodegraphArtifactSchema.shape.oracle.parse(JSON.parse(readFileSync(oraclePath, "utf8")));
  }
  writeFileSync(`${out}.edges.tsv`, formatTallyEdgeDump(artifact.rows, JSON.stringify(artifact.kindStats)));
  writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  rustCodegraphRegressionMain(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
}
