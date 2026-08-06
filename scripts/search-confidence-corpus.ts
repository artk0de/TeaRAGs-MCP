/**
 * search-confidence-corpus.ts (bd tea-rags-mcp-7vzo)
 *
 * Calibrates and measures the search-confidence mechanism against the LIVE
 * tea-rags index. Read-only: embeds each corpus query, runs the dense and the
 * hybrid leg exactly as the production strategies do (overfetch ×2, trim to the
 * requested limit), and feeds the resulting score/path pairs into the REAL
 * `computeSearchConfidence` — no re-implementation of the mechanism here.
 *
 * Two query sets: nonsense (subject matter provably absent from this codebase)
 * and legitimate (symbols and subsystems taken from the real index).
 *
 * Calibration is quantile-based, not eyeballed:
 *   high cut-point   = p90 of the NONSENSE confidence values  (≤10% above it)
 *   medium cut-point = p10 of the LEGITIMATE confidence values (≥90% above it)
 * `spreadHalfPoint` is grid-swept; the k maximising the margin between those
 * two quantiles wins. The script then re-scores everything through the SHIPPED
 * constants and reports the acceptance gate on those.
 *
 * Usage:
 *   npx tsx scripts/search-confidence-corpus.ts [--collection code_8b243ffe]
 *
 * Env: QDRANT_URL, OLLAMA_URL, EMBEDDING_MODEL (defaults match the local dev
 * setup; read them off `get_index_status` if they have moved).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { OllamaEmbeddings } from "../src/core/adapters/embeddings/ollama.js";
import { QdrantManager } from "../src/core/adapters/qdrant/client.js";
import { generateSparseVector } from "../src/core/adapters/qdrant/sparse.js";
import { computeSearchConfidence } from "../src/core/domains/explore/confidence.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const COLLECTION = argValue("--collection") ?? "code_8b243ffe";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://127.0.0.1:54571";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://192.168.1.71:11434";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "unclemusclez/jina-embeddings-v2-base-code:latest";

/** semantic_search default limit, and the ×2 overfetch its strategy applies. */
const LIMIT = 10;
const FETCH_LIMIT = Math.max(20, LIMIT * 2);

/** Acceptance gate from the design spec. */
const MAX_NONSENSE_HIGH = 0.1;
const MIN_LEGIT_ABOVE_LOW = 0.9;

/**
 * Nonsense set — subject matter absent from a TypeScript MCP code-search
 * server. These must not resolve to anything; the mechanism has to say so.
 */
const NONSENSE_QUERIES = [
  "kubernetes horizontal pod autoscaler",
  "photosynthesis chlorophyll light absorption",
  "mortgage amortization schedule interest",
  "sourdough starter hydration ratio",
  "quaternion slerp interpolation shader",
  "zebra migration serengeti herd",
  "insulin glucose regulation pancreas",
  "medieval castle siege trebuchet",
  "orbital mechanics hohmann transfer burn",
  "vinyl record groove stylus tracking",
  "espresso tamping pressure grind size",
  "tectonic subduction zone magma",
  "haiku seasonal kigo poetry",
  "penalty kick offside referee",
  "chemotherapy dosage titration protocol",
  "wind turbine blade pitch control",
  "sanskrit grammar panini sutra",
  "coral reef bleaching salinity",
  "violin bow rosin tension",
  "airline seat pitch legroom cabin",
  "flamenco guitar rasgueado strumming",
  "beekeeping hive varroa mite treatment",
  "glacier crevasse moraine deposition",
  "opera libretto soprano aria",
  "cattle grazing rotational pasture",
];

