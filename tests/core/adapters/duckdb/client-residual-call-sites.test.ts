import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { encodeResidualClassTargets } from "../../../../src/core/adapters/duckdb/residual-class-targets-codec.js";
import type {
  ResidualCallSiteRow,
  ResidualClassTarget,
} from "../../../../src/core/contracts/types/codegraph-residual.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

function site(sourceRelPath: string, siteKey: string, over: Partial<ResidualCallSiteRow> = {}): ResidualCallSiteRow {
  return {
    siteKey,
    sourceRelPath,
    methodSymbolId: "Billing#run",
    methodStartLine: 10,
    methodEndLine: 20,
    line: 12,
    column: 6,
    receiverText: "account",
    member: "users",
    kind: "dynamic",
    candidates: ["Firm#users", "Team#users"],
    menuHash: "menu-1",
    menuOverflow: false,
    ...over,
  };
}

describe("DuckDbGraphClient — residual call-site persistence", () => {
  let tmp: string;
  let client: DuckDbGraphClient;

  interface Row {
    source_rel_path: string;
    site_key: string;
    method_symbol_id: string;
    method_start_line: number;
    method_end_line: number;
    line: number;
    call_column: number;
    receiver_text: string;
    member: string;
    kind: string;
    candidates: string;
    menu_hash: string;
    menu_overflow: boolean;
  }

  const readRows = async (): Promise<Row[]> =>
    client.queryAll<Row>("SELECT * FROM cg_residual_call_sites ORDER BY source_rel_path, site_key");

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-cli-residual-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("upsertFile persists residual rows with every column and JSON candidates", async () => {
    await client.upsertFile(
      { relPath: "a.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], residualCallSites: [site("a.rb", "k1", { menuOverflow: true })] },
    );

    const rows = await readRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_rel_path: "a.rb",
      site_key: "k1",
      method_symbol_id: "Billing#run",
      method_start_line: 10,
      method_end_line: 20,
      line: 12,
      call_column: 6,
      receiver_text: "account",
      member: "users",
      kind: "dynamic",
      menu_hash: "menu-1",
      menu_overflow: true,
    });
    expect(JSON.parse(rows[0].candidates)).toEqual(["Firm#users", "Team#users"]);
  });

  it("round-trips a site's receiver group and class targets, and reads none for a site without them", async () => {
    const classTargets: ResidualClassTarget[] = [
      ["Bill", "Document#users"],
      ["Firm", "Firm#users", "Team"],
    ];
    await client.upsertFile(
      { relPath: "a.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [],
        residualCallSites: [
          site("a.rb", "k1", { receiverGroup: "g-1", classTargets, downstreamGroup: "g-2" }),
          site("a.rb", "k2"),
        ],
      },
    );

    const [grouped, plain] = await client.readResidualCallSites();

    expect(grouped).toMatchObject({ siteKey: "k1", receiverGroup: "g-1", classTargets, downstreamGroup: "g-2" });
    expect(plain.siteKey).toBe("k2");
    expect(plain).not.toHaveProperty("receiverGroup");
    expect(plain).not.toHaveProperty("classTargets");
    expect(plain).not.toHaveProperty("downstreamGroup");
  });

  it("stores a class target reaching the default `Class#member` without its target, and reads it back whole", async () => {
    const classTargets: ResidualClassTarget[] = [
      ["Firm", "Firm#users"],
      ["Team", "Team#users", "User"],
      ["Bill", "Document#users"],
      ["Plan", "Plan.users"],
    ];
    await client.upsertFile(
      { relPath: "a.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [],
        residualCallSites: [site("a.rb", "k1", { receiverGroup: "g-1", classTargets })],
      },
    );

    const [stored] = await client.queryAll<{ class_targets: string }>(
      "SELECT class_targets FROM cg_residual_call_sites",
    );
    expect(JSON.parse(stored.class_targets)).toEqual([
      ["Firm"],
      ["Team", null, "User"],
      ["Bill", "Document#users"],
      ["Plan", "Plan.users"],
    ]);
    const [row] = await client.readResidualCallSites();
    expect(row.classTargets).toEqual(classTargets);
  });

  it("reads a row stored before the compact form, every target spelled out", async () => {
    await client.upsertFile(
      { relPath: "a.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [],
        residualCallSites: [site("a.rb", "k1", { receiverGroup: "g-1", classTargets: [] })],
      },
    );
    await client.run(
      `UPDATE cg_residual_call_sites SET class_targets = '[["Firm","Firm#users"],["Team","Team#users","User"]]'`,
    );

    const [row] = await client.readResidualCallSites();

    expect(row.classTargets).toEqual([
      ["Firm", "Firm#users"],
      ["Team", "Team#users", "User"],
    ]);
  });

  describe("a class set over 40 classes", () => {
    /** `n` classes: every 7th inherits `Base#users`, every 5th returns `User`. */
    const bigSet = (n: number, prefix = "K"): ResidualClassTarget[] =>
      Array.from({ length: n }, (_, i): ResidualClassTarget => {
        const cls = `${prefix}${String(i).padStart(3, "0")}`;
        const target = i % 7 === 0 ? "Base#users" : `${cls}#users`;
        return i % 5 === 0 ? [cls, target, "User"] : [cls, target];
      });
    const grouped = (relPath: string, siteKey: string, classTargets: ResidualClassTarget[], group = "g-1") =>
      site(relPath, siteKey, { receiverGroup: group, classTargets });
    const setCount = async () =>
      Number((await client.queryAll<{ n: bigint }>("SELECT count(*) AS n FROM cg_residual_class_sets"))[0].n);

    it("is stored once for every row with the same member and set, and read back whole", async () => {
      const classTargets = bigSet(300);
      await client.upsertFile(
        { relPath: "a.rb", language: "ruby" },
        {
          fileEdges: [],
          methodEdges: [],
          residualCallSites: [grouped("a.rb", "k1", classTargets), grouped("a.rb", "k2", classTargets, "g-2")],
        },
      );
      await client.upsertFile(
        { relPath: "b.rb", language: "ruby" },
        { fileEdges: [], methodEdges: [], residualCallSites: [grouped("b.rb", "k1", classTargets)] },
      );

      const stored = await client.queryAll<{ class_targets: string | null; class_set: string | null }>(
        "SELECT class_targets, class_set FROM cg_residual_call_sites",
      );
      expect(stored.every((r) => r.class_targets === null && r.class_set !== null)).toBe(true);
      expect(new Set(stored.map((r) => r.class_set)).size).toBe(1);
      expect(await setCount()).toBe(1);
      const rows = await client.readResidualCallSites();
      expect(rows.map((r) => r.classTargets)).toEqual([classTargets, classTargets, classTargets]);
    });

    it("keeps a set of 40 classes on the row", async () => {
      await client.upsertFile(
        { relPath: "a.rb", language: "ruby" },
        { fileEdges: [], methodEdges: [], residualCallSites: [grouped("a.rb", "k1", bigSet(40))] },
      );

      const [stored] = await client.queryAll<{ class_targets: string | null; class_set: string | null }>(
        "SELECT class_targets, class_set FROM cg_residual_call_sites",
      );
      expect(stored.class_set).toBeNull();
      expect(stored.class_targets).not.toBeNull();
      expect(await setCount()).toBe(0);
    });

    it("drops a set no row refers to once its file is re-walked into another set or removed", async () => {
      const node = { relPath: "a.rb", language: "ruby" };
      await client.upsertFile(node, {
        fileEdges: [],
        methodEdges: [],
        residualCallSites: [grouped("a.rb", "k1", bigSet(300))],
      });
      await client.upsertFile(node, {
        fileEdges: [],
        methodEdges: [],
        residualCallSites: [grouped("a.rb", "k1", bigSet(200, "J"))],
      });

      expect(await setCount()).toBe(1);
      const [row] = await client.readResidualCallSites();
      expect(row.classTargets?.[0][0]).toBe("J000");

      await client.removeFiles(["a.rb"]);
      expect(await setCount()).toBe(0);
    });

    it("costs a small fraction of the per-row form on rows shaped like a large Rails app", async () => {
      // 600 rows over 500 groups; 6 class sets of 300..550 classes, each reached by two members.
      const sets = Array.from({ length: 6 }, (_, i) => bigSet(300 + i * 50, `Api::V1::Serializers::Klass${i}x`));
      const members = ["users", "firm"];
      const rows = Array.from({ length: 600 }, (_, i) => {
        const member = members[Math.floor(i / 6) % 2];
        const classTargets = sets[i % 6].map(
          ([cls, target, returnType]): ResidualClassTarget =>
            returnType === undefined
              ? [cls, target.replace("#users", `#${member}`)]
              : [cls, target.replace("#users", `#${member}`), returnType],
        );
        return site(`app/f${i % 50}.rb`, `k${i}`, { member, receiverGroup: `g-${i % 500}`, classTargets });
      });
      const perRowBytes = rows.reduce(
        (n, r) => n + encodeResidualClassTargets(r.member, r.classTargets ?? []).length,
        0,
      );

      await client.upsertFilesBulk(
        [...new Set(rows.map((r) => r.sourceRelPath))].map((relPath) => ({
          node: { relPath, language: "ruby" },
          edges: { fileEdges: [], methodEdges: [], residualCallSites: rows.filter((r) => r.sourceRelPath === relPath) },
        })),
      );

      const [{ bytes }] = await client.queryAll<{ bytes: bigint }>(
        `SELECT (SELECT coalesce(sum(length(class_targets)), 0) + coalesce(sum(length(class_set)), 0)
                   FROM cg_residual_call_sites)
              + (SELECT coalesce(sum(length(class_targets) + length(set_key)), 0) FROM cg_residual_class_sets) AS bytes`,
      );
      expect(await setCount()).toBe(12);
      expect(Number(bytes)).toBeLessThan(perRowBytes / 20);
      const read = await client.readResidualCallSites();
      expect(read.find((r) => r.siteKey === "k7")?.classTargets).toEqual(rows[7].classTargets);
    });
  });

  it("re-upserting a file replaces its slice", async () => {
    const node = { relPath: "a.rb", language: "ruby" };
    await client.upsertFile(node, {
      fileEdges: [],
      methodEdges: [],
      residualCallSites: [site("a.rb", "k1"), site("a.rb", "k2")],
    });
    await client.upsertFile(node, { fileEdges: [], methodEdges: [], residualCallSites: [site("a.rb", "k2")] });

    expect((await readRows()).map((r) => r.site_key)).toEqual(["k2"]);
  });

  it("an absent field clears the file's slice and leaves other files alone", async () => {
    await client.upsertFile(
      { relPath: "a.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], residualCallSites: [site("a.rb", "k1")] },
    );
    await client.upsertFile(
      { relPath: "b.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], residualCallSites: [site("b.rb", "k1")] },
    );
    await client.upsertFile({ relPath: "a.rb", language: "ruby" }, { fileEdges: [], methodEdges: [] });

    expect((await readRows()).map((r) => r.source_rel_path)).toEqual(["b.rb"]);
  });

  it("upsertFilesBulk persists slices per file and removeFiles retires them", async () => {
    await client.upsertFilesBulk([
      {
        node: { relPath: "a.rb", language: "ruby" },
        edges: { fileEdges: [], methodEdges: [], residualCallSites: [site("a.rb", "k1")] },
      },
      {
        node: { relPath: "b.rb", language: "ruby" },
        edges: { fileEdges: [], methodEdges: [], residualCallSites: [site("b.rb", "k1")] },
      },
    ]);
    expect(await readRows()).toHaveLength(2);

    await client.removeFiles(["a.rb"]);
    expect((await readRows()).map((r) => r.source_rel_path)).toEqual(["b.rb"]);
  });
});
