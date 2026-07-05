/**
 * Step 0 spike (bd tea-rags-mcp-dog1v) — is es-git (napi-rs / libgit2)
 * `blameFile` thread-safe across worker_threads?
 *
 * The design "git blame off the main thread" (docs/superpowers/specs/
 * 2026-07-05-git-blame-off-main-thread-design.md) moves the sync es-git blame
 * into a POOL of workers. A thread pool is the cheapest transport IF es-git is
 * thread-safe. node-tree-sitter is NOT (yl9tv): concurrent parse() from two
 * threads corrupts shared native state -> a non-deterministic count for the
 * same file. This spike runs the same diagnosis on es-git blame.
 *
 * Method (mirror yl9tv: isolation-stable vs concurrency-corrupt):
 *   1. Baseline: ONE repo handle, blame each file once -> canonical hunk sig.
 *   2. Concurrency: K worker_threads (EACH its own openRepository handle) +
 *      the main thread all blame the SAME files, M iterations, concurrently.
 *   3. Compare every observed sig to the baseline. Any file whose observed
 *      hunk-count set has size > 1, any sig mismatch, or any Napi::Error crash
 *      => RED (native layer not thread-safe -> process pool). All stable +
 *      no crash => GREEN (thread pool).
 *
 * Pure .mjs so worker_threads load without a tsx loader hook. Tests the RAW
 * binding (repo.blameFile) — the exact napi call EsGitAdapter.blameFileInProcess
 * makes — so the verdict is about es-git itself, not our wrapper.
 *
 * Run:  node scripts/spikes/esgit-thread-safety.js
 * Env:  SPIKE_REPO   repo root to blame (default: this worktree)
 *       SPIKE_WORKERS number of concurrent worker threads (default 4)
 *       SPIKE_ITERS   blame iterations per worker per file (default 20)
 *       SPIKE_GLOB    git-ls-files pathspec for candidate files
 */

import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import { openRepository, openRepositoryFromWorktree } from "es-git";

const REPO_ROOT = process.env.SPIKE_REPO ?? fileURLToPath(new URL("../..", import.meta.url));
const WORKERS = Number(process.env.SPIKE_WORKERS ?? 4);
const ITERS = Number(process.env.SPIKE_ITERS ?? 20);
const GLOB = process.env.SPIKE_GLOB ?? "src/core/domains/trajectory/git/**/*.ts";
/** Files whose baseline blame is slower than this are DEEP (would route to the
 *  CLI in prod) — excluded so the spike stays in-process and fast. */
const DEEP_BLAME_MS = 3000;
/** Cap the in-process file set so K*M*files blames stay a few seconds. */
const MAX_FILES = 12;

/** Open the repo, tolerating a linked worktree (its `.git` is a file).
 *  es-git's openRepository returns a Promise (mirrors EsGitAdapter.open's await). */
async function openRepo(root) {
  try {
    return await openRepository(root);
  } catch {
    return await openRepositoryFromWorktree(root);
  }
}

/** Canonical signature of a file's blame: per-hunk start:len:finalCommitId,
 *  plus the total hunk count. Mirrors EsGitAdapter.blameFileInProcess iteration
 *  order (index 0..hunkCount). */
function blameSig(repo, head, filePath) {
  const blame = repo.blameFile(filePath, { newestCommit: head, useMailmap: true });
  const count = blame.getHunkCount();
  const parts = [];
  for (let i = 0; i < count; i++) {
    const h = blame.getHunkByIndex(i);
    parts.push(`${h.finalStartLineNumber}:${h.linesInHunk}:${h.finalCommitId}`);
  }
  return { count, sig: parts.join("|") };
}

