/**
 * Correctness gate of seeded tree builds (epic xi2r9): a tree graph built
 * INCREMENTALLY — the previous tree graph (S1) as the snapshot, the S1→S2 diff
 * from `treeDeltaAgainstSeed` as the delta — must equal the graph built from
 * the BASE over the whole S2 delta. One chain of tree states, one edit class
 * per step; every step compares the two graphs table by table through the
 * shared dump (`dumpCodegraphTables`): every `cg_*` row byte for byte, the
 * order-sensitive analytics (cycles, PageRank) by meaning.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cycleMemberSets,
  dumpCodegraphTables,
  ORDER_SENSITIVE_ANALYTICS_TABLES,
  PAGE_RANK_EPSILON,
} from "../__helpers__/graph-db-dump.js";
import {
  buildWorkingTreeGraph,
  type WorkingTreeGraphBuilt,
} from "../../../../../../src/core/domains/trajectory/codegraph/working-tree/tree-graph-build.js";
import type { WorkingTreeGraphSeed } from "../../../../../../src/core/domains/trajectory/codegraph/working-tree/tree-graph-seed-apply.js";
import {
  treeGraphSeedOf,
  type WorkingTreeDeltaRecord,
} from "../../../../../../src/core/domains/trajectory/codegraph/working-tree/tree-graph-seed.js";
import { fileContentHash } from "../../../../../../src/core/infra/file-content-hash.js";
import {
  buildTreeGraphFixture,
  cleanupTreeGraphFixtures,
  LANGUAGE_MODULE_PATH,
  MIGRATIONS_MODULE_PATH,
  PHYSICAL,
  withReadOnlyGraph,
  type TreeGraphFixture,
} from "./__helpers__/tree-graph-fixture.js";

const outputDirs: string[] = [];

afterAll(() => {
  cleanupTreeGraphFixtures();
  for (const dir of outputDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ─── Fixture: files that call across each other, so an edit moves edges ─────

const fn = (name: string, body: string, imports = ""): string =>
  `${imports}export function ${name}(): number {\n  return ${body};\n}\n`;

/** `m.ts` at a given body of `m`, with or without the `mx` a file outside every delta calls. */
const mFile = (body: string, withMx = true): string =>
  `${fn("m", body, `import { k } from "./k";\n\n`)}${withMx ? `\n${fn("mx", "1")}` : ""}`;

const BASE_FILES: Record<string, string> = {
  "src/k.ts": fn("k", "7"),
  "src/m.ts": mFile("k()"),
  // Never edited — files OUTSIDE every tree delta, holding the base's edges into
  // what the tree removes and restores.
  "src/mx-user.ts": fn("mxUser", "mx()", `import { mx } from "./m";\n\n`),
  "src/keeper.ts": fn("keep", "doomed()", `import { doomed } from "./d";\n\n`),
  // Imports a module the base does not have; the tree adds it, then deletes it.
  "src/ghost-user.ts": fn("ghostUser", "ghost()", `import { ghost } from "./ghost";\n\n`),
  "src/lonely.ts": fn("lonely", "3"),
  "src/v.ts": fn("v", "m()", `import { m } from "./m";\n\n`),
  "src/d.ts": fn("doomed", "k()", `import { k } from "./k";\n\n`),
  "src/u.ts": `import { doomed } from "./d";\nimport { v } from "./v";\n\nexport function u(): number {\n  return doomed() + v();\n}\n`,
  "src/r-old.ts": fn("renamed", "4"),
  "src/rc.ts": fn("callRenamed", "renamed()", `import { renamed } from "./r-old";\n\n`),
  "src/api.ts": `export interface Closer {\n  close(): void;\n}\n\nexport function drain(c: Closer): void {\n  c.close();\n}\n`,
  "src/a.ts": implementer("A"),
  "src/b.ts": implementer("B"),
};

function implementer(name: string): string {
  return `import type { Closer } from "./api";\n\nexport class ${name} implements Closer {\n  close(): void {\n    console.log("${name}");\n  }\n}\n`;
}

/** Every file under `root`, relative and sorted. */
function listFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, path));
    else out.push(relative(root, path));
  }
  return out.sort();
}