/** Legitimate set — real subsystems and symbols of this codebase. */
const LEGIT_QUERIES = [
  "adaptive bounds normalization at rerank time",
  "resolve label from percentile thresholds",
  "hybrid search sparse BM25 vector fusion",
  "tree-sitter chunker language hooks",
  "git blame enrichment provider file signals",
  "codegraph symbol resolution strategy chain",
  "schema drift monitor payload version",
  "collection stats percentile computation",
  "MCP tool registration and output schema",
  "ollama embedding batch request retry",
  "DuckDB codegraph daemon client pool",
  "worktree provisioner git checkout",
  "filter preset compiler adaptive thresholds",
  "snapshot sharding manifest write",
  "quarantine store failed chunks",
  "PageRank over the method call graph",
  "Tarjan strongly connected components cycles",
  "lazy stats recompute backfill percentiles",
  "project registry alias resolution",
  "metaOnly strips content from results",
  "rerank preset weights and overlay mask",
  "file outline strategy scroll by relativePath",
  "symbol id composer class method separator",
  "enrichment coordinator provider dispatch",
  "incremental reindex deletion sync",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type QueryClass = "nonsense" | "legit";
type Leg = "dense" | "hybrid";

interface Measurement {
  query: string;
  queryClass: QueryClass;
  leg: Leg;
  hits: { score: number; relativePath?: string }[];
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

const CACHE_PATH = "/tmp/tea-rags-search-confidence-corpus.json";

/** Raw measurements are cached so calibration re-runs do not re-embed. */
async function measureCached(): Promise<Measurement[]> {
  if (!process.argv.includes("--refresh") && existsSync(CACHE_PATH)) {
    process.stderr.write(`  reusing cached measurements (${CACHE_PATH}; --refresh to re-measure)\n`);
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as Measurement[];
  }
  const measurements = await measure();
  writeFileSync(CACHE_PATH, JSON.stringify(measurements));
  return measurements;
}

async function measure(): Promise<Measurement[]> {
  const qdrant = new QdrantManager(QDRANT_URL);
  const embeddings = new OllamaEmbeddings(EMBEDDING_MODEL, undefined, undefined, OLLAMA_URL);

  const corpus: { query: string; queryClass: QueryClass }[] = [
    ...NONSENSE_QUERIES.map((query) => ({ query, queryClass: "nonsense" as const })),
    ...LEGIT_QUERIES.map((query) => ({ query, queryClass: "legit" as const })),
  ];

  const measurements: Measurement[] = [];
  for (const [i, { query, queryClass }] of corpus.entries()) {
    const { embedding } = await embeddings.embed(query);
    const sparse = generateSparseVector(query);

    const dense = await qdrant.search(COLLECTION, embedding, FETCH_LIMIT);
    const hybrid = await qdrant.hybridSearch(COLLECTION, embedding, sparse, FETCH_LIMIT);

    measurements.push({ query, queryClass, leg: "dense", hits: toHits(dense) });
    measurements.push({ query, queryClass, leg: "hybrid", hits: toHits(hybrid) });
    process.stderr.write(`\r  measured ${i + 1}/${corpus.length}`);
  }
  process.stderr.write("\n");
  return measurements;
}

function toHits(results: { score: number; payload?: Record<string, unknown> }[]) {
  return results.slice(0, LIMIT).map((r) => ({
    score: r.score,
    relativePath: typeof r.payload?.relativePath === "string" ? r.payload.relativePath : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

interface Fit {
  spreadHalfPoint: number;
  mediumCut: number;
  highCut: number;
  margin: number;
}

function fitConstants(measurements: Measurement[]): Fit {
  let best: Fit = { spreadHalfPoint: 0.01, mediumCut: 0, highCut: 0, margin: Number.NEGATIVE_INFINITY };
  for (let k = 0.01; k <= 0.4001; k += 0.01) {
    const nonsense = valuesFor(measurements, "nonsense", k);
    const legit = valuesFor(measurements, "legit", k);
    // ≤10% of nonsense may sit at or above the high cut-point; ≥90% of
    // legitimate must sit at or above the medium cut-point.
    const highCut = quantile(nonsense, 1 - MAX_NONSENSE_HIGH);
    const mediumCut = quantile(legit, 1 - MIN_LEGIT_ABOVE_LOW);
    const margin = highCut - mediumCut;
    if (margin > best.margin) {
      best = { spreadHalfPoint: round2(k), mediumCut, highCut, margin };
    }
  }
  return best;
}

function valuesFor(measurements: Measurement[], queryClass: QueryClass, k: number): number[] {
  return measurements
    .filter((m) => m.queryClass === queryClass)
    .map((m) => computeSearchConfidence(m.hits, { spreadHalfPoint: k }).value);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(measurements: Measurement[], fit: Fit): boolean {
  const scored = measurements.map((m) => ({ ...m, ...computeSearchConfidence(m.hits) }));

  console.log(`\ncollection      ${COLLECTION}`);
  console.log(`corpus          ${NONSENSE_QUERIES.length} nonsense + ${LEGIT_QUERIES.length} legitimate`);
  console.log(`measurements    ${scored.length} (dense + hybrid legs)\n`);

  console.log("fitted from the corpus quantiles (informational — shipped constants are in confidence.ts):");
  console.log(`  spreadHalfPoint k   ${fit.spreadHalfPoint}`);
  console.log(`  medium cut-point    ${round2(fit.mediumCut)}   (p10 of legitimate)`);
  console.log(`  high cut-point      ${round2(fit.highCut)}   (p90 of nonsense)`);
  console.log(`  margin              ${round2(fit.margin)}\n`);

  let pass = true;
  for (const leg of ["dense", "hybrid", "both"] as const) {
    const slice = leg === "both" ? scored : scored.filter((m) => m.leg === leg);
    const nonsense = slice.filter((m) => m.queryClass === "nonsense");
    const legit = slice.filter((m) => m.queryClass === "legit");
    const nonsenseHigh = nonsense.filter((m) => m.label === "high").length;
    const legitAboveLow = legit.filter((m) => m.label !== "low").length;
    const nonsenseHighRate = nonsenseHigh / nonsense.length;
    const legitAboveLowRate = legitAboveLow / legit.length;
    const legOk = nonsenseHighRate <= MAX_NONSENSE_HIGH && legitAboveLowRate >= MIN_LEGIT_ABOVE_LOW;
    if (leg === "both") pass = legOk;

    console.log(`[${leg}] shipped constants`);
    console.log(
      `  nonsense high        ${nonsenseHigh}/${nonsense.length} = ${pct(nonsenseHighRate)}   (gate ≤ ${pct(MAX_NONSENSE_HIGH)})`,
    );
    console.log(
      `  legit above low      ${legitAboveLow}/${legit.length} = ${pct(legitAboveLowRate)}   (gate ≥ ${pct(MIN_LEGIT_ABOVE_LOW)})`,
    );
    console.log(
      `  mean confidence      nonsense ${round3(mean(nonsense.map((m) => m.value)))}, legit ${round3(mean(legit.map((m) => m.value)))}`,
    );
    console.log(`  label mix nonsense   ${labelMix(nonsense)}`);
    console.log(`  label mix legit      ${labelMix(legit)}\n`);
  }

  console.log("per-query (dense leg):");
  for (const m of scored.filter((s) => s.leg === "dense").sort((a, b) => a.value - b.value)) {
    console.log(`  ${m.value.toFixed(2)}  ${m.label.padEnd(6)} ${m.queryClass.padEnd(8)} ${m.query}`);
  }

  const misses = scored.filter(
    (m) => (m.queryClass === "nonsense" && m.label === "high") || (m.queryClass === "legit" && m.label === "low"),
  );
  if (misses.length > 0) {
    console.log("\nmisclassified:");
    for (const m of misses)
      console.log(
        `  ${m.value.toFixed(2)}  ${m.label.padEnd(6)} ${m.leg.padEnd(6)} ${m.queryClass.padEnd(8)} ${m.query}`,
      );
  }

  return pass;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

function labelMix(scored: { label: string }[]): string {
  const counts = new Map<string, number>();
  for (const { label } of scored) counts.set(label, (counts.get(label) ?? 0) + 1);
  return ["high", "medium", "low"].map((l) => `${l}=${counts.get(l) ?? 0}`).join(" ");
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

// ---------------------------------------------------------------------------

/**
 * Component diagnostics. Mirrors the formulas in `confidence.ts` — used ONLY to
 * see which component carries (or fails to carry) the separation. Every number
 * that the acceptance gate depends on still comes from the real
 * `computeSearchConfidence`.
 */
function diagnose(measurements: Measurement[]): void {
  console.log("\ncomponent diagnostics (means by class; AUC = P(legit > nonsense)):");
  for (const leg of ["dense", "hybrid"] as const) {
    const byClass = (c: QueryClass) => measurements.filter((m) => m.leg === leg && m.queryClass === c);
    const peak = (m: Measurement) => {
      const s = m.hits.map((h) => h.score).sort((a, b) => b - a);
      if (s.length < 2 || s[0] <= 0) return 0;
      const tail = s.slice(1).sort((a, b) => a - b);
      const mid = Math.floor(tail.length / 2);
      const med = tail.length % 2 === 0 ? (tail[mid - 1] + tail[mid]) / 2 : tail[mid];
      return (s[0] - med) / s[0];
    };
    const cv = (m: Measurement) => {
      const s = m.hits.map((h) => h.score);
      const mu = mean(s);
      if (mu <= 0) return 0;
      return Math.sqrt(mean(s.map((x) => (x - mu) ** 2))) / mu;
    };
    const locality = (m: Measurement) => {
      const buckets = new Map<string, number>();
      let n = 0;
      for (const h of m.hits) {
        if (!h.relativePath) continue;
        const dir = h.relativePath.slice(0, Math.max(0, h.relativePath.lastIndexOf("/")));
        buckets.set(dir, (buckets.get(dir) ?? 0) + 1);
        n += 1;
      }
      if (n < 2) return n;
      let H = 0;
      for (const c of buckets.values()) H -= (c / n) * Math.log(c / n);
      return 1 - H / Math.log(n);
    };

    console.log(`  [${leg}]`);
    for (const [name, fn] of [
      ["peak", peak],
      ["cv", cv],
      ["locality", locality],
      ["value", (m: Measurement) => computeSearchConfidence(m.hits).value],
    ] as const) {
      const ns = byClass("nonsense").map(fn);
      const lg = byClass("legit").map(fn);
      console.log(
        `    ${name.padEnd(9)} nonsense ${round3(mean(ns))}  legit ${round3(mean(lg))}  AUC ${round3(auc(lg, ns))}`,
      );
    }
  }
}

/**
 * What the acceptance gate would report under alternative component weightings,
 * with cut-points fitted by the same quantile rule. Diagnostic only — it tells
 * the owner which weighting the corpus actually supports.
 *
 * `nonsense above low` is the honesty column: the stated gate is satisfiable by
 * construction with weak separation, and that column shows the cost.
 */
function compareWeightings(measurements: Measurement[]): void {
  const weightings: [string, number, number, number][] = [
    ["design 0.4/0.4/0.2", 0.4, 0.4, 0.2],
    ["even 1/3 each", 1 / 3, 1 / 3, 1 / 3],
    ["locality-led 0.2/0.2/0.6", 0.2, 0.2, 0.6],
    ["locality only 0/0/1", 0, 0, 1],
    ["peak+spread only 0.5/0.5/0", 0.5, 0.5, 0],
  ];

  console.log("\nweighting comparison (cut-points quantile-fitted per row; k = 0.06):");
  for (const leg of ["dense", "hybrid"] as const) {
    console.log(`  [${leg}]`);
    console.log("    weighting                  medium  high   nonsense-high  legit>low  nonsense>low  AUC");
    for (const [name, wp, ws, wl] of weightings) {
      const value = (m: Measurement) => {
        const c = components(m);
        return round2(clamp01(wp * c.peak + ws * (c.cv / (c.cv + 0.06)) + wl * c.locality));
      };
      const ns = measurements.filter((m) => m.leg === leg && m.queryClass === "nonsense").map(value);
      const lg = measurements.filter((m) => m.leg === leg && m.queryClass === "legit").map(value);
      const highCut = quantile(ns, 1 - MAX_NONSENSE_HIGH);
      const mediumCut = quantile(lg, 1 - MIN_LEGIT_ABOVE_LOW);
      const rate = (vals: number[], cut: number) => vals.filter((v) => v >= cut).length / vals.length;
      console.log(
        `    ${name.padEnd(26)} ${round2(mediumCut).toFixed(2)}    ${round2(highCut).toFixed(2)}   ` +
          `${pct(rate(ns, highCut)).padStart(12)}   ${pct(rate(lg, mediumCut)).padStart(8)}   ` +
          `${pct(rate(ns, mediumCut)).padStart(11)}   ${round3(auc(lg, ns))}`,
      );
    }
  }
}

/** Diagnostic mirror of the confidence components (see `diagnose`). */
function components(m: Measurement): { peak: number; cv: number; locality: number } {
  const scores = m.hits.map((h) => h.score).sort((a, b) => b - a);
  let peak = 0;
  if (scores.length >= 2 && scores[0] > 0) {
    const tail = scores.slice(1).sort((a, b) => a - b);
    const mid = Math.floor(tail.length / 2);
    const med = tail.length % 2 === 0 ? (tail[mid - 1] + tail[mid]) / 2 : tail[mid];
    peak = Math.max(0, (scores[0] - med) / scores[0]);
  }
  const mu = mean(scores);
  const cv = mu > 0 ? Math.sqrt(mean(scores.map((x) => (x - mu) ** 2))) / mu : 0;
  const buckets = new Map<string, number>();
  let n = 0;
  for (const h of m.hits) {
    if (!h.relativePath) continue;
    const dir = h.relativePath.slice(0, Math.max(0, h.relativePath.lastIndexOf("/")));
    buckets.set(dir, (buckets.get(dir) ?? 0) + 1);
    n += 1;
  }
  let locality = n < 2 ? n : 0;
  if (n >= 2) {
    let H = 0;
    for (const c of buckets.values()) H -= (c / n) * Math.log(c / n);
    locality = 1 - H / Math.log(n);
  }
  return { peak, cv, locality };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Mann-Whitney AUC: probability a random legit value exceeds a random nonsense one. */
function auc(positive: number[], negative: number[]): number {
  let wins = 0;
  for (const p of positive) for (const n of negative) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (positive.length * negative.length);
}

const measurements = await measureCached();
const fit = fitConstants(measurements);
const pass = report(measurements, fit);
diagnose(measurements);
compareWeightings(measurements);
process.exit(pass ? 0 : 1);
