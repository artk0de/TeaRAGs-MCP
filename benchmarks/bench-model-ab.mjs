#!/usr/bin/env node
/**
 * Embedding model A/B bench (bd tea-rags-mcp-h6tmp): throughput and retrieval
 * quality of GGUF embedding models served by llama-server (OpenAI-compatible
 * /v1/embeddings), one model instance at a time.
 *
 * Modes:
 *   corpus     [-size 2048] [-chunk-chars 700] [-out FILE] [-roots src,tests]
 *              Build the document corpus from this repo's source + tests,
 *              chunked at ~chunk-chars chars on line boundaries (median
 *              production code chunk is ~700 chars).
 *   queries    [-corpus FILE] [-out FILE]
 *              Build the query set: A = hand-written natural-language
 *              paraphrases (file-level targets, listed below), B = code->test
 *              pairs generated from the src/x.ts to tests/x.test.ts naming
 *              convention (query = first lines of the source file).
 *   throughput -port 8181 [-corpus FILE] [-seconds 30] [-batch 64] [-inflight 4]
 *              Sustained texts/s + chars/s (protocol of the 2026-10-03 nucbox
 *              benches: fixed batch, fixed in-flight requests, run to deadline).
 *   quality    -port 8181 -corpus FILE -queries FILE [-limit N]
 *              Embed corpus + queries through the model on -port, rank by
 *              cosine similarity, report MRR and recall@10 per query set.
 *
 * Corpora and query files are generated artifacts: keep them outside the repo
 * (/tmp) and regenerate. The script itself is the durable part.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = new URL("../", import.meta.url).pathname;

// ── args ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const mode = argv[0];
  const a = { mode };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("-")) {
      const key = argv[i].replace(/^-+/, "");
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) a[key] = true;
      else {
        a[key] = Number.isNaN(Number(next)) ? next : Number(next);
        i++;
      }
    }
  }
  return a;
}

// ── corpus ──────────────────────────────────────────────────────────────────
function walkTs(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "__snapshots__") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function chunkFile(file, chunkChars) {
  const lines = readFileSync(file, "utf8").split("\n");
  const chunks = [];
  let buf = [];
  let len = 0;
  const flush = () => {
    if (buf.length) chunks.push(buf.join("\n"));
    buf = [];
    len = 0;
  };
  for (const line of lines) {
    // A single over-long line (minified fixture, embedded blob) must not make
    // an unembeddable chunk: hard-split it at chunkChars boundaries.
    if (line.length > chunkChars) {
      flush();
      for (let i = 0; i < line.length; i += chunkChars) chunks.push(line.slice(i, i + chunkChars));
      continue;
    }
    buf.push(line);
    len += line.length + 1;
    if (len >= chunkChars) flush();
  }
  flush();
  return chunks.filter((t) => t.trim().length > 60);
}

function buildCorpus(a) {
  const chunkChars = a["chunk-chars"] ?? 700;
  const size = a.size ?? 2048;
  const roots = String(a.roots ?? "src,tests").split(",");
  const files = roots.flatMap((r) => walkTs(join(REPO, r)));
  files.sort();
  // Round-robin one chunk per file first, so no single directory dominates the cap.
  const perFile = files.map((f) => ({ file: f.slice(REPO.length), chunks: chunkFile(f, chunkChars) }));
  const docs = [];
  for (let round = 0; docs.length < size; round++) {
    let added = false;
    for (const f of perFile) {
      if (round < f.chunks.length) {
        docs.push({ i: docs.length, file: f.file, text: f.chunks[round] });
        added = true;
        if (docs.length >= size) break;
      }
    }
    if (!added) break;
  }
  const out = a.out ?? `/tmp/ab-corpus-${chunkChars}.json`;
  writeFileSync(out, JSON.stringify(docs));
  const filesN = new Set(docs.map((d) => d.file)).size;
  const chars = docs.reduce((s, d) => s + d.text.length, 0);
  console.log(
    `corpus: ${docs.length} chunks, ${filesN} files, ${(chars / 1000).toFixed(0)}k chars, avg ${Math.round(chars / docs.length)} -> ${out}`,
  );
}

// ── queries ─────────────────────────────────────────────────────────────────
// A: natural-language paraphrases. Wording deliberately avoids the identifiers
// in the target files — that is the point of the paraphrase probe.
const QUERIES_A = [
  {
    q: "spreading embedding requests over several inference server endpoints",
    file: "src/core/adapters/embeddings/endpoint-pool.ts",
  },
  {
    q: "deciding an inference endpoint is unhealthy and routing around it",
    file: "src/core/adapters/embeddings/endpoint-down-verdicts.ts",
  },
  {
    q: "limiting how many requests hit one endpoint at the same time",
    file: "src/core/adapters/embeddings/endpoint-slot-limiter.ts",
  },
  {
    q: "sending one batch of texts to multiple mirrors and merging the replies",
    file: "src/core/adapters/embeddings/batch-fanout.ts",
  },
  {
    q: "the table of known embedding models and their vector widths",
    file: "src/core/adapters/embeddings/model-catalog.ts",
  },
  { q: "choosing which embedding model a project should use", file: "src/core/adapters/embeddings/model-choice.ts" },
  { q: "retrying failed embedding calls with waits between attempts", file: "src/core/adapters/embeddings/retry.ts" },
  { q: "interface that every embedding backend implements", file: "src/core/adapters/embeddings/base.ts" },
  {
    q: "locating and starting the local llama.cpp inference server executable",
    file: "src/core/adapters/llama-server/binary.ts",
  },
  { q: "entry module wiring the llama-server adapter together", file: "src/core/adapters/llama-server/index.ts" },
  { q: "constructing the vector database client and its connection", file: "src/core/adapters/qdrant/client.ts" },
  { q: "paging through every stored point of a collection", file: "src/core/adapters/qdrant/scroller.ts" },
  {
    q: "making freshly written points visible to subsequent searches",
    file: "src/core/adapters/qdrant/write-barrier.ts",
  },
  {
    q: "creating collections and keeping their vector configuration up to date",
    file: "src/core/adapters/qdrant/collection-admin.ts",
  },
  {
    q: "running a vector search request and returning ranked results",
    file: "src/core/adapters/qdrant/search-executor.ts",
  },
  {
    q: "in-memory staging of points before they are flushed to the database",
    file: "src/core/adapters/qdrant/point-store.ts",
  },
  { q: "sparse keyword vectors for hybrid retrieval", file: "src/core/adapters/qdrant/sparse.ts" },
  {
    q: "the registry that builds walkers and resolvers for each programming language",
    file: "src/core/domains/language/factory.ts",
  },
  { q: "error types thrown when language processing fails", file: "src/core/domains/language/errors.ts" },
  { q: "building the command line application and registering its commands", file: "src/cli/create-cli.ts" },
  { q: "shell completion scripts for the CLI", file: "src/cli/completion.ts" },
  {
    q: "tracking indexing phases and reporting progress to the UI renderer",
    file: "src/cli/index-progress/phase-tracker.ts",
  },
  { q: "core type definitions shared across the server", file: "src/core/types.ts" },
  { q: "package entry point exporting the public server API", file: "src/index.ts" },
];

function buildQueries(a) {
  const corpusPath = a.corpus ?? "/tmp/ab-corpus-700.json";
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  const corpusFiles = new Set(corpus.map((d) => d.file));
  const queries = [];
  for (const { q, file } of QUERIES_A) {
    if (!statSync(join(REPO, file), { throwIfNoEntry: false })) throw new Error(`A-query target missing: ${file}`);
    if (!corpusFiles.has(file)) throw new Error(`A-query target not in corpus: ${file} (rebuild corpus with src root)`);
    queries.push({ set: "A", q, expect: file });
  }
  // B: code -> test. Query = opening lines of the source file (imports + first
  // declarations); expected = any chunk of its conventionally-named test file.
  const srcFiles = walkTs(join(REPO, "src")).map((f) => f.slice(REPO.length));
  const testByBasename = new Map();
  for (const f of corpusFiles) {
    if (f.startsWith("tests/") && f.endsWith(".test.ts")) {
      const base = f.slice("tests/".length).replace(/\.test\.ts$/, "");
      if (!testByBasename.has(base)) testByBasename.set(base, f);
    }
  }
  let bCount = 0;
  for (const src of srcFiles) {
    const base = src.slice("src/".length).replace(/\.ts$/, "");
    const test = testByBasename.get(base);
    if (!test) continue;
    const text = readFileSync(join(REPO, src), "utf8");
    const q = text.split("\n").slice(0, 40).join("\n").slice(0, 1200);
    if (q.trim().length < 100) continue;
    queries.push({ set: "B", q, expect: test, src });
    bCount++;
    if (bCount >= 60) break;
  }
  const out = a.out ?? "/tmp/ab-queries.json";
  writeFileSync(out, JSON.stringify(queries));
  console.log(`queries: ${QUERIES_A.length} A + ${bCount} B -> ${out}`);
}

// ── embeddings client ───────────────────────────────────────────────────────
// llama-server rejects a request whose total tokens exceed its physical batch
// size (-ub): "input (N tokens) is too large". Split every logical batch into
// requests that fit an estimated token budget (code ≈ 3.5 chars/token).
const CHARS_PER_TOKEN = 3.0; // code tokenizes denser than prose; underestimate chars/token
const UB_MARGIN = 0.85; // stay under -ub even when the estimate is optimistic

function fitSlices(texts, batch, ubTokens) {
  const budget = Math.floor(ubTokens * UB_MARGIN);
  const slices = [];
  let cur = [];
  let tok = 0;
  for (const t of texts) {
    const tTok = Math.ceil(t.length / CHARS_PER_TOKEN);
    if (cur.length && (cur.length >= batch || tok + tTok > budget)) {
      slices.push(cur);
      cur = [];
      tok = 0;
    }
    cur.push(t);
    tok += tTok;
  }
  if (cur.length) slices.push(cur);
  return slices;
}

async function embed(port, texts, batch, inflight, ubTokens) {
  const slices = fitSlices(texts, batch, ubTokens);
  let pos = 0;
  const offsets = slices.map((s) => {
    const o = pos;
    pos += s.length;
    return o;
  });
  const vecs = new Map();
  let nextSlice = 0;
  async function run() {
    while (nextSlice < slices.length) {
      const si = nextSlice++;
      const slice = slices[si];
      const start = offsets[si];
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: slice, model: "bench" }),
            signal: AbortSignal.timeout(120000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
          const json = await res.json();
          for (const d of json.data) vecs.set(start + d.index, d.embedding);
          break;
        } catch (e) {
          if (attempt >= 4) throw e;
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
  }
  await Promise.all(Array.from({ length: inflight }, run));
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    const v = vecs.get(i);
    if (!v) throw new Error(`missing embedding ${i}`);
    out.push(v);
  }
  return out;
}

async function throughput(a) {
  const corpus = JSON.parse(readFileSync(a.corpus ?? "/tmp/ab-corpus-700.json", "utf8"));
  const seconds = a.seconds ?? 30;
  const batch = a.batch ?? 64;
  const inflight = a.inflight ?? 4;
  const ubTokens = a.ub ?? 8192;
  const pool = fitSlices(
    corpus.map((d) => d.text),
    batch,
    ubTokens,
  );
  let chars = 0;
  let count = 0;
  let errors = 0;
  const deadline = Date.now() + seconds * 1000;
  async function worker(warm) {
    let i = (warm * 131) % pool.length;
    while (Date.now() < deadline) {
      const slice = pool[i % pool.length];
      i++;
      try {
        const res = await fetch(`http://127.0.0.1:${a.port}/v1/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: slice, model: "bench" }),
          signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.json();
        count += slice.length;
        chars += slice.reduce((s, t) => s + t.length, 0);
      } catch {
        errors += slice.length;
      }
    }
  }
  const t0 = Date.now();
  await Promise.all(Array.from({ length: inflight }, (_, w) => worker(w)));
  const elapsed = (Date.now() - t0) / 1000;
  console.log(
    JSON.stringify({
      port: a.port,
      seconds: +elapsed.toFixed(1),
      texts_per_s: +(count / elapsed).toFixed(1),
      chars_per_s: Math.round(chars / elapsed),
      requests: Math.round(count / (pool.reduce((s, p) => s + p.length, 0) / pool.length)),
      avg_request_texts: +(pool.reduce((s, p) => s + p.length, 0) / pool.length).toFixed(1),
      errors,
    }),
  );
}

function cosineRank(v, docs) {
  const norm = (x) => Math.sqrt(x.reduce((s, c) => s + c * c, 0));
  const vn = norm(v);
  return docs
    .map((d, i) => ({ i, file: d.file, s: v.reduce((s, c, k) => s + c * d.vec[k], 0) / (vn * d.n) }))
    .sort((x, y) => y.s - x.s);
}

async function quality(a) {
  const corpus = JSON.parse(readFileSync(a.corpus, "utf8"));
  const queries = JSON.parse(readFileSync(a.queries ?? "/tmp/ab-queries.json", "utf8"));
  const limit = a.limit ?? queries.length;
  const qs = queries.slice(0, limit);
  const ubTokens = a.ub ?? 8192;
  // -maxchars: emulate producer-side truncation for models whose context the
  // raw corpus exceeds (llama-server REJECTS over-context texts with
  // exceed_context_size rather than truncating them).
  const { maxchars } = a;
  const clip = (t) => (maxchars ? t.slice(0, maxchars) : t);
  const t0 = Date.now();
  const docVecs = await embed(
    a.port,
    corpus.map((d) => clip(d.text)),
    64,
    4,
    ubTokens,
  );
  const qVecs = await embed(
    a.port,
    qs.map((q) => clip(q.q)),
    32,
    2,
    ubTokens,
  );
  const docs = corpus.map((d, i) => ({
    file: d.file,
    vec: docVecs[i],
    n: Math.sqrt(docVecs[i].reduce((s, c) => s + c * c, 0)),
  }));
  const perSet = {};
  for (let qi = 0; qi < qs.length; qi++) {
    const ranked = cosineRank(qVecs[qi], docs);
    const { expect } = qs[qi];
    const firstRel = ranked.findIndex((r) => r.file === expect);
    const in10 = ranked.slice(0, 10).some((r) => r.file === expect);
    const { set } = qs[qi];
    perSet[set] ??= { n: 0, mrr: 0, r10: 0 };
    perSet[set].n++;
    perSet[set].mrr += firstRel >= 0 ? 1 / (firstRel + 1) : 0;
    perSet[set].r10 += in10 ? 1 : 0;
  }
  const report = {};
  for (const [set, r] of Object.entries(perSet))
    report[set] = { n: r.n, MRR: +(r.mrr / r.n).toFixed(3), recall_at_10: +(r.r10 / r.n).toFixed(3) };
  report.seconds = +((Date.now() - t0) / 1000).toFixed(1);
  console.log(JSON.stringify({ port: a.port, corpus: corpus.length, ...report }));
}

const a = parseArgs(process.argv.slice(2));
if (a.mode === "corpus") await buildCorpus(a);
else if (a.mode === "queries") await buildQueries(a);
else if (a.mode === "throughput") await throughput(a);
else if (a.mode === "quality") await quality(a);
else {
  console.error("modes: corpus | queries | throughput | quality  (see header comment)");
  process.exit(1);
}
