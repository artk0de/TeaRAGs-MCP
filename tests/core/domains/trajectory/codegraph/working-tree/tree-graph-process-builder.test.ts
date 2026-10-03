/**
 * `WorkingTreeGraphProcessBuilder` forks the COMPILED `tree-graph-entry.js`
 * (needs `npm run build`), so these cases exercise the real child: IPC in, a
 * real tree build, IPC out — and the three ways a child ends without a graph.
 * None of them may throw: the caller degrades to the base graph on any of them.
 *
 * The child is WARM: it serves build after build until it times out, dies, is
 * recycled for its heap or sits idle too long. The lifecycle cases that need a
 * child to misbehave on cue (run out of heap, hang, report a heavy heap) fork a
 * SCRIPTED entry written per test instead — the builder takes the entry path,
 * and what is under test there is the builder's bookkeeping, not the build.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { WorkingTreeGraphBuildInput } from "../../../../../../src/core/domains/trajectory/codegraph/working-tree/tree-graph-build.js";
import {
  WorkingTreeGraphProcessBuilder,
  type WorkingTreeGraphProcessBuilderOptions,
} from "../../../../../../src/core/domains/trajectory/codegraph/working-tree/tree-graph-process-builder.js";
import {
  buildTreeGraphFixture,
  cleanupTreeGraphFixtures,
  LANGUAGE_MODULE_PATH,
  methodEdges,
  MIGRATIONS_MODULE_PATH,
  PHYSICAL,
  type TreeGraphFixture,
} from "./__helpers__/tree-graph-fixture.js";

const scriptDirs: string[] = [];
const builders: WorkingTreeGraphProcessBuilder[] = [];

afterEach(async () => {
  await Promise.all(builders.splice(0).map(async (builder) => builder.close()));
});

afterAll(() => {
  cleanupTreeGraphFixtures();
  for (const dir of scriptDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BUDGET = { timeoutMs: 60_000, heapLimitMb: 1024 };

const BASE = {
  "src/x.ts": `export function x(): number {\n  return 1;\n}\n\nexport function y(): number {\n  return 2;\n}\n`,
  "src/a.ts": `import { x } from "./x";\n\nexport function run(): number {\n  return x();\n}\n`,
};
const A_TREE = `import { y } from "./x";\n\nexport function run(): number {\n  return y();\n}\n`;

const CHECKED_BASE = {
  "src/api.ts": `export interface Closer {\n  close(): void;\n}\n\nexport function drain(c: Closer): void {\n  c.close();\n}\n`,
  "src/a.ts": `import type { Closer } from "./api";\n\nexport class A implements Closer {\n  close(): void {\n    console.log("A");\n  }\n}\n`,
};
const CHECKED_API_TREE = `${CHECKED_BASE["src/api.ts"]}\nexport function drainTwice(c: Closer): void {\n  c.close();\n  c.close();\n}\n`;

function inputFor(fixture: TreeGraphFixture, outputRoot = fixture.outputRoot): WorkingTreeGraphBuildInput {
  return {
    snapshotPath: fixture.snapshotPath,
    outputRoot,
    physicalCollectionName: PHYSICAL,
    treeRoot: fixture.treeRoot,
    changedRelPaths: ["src/a.ts"],
    deletedRelPaths: [],
    providerConfig: { languageModulePath: LANGUAGE_MODULE_PATH, migrationsModulePath: MIGRATIONS_MODULE_PATH },
  };
}

/** A fresh staging dir: the graph lands at a fixed path under it, and each build takes one clone. */
function freshOutputRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "wtg-pb-out-"));
  scriptDirs.push(dir);
  return dir;
}

