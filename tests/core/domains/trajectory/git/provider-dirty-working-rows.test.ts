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
