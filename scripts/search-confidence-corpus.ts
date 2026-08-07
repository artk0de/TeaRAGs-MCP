/**
 * search-confidence-corpus.ts (bd tea-rags-mcp-7vzo)
 *
 * Acceptance harness for search confidence, run against the LIVE tea-rags
 * index. Read-only. Embeds each corpus query, runs the production search call,
 * measures the collection's similarity scale exactly as index time does, and
 * feeds both into the REAL `computeSearchConfidence` — the mechanism is never
 * re-implemented here.
 *
 * Two query sets: nonsense (subject matter provably absent from this codebase)
 * and legitimate (symbols and subsystems taken from the real index). Two legs:
 * semantic_search (dense) and find_similar (Qdrant recommend). hybrid_search is
 * out of scope — RRF fusion emits rank-derived scores.
 *
 * Calibration is quantile-based, not eyeballed:
 *   high cut-point   = p90 of the NONSENSE confidence values  (≤10% above it)
 *   medium cut-point = p10 of the LEGITIMATE confidence values (≥90% above it)
 * The z bounds are grid-swept; the pair maximising the margin between those
 * quantiles wins. The script then re-scores everything through the SHIPPED
 * constants and reports the acceptance gate on those, exiting non-zero if the
 * gate fails.
 *
 * Usage:
 *   QDRANT_URL=http://127.0.0.1:<port> npx tsx scripts/search-confidence-corpus.ts [--refresh]
 *
 * The embedded Qdrant daemon moves ports between restarts — read the current
 * one off `get_index_status`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { OllamaEmbeddings } from "../src/core/adapters/embeddings/ollama.js";
import { QdrantManager } from "../src/core/adapters/qdrant/client.js";
import { sampleVectors } from "../src/core/adapters/qdrant/scroll.js";
import type { ScoreBackground } from "../src/core/contracts/types/trajectory.js";
import { computeSearchConfidence } from "../src/core/domains/explore/confidence.js";
import { computeScoreBackground } from "../src/core/domains/ingest/infra/score-background.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const COLLECTION = argValue("--collection") ?? "code_8b243ffe";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://127.0.0.1:55174";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://192.168.1.71:11434";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "unclemusclez/jina-embeddings-v2-base-code:latest";
const CACHE_PATH = "/tmp/tea-rags-search-confidence-corpus-v2.json";

/** semantic_search default limit, and the ×2 overfetch its strategy applies. */
const LIMIT = 10;
const FETCH_LIMIT = Math.max(20, LIMIT * 2);
/** Mirrors IndexingOps.SCORE_BACKGROUND_SAMPLE. */
const BACKGROUND_SAMPLE = 1200;

/** Acceptance gate from the design spec. */
const MAX_NONSENSE_HIGH = 0.1;
const MIN_LEGIT_ABOVE_LOW = 0.9;

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

/** find_similar corpus — code snippets, since that is what its query is. */
const NONSENSE_SNIPPETS = [
  "fn main() { let mut world = World::new(); loop { world.update(1.0 / 60.0); world.render(); } }",
  "CREATE PROCEDURE sp_MonthlyPayroll @month INT AS BEGIN SELECT employee_id, SUM(gross) FROM payroll GROUP BY employee_id END",
  "def photosynthesis(light_lux, co2_ppm):\n    return 0.7 * light_lux * co2_ppm / (light_lux + 400)",
  '<template><div class="cart"><ProductCard v-for="p in products" :key="p.sku" :price="p.price" /></div></template>',
  "MOVE WS-GROSS-PAY TO WS-NET-PAY.\nCOMPUTE WS-TAX = WS-GROSS-PAY * 0.23.\nDISPLAY 'NET: ' WS-NET-PAY.",
  "shader_type canvas_item;\nvoid fragment() { COLOR = texture(TEXTURE, UV) * vec4(1.0, 0.5, 0.2, 1.0); }",
  "class Trebuchet:\n    def range(self, counterweight_kg, arm_ratio):\n        return counterweight_kg * arm_ratio * 0.41",
  "%%[ SET @donor = AttributeValue('first_name') ]%% Dear %%=v(@donor)=%%, your gift supports the reef.",
  'resource "aws_autoscaling_group" "web" { min_size = 2 max_size = 10 health_check_type = "ELB" }',
  "PLOT VAR=insulin BY time; MODEL glucose = insulin dose / SOLUTION DDFM=KR; RUN;",
];

