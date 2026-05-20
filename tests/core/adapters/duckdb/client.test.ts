import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { runMigrations } from "../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../src/core/infra/migration/database/migrations");

describe("DuckDbGraphClient", () => {
  let tmp: string;
  let dbPath: string;
  let client: DuckDbGraphClient;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-db-"));
    dbPath = join(tmp, "g.duckdb");
    client = new DuckDbGraphClient({ path: dbPath });
    await client.init();
    await runMigrations(client, MIG_DIR);
  });
  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("hasData() returns false on a freshly migrated DB", async () => {
    expect(await client.hasData()).toBe(false);
  });

  it("upsertFile inserts file row and outgoing edges atomically", async () => {
    await client.upsertFile({ relPath: "src/b.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    await client.upsertFile(
      { relPath: "src/a.ts", language: "typescript" },
      {
        fileEdges: [{ targetRelPath: "src/b.ts", importText: "./b" }],
        methodEdges: [],
      },
    );
    expect(await client.getFanOut("src/a.ts")).toBe(1);
    expect(await client.getFanIn("src/b.ts")).toBe(1);
    expect(await client.hasData()).toBe(true);
  });

  it("removeFile cascades incoming + outgoing edges via ON DELETE CASCADE", async () => {
    await client.upsertFile({ relPath: "src/a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    await client.upsertFile(
      { relPath: "src/b.ts", language: "typescript" },
      {
        fileEdges: [{ targetRelPath: "src/a.ts", importText: "./a" }],
        methodEdges: [],
      },
    );
    await client.removeFile("src/a.ts");
    expect(await client.getFanOut("src/b.ts")).toBe(0);
  });

  it("getCallers returns method-edges in stable order", async () => {
    await client.upsertFile({ relPath: "src/a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    await client.upsertFile(
      { relPath: "src/c.ts", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "C.f",
            targetSymbolId: "A.x",
            targetRelPath: "src/a.ts",
            callExpression: "A.x()",
          },
        ],
      },
    );
    await client.upsertFile(
      { relPath: "src/d.ts", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "D.g",
            targetSymbolId: "A.x",
            targetRelPath: "src/a.ts",
            callExpression: "A.x()",
          },
        ],
      },
    );
    const callers = await client.getCallers("A.x");
    expect(callers.map((c) => c.sourceSymbolId).sort()).toEqual(["C.f", "D.g"]);
  });

  it("getCallees + getCalledByCount + getCallSiteCount track method edges", async () => {
    await client.upsertFile({ relPath: "src/a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    await client.upsertFile({ relPath: "src/b.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    await client.upsertFile(
      { relPath: "src/main.ts", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "main",
            targetSymbolId: "A.x",
            targetRelPath: "src/a.ts",
            callExpression: "A.x()",
          },
          {
            sourceSymbolId: "main",
            targetSymbolId: "B.y",
            targetRelPath: "src/b.ts",
            callExpression: "B.y()",
          },
        ],
      },
    );
    expect((await client.getCallees("main")).length).toBe(2);
    expect(await client.getCallSiteCount("main")).toBe(2);
    expect(await client.getCalledByCount("A.x")).toBe(1);
  });
});