/** The tree's delta against the base, the way the cache states it: changed paths with their content hash, deleted paths. */
function deltaOf(fixture: TreeGraphFixture): WorkingTreeDeltaRecord {
  const baseFiles = new Set(listFiles(fixture.baseRoot));
  const treeFiles = new Set(listFiles(fixture.treeRoot));
  const changed: Record<string, string> = {};
  for (const relPath of treeFiles) {
    const tree = readFileSync(join(fixture.treeRoot, relPath), "utf8");
    if (baseFiles.has(relPath) && readFileSync(join(fixture.baseRoot, relPath), "utf8") === tree) continue;
    changed[relPath] = fileContentHash(tree);
  }
  return { changed, deleted: [...baseFiles].filter((relPath) => !treeFiles.has(relPath)).sort() };
}

async function build(
  fixture: TreeGraphFixture,
  snapshotPath: string,
  changedRelPaths: string[],
  deletedRelPaths: string[],
  seed?: WorkingTreeGraphSeed,
): Promise<WorkingTreeGraphBuilt> {
  const outputRoot = mkdtempSync(join(tmpdir(), "wtg-eq-out-"));
  outputDirs.push(outputRoot);
  return buildWorkingTreeGraph({
    snapshotPath,
    outputRoot,
    physicalCollectionName: PHYSICAL,
    treeRoot: fixture.treeRoot,
    changedRelPaths,
    deletedRelPaths,
    providerConfig: { languageModulePath: LANGUAGE_MODULE_PATH, migrationsModulePath: MIGRATIONS_MODULE_PATH },
    ...(seed ? { seed } : {}),
  });
}

interface SemanticGraph {
  /** Every `cg_*` table but the order-sensitive analytics, rows byte for byte. */
  tables: Record<string, string[]>;
  cycles: string[];
  /** `rel_path#symbol_id → page_rank` of `cg_symbols_metrics`, other columns kept verbatim. */
  metrics: Map<string, { pageRank: number; rest: string }>;
}

async function semanticGraph(dbPath: string): Promise<SemanticGraph> {
  const dump = await withReadOnlyGraph(dbPath, async (client) => dumpCodegraphTables(client));
  const tables = Object.fromEntries(
    Object.entries(dump).filter(([table]) => !ORDER_SENSITIVE_ANALYTICS_TABLES.includes(table)),
  );
  const metrics = new Map<string, { pageRank: number; rest: string }>();
  for (const line of dump.cg_symbols_metrics ?? []) {
    const { page_rank: pageRank, ...rest } = JSON.parse(line) as Record<string, unknown>;
    metrics.set(`${String(rest.rel_path)}#${String(rest.symbol_id)}`, {
      pageRank: Number(pageRank),
      rest: JSON.stringify(rest),
    });
  }
  return { tables, cycles: cycleMemberSets(dump.cg_symbols_cycles ?? []), metrics };
}

function expectEquivalent(seeded: SemanticGraph, fromBase: SemanticGraph): void {
  expect(Object.keys(seeded.tables)).toEqual(Object.keys(fromBase.tables));
  for (const table of Object.keys(fromBase.tables)) {
    // Rows only one side holds, so a failure names them instead of a truncated array.
    const seededRows = seeded.tables[table];
    const baseRows = fromBase.tables[table];
    const onlySeeded = seededRows.filter((row) => !baseRows.includes(row));
    const onlyFromBase = baseRows.filter((row) => !seededRows.includes(row));
    expect(JSON.stringify({ table, onlySeeded, onlyFromBase }, null, 1)).toBe(
      JSON.stringify({ table, onlySeeded: [], onlyFromBase: [] }, null, 1),
    );
    expect(seededRows, table).toEqual(baseRows);
  }
  expect(seeded.cycles).toEqual(fromBase.cycles);
  expect([...seeded.metrics.keys()].sort()).toEqual([...fromBase.metrics.keys()].sort());
  for (const [key, expected] of fromBase.metrics) {
    const actual = seeded.metrics.get(key);
    expect(actual?.rest, key).toBe(expected.rest);
    expect(Math.abs((actual?.pageRank ?? Number.NaN) - expected.pageRank), key).toBeLessThanOrEqual(PAGE_RANK_EPSILON);
  }
}