const LEGIT_SNIPPETS = [
  "const sourceBounds = new Map<string, number>();\nfor (const [source, values] of rawValues) {\n  const batchP95 = p95(values);\n  const collectionP95 = this.getCollectionP95(source);\n  sourceBounds.set(source, Math.max(batchP95, collectionP95 ?? 0));\n}",
  "export function resolveLabel(value: number, labels: Record<string, string>, percentiles: Record<number, number>): string {\n  const entries = Object.entries(labels).map(([pKey, label]) => ({ p: Number(pKey.slice(1)), label })).sort((a, b) => a.p - b.p);\n  return entries[0].label;\n}",
  "protected async postProcess(results: ExploreResult[], originalCtx: ExploreContext): Promise<ExploreResult[]> {\n  const requestedLimit = Math.max(originalCtx.limit ?? 0, 5);\n  return results.slice(0, requestedLimit);\n}",
  "async search(collectionName: string, vector: number[], limit = 5, filter?: Record<string, unknown>): Promise<SearchResult[]> {\n  return this.guard(() => this.client.search(collectionName, { vector, limit, filter }));\n}",
  "const collectionInfo = await this.qdrant.getCollectionInfo(ctx.collectionName);\nif (!collectionInfo.hybridEnabled) throw new HybridNotEnabledError(ctx.collectionName);",
  "private async ensureStats(collectionName: string): Promise<void> {\n  if (!this.statsCache || this.reranker.hasCollectionStats) return;\n  const stats = this.statsCache.load(collectionName);\n  if (stats) this.reranker.setCollectionStats(stats, { collectionName });\n}",
  'export class VectorSearchStrategy extends BaseExploreStrategy {\n  readonly type = "vector" as const;\n  protected async executeExplore(ctx: ExploreContext) { return this.qdrant.search(ctx.collectionName, ctx.embedding!, ctx.limit, ctx.filter); }\n}',
  "function computeFetchLimit(limit?: number, hasRerank?: boolean): FetchLimits {\n  const requestedLimit = Math.max(limit ?? 0, 5);\n  return { requestedLimit, fetchLimit: Math.max(20, requestedLimit * (hasRerank ? 4 : 2)) };\n}",
  "registerToolSafe(server, tool.name, { title: tool.title, description: tool.description, inputSchema: schemas[tool.schemaKey], outputSchema: SearchResultOutputSchema, annotations: { readOnlyHint: true } }, handler);",
  "const buckets = new Map<string, number>();\nfor (const { relativePath } of results) {\n  const dir = relativePath.slice(0, relativePath.lastIndexOf('/'));\n  buckets.set(dir, (buckets.get(dir) ?? 0) + 1);\n}",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type QueryClass = "nonsense" | "legit";
type Leg = "semantic_search" | "find_similar";

interface Measurement {
  label: string;
  queryClass: QueryClass;
  leg: Leg;
  hits: { score: number; relativePath?: string }[];
}

interface Corpus {
  measurements: Measurement[];
  background: ScoreBackground;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

async function measure(): Promise<Corpus> {
  const qdrant = new QdrantManager(QDRANT_URL);
  const embeddings = new OllamaEmbeddings(EMBEDDING_MODEL, undefined, undefined, OLLAMA_URL);

  const background = computeScoreBackground(await sampleVectors(qdrant, COLLECTION, BACKGROUND_SAMPLE));
  if (!background) throw new Error("collection is too small to measure a score background");

  const measurements: Measurement[] = [];
  const queries: [string, QueryClass][] = [
    ...NONSENSE_QUERIES.map((q) => [q, "nonsense"] as [string, QueryClass]),
    ...LEGIT_QUERIES.map((q) => [q, "legit"] as [string, QueryClass]),
  ];
  for (const [query, queryClass] of queries) {
    const { embedding } = await embeddings.embed(query);
    const hits = await qdrant.search(COLLECTION, embedding, FETCH_LIMIT);
    measurements.push({ label: query, queryClass, leg: "semantic_search", hits: toHits(hits) });
    process.stderr.write(`\r  semantic_search ${measurements.length}/${queries.length}`);
  }
  process.stderr.write("\n");

  const snippets: [string, QueryClass][] = [
    ...NONSENSE_SNIPPETS.map((s) => [s, "nonsense"] as [string, QueryClass]),
    ...LEGIT_SNIPPETS.map((s) => [s, "legit"] as [string, QueryClass]),
  ];
  for (const [snippet, queryClass] of snippets) {
    const [{ embedding }] = await embeddings.embedBatch([snippet]);
    // The call SimilarSearchStrategy makes: recommend with one positive vector.
    const hits = await qdrant.query(COLLECTION, { positive: [embedding], strategy: "best_score", limit: FETCH_LIMIT });
    measurements.push({ label: snippet.slice(0, 44), queryClass, leg: "find_similar", hits: toHits(hits) });
  }

  return { measurements, background };
}

function toHits(results: { score: number; payload?: Record<string, unknown> }[]) {
  return results.slice(0, LIMIT).map((r) => ({
    score: r.score,
    relativePath: typeof r.payload?.relativePath === "string" ? r.payload.relativePath : undefined,
  }));
}

async function measureCached(): Promise<Corpus> {
  if (!process.argv.includes("--refresh") && existsSync(CACHE_PATH)) {
    process.stderr.write(`  reusing cached measurements (${CACHE_PATH}; --refresh to re-measure)\n`);
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as Corpus;
  }
  const corpus = await measure();
  writeFileSync(CACHE_PATH, JSON.stringify(corpus));
  return corpus;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

interface Fit {
  zFloor: number;
  zCeiling: number;
  mediumCut: number;
  highCut: number;
  margin: number;
}

/**
 * Sweep the z bounds; for each, read the cut-points off the corpus quantiles
 * and keep the pair with the widest margin between them. Fitted on the
 * semantic_search leg, which is the corpus the acceptance criterion names.
 */
function fitConstants(corpus: Corpus): Fit {
  let best: Fit = { zFloor: 0, zCeiling: 1, mediumCut: 0, highCut: 0, margin: Number.NEGATIVE_INFINITY };
  for (let zFloor = 0; zFloor <= 2.01; zFloor += 0.1) {
    for (let zCeiling = zFloor + 0.5; zCeiling <= 6.01; zCeiling += 0.1) {
      const options = { zFloor, zCeiling };
      const nonsense = valuesFor(corpus, "nonsense", "semantic_search", options);
      const legit = valuesFor(corpus, "legit", "semantic_search", options);
      const highCut = quantile(nonsense, 1 - MAX_NONSENSE_HIGH);
      const mediumCut = quantile(legit, 1 - MIN_LEGIT_ABOVE_LOW);
      const margin = highCut - mediumCut;
      if (margin > best.margin) {
        best = { zFloor: round2(zFloor), zCeiling: round2(zCeiling), mediumCut, highCut, margin };
      }
    }
  }
  return best;
}

function valuesFor(
  corpus: Corpus,
  queryClass: QueryClass,
  leg: Leg,
  options?: { zFloor: number; zCeiling: number },
): number[] {
  return corpus.measurements
    .filter((m) => m.queryClass === queryClass && m.leg === leg)
    .map((m) => computeSearchConfidence(m.hits, corpus.background, options)?.value ?? 0);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(corpus: Corpus, fit: Fit): boolean {
  const scored = corpus.measurements.map((m) => ({
    ...m,
    ...(computeSearchConfidence(m.hits, corpus.background) ?? { value: 0, label: "none" }),
  }));

  console.log(`\ncollection        ${COLLECTION}`);
  console.log(
    `score background  mean ${round3(corpus.background.mean)} sd ${round3(corpus.background.stddev)} over ${corpus.background.sampleCount} pairs`,
  );
  console.log(`corpus            ${NONSENSE_QUERIES.length} nonsense + ${LEGIT_QUERIES.length} legitimate queries`);
  console.log(
    `                  ${NONSENSE_SNIPPETS.length} + ${LEGIT_SNIPPETS.length} snippets for find_similar\n`,
  );

  console.log("quantile sweep over the z bounds (informational — shipped constants live in confidence.ts):");
  console.log(`  best zFloor / zCeiling   ${fit.zFloor} / ${fit.zCeiling}`);
  console.log(`  medium cut-point         ${round2(fit.mediumCut)}   (p10 of legitimate)`);
  console.log(`  high cut-point           ${round2(fit.highCut)}   (p90 of nonsense)`);
  console.log(`  margin                   ${round2(fit.margin)}\n`);

  // The window the shipped cut-points must lie inside for the gate to hold.
  const shippedNonsense = valuesFor(corpus, "nonsense", "semantic_search");
  const shippedLegit = valuesFor(corpus, "legit", "semantic_search");
  console.log("separation window under the SHIPPED z bounds (semantic_search leg):");
  console.log(
    `  nonsense  max ${round2(Math.max(...shippedNonsense))}  p90 ${round2(quantile(shippedNonsense, 0.9))}`,
  );
  console.log(`  legit     min ${round2(Math.min(...shippedLegit))}  p10 ${round2(quantile(shippedLegit, 0.1))}`);
  console.log(`  → any medium cut in [${round2(Math.min(...shippedLegit))}, …] keeps 100% of legit above low`);
  console.log(`  → any high cut above ${round2(quantile(shippedNonsense, 0.9))} keeps nonsense-high under 10%\n`);

  let pass = true;
  for (const leg of ["semantic_search", "find_similar"] as const) {
    const slice = scored.filter((m) => m.leg === leg);
    const nonsense = slice.filter((m) => m.queryClass === "nonsense");
    const legit = slice.filter((m) => m.queryClass === "legit");
    const nonsenseHigh = nonsense.filter((m) => m.label === "high").length;
    const legitAboveLow = legit.filter((m) => m.label !== "low").length;
    const nonsenseHighRate = nonsenseHigh / nonsense.length;
    const legitAboveLowRate = legitAboveLow / legit.length;
    const legOk = nonsenseHighRate <= MAX_NONSENSE_HIGH && legitAboveLowRate >= MIN_LEGIT_ABOVE_LOW;
    // The acceptance corpus named in the spec is the 25+25 query set.
    if (leg === "semantic_search") pass = legOk;

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
    console.log(
      `  AUC                  ${round3(auc(legit.map((m) => m.value), nonsense.map((m) => m.value)))}`,
    );
    console.log(`  label mix nonsense   ${labelMix(nonsense)}`);
    console.log(`  label mix legit      ${labelMix(legit)}\n`);
  }

  console.log("per-query (semantic_search):");
  for (const m of scored.filter((s) => s.leg === "semantic_search").sort((a, b) => a.value - b.value)) {
    console.log(`  ${m.value.toFixed(2)}  ${m.label.padEnd(6)} ${m.queryClass.padEnd(8)} ${m.label}`.slice(0, 110));
  }

  const misses = scored.filter(
    (m) => (m.queryClass === "nonsense" && m.label === "high") || (m.queryClass === "legit" && m.label === "low"),
  );
  console.log(`\nmisclassified (${misses.length}):`);
  for (const m of misses) {
    console.log(`  ${m.value.toFixed(2)}  ${m.label.padEnd(6)} ${m.leg.padEnd(15)} ${m.queryClass.padEnd(8)}`);
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

/** Mann-Whitney AUC: probability a random legit value exceeds a random nonsense one. */
function auc(positive: number[], negative: number[]): number {
  let wins = 0;
  for (const p of positive) for (const n of negative) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (positive.length * negative.length);
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

const corpus = await measureCached();
const fit = fitConstants(corpus);
const pass = report(corpus, fit);
process.exit(pass ? 0 : 1);
