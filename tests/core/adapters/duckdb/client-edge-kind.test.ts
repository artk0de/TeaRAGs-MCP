import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/infra/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/infra/migration/database/runner.js";

describe("DuckDbGraphClient — edge_kind/confidence + run-stats (bd 2jet/j431)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-edge-kind-client-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("upsertFile method-edge edge_kind/confidence", () => {
    it("persists explicit cone edgeKind + fractional confidence", async () => {
      await db.upsertFile(
        { relPath: "app/agent.rb", language: "ruby" },
        {
          fileEdges: [],
          methodEdges: [
            {
              sourceSymbolId: "Caller#run",
              targetSymbolId: "WebsiteAgent#check",
              targetRelPath: "app/website_agent.rb",
              callExpression: "agent.check",
              edgeKind: "cone",
              confidence: 0.125,
            },
          ],
        },
      );
      const rows = await db.queryAll<{ edge_kind: string; confidence: number }>(
        "SELECT edge_kind, confidence FROM cg_symbols_edges_method WHERE source_symbol_id = 'Caller#run'",
      );
      expect(rows[0]?.edge_kind).toBe("cone");
      expect(rows[0]?.confidence).toBeCloseTo(0.125, 5);
    });

    it("defaults omitted edgeKind/confidence to exact/1.0", async () => {
      await db.upsertFile(
        { relPath: "app/x.rb", language: "ruby" },
        {
          fileEdges: [],
          methodEdges: [
            {
              sourceSymbolId: "X#a",
              targetSymbolId: "Y#b",
              targetRelPath: "app/y.rb",
              callExpression: "y.b",
            },
          ],
        },
      );
      const rows = await db.queryAll<{ edge_kind: string; confidence: number }>(
        "SELECT edge_kind, confidence FROM cg_symbols_edges_method WHERE source_symbol_id = 'X#a'",
      );
      expect(rows[0]?.edge_kind).toBe("exact");
      expect(rows[0]?.confidence).toBeCloseTo(1.0, 5);
    });
  });

  describe("recordRunStats / getRunStats", () => {
    it("round-trips per-(language, receiver-kind) rows ordered by language then kind (cnqrg, ykj7)", async () => {
      await db.recordRunStats([
        {
          language: "typescript",
          receiverKind: "constant",
          attempted: 100,
          resolved: 90,
          externalSkipped: 7,
          unresolvable: 0,
        },
        {
          language: "ruby",
          receiverKind: "bareCall",
          attempted: 50,
          resolved: 10,
          externalSkipped: 0,
          unresolvable: 4,
        },
      ]);
      const rows = await db.getRunStats();
      // ORDER BY language, receiver_kind → ruby/bareCall before typescript/constant.
      expect(rows).toEqual([
        {
          language: "ruby",
          receiverKind: "bareCall",
          attempted: 50,
          resolved: 10,
          externalSkipped: 0,
          unresolvable: 4,
        },
        {
          language: "typescript",
          receiverKind: "constant",
          attempted: 100,
          resolved: 90,
          externalSkipped: 7,
          unresolvable: 0,
        },
      ]);
    });

    it("overwrites the whole table each run (no stale rows from prior run)", async () => {
      await db.recordRunStats([
        {
          language: "typescript",
          receiverKind: "constant",
          attempted: 100,
          resolved: 90,
          externalSkipped: 5,
          unresolvable: 0,
        },
        {
          language: "typescript",
          receiverKind: "dynamic",
          attempted: 30,
          resolved: 0,
          externalSkipped: 25,
          unresolvable: 0,
        },
      ]);
      await db.recordRunStats([
        {
          language: "typescript",
          receiverKind: "constant",
          attempted: 120,
          resolved: 118,
          externalSkipped: 1,
          unresolvable: 0,
        },
      ]);
      const rows = await db.getRunStats();
      expect(rows).toEqual([
        {
          language: "typescript",
          receiverKind: "constant",
          attempted: 120,
          resolved: 118,
          externalSkipped: 1,
          unresolvable: 0,
        },
      ]);
    });

    it("returns empty array before any run is recorded", async () => {
      expect(await db.getRunStats()).toEqual([]);
    });
  });
});