function track(builder: WorkingTreeGraphProcessBuilder): WorkingTreeGraphProcessBuilder {
  builders.push(builder);
  return builder;
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

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * A stand-in child speaking the entry's protocol. `input.treeRoot` is the cue:
 * `oom` allocates past the heap ceiling, `hang` never replies, `heap:<bytes>`
 * replies reporting that heap, anything else replies at once. Every reply is
 * `failed` with the child's pid as the reason, so a test reads which child
 * answered. Named `tree-graph-entry-*` so {@link treeGraphChildren} sees it.
 */
const SCRIPTED_ENTRY = `
process.on("disconnect", () => process.exit(0));
process.on("message", (message) => {
  if (message.kind === "shutdown") process.exit(0);
  const cue = message.input.treeRoot;
  if (cue === "oom") {
    const hold = [];
    for (;;) hold.push(new Array(1_000_000).fill(hold.length));
  }
  if (cue === "hang") return;
  const heapUsedBytes = cue.startsWith("heap:") ? Number(cue.slice(5)) : 0;
  process.send({ kind: "failed", id: message.id, reason: "pid=" + process.pid, heapUsedBytes });
});
`;

function scriptedBuilder(options: WorkingTreeGraphProcessBuilderOptions = {}): WorkingTreeGraphProcessBuilder {
  const dir = mkdtempSync(join(tmpdir(), "wtg-scripted-"));
  scriptDirs.push(dir);
  const entryPath = join(dir, "tree-graph-entry-scripted.mjs");
  writeFileSync(entryPath, SCRIPTED_ENTRY);
  return track(new WorkingTreeGraphProcessBuilder(entryPath, options));
}

function cued(treeRoot: string): WorkingTreeGraphBuildInput {
  return {
    snapshotPath: "/unused.duckdb",
    outputRoot: "/unused",
    physicalCollectionName: PHYSICAL,
    treeRoot,
    changedRelPaths: ["src/a.ts"],
    deletedRelPaths: [],
    providerConfig: { languageModulePath: "/unused.js", migrationsModulePath: "/unused.js" },
  };
}

/** The pid a scripted child put in its reply. */
function answeredBy(outcome: Awaited<ReturnType<WorkingTreeGraphProcessBuilder["build"]>>): number {
  if (outcome.kind !== "failed") throw new Error(`expected the scripted reply, got ${outcome.kind}`);
  const match = /^pid=(\d+)$/.exec(outcome.reason);
  if (!match) throw new Error(`not a scripted reply: ${outcome.reason}`);
  return Number(match[1]);
}

const SCRIPTED_BUDGET = { timeoutMs: 30_000, heapLimitMb: 64 };

describe("WorkingTreeGraphProcessBuilder", () => {
  it("a forked build against the compiled entry succeeds and the graph reflects the tree", async () => {
    const fixture = await buildTreeGraphFixture(BASE);
    fixture.writeTree("src/a.ts", A_TREE);
    const builder = track(new WorkingTreeGraphProcessBuilder());

    const outcome = await builder.build(inputFor(fixture), BUDGET);

    expect(outcome.kind).toBe("built");
    if (outcome.kind !== "built") return;
    expect(outcome.graph.dbPath).toBe(join(fixture.outputRoot, "codegraph", `${PHYSICAL}.duckdb`));
    expect(outcome.graph.walkedFileCount).toBe(1);
    const wal = `${outcome.graph.dbPath}.wal`;
    expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true);
    const edges = await methodEdges(outcome.graph.dbPath);
    expect(edges).toContain("src/a.ts#run -> src/x.ts#y");
    expect(edges).not.toContain("src/a.ts#run -> src/x.ts#x");
    // The child outlives the build (it is warm) and goes when the builder closes.
    expect(treeGraphChildren()).toHaveLength(1);
    await builder.close();
    expect(treeGraphChildren()).toEqual([]);
  }, 120_000);

  it("two builds through one builder run in ONE warm child, and the second reuses the first's parses", async () => {
    // A call on an interface-typed parameter: the checker tier types it, so the
    // build constructs a ts.Program — the parses the second build should reuse.
    const fixture = await buildTreeGraphFixture(CHECKED_BASE);
    fixture.writeTree("src/api.ts", CHECKED_API_TREE);
    const builder = track(new WorkingTreeGraphProcessBuilder());
    const input = (): WorkingTreeGraphBuildInput => ({
      ...inputFor(fixture, freshOutputRoot()),
      changedRelPaths: ["src/api.ts"],
    });

    const first = await builder.build(input(), BUDGET);
    const afterFirst = treeGraphChildren();
    fixture.writeTree("src/api.ts", `${CHECKED_API_TREE}\nexport const marker = 1;\n`);
    const second = await builder.build(input(), BUDGET);

    expect(first.kind).toBe("built");
    expect(second.kind).toBe("built");
    expect(afterFirst).toHaveLength(1);
    expect(treeGraphChildren()).toEqual(afterFirst);
    if (first.kind !== "built" || second.kind !== "built") return;
    expect(first.graph.parseCache?.state).toBe("cold");
    expect(second.graph.parseCache?.state).toBe("warm");
    expect(second.graph.parseCache?.reused).toBeGreaterThan(0);
  }, 120_000);

  it("a build over its time budget is killed: timedOut, and no child is left behind", async () => {
    const fixture = await buildTreeGraphFixture(BASE);
    fixture.writeTree("src/a.ts", A_TREE);

    const outcome = await track(new WorkingTreeGraphProcessBuilder()).build(inputFor(fixture), {
      timeoutMs: 1,
      heapLimitMb: 1024,
    });

    expect(outcome).toEqual({ kind: "timedOut", timeoutMs: 1 });
    expect(treeGraphChildren()).toEqual([]);
  }, 120_000);

  it("a timed-out build kills the warm child, and the next build forks a new one", async () => {
    const fixture = await buildTreeGraphFixture(BASE);
    fixture.writeTree("src/a.ts", A_TREE);
    const builder = track(new WorkingTreeGraphProcessBuilder());

    const warm = await builder.build(inputFor(fixture, freshOutputRoot()), BUDGET);
    const [warmPid] = treeGraphChildren();
    const killed = await builder.build(inputFor(fixture, freshOutputRoot()), { timeoutMs: 1, heapLimitMb: 1024 });
    const afterKill = treeGraphChildren();
    const fresh = await builder.build(inputFor(fixture, freshOutputRoot()), BUDGET);

    expect(warm.kind).toBe("built");
    expect(killed).toEqual({ kind: "timedOut", timeoutMs: 1 });
    expect(afterKill).toEqual([]);
    expect(fresh.kind).toBe("built");
    expect(treeGraphChildren()).toHaveLength(1);
    expect(treeGraphChildren()).not.toContain(warmPid);
  }, 120_000);

  it("a child that runs out of heap reports heapExhausted (bd tea-rags-mcp-ghfgx: a ceiling node boots under)", async () => {
    const outcome = await scriptedBuilder().build(cued("oom"), SCRIPTED_BUDGET);

    expect(outcome).toEqual({ kind: "heapExhausted", heapLimitMb: 64 });
    expect(treeGraphChildren()).toEqual([]);
  }, 120_000);

  it("a child that ran out of heap is replaced by the next build", async () => {
    const builder = scriptedBuilder();

    const exhausted = await builder.build(cued("oom"), SCRIPTED_BUDGET);
    const next = await builder.build(cued("reply"), SCRIPTED_BUDGET);

    expect(exhausted.kind).toBe("heapExhausted");
    expect(treeGraphChildren()).toEqual([answeredBy(next)]);
  }, 120_000);

  it("builds queued behind a killed child are dispatched to a fresh child, not failed", async () => {
    const builder = scriptedBuilder();

    const hung = builder.build(cued("hang"), { timeoutMs: 500, heapLimitMb: 64 });
    const queuedA = builder.build(cued("reply"), SCRIPTED_BUDGET);
    const queuedB = builder.build(cued("reply"), SCRIPTED_BUDGET);
    await until(() => treeGraphChildren().length === 1, "the hung child is up");
    const [hungPid] = treeGraphChildren();

    expect(await hung).toEqual({ kind: "timedOut", timeoutMs: 500 });
    const pidA = answeredBy(await queuedA);
    const pidB = answeredBy(await queuedB);
    expect(pidA).not.toBe(hungPid);
    expect(pidB).toBe(pidA);
  }, 120_000);

  it("killInFlight kills a running child at once (process exit): the build settles failed, no child left", async () => {
    const fixture = await buildTreeGraphFixture(BASE);
    fixture.writeTree("src/a.ts", A_TREE);
    const builder = track(new WorkingTreeGraphProcessBuilder());

    const pending = builder.build(inputFor(fixture), BUDGET);
    while (treeGraphChildren().length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    builder.killInFlight();
    const outcome = await pending;

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toMatch(/SIGKILL/);
    expect(treeGraphChildren()).toEqual([]);
  }, 120_000);

  it("killInFlight kills an idle warm child too", async () => {
    const builder = scriptedBuilder();
    await builder.build(cued("reply"), SCRIPTED_BUDGET);
    expect(treeGraphChildren()).toHaveLength(1);

    builder.killInFlight();

    await until(() => treeGraphChildren().length === 0, "the idle child is gone");
  }, 120_000);

  it("an idle child shuts down after the idle period", async () => {
    const builder = scriptedBuilder({ idleMs: 1_000 });

    const outcome = await builder.build(cued("reply"), SCRIPTED_BUDGET);

    expect(treeGraphChildren()).toEqual([answeredBy(outcome)]);
    await until(() => treeGraphChildren().length === 0, "the idle child exited");
  }, 120_000);

  it("a child reporting heap above the recycle fraction of its ceiling is retired after its build", async () => {
    const builder = scriptedBuilder({ recycleHeapFraction: 0.5 });
    const ceilingBytes = SCRIPTED_BUDGET.heapLimitMb * 1024 * 1024;

    const light = await builder.build(cued(`heap:${String(ceilingBytes * 0.4)}`), SCRIPTED_BUDGET);
    const stillWarm = await builder.build(cued(`heap:${String(ceilingBytes * 0.6)}`), SCRIPTED_BUDGET);
    await until(() => treeGraphChildren().length === 0, "the heavy child was retired");
    const fresh = await builder.build(cued("reply"), SCRIPTED_BUDGET);

    expect(answeredBy(stillWarm)).toBe(answeredBy(light));
    expect(answeredBy(fresh)).not.toBe(answeredBy(light));
  }, 120_000);

  it("a build under a different heap ceiling gets a child forked with that ceiling", async () => {
    const builder = scriptedBuilder();

    const small = await builder.build(cued("reply"), SCRIPTED_BUDGET);
    const large = await builder.build(cued("reply"), { timeoutMs: 30_000, heapLimitMb: 128 });

    expect(answeredBy(large)).not.toBe(answeredBy(small));
    // The 64 MB child was retired when the 128 MB build arrived; it exits on its own.
    await until(() => treeGraphChildren().join() === String(answeredBy(large)), "only the 128 MB child is left");
  }, 120_000);

  it("a bad input returns failed with the child's reason, never throws", async () => {
    const fixture = await buildTreeGraphFixture(BASE);

    const outcome = await track(new WorkingTreeGraphProcessBuilder()).build(
      { ...inputFor(fixture), snapshotPath: join(fixture.outputRoot, "no-such-snapshot.duckdb") },
      BUDGET,
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toMatch(/no-such-snapshot/);
  }, 120_000);
});