/**
 * The chain: S0 is a first tree state built from the base; each later step
 * applies one edit class to the tree and builds S(n) both ways.
 */
const STEPS: {
  name: string;
  edit: (fixture: TreeGraphFixture) => void;
  /** `true`: the seed is used; a pattern: the seed is rejected for a reason matching it. */
  seed: true | RegExp;
}[] = [
  {
    name: "modify a file already changed in the seed",
    edit: (f) => {
      f.writeTree("src/m.ts", mFile("k() + 2"));
    },
    seed: true,
  },
  {
    name: "modify a file the seed held at base content",
    edit: (f) => {
      f.writeTree("src/k.ts", `${fn("k", "7")}\nexport function k2(): number {\n  return 8;\n}\n`);
    },
    seed: true,
  },
  {
    name: "remove a function a delta file the edit leaves alone calls",
    edit: (f) => {
      f.writeTree("src/v.ts", fn("vv", "m() + 1", `import { m } from "./m";\n\n`));
    },
    seed: true,
  },
  {
    name: "revert a file to base content (rejected: only the base build keeps its base rows)",
    edit: (f) => {
      f.writeTree("src/v.ts", BASE_FILES["src/v.ts"]);
    },
    seed: /back at base content/,
  },
  {
    name: "remove a function a file outside the delta calls",
    edit: (f) => {
      f.writeTree("src/m.ts", mFile("k() + 2", false));
    },
    seed: true,
  },
  {
    name: "restore a function a file outside the delta calls (rejected: the seed pruned that edge)",
    edit: (f) => {
      f.writeTree("src/m.ts", mFile("k() + 2"));
    },
    seed: /reappears on a file the seed changed/,
  },
  {
    name: "delete a file",
    edit: (f) => {
      f.removeTree("src/b.ts");
    },
    seed: true,
  },
  {
    name: "re-add a previously deleted file with new content",
    edit: (f) => {
      f.writeTree("src/lonely.ts", fn("lonely", "33"));
    },
    seed: true,
  },
  {
    name: "re-add with new content a deleted file a file outside the delta calls (rejected: the seed pruned that edge)",
    edit: (f) => {
      f.writeTree("src/d.ts", fn("doomed", "k() + 1", `import { k } from "./k";\n\n`));
    },
    seed: /deleted in the seed's tree, is back/,
  },
  {
    name: "revert a re-added file to base content (rejected: only the base build keeps its base rows)",
    edit: (f) => {
      f.writeTree("src/d.ts", BASE_FILES["src/d.ts"]);
    },
    seed: /back at base content/,
  },
  {
    name: "add a brand-new file",
    edit: (f) => {
      f.writeTree("src/w.ts", fn("w", "k2() + n()", `import { k2 } from "./k";\nimport { n } from "./n";\n\n`));
    },
    seed: true,
  },
  {
    name: "delete a newly added file",
    edit: (f) => {
      f.removeTree("src/n.ts");
    },
    seed: true,
  },
  {
    name: "delete a newly added file a file outside the delta imports (rejected: the base build never pruned it)",
    edit: (f) => {
      f.removeTree("src/ghost.ts");
    },
    seed: /added by the seed's tree, is deleted/,
  },
  {
    name: "rename a file",
    edit: (f) => {
      f.removeTree("src/r-new.ts");
      f.writeTree("src/r-newer.ts", fn("renamed", "4"));
      f.writeTree("src/rc.ts", fn("callRenamed", "renamed()", `import { renamed } from "./r-newer";\n\n`));
    },
    seed: true,
  },
  {
    name: "add an implementer the unchanged caller's cone gains",
    edit: (f) => {
      f.writeTree("src/c.ts", implementer("C"));
    },
    seed: true,
  },
  {
    name: "an implementer drops the member the cone pins",
    edit: (f) => {
      f.writeTree("src/a.ts", implementer("A").replace("implements Closer", "").replace("close()", "shut()"));
    },
    seed: true,
  },
  {
    name: "the cone's caller becomes a delta file, then an implementer the edit leaves alone moves",
    edit: (f) => {
      f.writeTree(
        "src/api.ts",
        `${BASE_FILES["src/api.ts"]}\nexport function drainTwice(c: Closer): void {\n  c.close();\n  c.close();\n}\n`,
      );
      f.writeTree("src/c.ts", `${implementer("C")}\nexport function extra(): number {\n  return 1;\n}\n`);
    },
    seed: true,
  },
];

