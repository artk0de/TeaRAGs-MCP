/**
 * Framework-routed call weight on file edges (bd tea-rags-mcp-4vj2u, xb669.8).
 *
 * A resolved call that never NAMES the member it lands on went through a
 * framework's interface: `Worker.perform_async(id)` runs Sidekiq's class-level
 * enqueue, and the resolver routed it to `Worker#perform` — the source knows
 * the worker's framework contract, not its logic.
 *
 * Invariants under test:
 *   - `frameworkRoutedCallWeight` is the confidence-weighted part of
 *     `callWeight` whose call text names neither the target member nor, for a
 *     construction, the target's owner type called directly (`new Owner(…)`,
 *     `Owner(…)`) — wherever in the call text that construction sits;
 *   - a call naming the PART of the member it selects is not framework-routed:
 *     `Policy.authorized?(u, :sync, x)` routed to `Policy#can_sync?` — the
 *     caller picked which logic runs (an in-project wrapper of the verb, like
 *     an `ApplicationWorker.perform_async` override, changes nothing: the
 *     enqueue still names no part of `#perform`);
 *   - a call along an inheritance edge (`super(message)` from a subclass in
 *     the source file into its base class in the target) is never
 *     framework-routed: the source extends the target's own logic;
 *   - a call naming the member anywhere in its text (`obj.send(:run)`) is not
 *     framework-routed;
 *   - an edge with no framework-routed call reads back without the field, so
 *     every existing edge shape is unchanged.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

describe("DuckDbGraphClient — framework-routed call weight", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-file-edge-framework-routed-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("weighs the calls that never name the member they land on", async () => {
    await db.upsertFile(
      { relPath: "app/services/sync.rb", language: "ruby" },
      {
        fileEdges: [
          { targetRelPath: "app/workers/sync_worker.rb", importText: "zeitwerk:SyncWorker" },
          { targetRelPath: "app/workers/mixed_worker.rb", importText: "zeitwerk:MixedWorker" },
          { targetRelPath: "app/models/account.rb", importText: "zeitwerk:Account" },
          { targetRelPath: "app/policies/account_policy.rb", importText: "zeitwerk:AccountPolicy" },
        ],
        methodEdges: [
          // Enqueue verbs routed to the entrypoint — with and without parentheses.
          {
            sourceSymbolId: "Sync#call",
            targetSymbolId: "SyncWorker#perform",
            targetRelPath: "app/workers/sync_worker.rb",
            callExpression: "SyncWorker.perform_async(account.id)",
          },
          {
            sourceSymbolId: "Sync#later",
            targetSymbolId: "SyncWorker#perform",
            targetRelPath: "app/workers/sync_worker.rb",
            callExpression: "SyncWorker.perform_in 5.minutes, account.id",
            confidence: 0.5,
          },
          // One routed call and one named call into the same worker.
          {
            sourceSymbolId: "Sync#call",
            targetSymbolId: "MixedWorker#perform",
            targetRelPath: "app/workers/mixed_worker.rb",
            callExpression: "MixedWorker.perform_async(1)",
          },
          {
            sourceSymbolId: "Sync#call",
            targetSymbolId: "MixedWorker.throttle_key",
            targetRelPath: "app/workers/mixed_worker.rb",
            callExpression: "MixedWorker.throttle_key",
          },
          // A dynamic send names its member in the argument.
          {
            sourceSymbolId: "Sync#call",
            targetSymbolId: "Account#refresh!",
            targetRelPath: "app/models/account.rb",
            callExpression: "account.public_send(:refresh!)",
          },
          // A policy dispatcher routes to the ability predicate the caller names.
          {
            sourceSymbolId: "Sync#call",
            targetSymbolId: "AccountPolicy#can_sync?",
            targetRelPath: "app/policies/account_policy.rb",
            callExpression: "::AccountPolicy.authorized?(user, :sync, account)",
          },
        ],
      },
    );
    await db.upsertFile(
      { relPath: "src/app.ts", language: "typescript" },
      {
        fileEdges: [
          { targetRelPath: "src/registry.ts", importText: "./registry.js" },
          { targetRelPath: "src/git.ts", importText: "./git.js" },
        ],
        methodEdges: [
          // Constructions name the owner type, nested in an argument or generic.
          {
            sourceSymbolId: "boot",
            targetSymbolId: "Registry#constructor",
            targetRelPath: "src/registry.ts",
            callExpression: "new Registry<Trajectory>()",
          },
          {
            sourceSymbolId: "boot",
            targetSymbolId: "Registry#register",
            targetRelPath: "src/registry.ts",
            callExpression: "registry.register(new GitTrajectory(config))",
          },
          {
            sourceSymbolId: "boot",
            targetSymbolId: "GitTrajectory#constructor",
            targetRelPath: "src/git.ts",
            callExpression: "registry.register(new GitTrajectory(config))",
          },
        ],
      },
    );

    await db.upsertFile(
      { relPath: "src/qdrant-error.ts", language: "typescript" },
      {
        fileEdges: [{ targetRelPath: "src/base-error.ts", importText: "./base-error.js" }],
        methodEdges: [
          {
            sourceSymbolId: "QdrantError#constructor",
            targetSymbolId: "BaseError#constructor",
            targetRelPath: "src/base-error.ts",
            callExpression: "super(message)",
          },
        ],
        inheritance: [
          {
            sourceFqName: "QdrantError",
            sourceSymbolId: "QdrantError",
            ancestorFqName: "BaseError",
            ancestorSymbolId: "BaseError",
            kind: "super",
            ordinal: 0,
          },
        ],
      },
    );
    await db.upsertSymbols("src/base-error.ts", [
      { symbolId: "BaseError", fqName: "BaseError", shortName: "BaseError", relPath: "src/base-error.ts", scope: [] },
    ]);

    const { edges } = await db.readFileDependencyGraph();
    const byTarget = new Map(edges.map((e) => [e.targetRelPath, e]));

    expect(byTarget.get("app/workers/sync_worker.rb")).toMatchObject({
      callWeight: 1.5,
      frameworkRoutedCallWeight: 1.5,
    });
    expect(byTarget.get("app/workers/mixed_worker.rb")).toMatchObject({
      callWeight: 2,
      frameworkRoutedCallWeight: 1,
    });
    const named = ["app/models/account.rb", "app/policies/account_policy.rb", "src/registry.ts", "src/git.ts"];
    for (const target of [...named, "src/base-error.ts"]) {
      const edge = byTarget.get(target);
      expect(edge?.callWeight).toBeGreaterThan(0);
      expect(edge && "frameworkRoutedCallWeight" in edge).toBe(false);
    }
  });
});
