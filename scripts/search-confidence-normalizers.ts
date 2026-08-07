/**
 * search-confidence-normalizers.ts (bd tea-rags-mcp-7vzo, round 2)
 *
 * Exploratory measurement, NOT the acceptance harness. Round 1 proved that the
 * score-distribution SHAPE carries no signal while the absolute magnitude
 * carries almost all of it (mean-score AUC 0.997 dense). Absolute magnitude
 * cannot be thresholded directly — the scale belongs to the embedding model —
 * so this script measures candidate NORMALISERS that turn magnitude into a
 * collection-relative quantity, plus the find_similar leg that round 1 left
 * unmeasured.
 *
 * Legs measured: dense search, Qdrant recommend (find_similar).
 * Background references measured per query by fetching deep (rank 100..200)
 * and, for comparison, a collection-level background sampled from random
 * stored-vector pairs — the statistic that would have to live in StatsCache.
 *
 * Usage: npx tsx scripts/search-confidence-normalizers.ts [--refresh]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { OllamaEmbeddings } from "../src/core/adapters/embeddings/ollama.js";
import { QdrantManager } from "../src/core/adapters/qdrant/client.js";

const COLLECTION = "code_8b243ffe";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://127.0.0.1:54571";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://192.168.1.71:11434";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "unclemusclez/jina-embeddings-v2-base-code:latest";
const CACHE_PATH = "/tmp/tea-rags-search-confidence-normalizers.json";

const TOP_K = 10;
const DEEP_LIMIT = 200;

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

/** find_similar corpus: code snippets, not prose. */
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

type QueryClass = "nonsense" | "legit";
type Leg = "dense" | "similar";

interface Sample {
  label: string;
  queryClass: QueryClass;
  leg: Leg;
  /** Scores of the deep fetch, descending. */
  scores: number[];
  /** Directory of each of the top-K hits. */
  topDirs: string[];
}

interface Corpus {
  samples: Sample[];
  /** Cosine similarity of random stored-vector PAIRS — the collection background. */
  pairBackground: number[];
}

// ---------------------------------------------------------------------------

async function collect(): Promise<Corpus> {
  const qdrant = new QdrantManager(QDRANT_URL);
  const embeddings = new OllamaEmbeddings(EMBEDDING_MODEL, undefined, undefined, OLLAMA_URL);
  const samples: Sample[] = [];

  const queries: [string, QueryClass][] = [
    ...NONSENSE_QUERIES.map((q) => [q, "nonsense"] as [string, QueryClass]),
    ...LEGIT_QUERIES.map((q) => [q, "legit"] as [string, QueryClass]),
  ];
  for (const [query, queryClass] of queries) {
    const { embedding } = await embeddings.embed(query);
    const hits = await qdrant.search(COLLECTION, embedding, DEEP_LIMIT);
    samples.push({ label: query, queryClass, leg: "dense", ...shape(hits) });
    process.stderr.write(`\r  dense ${samples.length}/${queries.length}`);
  }
  process.stderr.write("\n");

  const snippets: [string, QueryClass][] = [
    ...NONSENSE_SNIPPETS.map((s) => [s, "nonsense"] as [string, QueryClass]),
    ...LEGIT_SNIPPETS.map((s) => [s, "legit"] as [string, QueryClass]),
  ];
  for (const [snippet, queryClass] of snippets) {
    const [{ embedding }] = await embeddings.embedBatch([snippet]);
    // Same call SimilarSearchStrategy makes: recommend with one positive vector.
    const hits = await qdrant.query(COLLECTION, {
      positive: [embedding],
      strategy: "best_score",
      limit: DEEP_LIMIT,
    });
    samples.push({ label: snippet.slice(0, 48), queryClass, leg: "similar", ...shape(hits) });
    process.stderr.write(`\r  similar ${samples.length - queries.length}/${snippets.length}`);
  }
  process.stderr.write("\n");

  return { samples, pairBackground: await samplePairBackground(qdrant) };
}

function shape(hits: { score: number; payload?: Record<string, unknown> }[]) {
  return {
    scores: hits.map((h) => h.score),
    topDirs: hits.slice(0, TOP_K).map((h) => {
      const p = typeof h.payload?.relativePath === "string" ? h.payload.relativePath : "";
      return p.slice(0, Math.max(0, p.lastIndexOf("/")));
    }),
  };
}

/**
 * Collection background: cosine similarity between random pairs of stored
 * vectors. This is the statistic that does NOT exist in StatsCache today.
 */
