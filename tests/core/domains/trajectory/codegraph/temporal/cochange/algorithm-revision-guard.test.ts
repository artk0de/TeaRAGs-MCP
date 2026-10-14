/**
 * bd tea-rags-mcp-hzm7g — a co-change snapshot is reused while its fingerprint
 * (which carries `COCHANGE_ALGORITHM_REVISION`) still matches. A migration that
 * adds a persisted `cg_temporal_*` field leaves that field NULL on every reused
 * snapshot, so it must ship with a revision bump — 046 and 047 did not, and
 * shotgun surgery's lifecycle stages went silently absent.
 *
 * The pin below records which `cg_temporal_*` migrations the current revision
 * was cut against. The migration set is DERIVED from the registry the runner
 * applies: any migration whose SQL names a `cg_temporal_` table. Adding one
 * changes the derived set and fails this test until the author bumps the
 * revision and updates the pin together.
 */

import { describe, expect, it } from "vitest";

import { DATABASE_MIGRATIONS } from "../../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { isSqlDatabaseMigration } from "../../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { COCHANGE_ALGORITHM_REVISION } from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/cochange/index.js";

const PINNED = {
  revision: 5,
  temporalMigrations: [
    "031-cg-temporal-init.sql",
    "041-cg-temporal-symbol-commits.sql",
    "042-cg-temporal-bundle-files.sql",
    "043-cg-temporal-bundle-commits.sql",
    "044-cg-temporal-bursts.sql",
    "045-cg-temporal-bundle-task-ids.sql",
    "046-cg-temporal-bundle-file-lines.sql",
    "047-cg-temporal-bundle-committed-at.sql",
    "052-cg-temporal-bundle-rename-sweep.sql",
  ],
} as const;

const TEMPORAL_TABLE = /\bcg_temporal_\w+/;

/**
 * Only SQL migrations can be classified here: a PROCEDURAL migration
 * (`{ filename, run }`, bd tea-rags-mcp-bdnfu) has no SQL text to scan, so this
 * guard cannot see whether it touches `cg_temporal_*`. A procedural migration
 * that adds or reshapes a persisted `cg_temporal_*` field escapes this pin —
 * its author must bump `COCHANGE_ALGORITHM_REVISION` by hand and give it its
 * own guard (e.g. assert its effect on a reused snapshot). The only procedural
 * migration today, 048, drops `cg_review_file_edges_*` and never touches them.
 */
function temporalMigrationFilenames(): string[] {
  return DATABASE_MIGRATIONS.filter(isSqlDatabaseMigration)
    .filter((migration) => TEMPORAL_TABLE.test(migration.sql))
    .map((migration) => migration.filename);
}

describe("COCHANGE_ALGORITHM_REVISION tracks the cg_temporal schema (bd tea-rags-mcp-hzm7g)", () => {
  it("is pinned against the current set of cg_temporal migrations", () => {
    const derived = temporalMigrationFilenames();
    const message =
      "The cg_temporal_* migrations changed. A reused co-change snapshot would keep the new " +
      "columns NULL: bump COCHANGE_ALGORITHM_REVISION in temporal/cochange/builder.ts, then " +
      "update PINNED (revision + temporalMigrations) in this test.";

    expect(derived, message).toEqual([...PINNED.temporalMigrations]);
    expect(COCHANGE_ALGORITHM_REVISION, message).toBe(PINNED.revision);
  });
});
