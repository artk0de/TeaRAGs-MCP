/**
 * End to end over a real git repository and a real DuckDB graph (bd
 * tea-rags-mcp-l1ot.2): the co-change sub-graph follows the working tree through
 * the seam a reindex that finalized nothing uses —
 * `EnrichmentCoordinator#runCollectionCompletion` →
 * `CodegraphEnrichmentProvider#completeCollection` → `TemporalCochangeBuilder`.
 *
 * Live 2026-09-25 (pixelclocktiles clone): a committed `git rm` followed by a
 * plain incremental took the deletion-only path, and the deleted file kept its
 * pairs and the old HEAD in `cg_temporal_meta`. Here each step is the state a
 * delete-only or no-change reindex would hand the seam.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildTestCodegraphDeps } from "../../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../../src/core/adapters/duckdb/client.js";
import { EnrichmentCoordinator } from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { collectSymbols } from "../../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { DATABASE_MIGRATIONS } from "../../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { createTemporalCochangeHooks } from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@x",
    },
  });
}

function commitTouching(root: string, files: string[], message: string): void {
  for (const file of files) writeFileSync(join(root, file), `// ${file} ${message}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

describe(
  "co-change sub-graph through collection completion — real git + DuckDB (bd tea-rags-mcp-l1ot.2)",
  {
    timeout: 60_000,
  },
  () => {
    let root: string;
    let dataDir: string;
    let dbDir: string;
    let db: DuckDbGraphClient;
    let coordinator: EnrichmentCoordinator;
    const collection = "code_e2e_v1" as never;

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), "cochange-e2e-repo-"));
      dataDir = mkdtempSync(join(tmpdir(), "cochange-e2e-data-"));
      dbDir = mkdtempSync(join(tmpdir(), "cochange-e2e-db-"));
      // The discovery store persists under the app data dir; keep it out of ~/.tea-rags.
      vi.stubEnv("TEA_RAGS_DATA_DIR", dataDir);

      git(root, "init", "-q", "-b", "main");
      writeFileSync(join(root, ".gitignore"), "build/\n");
      for (let i = 0; i < 3; i++) commitTouching(root, ["a.ts", "b.ts"], `ab-${i}`);
      for (let i = 0; i < 3; i++) commitTouching(root, ["a.ts", "c.ts"], `ac-${i}`);

      db = new DuckDbGraphClient({ path: join(dbDir, "g.duckdb") });
      await db.init();
      await runMigrations(db, DATABASE_MIGRATIONS);

      const provider = new CodegraphEnrichmentProvider({
        graphDb: db,
        symbolTable: new InMemoryGlobalSymbolTable(),
        ...buildTestCodegraphDeps(new Map()),
        composer: new DefaultSymbolIdComposer(),
        collectSymbols,
        collectionCompletionHooks: createTemporalCochangeHooks({
          windowMonths: 12,
          sessionGapMinutes: null,
          vcsAdapter: "git",
          gitTimeoutMs: 30_000,
        }),
      });
      coordinator = new EnrichmentCoordinator({} as never, provider, undefined, {
        runFileBatch: vi.fn(),
        runFinalize: vi.fn(),
        releaseRun: vi.fn(),
      } as never);
    });

    afterAll(async () => {
      await db.close();
      vi.unstubAllEnvs();
      for (const dir of [root, dataDir, dbDir]) rmSync(dir, { recursive: true, force: true });
    });

    async function pairs(): Promise<string[]> {
      const rows = await db.queryAll<{ rel_path_a: string; rel_path_b: string }>(
        "SELECT rel_path_a, rel_path_b FROM cg_temporal_edges_cochange ORDER BY rel_path_a, rel_path_b",
      );
      return rows.map((r) => `${r.rel_path_a}|${r.rel_path_b}`);
    }

    async function files(): Promise<string[]> {
      const rows = await db.queryAll<{ rel_path: string }>("SELECT rel_path FROM cg_temporal_files ORDER BY rel_path");
      return rows.map((r) => r.rel_path);
    }

    const head = (): string => git(root, "rev-parse", "HEAD").trim();

    it("builds the graph on the first completion", async () => {
      await coordinator.runCollectionCompletion(root, collection);

      expect(await pairs()).toEqual(["a.ts|b.ts", "a.ts|c.ts"]);
      expect((await db.readTemporalCochangeMeta())?.head).toBe(head());
    });

    it("skips a completion that finds HEAD and the working tree unchanged", async () => {
      const before = await db.readTemporalCochangeMeta();
      const replace = vi.spyOn(db, "replaceTemporalCochange");

      await coordinator.runCollectionCompletion(root, collection);

      expect(replace).not.toHaveBeenCalled();
      expect(await db.readTemporalCochangeMeta()).toEqual(before);
      replace.mockRestore();
    });

    it("drops every pair of a file deleted by a commit (the delete-only reindex)", async () => {
      git(root, "rm", "-q", "c.ts");
      git(root, "commit", "-q", "-m", "drop c");

      await coordinator.runCollectionCompletion(root, collection);

      expect(await pairs()).toEqual(["a.ts|b.ts"]);
      expect(await files()).not.toContain("c.ts");
      expect((await db.readTemporalCochangeMeta())?.head).toBe(head());
    });

    it("rebuilds when HEAD moved with no indexed file changed (the no-change reindex)", async () => {
      writeFileSync(join(root, ".gitignore"), "build/\ndist/\n");
      git(root, "commit", "-q", "-am", "ignore dist");

      await coordinator.runCollectionCompletion(root, collection);

      expect((await db.readTemporalCochangeMeta())?.head).toBe(head());
      expect(await pairs()).toEqual(["a.ts|b.ts"]);
    });

    it("drops the pairs of an uncommitted delete and brings them back on restore", async () => {
      unlinkSync(join(root, "b.ts"));
      await coordinator.runCollectionCompletion(root, collection);
      expect(await pairs()).toEqual([]);

      git(root, "checkout", "--", "b.ts");
      await coordinator.runCollectionCompletion(root, collection);
      expect(await pairs()).toEqual(["a.ts|b.ts"]);
    });
  },
);
