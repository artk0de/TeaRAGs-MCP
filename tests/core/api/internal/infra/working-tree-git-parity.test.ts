/**
 * Working-tree git parity harness (bd tea-rags-mcp-xi2r9, round-4 P3).
 *
 * The invariant: a working-tree delta row carries EXACTLY the `git.file` /
 * `git.chunk` blocks a reindex of that tree would write, with the index's own
 * config. The reference is INGEST — never `git log -L`, which ingest itself
 * departs from — so each case runs the real ingest computation over the whole
 * tree (`GitEnrichmentProvider`: streaming file batch over the windowed
 * discovery, backfill for what the window misses, the chunk walk over the
 * run-scoped commit matrix, chunk backfill — then the applier's `enrichedAt`
 * stamp) and asserts the overlay's delta rows (`createWorkingTreeDeltaSignalSource`
 * over `createWorkingTreeGitSignalSource`, base points from the same ingest run
 * at the index stamp) equal it.
 *
 * Cases: an uncommitted-only edit, a commit since the index, a backdated
 * commit, a rebased commit, a never-committed file, a new symbol in a tracked
 * file, a committed rename, a committed insertion above a symbol, uncommitted
 * edits inside and above symbols (both sides carry working rows onto HEAD), a
 * tree that branched before the stamp (only the stamp's side touched a file),
 * and a file past the chunk walk's line limit (the policy's `skippedAs` stamps).
 *
 * Time-derived fields are compared at a pinned clock (`Date` faked); the
 * `enrichedAt` stamp is a run time on both sides and is asserted present, not
 * equal.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { importGitHistory } from "../../../__helpers__/git-history-import.js";
import { GitCliAdapter } from "../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import type { BlameLine } from "../../../../../src/core/adapters/vcs/types.js";
import { createWorkingTreeDeltaSignalSource } from "../../../../../src/core/api/internal/infra/working-tree-delta-signals.js";
import { createWorkingTreeGitSignalSource } from "../../../../../src/core/api/internal/infra/working-tree-git-signals.js";
import type {
  WorkingTreeBasePoint,
  WorkingTreeDeltaRow,
} from "../../../../../src/core/contracts/types/working-tree.js";
import {
  enrichmentSkipReason,
  fileLinesOf,
} from "../../../../../src/core/domains/ingest/pipeline/enrichment/policy.js";
import type { SquashOptions } from "../../../../../src/core/domains/trajectory/git/infra/metrics.js";
import { GitEnrichmentProvider } from "../../../../../src/core/domains/trajectory/git/provider.js";

// The file phase blames on a worker-thread pool whose worker runs
// `adapter.blameFile` — the same call, run here in-thread so the harness does
// not depend on a compiled worker.
vi.mock("../../../../../src/core/domains/trajectory/git/infra/churn-walk/blame-pool.js", () => ({
  BlameWorkerPool: vi.fn(function () {
    return {
      blame: async (
        root: string,
        _kind: string,
        files: { relPath: string; historyDepthHint?: number }[],
        timeoutMs: number,
      ): Promise<Map<string, BlameLine[]>> => {
        const adapter = new GitCliAdapter(root);
        const out = new Map<string, BlameLine[]>();
        for (const { relPath, historyDepthHint } of files) {
          out.set(relPath, await adapter.blameFile(relPath, timeoutMs, historyDepthHint));
        }
        return out;
      },
      close: async () => undefined,
    };
  }),
}));

vi.setConfig({ testTimeout: 120_000 });

const TMP_BASE = realpathSync(tmpdir());
const PINNED = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY = 86_400_000;
const at = (daysAgo: number, minutes = 0): string => new Date(PINNED - daysAgo * DAY + minutes * 60_000).toISOString();
const TIMEOUT_MS = 30_000;
const WINDOWS = { file: 12, chunk: 6, maxFileLines: 5000 };

type Block = Record<string, unknown>;
interface ChunkRow {
  symbolId: string;
  startLine: number;
  endLine: number;
  /** The file's physical line count, as the chunker stamps every chunk of it. */
  moduleLines: number;
}