// ── Worker ────────────────────────────────────────────────────────────────
if (!isMainThread) {
  void (async () => {
    const { repoRoot, files, iters, workerId } = workerData;
    // Per file: the set of distinct sigs this worker observed across `iters`.
    const observed = {};
    for (const f of files) observed[f] = {};
    try {
      const repo = await openRepo(repoRoot);
      const head = repo.revparseSingle("HEAD");
      for (let it = 0; it < iters; it++) {
        for (const f of files) {
          const { count, sig } = blameSig(repo, head, f);
          const key = `${count}::${sig}`;
          observed[f][key] = (observed[f][key] ?? 0) + 1;
        }
      }
      parentPort.postMessage({ ok: true, workerId, observed });
    } catch (error) {
      parentPort.postMessage({ ok: false, workerId, error: String(error?.stack ?? error) });
    }
  })();
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`# es-git thread-safety spike`);
  console.log(`repo:    ${REPO_ROOT}`);
  console.log(`workers: ${WORKERS}   iters/worker: ${ITERS}   glob: ${GLOB}`);

  // Candidate files — one-shot git ls-files (experiment setup, not code search).
  const listed = execFileSync("git", ["-C", REPO_ROOT, "ls-files", GLOB], { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (listed.length === 0) {
    console.error(`RED: no files matched ${GLOB} — cannot run spike`);
    process.exit(2);
  }

  // Baseline + depth filter: keep multi-hunk, shallow (fast) files only.
  const repo = await openRepo(REPO_ROOT);
  const head = repo.revparseSingle("HEAD");
  const baseline = {};
  const files = [];
  for (const f of listed) {
    if (files.length >= MAX_FILES) break;
    const t0 = performance.now();
    let res;
    try {
      res = blameSig(repo, head, f);
    } catch {
      continue; // unblameable — skip
    }
    const ms = performance.now() - t0;
    if (ms > DEEP_BLAME_MS) continue; // deep-history -> CLI route in prod, skip
    if (res.count < 2) continue; // trivial 1-hunk file gives no corruption signal
    baseline[f] = res;
    files.push(f);
  }
  if (files.length === 0) {
    console.error(`RED: no shallow multi-hunk files found — widen SPIKE_GLOB`);
    process.exit(2);
  }
  console.log(`\nbaseline (single-thread, stable by construction):`);
  for (const f of files) console.log(`  ${baseline[f].count} hunks  ${f}`);

  // Re-run the baseline a few times single-threaded to PROVE isolation stability
  // (the control arm — if this drifts, the file itself is nondeterministic).
  let isolationStable = true;
  for (let r = 0; r < 3; r++) {
    for (const f of files) {
      const res = blameSig(repo, head, f);
      if (res.count !== baseline[f].count || res.sig !== baseline[f].sig) {
        isolationStable = false;
        console.log(`  ISOLATION DRIFT ${f}: ${baseline[f].count} -> ${res.count}`);
      }
    }
  }
  console.log(`isolation control: ${isolationStable ? "STABLE" : "DRIFT (file nondeterministic — invalid spike)"}`);

  // Concurrency arm: K workers + main all blame concurrently.
  const t0 = performance.now();
  const workerPromises = Array.from(
    { length: WORKERS },
    (_, workerId) =>
      new Promise((resolve, reject) => {
        const w = new Worker(fileURLToPath(import.meta.url), {
          workerData: { repoRoot: REPO_ROOT, files, iters: ITERS, workerId },
        });
        w.once("message", (m) => resolve(m));
        w.once("error", (e) => reject(e)); // Napi::Error crash surfaces here
        w.once("exit", (code) => {
          if (code !== 0) reject(new Error(`worker ${workerId} exited ${code}`));
        });
      }),
  );

  // Main-thread concurrent blame (worker-vs-main hazard, per yl9tv).
  const mainObserved = {};
  for (const f of files) mainObserved[f] = {};
  const mainLoop = (async () => {
    for (let it = 0; it < ITERS; it++) {
      for (const f of files) {
        const { count, sig } = blameSig(repo, head, f);
        const key = `${count}::${sig}`;
        mainObserved[f][key] = (mainObserved[f][key] ?? 0) + 1;
      }
      await new Promise((r) => setImmediate(r)); // let worker messages interleave
    }
  })();

  let crashed = null;
  let results;
  try {
    [results] = [await Promise.all(workerPromises)];
    await mainLoop;
  } catch (e) {
    crashed = e;
  }
  const wallMs = performance.now() - t0;

  // Aggregate: per file, the union of distinct sigs across ALL arms.
  const perFile = {};
  for (const f of files) perFile[f] = new Map();
  const addArm = (observed) => {
    for (const f of files) {
      for (const [key, n] of Object.entries(observed[f] ?? {})) {
        perFile[f].set(key, (perFile[f].get(key) ?? 0) + n);
      }
    }
  };
  const workerFailures = [];
  if (results) {
    for (const r of results) {
      if (!r.ok) workerFailures.push(`worker ${r.workerId}: ${r.error}`);
      else addArm(r.observed);
    }
  }
  addArm(mainObserved);
  // fold in main baseline key too
  for (const f of files) {
    const bkey = `${baseline[f].count}::${baseline[f].sig}`;
    perFile[f].set(bkey, (perFile[f].get(bkey) ?? 0) + 1);
  }

  console.log(`\nconcurrency arm: ${WORKERS} workers + main, ${wallMs.toFixed(0)}ms wall`);
  let corrupted = false;
  for (const f of files) {
    const variants = perFile[f];
    const counts = new Set([...variants.keys()].map((k) => k.split("::")[0]));
    const baselineKey = `${baseline[f].count}::${baseline[f].sig}`;
    const sigMismatch = [...variants.keys()].some((k) => k !== baselineKey);
    if (counts.size > 1 || sigMismatch) {
      corrupted = true;
      console.log(`  CORRUPT ${f}: hunk-count set {${[...counts].join(",")}} (baseline ${baseline[f].count})`);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  if (crashed || workerFailures.length) {
    console.log(`VERDICT: RED (crash) -> process pool (ProcessTransport)`);
    if (crashed) console.log(`  main/await error: ${String(crashed.stack ?? crashed)}`);
    for (const wf of workerFailures) console.log(`  ${wf}`);
    process.exit(1);
  }
  if (!isolationStable) {
    console.log(`VERDICT: INVALID — isolation control drifted; blame nondeterministic even single-threaded`);
    process.exit(2);
  }
  if (corrupted) {
    console.log(`VERDICT: RED (corruption) -> process pool (ProcessTransport)`);
    console.log(`  concurrent es-git blame produced variable results — same class as yl9tv (tree-sitter)`);
    process.exit(1);
  }
  console.log(`VERDICT: GREEN -> es-git thread pool (worker_threads) is safe`);
  console.log(`  ${WORKERS} workers x ${ITERS} iters x ${files.length} files, all sigs == baseline, no crash`);
  process.exit(0);
}

if (isMainThread) {
  main().catch((e) => {
    console.error(`spike main crashed: ${String(e?.stack ?? e)}`);
    process.exit(3);
  });
}
