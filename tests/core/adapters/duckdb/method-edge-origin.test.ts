import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

describe("method-edge reads — edge origin", () => {
  let tmp: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-edge-origin-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
    await client.upsertSymbols("app/models/firm.rb", [
      {
        symbolId: "Firm#users",
        fqName: "Firm#users",
        shortName: "users",
        relPath: "app/models/firm.rb",
        scope: ["Firm"],
      },
    ]);
    await client.upsertFile(
      { relPath: "app/billing.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "Billing#audit",
            targetSymbolId: "Firm#users",
            targetRelPath: "app/models/firm.rb",
            callExpression: "firm.users",
          },
        ],
        residualCallSites: [
          {
            siteKey: "k1",
            sourceRelPath: "app/billing.rb",
            methodSymbolId: "Billing#run",
            methodStartLine: 10,
            methodEndLine: 20,
            line: 12,
            column: 6,
            receiverText: "account",
            member: "users",
            kind: "dynamic",
            candidates: ["Firm#users"],
            menuHash: "menu-1",
            menuOverflow: false,
          },
        ],
      },
    );
    await client.applyModelEdges("kev", [
      {
        siteKey: "k1",
        sourceRelPath: "app/billing.rb",
        sourceSymbolId: "Billing#run",
        targetSymbolId: "Firm#users",
        model: "kev",
        p: 0.9,
      },
    ]);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("getCallers marks the model edge and leaves the static edge unmarked", async () => {
    const callers = await client.getCallers("Firm#users");

    expect(callers.find((c) => c.sourceSymbolId === "Billing#run")).toMatchObject({
      callExpression: "account.users",
      origin: "model",
      model: "kev",
      p: 0.9,
    });
    const staticCaller = callers.find((c) => c.sourceSymbolId === "Billing#audit");
    expect(staticCaller).toBeDefined();
    expect(staticCaller).not.toHaveProperty("origin");
    expect(staticCaller).not.toHaveProperty("model");
    expect(staticCaller).not.toHaveProperty("p");
  });

  it("getCallees marks the model edge", async () => {
    const callees = await client.getCallees("Billing#run");

    expect(callees).toEqual([
      expect.objectContaining({ targetSymbolId: "Firm#users", origin: "model", model: "kev", p: 0.9 }),
    ]);
  });

  it("getCallees leaves a static edge unmarked", async () => {
    const [callee] = await client.getCallees("Billing#audit");

    expect(callee).toBeDefined();
    expect(callee).not.toHaveProperty("origin");
  });
});
