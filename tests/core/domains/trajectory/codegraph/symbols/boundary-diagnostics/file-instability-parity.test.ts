/**
 * The boundary diagnostics judge a file by the SAME instability the
 * `codegraph.file.instability` payload signal carries (bd tea-rags-mcp-thc7s).
 *
 * The payload is written from `getFileMetricsBulk` through
 * `buildCodegraphFileSignals`; the detector counts fan over the whole
 * dependency graph it reads in one pass. Invariant: for every walked file both
 * paths yield the same `instability` and `connectionCount` — over a graph with
 * a cycle, a file importing something the walk never extracted, a file nobody
 * imports and a file with no edges at all.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../../src/core/adapters/duckdb/client.js";
import type { RelPath } from "../../../../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { computeFileInstabilities } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";
import { buildCodegraphFileSignals } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/payload-signals.js";

describe("computeFileInstabilities — parity with the codegraph.file.instability payload", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-instability-parity-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function importsFrom(source: RelPath, targets: RelPath[]): Promise<void> {
    await db.upsertFile(
      { relPath: source, language: "typescript" },
      { fileEdges: targets.map((t) => ({ targetRelPath: t, importText: `./${t}` })), methodEdges: [] },
    );
  }

  it("agrees with buildCodegraphFileSignals over getFileMetricsBulk for every walked file", async () => {
    await importsFrom("hub.ts", ["util.ts", "gen/schema.ts"]); // imports a file the walk never extracted
    await importsFrom("a.ts", ["hub.ts", "b.ts"]);
    await importsFrom("b.ts", ["hub.ts", "a.ts"]); // a ⇄ b cycle
    await importsFrom("c.ts", ["hub.ts"]);
    await importsFrom("util.ts", []);
    await importsFrom("lonely.ts", []); // no edge in either direction
    await importsFrom("entry.ts", ["a.ts", "c.ts", "util.ts"]); // nobody imports it

    const graph = await db.readFileDependencyGraph();
    const instabilities = computeFileInstabilities(graph);
    const universe = graph.files.map((f) => f.relPath);
    const bulk = await db.getFileMetricsBulk(universe);

    expect(universe).toHaveLength(7);
    for (const relPath of universe) {
      const payload = buildCodegraphFileSignals(bulk.get(relPath) ?? { fanIn: 0, fanOut: 0, transitiveImpact: 0 }, 0);
      expect({ relPath, ...instabilities.get(relPath) }).toEqual({
        relPath,
        instability: payload.instability,
        connectionCount: payload.connectionCount,
      });
    }
    // Spot-check so the loop cannot pass vacuously: hub has 3 importers and 2 imports.
    expect(instabilities.get("hub.ts")).toEqual({ instability: 2 / 5, connectionCount: 5 });
  });
});
