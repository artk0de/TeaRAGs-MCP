/**
 * `readNonPublicMemberEdges` — the method edges the convention-privacy check
 * judges (bd tea-rags-mcp-r8hme.1).
 *
 * Invariants under test:
 *   - an edge is returned only when its resolved target is declared private /
 *     protected OR its short name starts with an underscore, and the target's
 *     file is one of the requested languages;
 *   - each row carries both endpoints (file + symbol), the target's short name,
 *     visibility and language, and the call expression as written;
 *   - an unresolved edge (no target symbol) is never returned.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { SymbolDefinition } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

function def(relPath: string, symbolId: string, visibility?: SymbolDefinition["visibility"]): SymbolDefinition {
  const shortName = symbolId.split(/[#.]/).pop() ?? symbolId;
  return { symbolId, fqName: symbolId, shortName, relPath, scope: [], ...(visibility ? { visibility } : {}) };
}

describe("DuckDbGraphClient — readNonPublicMemberEdges (bd tea-rags-mcp-r8hme.1)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-non-public-edges-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns resolved edges into underscore-named or private/protected targets of the requested languages", async () => {
    await db.upsertFile(
      { relPath: "app/caller.py", language: "python" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "run",
            targetSymbolId: "Repo#_load",
            targetRelPath: "pkg/repo.py",
            callExpression: "r._load()",
          },
          {
            sourceSymbolId: "run",
            targetSymbolId: "Repo#save",
            targetRelPath: "pkg/repo.py",
            callExpression: "r.save()",
          },
          { sourceSymbolId: "run", targetSymbolId: null, targetRelPath: "pkg/repo.py", callExpression: "x._unknown()" },
        ],
      },
    );
    await db.upsertFile({ relPath: "pkg/repo.py", language: "python" }, { fileEdges: [], methodEdges: [] });
    await db.upsertFile(
      { relPath: "app/job.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "Job#perform",
            targetSymbolId: "User#secret",
            targetRelPath: "app/user.rb",
            callExpression: "user.send(:secret)",
          },
        ],
      },
    );
    await db.upsertFile({ relPath: "app/user.rb", language: "ruby" }, { fileEdges: [], methodEdges: [] });
    await db.upsertFile(
      { relPath: "web/a.ts", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "A#x",
            targetSymbolId: "B#hidden",
            targetRelPath: "web/b.ts",
            callExpression: "b.hidden()",
          },
        ],
      },
    );
    await db.upsertFile({ relPath: "web/b.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    await db.upsertSymbols("pkg/repo.py", [def("pkg/repo.py", "Repo#_load"), def("pkg/repo.py", "Repo#save")]);
    await db.upsertSymbols("app/user.rb", [def("app/user.rb", "User#secret", "private")]);
    await db.upsertSymbols("web/b.ts", [def("web/b.ts", "B#hidden", "private")]);

    const rows = await db.readNonPublicMemberEdges(["python", "ruby"]);

    expect([...rows].sort((a, b) => a.targetRelPath.localeCompare(b.targetRelPath))).toEqual([
      {
        sourceRelPath: "app/job.rb",
        sourceSymbolId: "Job#perform",
        targetRelPath: "app/user.rb",
        targetSymbolId: "User#secret",
        targetShortName: "secret",
        targetVisibility: "private",
        targetLanguage: "ruby",
        callExpression: "user.send(:secret)",
      },
      {
        sourceRelPath: "app/caller.py",
        sourceSymbolId: "run",
        targetRelPath: "pkg/repo.py",
        targetSymbolId: "Repo#_load",
        targetShortName: "_load",
        targetVisibility: null,
        targetLanguage: "python",
        callExpression: "r._load()",
      },
    ]);
  });

  it("returns nothing when no language is requested", async () => {
    expect(await db.readNonPublicMemberEdges([])).toEqual([]);
  });
});