async function samplePairBackground(qdrant: QdrantManager): Promise<number[]> {
  const vectors: number[][] = [];
  for await (const batch of qdrant.scrollWithVectors(COLLECTION, 200)) {
    for (const p of batch) {
      const v = extractDense(p.vector);
      if (v) vectors.push(v);
    }
    if (vectors.length >= 1200) break;
  }
  const sims: number[] = [];
  for (let i = 0; i + 1 < vectors.length; i += 2) sims.push(cosine(vectors[i], vectors[i + 1]));
  return sims;
}

/** Points carry named vectors ({ dense: [...] }) once hybrid is enabled. */
function extractDense(vector: unknown): number[] | undefined {
  if (Array.isArray(vector) && typeof vector[0] === "number") return vector as number[];
  if (vector && typeof vector === "object") {
    for (const value of Object.values(vector as Record<string, unknown>)) {
      if (Array.isArray(value) && typeof value[0] === "number") return value as number[];
    }
  }
  return undefined;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ---------------------------------------------------------------------------

const mean = (v: number[]) => (v.length === 0 ? 0 : v.reduce((s, x) => s + x, 0) / v.length);
const sd = (v: number[]) => {
  const m = mean(v);
  return Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
};
const round3 = (v: number) => Math.round(v * 1000) / 1000;

function auc(pos: number[], neg: number[]): number {
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

function locality(dirs: string[]): number {
  const counted = dirs.filter((d) => d.length > 0);
  if (counted.length < 2) return counted.length;
  const buckets = new Map<string, number>();
  for (const d of counted) buckets.set(d, (buckets.get(d) ?? 0) + 1);
  let H = 0;
  for (const c of buckets.values()) H -= (c / counted.length) * Math.log(c / counted.length);
  return 1 - H / Math.log(counted.length);
}

// ---------------------------------------------------------------------------

const corpus: Corpus =
  !process.argv.includes("--refresh") && existsSync(CACHE_PATH)
    ? (JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as Corpus)
    : await collect().then((c) => {
        writeFileSync(CACHE_PATH, JSON.stringify(c));
        return c;
      });

const bgMean = mean(corpus.pairBackground);
const bgSd = sd(corpus.pairBackground);
console.log(
  `\ncollection pair-background (n=${corpus.pairBackground.length}): mean ${round3(bgMean)} sd ${round3(bgSd)}`,
);
console.log(
  `  percentiles p50 ${round3(pct(corpus.pairBackground, 50))} p95 ${round3(pct(corpus.pairBackground, 95))} p99 ${round3(pct(corpus.pairBackground, 99))}\n`,
);

function pct(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

const NORMALISERS: [string, (s: Sample) => number][] = [
  ["raw mean(top10)", (s) => mean(s.scores.slice(0, TOP_K))],
  ["raw s1", (s) => s.scores[0] ?? 0],
  ["z vs deep tail 100..200", (s) => zAgainst(s, s.scores.slice(100, 200))],
  ["z vs tail 20..50", (s) => zAgainst(s, s.scores.slice(20, 50))],
  ["z vs tail 10..20 (current fetch)", (s) => zAgainst(s, s.scores.slice(10, 20))],
  ["ratio to deep tail 100..200", (s) => mean(s.scores.slice(0, TOP_K)) / (mean(s.scores.slice(100, 200)) || 1)],
  ["z vs collection pair background", (s) => (mean(s.scores.slice(0, TOP_K)) - bgMean) / (bgSd || 1)],
  ["locality alone", (s) => locality(s.topDirs)],
];

function zAgainst(s: Sample, tail: number[]): number {
  if (tail.length < 2) return 0;
  return (mean(s.scores.slice(0, TOP_K)) - mean(tail)) / (sd(tail) || 1e-9);
}

for (const leg of ["dense", "similar"] as const) {
  const pick = (c: QueryClass, f: (s: Sample) => number) =>
    corpus.samples.filter((s) => s.leg === leg && s.queryClass === c).map(f);
  console.log(`[${leg}]`);
  console.log("  normaliser                          nonsense    legit       AUC");
  for (const [name, fn] of NORMALISERS) {
    const ns = pick("nonsense", fn);
    const lg = pick("legit", fn);
    console.log(
      `  ${name.padEnd(34)} ${round3(mean(ns)).toFixed(3).padStart(8)} ${round3(mean(lg)).toFixed(3).padStart(10)} ${round3(auc(lg, ns)).toFixed(3).padStart(9)}`,
    );
  }
  console.log();
}
