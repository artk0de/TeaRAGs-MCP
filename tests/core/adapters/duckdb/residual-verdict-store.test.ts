import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ResidualVerdictStore } from "../../../../src/core/adapters/duckdb/residual-verdict-store.js";
import type { ResidualVerdict } from "../../../../src/core/contracts/types/codegraph-residual.js";

const DAY = 86_400_000;

function verdict(over: Partial<ResidualVerdict> = {}): ResidualVerdict {
  return {
    siteKey: "k1",
    menuHash: "m1",
    model: "kev",
    modelVersion: "kev-4b@v1.0",
    pick: "Firm#users",
    p: 0.9,
    probabilities: { "Firm#users": 0.9, "Team#users": 0.1 },
    questionPayload: '{"q":1}',
    createdAt: 1_000,
    lastSeenAt: 1_000,
    ...over,
  };
}

describe("ResidualVerdictStore", () => {
  let root: string;
  let store: ResidualVerdictStore;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "residual-verdicts-"));
    store = await ResidualVerdictStore.open(root, "code_a");
  });

  afterEach(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("lives at <rootDir>/residual-verdicts/<logicalName>.duckdb", () => {
    expect(ResidualVerdictStore.pathFor(root, "code_a")).toBe(join(root, "residual-verdicts", "code_a.duckdb"));
    expect(existsSync(ResidualVerdictStore.pathFor(root, "code_a"))).toBe(true);
  });

  it("finds a stored verdict by site, menu and model version only", async () => {
    await store.put([verdict()]);

    expect(await store.find([{ siteKey: "k1", menuHash: "m1", modelVersion: "kev-4b@v1.0" }])).toEqual([verdict()]);
    expect(await store.find([{ siteKey: "k1", menuHash: "m2", modelVersion: "kev-4b@v1.0" }])).toEqual([]);
    expect(await store.find([{ siteKey: "k1", menuHash: "m1", modelVersion: "kev-4b@v1.1" }])).toEqual([]);
  });

  it("put overwrites the answer of a known key and keeps its creation time", async () => {
    await store.put([verdict()]);

    await store.put([
      verdict({
        pick: "Team#users",
        p: 0.75,
        createdAt: 5_000,
        lastSeenAt: 5_000,
      }),
    ]);

    expect(await store.find([{ siteKey: "k1", menuHash: "m1", modelVersion: "kev-4b@v1.0" }])).toEqual([
      verdict({
        pick: "Team#users",
        p: 0.75,
        createdAt: 1_000,
        lastSeenAt: 5_000,
      }),
    ]);
  });

  it("put collapses repeated keys in one batch, last wins", async () => {
    await store.put([verdict({ pick: "Team#users" }), verdict({ pick: "Firm#users" })]);

    const [found] = await store.find([{ siteKey: "k1", menuHash: "m1", modelVersion: "kev-4b@v1.0" }]);
    expect(found?.pick).toBe("Firm#users");
  });

  it("findLatest answers the newest verdict of the model per site and menu, whatever its version", async () => {
    await store.put([
      verdict({ modelVersion: "kev@1", pick: "Team#users", createdAt: 1_000 }),
      verdict({ modelVersion: "kev@2", pick: "Firm#users", createdAt: 2_000 }),
      verdict({ siteKey: "k2", modelVersion: "kev@1", createdAt: 1_500 }),
      verdict({ siteKey: "k1", model: "jev", modelVersion: "jev@9", createdAt: 9_000 }),
      verdict({ siteKey: "k1", menuHash: "m2", modelVersion: "kev@3", createdAt: 3_000 }),
    ]);

    const latest = await store.findLatest(
      [
        { siteKey: "k1", menuHash: "m1" },
        { siteKey: "k2", menuHash: "m1" },
        { siteKey: "k3", menuHash: "m1" },
      ],
      "kev",
    );

    expect(latest.map((v) => [v.siteKey, v.menuHash, v.modelVersion, v.pick])).toEqual([
      ["k1", "m1", "kev@2", "Firm#users"],
      ["k2", "m1", "kev@1", "Firm#users"],
    ]);
  });

  it("touch moves last_seen_at for the model's sites only", async () => {
    await store.put([verdict(), verdict({ siteKey: "k2" }), verdict({ model: "jev", modelVersion: "jev@1" })]);

    await store.touch(["k1"], "kev", 9_000);

    const seen = await store.find([
      { siteKey: "k1", menuHash: "m1", modelVersion: "kev-4b@v1.0" },
      { siteKey: "k2", menuHash: "m1", modelVersion: "kev-4b@v1.0" },
      { siteKey: "k1", menuHash: "m1", modelVersion: "jev@1" },
    ]);
    expect(seen.map((v) => [v.siteKey, v.model, v.lastSeenAt])).toEqual([
      ["k1", "jev", 1_000],
      ["k1", "kev", 9_000],
      ["k2", "kev", 1_000],
    ]);
  });

  it("expire deletes verdicts unseen for longer than the retention and counts them", async () => {
    const now = 400 * DAY;
    await store.put([
      verdict({ siteKey: "old", lastSeenAt: now - 181 * DAY }),
      verdict({ siteKey: "fresh", lastSeenAt: now - DAY }),
    ]);

    expect(await store.expire(180, now)).toBe(1);

    const left = await store.find([
      { siteKey: "old", menuHash: "m1", modelVersion: "kev-4b@v1.0" },
      { siteKey: "fresh", menuHash: "m1", modelVersion: "kev-4b@v1.0" },
    ]);
    expect(left.map((v) => v.siteKey)).toEqual(["fresh"]);
  });

  it("keeps verdicts across a close and reopen", async () => {
    await store.put([verdict()]);
    await store.close();

    store = await ResidualVerdictStore.open(root, "code_a");

    expect(await store.find([{ siteKey: "k1", menuHash: "m1", modelVersion: "kev-4b@v1.0" }])).toHaveLength(1);
  });
  it("a batch that fails part-way stores none of its verdicts", async () => {
    const batch = Array.from({ length: 250 }, (_, i) => verdict({ siteKey: `s${i}` }));
    batch[249] = verdict({ siteKey: "s249", pick: null as unknown as string });

    await expect(store.put(batch)).rejects.toThrow();

    expect(
      await store.find([
        { siteKey: "s0", menuHash: "m1", modelVersion: "kev-4b@v1.0" },
        { siteKey: "s249", menuHash: "m1", modelVersion: "kev-4b@v1.0" },
      ]),
    ).toEqual([]);
  });

  it("a process killed inside a write leaves a file that opens with only the committed verdicts", async () => {
    await store.put([verdict()]);
    await store.close();
    const file = ResidualVerdictStore.pathFor(root, "code_a");
    const script = [
      'import { DuckDBInstance } from "@duckdb/node-api";',
      `const instance = await DuckDBInstance.create(${JSON.stringify(file)});`,
      "const conn = await instance.connect();",
      "await conn.run(\"INSERT INTO residual_verdicts VALUES ('k2','m1','kev','kev-4b@v1.0','Firm#users',0.9,'{}','{}',1,1)\");",
      'await conn.run("BEGIN");',
      "await conn.run(\"INSERT INTO residual_verdicts VALUES ('k3','m1','kev','kev-4b@v1.0','Firm#users',0.9,'{}','{}',1,1)\");",
      "process.exit(1);",
    ].join("\n");
    expect(() =>
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toThrow();

    store = await ResidualVerdictStore.open(root, "code_a");

    const found = await store.find(
      ["k1", "k2", "k3"].map((siteKey) => ({ siteKey, menuHash: "m1", modelVersion: "kev-4b@v1.0" })),
    );
    expect(found.map((v) => v.siteKey)).toEqual(["k1", "k2"]);
  });

  it("opens beside another collection's store in the same process", async () => {
    const other = await ResidualVerdictStore.open(root, "code_b");
    try {
      await other.put([verdict({ pick: "Team#users" })]);
      await store.put([verdict()]);

      const [mine] = await store.find([{ siteKey: "k1", menuHash: "m1", modelVersion: "kev-4b@v1.0" }]);
      const [theirs] = await other.find([{ siteKey: "k1", menuHash: "m1", modelVersion: "kev-4b@v1.0" }]);
      expect([mine?.pick, theirs?.pick]).toEqual(["Firm#users", "Team#users"]);
    } finally {
      await other.close();
    }
  });
});