/** Top-level `export function` / `export class` blocks, from their line to the next column-0 `}`. */
function chunksOf(content: string): ChunkRow[] {
  const lines = content.split("\n");
  const moduleLines = content.endsWith("\n") ? lines.length - 1 : lines.length;
  const rows: ChunkRow[] = [];
  lines.forEach((line, i) => {
    const match = /^export (?:function|class) (\w+)/.exec(line);
    if (!match) return;
    const end = lines.findIndex((other, j) => j > i && other === "}");
    rows.push({ symbolId: match[1], startLine: i + 1, endLine: end + 1, moduleLines });
  });
  return rows;
}

function repoGit(cwd: string, args: string[], who = "alice", when = at(0), committedAt = when): string {
  if (!resolve(cwd).startsWith(TMP_BASE + sep)) throw new Error(`refusing git outside the temp root: ${cwd}`);
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: who,
      GIT_AUTHOR_EMAIL: `${who}@x`,
      GIT_COMMITTER_NAME: who,
      GIT_COMMITTER_EMAIL: `${who}@x`,
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: committedAt,
    },
  }).trim();
}

function write(root: string, relPath: string, content: string): void {
  const target = join(root, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

interface ParityCommit {
  /** key of the sha in {@link commitAll}'s result */
  label?: string;
  files?: Record<string, string>;
  rename?: [string, string];
  message: string;
  /** author AND committer, `<who>@x` */
  who: string;
  when: string;
  committedAt?: string;
  branch?: string;
  from?: string;
}

/**
 * Commits `commits` in order onto `root`'s `main` (a fresh repository when
 * `init`) with ONE fast-import (bd tea-rags-mcp-1r3e5) — the identities and
 * dates the add/commit chain gave them — and returns the labelled shas.
 */
function commitAll(root: string, commits: readonly ParityCommit[], init = true): Record<string, string> {
  if (!resolve(root).startsWith(TMP_BASE + sep)) throw new Error(`refusing git outside the temp root: ${root}`);
  return importGitHistory(
    root,
    commits.map((c) => ({
      label: c.label,
      branch: c.branch,
      from: c.from,
      message: c.message,
      author: { name: c.who, email: `${c.who}@x` },
      authorDate: c.when,
      committerDate: c.committedAt ?? c.when,
      writes: c.files,
      renames: c.rename === undefined ? undefined : [c.rename],
    })),
    { init },
  );
}

/** What ingest writes for every file of `paths` in the tree at `root`: file blocks by path, chunk blocks by `path::symbol`. */
async function ingestReference(
  root: string,
  paths: readonly string[],
  squashOpts: SquashOptions | undefined,
): Promise<{ file: Map<string, Block>; chunk: Map<string, Block> }> {
  const provider = new GitEnrichmentProvider(
    {
      vcsAdapter: "git",
      logMaxAgeMonths: WINDOWS.file,
      logTimeoutMs: TIMEOUT_MS,
      chunkConcurrency: 4,
      blamePoolSize: 1,
      chunkMaxAgeMonths: WINDOWS.chunk,
      chunkTimeoutMs: TIMEOUT_MS,
      chunkMaxFileLines: WINDOWS.maxFileLines,
    },
    squashOpts,
  );
  const enrichedAt = new Date().toISOString();
  const rowsOf = new Map(paths.map((path) => [path, chunksOf(readFileSync(join(root, path), "utf8"))]));
  const maxEndLine = (path: string): number => Math.max(0, ...(rowsOf.get(path) ?? []).map((row) => row.endLine));
  const chunkIdOf = (path: string, symbolId: string): string => `${path}::${symbolId}`;
  const lookupOf = (path: string) =>
    (rowsOf.get(path) ?? []).map((row) => ({
      chunkId: chunkIdOf(path, row.symbolId),
      startLine: row.startLine,
      endLine: row.endLine,
      moduleLines: row.moduleLines,
    }));

  const file = new Map<string, Block>();
  const chunk = new Map<string, Block>();
  // The pipeline's policy: a level the provider declines carries the skip stamp
  // and nothing else (file phase without a line count, chunk phase with it).
  const declinedFile = new Map(paths.map((path) => [path, enrichmentSkipReason(provider, path, "file")]));
  const declinedChunk = new Map(
    paths.map((path) => [
      path,
      enrichmentSkipReason(provider, path, "chunk", { fileLines: fileLinesOf(lookupOf(path)) }),
    ]),
  );
  const filePaths = paths.filter((path) => declinedFile.get(path) === null);
  const chunkPaths = paths.filter((path) => declinedChunk.get(path) === null);
  for (const path of paths) {
    const fileReason = declinedFile.get(path);
    if (fileReason) file.set(path, { skippedAs: fileReason });
    const chunkReason = declinedChunk.get(path);
    if (chunkReason) {
      for (const row of rowsOf.get(path) ?? []) chunk.set(chunkIdOf(path, row.symbolId), { skippedAs: chunkReason });
    }
  }
  try {
    // Streaming file batch, then the chunk walk over the run-scoped matrix.
    const streamed = await provider.streamFileBatch(root, [...filePaths]);
    for (const [path, data] of streamed) {
      file.set(path, { ...provider.fileSignalTransform?.(data, maxEndLine(path)), enrichedAt });
    }
    // Keyed repo-relative, as `ChunkPhase#extractBatchChunkMap` and the
    // recompute scroll hand the chunk map to the provider.
    const walked = await provider.buildChunkSignals(root, new Map(chunkPaths.map((path) => [path, lookupOf(path)])), {
      skipCache: true,
      commitDiscovery: provider.createCommitDiscovery(root),
    });
    for (const overlays of walked.values()) {
      for (const [chunkId, overlay] of overlays) chunk.set(chunkId, { ...overlay, enrichedAt });
    }
    // Backfill: a file the window found nothing for, then its chunks re-walked.
    const missed = filePaths.filter((path) => !streamed.has(path));
    const backfilled = missed.length > 0 ? await provider.buildFileSignals(root, { paths: missed }) : new Map();
    for (const path of missed) {
      const data = backfilled.get(path);
      file.set(path, data ? { ...provider.fileSignalTransform?.(data, maxEndLine(path)), enrichedAt } : { enrichedAt });
    }
    const refill = missed.filter((path) => backfilled.has(path) && declinedChunk.get(path) === null);
    if (refill.length > 0) {
      const rewalked = await provider.buildChunkSignals(root, new Map(refill.map((path) => [path, lookupOf(path)])));
      for (const overlays of rewalked.values()) {
        for (const [chunkId, overlay] of overlays) chunk.set(chunkId, { ...overlay, enrichedAt });
      }
    }
    // A requested chunk the walk answered nothing for gets the bare stamp.
    for (const path of chunkPaths) {
      for (const row of rowsOf.get(path) ?? []) {
        const id = chunkIdOf(path, row.symbolId);
        if (!chunk.has(id)) chunk.set(id, { enrichedAt });
      }
    }
  } finally {
    await provider.finalizeSignals();
  }
  return { file, chunk };
}

/** The index's stored points of `paths`, as ingest wrote them at the stamp. */
async function indexAt(
  root: string,
  paths: readonly string[],
  squashOpts: SquashOptions | undefined,
): Promise<Map<string, WorkingTreeBasePoint[]>> {
  const reference = await ingestReference(root, paths, squashOpts);
  const points = new Map<string, WorkingTreeBasePoint[]>();
  for (const path of paths) {
    points.set(
      path,
      chunksOf(readFileSync(join(root, path), "utf8")).map((row) => ({
        id: `base:${path}::${row.symbolId}`,
        payload: {
          relativePath: path,
          symbolId: row.symbolId,
          startLine: row.startLine,
          endLine: row.endLine,
          moduleLines: row.moduleLines,
          git: { file: reference.file.get(path), chunk: reference.chunk.get(`${path}::${row.symbolId}`) },
        },
      })),
    );
  }
  return points;
}

/** The overlay's delta rows of `paths` in the tree at `root`, enriched against the index. */
async function overlayRows(
  root: string,
  paths: readonly string[],
  basePoints: Map<string, WorkingTreeBasePoint[]>,
  indexedCommit: string,
  squashOpts: SquashOptions | undefined,
  renamedFrom?: ReadonlyMap<string, string>,
): Promise<WorkingTreeDeltaRow[]> {
  const rows: WorkingTreeDeltaRow[] = paths.flatMap((path) =>
    chunksOf(readFileSync(join(root, path), "utf8")).map((row) => ({
      id: `${path}::${row.symbolId}`,
      payload: {
        relativePath: path,
        symbolId: row.symbolId,
        startLine: row.startLine,
        endLine: row.endLine,
        moduleLines: row.moduleLines,
      },
    })),
  );
  const source = createWorkingTreeDeltaSignalSource({
    graphFiles: () => undefined,
    gitSignals: createWorkingTreeGitSignalSource({
      vcsAdapter: "git",
      timeoutMs: TIMEOUT_MS,
      ...(squashOpts ? { squashOpts } : {}),
      file: { maxAgeMonths: WINDOWS.file },
      chunk: { maxAgeMonths: WINDOWS.chunk, timeoutMs: TIMEOUT_MS, maxFileLines: WINDOWS.maxFileLines, concurrency: 4 },
    }),
  });
  const result = await source.enrich({
    tree: { root, baseIndex: { collectionName: "code_parity", root } },
    rows,
    indexedCommit,
    readTouchedBasePoints: async () => basePoints,
    ...(renamedFrom ? { renamedFrom } : {}),
  });
  return result.rows;
}

/**
 * A block with its run stamp taken out, after asserting it carried one. A
 * policy-declined level holds its skip stamp and nothing else — compared whole.
 */
function unstamped(block: unknown, where: string): Block | undefined {
  if (block === undefined) return undefined;
  if ((block as Block).skippedAs !== undefined) return block as Block;
  const { enrichedAt, ...rest } = block as Block;
  expect(enrichedAt, `${where}: enrichedAt`).toEqual(expect.any(String));
  return rest;
}

function expectParity(
  rows: readonly WorkingTreeDeltaRow[],
  reference: { file: Map<string, Block>; chunk: Map<string, Block> },
): void {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const where = String(row.id);
    const git = (row.payload.git ?? {}) as { file?: Block; chunk?: Block };
    const path = row.payload.relativePath as string;
    expect(unstamped(git.file, `${where} file`), `${where} git.file`).toEqual(
      unstamped(reference.file.get(path), `${where} reference file`),
    );
    expect(unstamped(git.chunk, `${where} chunk`), `${where} git.chunk`).toEqual(
      unstamped(reference.chunk.get(where), `${where} reference chunk`),
    );
  }
}

const ENGINE_V1 = [
  "export function helperB(): number {",
  "  return 2; // b0",
  "}",
  "",
  "export function helperA(): number {",
  "  return helperB() + 1;",
  "}",
  "",
  "export class Engine {",
  "  start(): number {",
  "    return helperA() + this.step();",
  "  }",
  "",
  "  step(): number {",
  "    return 1;",
  "  }",
  "}",
  "",
].join("\n");

describe.each([
  { label: "plain commits", squashOpts: undefined },
  { label: "squash-aware sessions", squashOpts: { squashAwareSessions: true, sessionGapMinutes: 30 } },
])("working-tree delta rows carry ingest's git blocks ($label)", ({ squashOpts }) => {
  let scratch: string;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED);
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "wt-git-parity-")));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("matches a reindex of a tree with commits since the index and uncommitted edits", async () => {
    const repo = join(scratch, "main");
    mkdirSync(repo);
    const { stamp } = commitAll(repo, [
      {
        files: {
          "src/engine.ts": ENGINE_V1,
          "src/user.ts": 'import { x } from "./x";\n\nexport function unchangedUser(): number {\n  return x + 1;\n}\n',
          "src/renamer.ts": "export function renamedTarget(): number {\n  return 3;\n}\n",
          "src/main.ts": "export function mainEntry(): number {\n  return 4;\n}\n",
          "src/zoo/animal.ts": "export class Animal {\n  name = 'a';\n}\n",
        },
        message: "init",
        who: "alice",
        when: at(40),
      },
      // Three quick helperB edits by one author — one squash session.
      ...[1, 2, 3].map((i) => ({
        files: { "src/engine.ts": ENGINE_V1.replace("// b0", `// b${i}`) },
        message: `feat: helperB ${i}`,
        who: "bob",
        when: at(35, i * 5),
      })),
      {
        label: "stamp",
        files: { "src/engine.ts": ENGINE_V1.replace("// b0", "// b3").replace("return 1;", "return 1; // v2") },
        message: "fix: engine step",
        who: "alice",
        when: at(20),
      },
    ]);
    const indexed = ["src/engine.ts", "src/user.ts", "src/renamer.ts", "src/main.ts", "src/zoo/animal.ts"];
    const basePoints = await indexAt(repo, indexed, squashOpts);

    const userNow = `${readFileSync(join(repo, "src/user.ts"), "utf8")}\nexport function carolCommitted(): number {\n  return 77;\n}\n`;
    const engineHelperA = readFileSync(join(repo, "src/engine.ts"), "utf8").replace("helperB() + 1", "helperB() + 2");
    const withZebra = engineHelperA.replace(
      "export class Engine",
      "export function zebraQuantumFlux(): number {\n  return helperB() * 42;\n}\n\nexport class Engine",
    );
    commitAll(
      repo,
      [
        // Since the index: a BACKDATED commit (dated before everything below it)...
        { files: { "src/user.ts": userNow }, message: "feat: carol user", who: "carol", when: at(45) },
        // ...a committed rename...
        {
          rename: ["src/renamer.ts", "src/renamerCommitted.ts"],
          message: "refactor: rename renamer",
          who: "dave",
          when: at(5),
        },
        // ...a REBASED commit (old author date, new committer date) editing one function...
        {
          files: { "src/engine.ts": engineHelperA },
          message: "fix: helperA",
          who: "erin",
          when: at(50),
          committedAt: at(1),
        },
        // ...and an insertion above a symbol.
        { files: { "src/engine.ts": withZebra }, message: "feat: zebra", who: "frank", when: at(1, 1) },
      ],
      false,
    );
    // Uncommitted: an edit outside every symbol, a new symbol in a tracked file, a never-committed file.
    appendFileSync(join(repo, "src/main.ts"), "// trailing note\n");
    appendFileSync(
      join(repo, "src/zoo/animal.ts"),
      "\nexport function freshAnimalSymbol(): string {\n  return 'fresh';\n}\n",
    );
    write(repo, "src/core/fresh.ts", "export function neverCommittedFresh(n: number): number {\n  return n * 3;\n}\n");

    const delta = [
      "src/engine.ts",
      "src/user.ts",
      "src/renamerCommitted.ts",
      "src/main.ts",
      "src/zoo/animal.ts",
      "src/core/fresh.ts",
    ];
    const reference = await ingestReference(repo, delta, squashOpts);
    const rows = await overlayRows(
      repo,
      delta,
      basePoints,
      stamp,
      squashOpts,
      new Map([["src/renamerCommitted.ts", "src/renamer.ts"]]),
    );

    expectParity(rows, reference);
  });

  it("matches a reindex of a tree that branched before the stamp", async () => {
    const repo = join(scratch, "main");
    mkdirSync(repo);
    const { branchPoint, stamp } = commitAll(repo, [
      {
        label: "branchPoint",
        files: { "src/engine.ts": ENGINE_V1, "src/cyc/b.ts": "export function bFn(): number {\n  return 1;\n}\n" },
        message: "init",
        who: "alice",
        when: at(30),
      },
      {
        label: "stamp",
        files: { "src/engine.ts": ENGINE_V1.replace("return 1;", "return 1; // main") },
        message: "fix: main moves engine",
        who: "bob",
        when: at(20),
      },
    ]);
    const basePoints = await indexAt(repo, ["src/engine.ts", "src/cyc/b.ts"], squashOpts);
    const tree = join(scratch, "div");
    // The branch commit goes in by import; checking `div` out in its linked worktree stays live.
    commitAll(
      repo,
      [
        {
          branch: "div",
          from: branchPoint,
          files: { "src/core/branch-work.ts": "export function branchWork(): number {\n  return 5;\n}\n" },
          message: "feat: branch",
          who: "carol",
          when: at(10),
        },
      ],
      false,
    );
    repoGit(repo, ["worktree", "add", "-q", tree, "div"]);

    const delta = ["src/engine.ts", "src/core/branch-work.ts"];
    const reference = await ingestReference(tree, delta, squashOpts);
    const rows = await overlayRows(tree, delta, basePoints, stamp, squashOpts);

    expectParity(rows, reference);
  });

  it("matches a reindex of a tree with uncommitted edits inside and above symbols", async () => {
    const repo = join(scratch, "main");
    mkdirSync(repo);
    const { stamp } = commitAll(repo, [
      { files: { "src/engine.ts": ENGINE_V1 }, message: "init", who: "alice", when: at(40) },
      {
        files: { "src/engine.ts": ENGINE_V1.replace("helperB() + 1", "helperB() + 3") },
        message: "fix: helperA",
        who: "bob",
        when: at(30),
      },
      {
        label: "stamp",
        files: {
          "src/engine.ts": ENGINE_V1.replace("helperB() + 1", "helperB() + 3").replace("return 1;", "return 1; // v2"),
        },
        message: "feat: engine step",
        who: "carol",
        when: at(20),
      },
    ]);
    const basePoints = await indexAt(repo, ["src/engine.ts"], squashOpts);

    // Uncommitted: lines added ABOVE every symbol (shifting all of them), and
    // lines added INSIDE helperA (growing its range).
    const dirty = readFileSync(join(repo, "src/engine.ts"), "utf8")
      .replace("export function helperB", "// header one\n// header two\n// header three\n\nexport function helperB")
      .replace("  return helperB() + 3;", "  const base = helperB();\n  const bump = 3;\n  return base + bump;");
    write(repo, "src/engine.ts", dirty);

    const delta = ["src/engine.ts"];
    const reference = await ingestReference(repo, delta, squashOpts);
    const rows = await overlayRows(repo, delta, basePoints, stamp, squashOpts);

    // Ingest carries a dirty file's working rows onto HEAD before the chunk
    // walk, as the overlay does: each symbol keeps its own HEAD commits
    // (helperB 1, helperA 2), never the commits of the symbol whose HEAD rows
    // its working rows landed on.
    expectParity(rows, reference);
    const chunkOf = (symbol: string) => unstamped(reference.chunk.get(`src/engine.ts::${symbol}`), symbol);
    expect(chunkOf("helperB")).toMatchObject({ commitCount: 1 });
    expect(chunkOf("helperA")).toMatchObject({ commitCount: 2 });
  });

  it("matches a reindex of a tree with an uncommitted-only symbol between committed ones", async () => {
    const repo = join(scratch, "main");
    mkdirSync(repo);
    const history: ParityCommit[] = [
      { files: { "src/engine.ts": ENGINE_V1 }, message: "init", who: "alice", when: at(40) },
    ];
    let content = ENGINE_V1;
    for (let v = 1; v <= 3; v++) {
      content = content.replace(v === 1 ? "return 1;" : `return 1; // v${v - 1}`, `return 1; // v${v}`);
      history.push({
        files: { "src/engine.ts": content },
        message: `fix: engine step ${v}`,
        who: "bob",
        when: at(30 - v),
      });
    }
    const { stamp } = commitAll(repo, [
      ...history,
      {
        label: "stamp",
        files: { "src/engine.ts": content.replace("// b0", "// b1") },
        message: "feat: helperB",
        who: "carol",
        when: at(20),
      },
    ]);
    const basePoints = await indexAt(repo, ["src/engine.ts"], squashOpts);

    // Uncommitted: header lines above every symbol, a line inside helperA, and
    // a brand-new symbol BETWEEN helperA and Engine — rows after it sit on
    // other symbols' HEAD rows unless carried onto HEAD.
    const dirty = readFileSync(join(repo, "src/engine.ts"), "utf8")
      .replace("export function helperB", "// header one\n// header two\nexport function helperB")
      .replace("  return helperB() + 1;", "  const s2 = 0;\n  return helperB() + 1 + s2;")
      .replace(
        "export class Engine",
        "export function brandNewBetween(): number {\n  // never committed\n  return 42;\n}\n\nexport class Engine",
      );
    write(repo, "src/engine.ts", dirty);

    const delta = ["src/engine.ts"];
    const reference = await ingestReference(repo, delta, squashOpts);
    const rows = await overlayRows(repo, delta, basePoints, stamp, squashOpts);

    expectParity(rows, reference);
    const chunkOf = (symbol: string) => unstamped(reference.chunk.get(`src/engine.ts::${symbol}`), symbol);
    expect(chunkOf("helperB")).toMatchObject({ commitCount: 2 });
    expect(chunkOf("helperA")).toMatchObject({ commitCount: 1 });
    expect(chunkOf("brandNewBetween")).toMatchObject({ commitCount: 0, lastModifiedAt: 0 });
    expect(chunkOf("Engine")).toMatchObject({ commitCount: 4 });
  });

  it("stamps a file past the chunk walk's line limit as ingest's policy does", async () => {
    const oversized = (name: string): string =>
      `export function ${name}(): number {\n  let n = 0;\n${"  n += 1;\n".repeat(WINDOWS.maxFileLines + 5)}  return n;\n}\n`;
    const repo = join(scratch, "main");
    mkdirSync(repo);
    const { stamp } = commitAll(repo, [
      {
        files: { "src/engine.ts": ENGINE_V1, "src/big.ts": oversized("bigFunction") },
        message: "init",
        who: "alice",
        when: at(40),
      },
      {
        label: "stamp",
        files: { "src/engine.ts": ENGINE_V1.replace("return 1;", "return 1; // v2") },
        message: "feat: engine step",
        who: "bob",
        when: at(20),
      },
    ]);
    const basePoints = await indexAt(repo, ["src/engine.ts", "src/big.ts"], squashOpts);

    // Since the index: an oversized file committed; uncommitted: a new symbol in the indexed oversized file.
    commitAll(
      repo,
      [{ files: { "src/big2.ts": oversized("otherBigFunction") }, message: "feat: big2", who: "carol", when: at(5) }],
      false,
    );
    appendFileSync(join(repo, "src/big.ts"), "\nexport function tailSymbol(): number {\n  return 9;\n}\n");

    const delta = ["src/big.ts", "src/big2.ts"];
    const reference = await ingestReference(repo, delta, squashOpts);
    const rows = await overlayRows(repo, delta, basePoints, stamp, squashOpts);

    expect(rows.map((row) => (row.payload.git as { chunk?: Block } | undefined)?.chunk)).toEqual(
      rows.map(() => ({ skippedAs: "oversized" })),
    );
    expectParity(rows, reference);
  });
});