describe("seeded tree build ≡ build from the base", () => {
  let fixture: TreeGraphFixture;
  const results: {
    name: string;
    seeded: SemanticGraph;
    fromBase: SemanticGraph;
    walked: number;
    usedSeed: boolean;
    rejection: string | undefined;
  }[] = [];

  beforeAll(async () => {
    fixture = await buildTreeGraphFixture(BASE_FILES);
    // S0: a delta that touches every edit class's ground — modified, deleted,
    // added, renamed, and a file that a later step reverts.
    fixture.writeTree("src/m.ts", mFile("k() + 1"));
    fixture.writeTree("src/v.ts", fn("v", "m() + 1", `import { m } from "./m";\n\n`));
    fixture.removeTree("src/d.ts");
    fixture.removeTree("src/lonely.ts");
    fixture.writeTree("src/ghost.ts", fn("ghost", "5"));
    fixture.writeTree("src/u.ts", fn("u", "v()", `import { v } from "./v";\n\n`));
    fixture.writeTree("src/n.ts", fn("n", "m()", `import { m } from "./m";\n\n`));
    // Calls a function no file declares yet; a later step adds it.
    fixture.writeTree("src/early.ts", fn("early", "k2()", `import { k2 } from "./k";\n\n`));
    fixture.removeTree("src/r-old.ts");
    fixture.writeTree("src/r-new.ts", fn("renamed", "4"));
    fixture.writeTree("src/rc.ts", fn("callRenamed", "renamed()", `import { renamed } from "./r-new";\n\n`));
    let seedDelta = deltaOf(fixture);
    let seed = await build(fixture, fixture.snapshotPath, Object.keys(seedDelta.changed).sort(), [
      ...seedDelta.deleted,
    ]);

    for (const step of STEPS) {
      step.edit(fixture);
      const current = deltaOf(fixture);
      const fromBase = await build(fixture, fixture.snapshotPath, Object.keys(current.changed).sort(), [
        ...current.deleted,
      ]);
      const seedInput = await treeGraphSeedOf(seed.dbPath, seedDelta, current, async (relPath) => {
        try {
          return statSync(join(fixture.treeRoot, relPath)).isFile();
        } catch {
          return false;
        }
      });
      const seeded = await build(
        fixture,
        fixture.snapshotPath,
        Object.keys(current.changed).sort(),
        [...current.deleted],
        seedInput,
      );
      results.push({
        name: step.name,
        seeded: await semanticGraph(seeded.dbPath),
        fromBase: await semanticGraph(fromBase.dbPath),
        walked: seeded.walkedFileCount,
        usedSeed: seeded.seeded === true,
        rejection: seeded.seedRejection,
      });
      seed = seeded;
      seedDelta = current;
    }
  }, 300_000);

  it.each(STEPS.map((step) => [step.name, step] as const))("%s", (name, step) => {
    const result = results.find((entry) => entry.name === name);
    if (!result) throw new Error(`step ${name} did not run`);
    expectEquivalent(result.seeded, result.fromBase);
    if (step.seed === true) {
      expect(result.rejection).toBeUndefined();
      expect(result.usedSeed).toBe(true);
    } else {
      expect(result.usedSeed).toBe(false);
      expect(result.rejection).toMatch(step.seed);
    }
  });

  it("an incremental step walks the edit and the delta files that reference it, not the tree's whole delta", () => {
    const modifyOnce = results.find((entry) => entry.name === "modify a file already changed in the seed");
    // m.ts, plus v.ts and n.ts: delta files whose imports and calls point into it.
    expect(modifyOnce?.walked).toBe(3);
  });
});
