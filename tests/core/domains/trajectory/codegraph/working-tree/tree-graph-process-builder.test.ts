/**
 * `WorkingTreeGraphProcessBuilder` forks the COMPILED `tree-graph-entry.js`
 * (needs `npm run build`), so these cases exercise the real child: IPC in, a
 * real tree build, IPC out — and the three ways a child ends without a graph.
 * None of them may throw: the caller degrades to the base graph on any of them.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { WorkingTreeGraphBuildInput } from "../../../../../../src/core/domains/trajectory/codegraph/working-tree/tree-graph-build.js";
import { WorkingTreeGraphProcessBuilder } from "../../../../../../src/core/domains/trajectory/codegraph/working-tree/tree-graph-process-builder.js";
import {
  buildTreeGraphFixture,
  cleanupTreeGraphFixtures,
  LANGUAGE_MODULE_PATH,
  methodEdges,
  MIGRATIONS_MODULE_PATH,
  PHYSICAL,
  type TreeGraphFixture,
} from "./__helpers__/tree-graph-fixture.js";

afterAll(() => {
  cleanupTreeGraphFixtures();
});

const BUDGET = { timeoutMs: 60_000, heapLimitMb: 1024 };

const BASE = {
  "src/x.ts": `export function x(): number {\n  return 1;\n}\n\nexport function y(): number {\n  return 2;\n}\n`,
  "src/a.ts": `import { x } from "./x";\n\nexport function run(): number {\n  return x();\n}\n`,
};
const A_TREE = `import { y } from "./x";\n\nexport function run(): number {\n  return y();\n}\n`;

function inputFor(fixture: TreeGraphFixture): WorkingTreeGraphBuildInput {
  return {
    snapshotPath: fixture.snapshotPath,
    outputRoot: fixture.outputRoot,
    physicalCollectionName: PHYSICAL,
    treeRoot: fixture.treeRoot,
    changedRelPaths: ["src/a.ts"],
    deletedRelPaths: [],
    providerConfig: { languageModulePath: LANGUAGE_MODULE_PATH, migrationsModulePath: MIGRATIONS_MODULE_PATH },
  };
}

/** PIDs of live tree-graph-entry children of THIS process. */
function treeGraphChildren(): number[] {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([, ppid, ...command]) => Number(ppid) === process.pid && command.join(" ").includes("tree-graph-entry"))
    .map(([pid]) => Number(pid));
}

describe("WorkingTreeGraphProcessBuilder", () => {
  it("a forked build against the compiled entry succeeds and the graph reflects the tree", async () => {
    const fixture = await buildTreeGraphFixture(BASE);
    fixture.writeTree("src/a.ts", A_TREE);

    const outcome = await new WorkingTreeGraphProcessBuilder().build(inputFor(fixture), BUDGET);

    expect(outcome.kind).toBe("built");
    if (outcome.kind !== "built") return;
    expect(outcome.graph.dbPath).toBe(join(fixture.outputRoot, "codegraph", `${PHYSICAL}.duckdb`));
    expect(outcome.graph.walkedFileCount).toBe(1);
    const wal = `${outcome.graph.dbPath}.wal`;
    expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true);
    const edges = await methodEdges(outcome.graph.dbPath);
    expect(edges).toContain("src/a.ts#run -> src/x.ts#y");
    expect(edges).not.toContain("src/a.ts#run -> src/x.ts#x");
    expect(treeGraphChildren()).toEqual([]);
  }, 120_000);

  it("a build over its time budget is killed: timedOut, and no child is left behind", async () => {
    const fixture = await buildTreeGraphFixture(BASE);
    fixture.writeTree("src/a.ts", A_TREE);

    const outcome = await new WorkingTreeGraphProcessBuilder().build(inputFor(fixture), {
      timeoutMs: 1,
      heapLimitMb: 1024,
    });

    expect(outcome).toEqual({ kind: "timedOut", timeoutMs: 1 });
    expect(treeGraphChildren()).toEqual([]);
  }, 120_000);

  it("a child that runs out of heap reports heapExhausted", async () => {
    const fixture = await buildTreeGraphFixture(BASE);
    fixture.writeTree("src/a.ts", A_TREE);

    const outcome = await new WorkingTreeGraphProcessBuilder().build(inputFor(fixture), {
      timeoutMs: 60_000,
      heapLimitMb: 4,
    });

    expect(outcome).toEqual({ kind: "heapExhausted", heapLimitMb: 4 });
    expect(treeGraphChildren()).toEqual([]);
  }, 120_000);

  it("killInFlight kills a running child at once (process exit): the build settles failed, no child left", async () => {
    const fixture = await buildTreeGraphFixture(BASE);
    fixture.writeTree("src/a.ts", A_TREE);
    const builder = new WorkingTreeGraphProcessBuilder();

    const pending = builder.build(inputFor(fixture), BUDGET);
    while (treeGraphChildren().length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    builder.killInFlight();
    const outcome = await pending;

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toMatch(/SIGKILL/);
    expect(treeGraphChildren()).toEqual([]);
  }, 120_000);

  it("a bad input returns failed with the child's reason, never throws", async () => {
    const fixture = await buildTreeGraphFixture(BASE);

    const outcome = await new WorkingTreeGraphProcessBuilder().build(
      { ...inputFor(fixture), snapshotPath: join(fixture.outputRoot, "no-such-snapshot.duckdb") },
      BUDGET,
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toMatch(/no-such-snapshot/);
  }, 120_000);
});
