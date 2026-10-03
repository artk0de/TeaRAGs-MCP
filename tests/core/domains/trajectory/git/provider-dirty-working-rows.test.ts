/**
 * bd tea-rags-mcp-xi2r9 (I1) — the ingest chunk walk addresses HEAD rows, and
 * the chunker hands it the WORKING file's rows. For a file with uncommitted
 * edits the two disagree: lines added above a symbol shift it onto another
 * symbol's HEAD rows, so the walk used to credit it with that symbol's commits
 * (measured by the working-tree parity harness: helperB took helperA's two
 * commits, helperA took Engine's one).
 *
 * `GitEnrichmentProvider#buildChunkSignals` must carry a dirty file's rows onto
 * HEAD through the working-vs-HEAD hunks before the walk — the mapping the
 * working-tree overlay uses — and give a row made only of uncommitted lines the
 * walk's zero overlay. Production path end to end: real `GitCliAdapter`, real
 * run-scoped commit discovery, real cat-file.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChunkSignalOverlay } from "../../../../../src/core/contracts/types/provider.js";
import { GitEnrichmentProvider } from "../../../../../src/core/domains/trajectory/git/provider.js";
import type { ChunkLookupEntry } from "../../../../../src/core/types.js";

vi.setConfig({ testTimeout: 60_000 });

const TMP_BASE = realpathSync(tmpdir());
const DAY = 86_400_000;
const at = (daysAgo: number): string => new Date(Date.now() - daysAgo * DAY).toISOString();
const FILE = "src/engine.ts";

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

/** Top-level `export function` / `export class` blocks, from their line to the next column-0 `}`. */
function chunksOf(content: string): ChunkLookupEntry[] {
  const lines = content.split("\n");
  const rows: ChunkLookupEntry[] = [];
  lines.forEach((line, i) => {
    const match = /^export (?:function|class) (\w+)/.exec(line);
    if (!match) return;
    const end = lines.findIndex((other, j) => j > i && other === "}");
    rows.push({ chunkId: match[1], startLine: i + 1, endLine: end + 1 });
  });
  return rows;
}

