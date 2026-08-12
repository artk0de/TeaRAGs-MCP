/**
 * How many `ts.Program`s does a run actually NEED? (bd tea-rags-mcp-d77bl)
 *
 * `ts-program-cache-run-profile.ts` establishes that the entry-keyed cache
 * builds exactly one Program per entry file, and that each of those Programs
 * already contains the entry's whole transitive import closure — on a
 * barrel-linked corpus, effectively every file. The two facts together say the
 * cache is missing on data it already holds: the Program built for `a.ts`
 * contains `b.ts` too, and `b.ts` is the very next entry.
 *
 * This probe puts a number on that. It walks the corpus in resolve order and
 * builds a new Program only when no Program already retained CONTAINS the entry
 * file, which is the coverage-keyed lookup the fix would add. Reported against
 * the entry-keyed baseline, under both resolve orders and both fixture
 * topologies, so the answer distinguishes "barrels made everything one cluster"
 * from "reuse works generally".
 *
 *   npx tsx scripts/spikes/ts-program-coverage-reuse-probe.ts [--features N] [--no-barrels]
 */

import { performance } from "node:perf_hooks";

import { loadTsConfig } from "../../src/core/domains/language/typescript/resolver/ts-config-loader.js";
import { TSProgramCache } from "../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { collectProjectFiles, FIXTURE_ROOT, parseShapeArgs } from "./ts-fixture-corpus.js";
import { DEFAULT_SHAPE, generateFixture, type FixtureShape } from "./ts-fixture-gen.js";

/**
 * Simulate the coverage-keyed cache: retain up to `maxRetained` Programs, and
 * serve an entry from any retained Program that already contains it.
 *
 * Deliberately simulated on top of the REAL cache rather than reimplemented —
 * every Program here is built by `TSProgramCache.acquire`, so the closure walk,
 * the compiler options and the shared host are the shipped ones. Only the
 * lookup that decides whether to build is new.
 */
function measureReuse(
  files: string[],
  cache: TSProgramCache,
  maxRetained: number,
): { builds: number; wallMs: number; coveredBy: number[] } {
  // A retained Program, remembered by the set of files it turned out to contain.
  const retained: { covers: Set<string>; order: number }[] = [];
  const coveredBy: number[] = [];
  let builds = 0;
  const started = performance.now();

  for (const relPath of files) {
    const hit = retained.find((entry) => entry.covers.has(relPath));
    if (hit) {
      coveredBy.push(hit.order);
      continue;
    }
    const handle = cache.acquire(relPath as never);
    if (!handle) continue;
    builds += 1;
    const covers = new Set<string>();
    for (const file of handle.program.getSourceFiles()) {
      if (file.fileName.startsWith(`${FIXTURE_ROOT}/`)) covers.add(file.fileName.slice(FIXTURE_ROOT.length + 1));
    }
    retained.push({ covers, order: builds });
    if (retained.length > maxRetained) retained.shift();
    coveredBy.push(builds);
  }
  return { builds, wallMs: performance.now() - started, coveredBy };
}

/** Entry-keyed baseline: what the shipped cache does — one build per entry. */
function measureBaseline(files: string[], cache: TSProgramCache): { builds: number; wallMs: number } {
  let builds = 0;
  const started = performance.now();
  for (const relPath of files) {
    if (cache.acquire(relPath as never)) builds += 1;
  }
  return { builds, wallMs: performance.now() - started };
}

function run(shape: FixtureShape): void {
  generateFixture(FIXTURE_ROOT, shape);
  const files = collectProjectFiles(FIXTURE_ROOT);
  const tsOptions = loadTsConfig(FIXTURE_ROOT);

  // A fresh cache per arm: a warm parse cache would hand the second arm a head
  // start the first one paid for.
  const baseline = measureBaseline(files, new TSProgramCache({ repoRoot: FIXTURE_ROOT, tsOptions }));
  const reuse = measureReuse(files, new TSProgramCache({ repoRoot: FIXTURE_ROOT, tsOptions }), 8);

  console.log(
    JSON.stringify(
      {
        corpusFiles: files.length,
        barrels: shape.useBarrels,
        entryKeyed: { programBuilds: baseline.builds, wallMs: Math.round(baseline.wallMs) },
        coverageKeyed: { programBuilds: reuse.builds, wallMs: Math.round(reuse.wallMs) },
        buildReduction: `${baseline.builds} -> ${reuse.builds}`,
        speedup: +(baseline.wallMs / Math.max(reuse.wallMs, 0.001)).toFixed(2),
        rssMb: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1),
      },
      null,
      2,
    ),
  );
}

const args = parseShapeArgs(process.argv.slice(2), DEFAULT_SHAPE);
run(args.shape);