describe("GitEnrichmentProvider#buildChunkSignals over a file with uncommitted edits", () => {
  let repo: string;

  const git = (args: string[], who = "alice", when = at(0)): string => {
    if (!resolve(repo).startsWith(TMP_BASE + sep)) throw new Error(`refusing git outside the temp root: ${repo}`);
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: who,
        GIT_AUTHOR_EMAIL: `${who}@x`,
        GIT_COMMITTER_NAME: who,
        GIT_COMMITTER_EMAIL: `${who}@x`,
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
      },
    }).trim();
  };
  const write = (content: string): void => {
    mkdirSync(dirname(join(repo, FILE)), { recursive: true });
    writeFileSync(join(repo, FILE), content);
  };
  const commit = (content: string, message: string, who: string, when: string): void => {
    write(content);
    git(["add", "-A"], who, when);
    git(["commit", "-q", "-m", message], who, when);
  };

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "dirty-working-rows-")));
    git(["init", "-q", "-b", "main"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const walk = async (content: string) => {
    const provider = new GitEnrichmentProvider({
      vcsAdapter: "git",
      logMaxAgeMonths: 12,
      logTimeoutMs: 30_000,
      chunkConcurrency: 4,
      blamePoolSize: 1,
      chunkMaxAgeMonths: 6,
      chunkTimeoutMs: 30_000,
      chunkMaxFileLines: 5000,
    });
    try {
      const result = await provider.buildChunkSignals(repo, new Map([[join(repo, FILE), chunksOf(content)]]), {
        skipCache: true,
        commitDiscovery: provider.createCommitDiscovery(repo),
      });
      return result.get(FILE);
    } finally {
      await provider.finalizeSignals();
    }
  };

  it("credits each symbol with its own HEAD commits when lines were added above and inside it", async () => {
    commit(ENGINE_V1, "init", "alice", at(40));
    const fixed = ENGINE_V1.replace("helperB() + 1", "helperB() + 3");
    commit(fixed, "fix: helperA", "bob", at(30));
    const head = fixed.replace("return 1;", "return 1; // v2");
    commit(head, "feat: engine step", "carol", at(20));

    // Uncommitted: lines ABOVE every symbol (shifting all of them), lines INSIDE
    // helperA (growing it), and a symbol no commit ever held.
    const dirty = `${head
      .replace("export function helperB", "// header one\n// header two\n// header three\n\nexport function helperB")
      .replace(
        "  return helperB() + 3;",
        "  const base = helperB();\n  const bump = 3;\n  return base + bump;",
      )}\nexport function brandNew(): number {\n  return 7;\n}\n`;
    write(dirty);

    const overlays = await walk(dirty);

    expect(overlays?.get("helperB")).toMatchObject({ commitCount: 1 });
    expect(overlays?.get("helperA")).toMatchObject({ commitCount: 2 });
    expect(overlays?.get("Engine")).toMatchObject({ commitCount: 2 });
    // Only uncommitted lines: the walk's zero contribution, never a neighbour's commits.
    expect(overlays?.get("brandNew")).toMatchObject({ commitCount: 0 });
  });

  describe.each([
    { walk: "inline walk", offThread: false, keys: "repo-relative keys", relativeKeys: true },
    { walk: "off-thread walk", offThread: true, keys: "repo-relative keys", relativeKeys: true },
    { walk: "inline walk", offThread: false, keys: "absolute keys", relativeKeys: false },
    { walk: "off-thread walk", offThread: true, keys: "absolute keys", relativeKeys: false },
  ])("an uncommitted-only row BETWEEN committed rows ($walk, $keys)", ({ offThread, relativeKeys }) => {
    // The chunker's rows for the dirty file: a class row and its method row
    // overlap, and a brand-new function sits between helperA and the class.
    // Ingest hands the chunk map keyed REPO-RELATIVE (`ChunkPhase` and the
    // `--force-enrichments` recompute scroll both do); absolute keys are the
    // other shape the provider accepts. Live repro (probe2-g, round 7): with
    // relative keys no dirty file was carried onto HEAD, so working rows were
    // walked as HEAD rows (brandNew ← Engine's 6 commits, Engine ← 1, start ← 0).
    const DIRTY = [
      "// dirty header line 1",
      "// dirty header line 2",
      "export function helperB(): number {",
      "  return 2; // b3",
      "}",
      "",
      "export function helperA(): number {",
      "  const s2 = 0; // dirty inside helperA",
      "  return helperB() + 1 + s2;",
      "}",
      "",
      "export function brandNew(): number {",
      "  // brand-new uncommitted symbol",
      "  return 42;",
      "}",
      "",
      "export class Engine {",
      "  start(): number {",
      "    // dirty inside start",
      "    return helperA() + this.step();",
      "  }",
      "",
      "  step(): number {",
      "    return 1; // v5",
      "  }",
      "}",
      "",
    ].join("\n");
    const ROWS: ChunkLookupEntry[] = [
      { chunkId: "helperB", startLine: 1, endLine: 5 },
      { chunkId: "helperA", startLine: 7, endLine: 10 },
      { chunkId: "brandNew", startLine: 12, endLine: 15 },
      { chunkId: "Engine", startLine: 17, endLine: 26 },
      { chunkId: "Engine#start", startLine: 18, endLine: 21 },
    ];

    it("credits every row with its own HEAD commits, the uncommitted row with none", async () => {
      commit(ENGINE_V1.replace("return 2; // b0", "return 2;"), "init", "probe", at(60));
      let content = ENGINE_V1.replace("return 2; // b0", "return 2;");
      for (let v = 1; v <= 5; v++) {
        const prev = v === 1 ? "return 1;" : `return 1; // v${v - 1}`;
        content = content.replace(prev, `return 1; // v${v}`);
        commit(content, `fix: engine step ${v}`, "alice", at(50 - v));
      }
      for (let b = 1; b <= 3; b++) {
        const prev = b === 1 ? "return 2;" : `return 2; // b${b - 1}`;
        content = content.replace(prev, `return 2; // b${b}`);
        commit(content, `feat: helperB ${b}`, "bob", at(40 - b));
      }
      write(DIRTY);

      const provider = new GitEnrichmentProvider({
        vcsAdapter: "git",
        logMaxAgeMonths: 12,
        logTimeoutMs: 30_000,
        chunkConcurrency: 4,
        blamePoolSize: 1,
        chunkMaxAgeMonths: 6,
        chunkTimeoutMs: 30_000,
        chunkMaxFileLines: 5000,
      });
      const walkThread = offThread ? provider.createChunkChurnWalkThread() : undefined;
      let overlays: Map<string, ChunkSignalOverlay> | undefined;
      try {
        const key = relativeKeys ? FILE : join(repo, FILE);
        const result = await provider.buildChunkSignals(repo, new Map([[key, ROWS]]), {
          skipCache: true,
          commitDiscovery: provider.createCommitDiscovery(repo),
          ...(walkThread ? { churnWalkThread: walkThread } : {}),
        });
        overlays = result.get(FILE);
      } finally {
        await walkThread?.close();
        await provider.finalizeSignals();
      }

      expect(overlays?.get("helperB")).toMatchObject({ commitCount: 4 });
      expect(overlays?.get("helperA")).toMatchObject({ commitCount: 1 });
      expect(overlays?.get("brandNew")).toMatchObject({ commitCount: 0, lastModifiedAt: 0 });
      expect(overlays?.get("Engine")).toMatchObject({ commitCount: 6 });
      expect(overlays?.get("Engine#start")).toMatchObject({ commitCount: 1 });
      expect(overlays?.get("Engine#start")?.lastModifiedAt).toBeGreaterThan(0);
    });
  });

  it("walks a clean file's rows as they are", async () => {
    commit(ENGINE_V1, "init", "alice", at(40));
    const fixed = ENGINE_V1.replace("helperB() + 1", "helperB() + 3");
    commit(fixed, "fix: helperA", "bob", at(30));

    const overlays = await walk(fixed);

    expect(overlays?.get("helperB")).toMatchObject({ commitCount: 1 });
    expect(overlays?.get("helperA")).toMatchObject({ commitCount: 2 });
    expect(overlays?.get("Engine")).toMatchObject({ commitCount: 1 });
  });
});
