/**
 * Full == incremental for the CHA cone (bd tea-rags-mcp-7t2ee, owner invariant
 * of bd tea-rags-mcp-39xca.14: the edge set is identical for a full and an
 * incremental run).
 *
 * A call site's cone is a function of the WHOLE hierarchy: `drain(c: Closer)`
 * fans `c.close()` out to every implementer of `Closer`, nominal or structural.
 * Edges are reconciled per SOURCE file, so a caller whose own file did not
 * change was never revisited when an implementer appeared, disappeared, or
 * changed its members elsewhere — its cone stayed whatever the run that last
 * walked it saw.
 *
 * Every case builds the same end state twice: once incrementally from an
 * earlier state, once as a fresh full index over the final tree, and demands
 * the two graphs agree on `drain`'s callees. Driven through the REAL write path
 * (`CodegraphEnrichmentProvider` over an in-process DuckDB with every migration
 * applied, walking real TypeScript source) with content hashes stamped the way
 * the ingest pipeline stamps them, so the drift repair re-walks only what
 * actually changed.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});

const COLLECTION = "code_cone_inval_v1" as never;

// ─── Fixture ────────────────────────────────────────────────────────────────

const API = "src/api.ts";
const A = "src/a.ts";
const B = "src/b.ts";
const C = "src/c.ts";
const UNRELATED = "src/unrelated.ts";

const API_SRC = `export interface Closer {
  close(): void;
}

export function drain(c: Closer): void {
  c.close();
}
`;

const A_SRC = `import type { Closer } from "./api";

export class A implements Closer {
  close(): void {
    console.log("a");
  }
}
`;

const B_SRC = `import type { Closer } from "./api";

export class B implements Closer {
  close(): void {
    console.log("b");
  }
}
`;

// B keeps the class but stops being an implementer: no clause, no member.
const B_NOT_A_CLOSER = `export class B {
  open(): void {
    console.log("b");
  }
}
`;

// Structural: satisfies Closer without an \`implements\` clause.
const C_SRC = `export class C {
  close(): void {
    console.log("c");
  }
}
`;

const UNRELATED_SRC = `export function unrelated(): number {
  return 1;
}
`;

// ─── Harness ────────────────────────────────────────────────────────────────

interface Project {
  root: string;
  client: DuckDbGraphClient;
  provider: CodegraphEnrichmentProvider;
  write: (relPath: string, source: string) => void;
  remove: (relPath: string) => void;
  /**
   * One incremental reindex the way `ReindexPipeline#reindexChanges` drives the
   * codegraph provider: the drift repair over the scanned tree (prunes orphans,
   * re-walks drifted files), then the changed files through the run sink, then
   * the finalize. Returns the files the run's pass-2 resolved.
   */
  reindex: (changed: string[]) => Promise<number | undefined>;
}

function sha(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function openClient(): Promise<DuckDbGraphClient> {
  const dbDir = mkdtempSync(join(tmpdir(), "cg-cone-inval-db-"));
  cleanups.push(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });
  const client = new DuckDbGraphClient({ path: join(dbDir, "g.duckdb") });
  await client.init();
  await runMigrations(client, DATABASE_MIGRATIONS);
  cleanups.push(async () => client.close());
  return client;
}

async function makeProject(files: Record<string, string>): Promise<Project> {
  const root = mkdtempSync(join(tmpdir(), "cg-cone-inval-src-"));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const present = new Set<string>();
  const write = (relPath: string, source: string): void => {
    mkdirSync(dirname(join(root, relPath)), { recursive: true });
    writeFileSync(join(root, relPath), source);
    present.add(relPath);
  };
  for (const [rel, src] of Object.entries(files)) write(rel, src);
  const client = await openClient();
  const provider = new CodegraphEnrichmentProvider({
    graphDb: client,
    symbolTable: new InMemoryGlobalSymbolTable(),
    ...buildTestCodegraphDeps(),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
  });
  const scannedHashes = (): Map<string, string> =>
    new Map([...present].map((rel) => [rel, sha(readFileSync(join(root, rel), "utf8"))]));
  return {
    root,
    client,
    provider,
    write,
    remove: (relPath) => {
      unlinkSync(join(root, relPath));
      present.delete(relPath);
    },
    reindex: async (changed) => {
      const contentHashes = scannedHashes();
      const coordinator = new EnrichmentCoordinator({} as never, provider, undefined, new InlineEnrichmentExecutor());
      await coordinator.runRepairPass(COLLECTION, root, contentHashes);
      if (changed.length > 0) {
        await provider.streamFileBatch(root, changed, { collectionName: COLLECTION, contentHashes });
      }
      await provider.finalizeSignals(root, { collectionName: COLLECTION, contentHashes });
      return provider.getRunMetrics()?.extractedFiles;
    },
  };
}

/** A fresh full index over `files` — the reference an incremental run must reproduce. */
async function fullIndex(files: Record<string, string>): Promise<Project> {
  const project = await makeProject(files);
  await project.reindex(Object.keys(files));
  return project;
}

/** `drain`'s persisted callees as `target@confidence`, sorted. */
async function drainCallees(client: DuckDbGraphClient, callerRelPath = API): Promise<string[]> {
  const rows = await client.queryAll<{ target: string | null; confidence: number }>(
    `SELECT target_symbol_id AS target, confidence FROM cg_symbols_edges_method
      WHERE source_rel_path = ? AND source_symbol_id = 'drain'`,
    [callerRelPath],
  );
  return rows.map((r) => `${r.target ?? "<file>"}@${Number(r.confidence).toFixed(3)}`).sort();
}

describe("incremental CHA cone == full (bd tea-rags-mcp-7t2ee)", () => {
  it("adding a nominal implementer re-resolves the unchanged caller", async () => {
    const project = await makeProject({ [API]: API_SRC, [A]: A_SRC });
    await project.reindex([API, A]);
    expect(await drainCallees(project.client)).toEqual(["A#close@1.000"]);

    project.write(B, B_SRC);
    await project.reindex([B]);

    const reference = await fullIndex({ [API]: API_SRC, [A]: A_SRC, [B]: B_SRC });
    expect(await drainCallees(reference.client)).toEqual(["A#close@0.500", "B#close@0.500"]);
    expect(await drainCallees(project.client)).toEqual(await drainCallees(reference.client));
  });

  it("adding a STRUCTURAL implementer re-resolves the unchanged caller", async () => {
    const project = await makeProject({ [API]: API_SRC, [A]: A_SRC });
    await project.reindex([API, A]);

    project.write(B, B_SRC);
    project.write(C, C_SRC);
    await project.reindex([B, C]);

    const reference = await fullIndex({ [API]: API_SRC, [A]: A_SRC, [B]: B_SRC, [C]: C_SRC });
    expect(await drainCallees(reference.client)).toEqual(["A#close@0.333", "B#close@0.333", "C#close@0.333"]);
    expect(await drainCallees(project.client)).toEqual(await drainCallees(reference.client));
  });

  it("deleting an implementer's file re-resolves the unchanged caller (deletion-only run)", async () => {
    const project = await makeProject({ [API]: API_SRC, [A]: A_SRC, [B]: B_SRC, [C]: C_SRC });
    await project.reindex([API, A, B, C]);

    project.remove(C);
    await project.reindex([]);

    const reference = await fullIndex({ [API]: API_SRC, [A]: A_SRC, [B]: B_SRC });
    expect(await drainCallees(project.client)).toEqual(await drainCallees(reference.client));
  });

  it("an implementer that stops implementing re-resolves the unchanged caller", async () => {
    const project = await makeProject({ [API]: API_SRC, [A]: A_SRC, [B]: B_SRC });
    await project.reindex([API, A, B]);

    project.write(B, B_NOT_A_CLOSER);
    await project.reindex([B]);

    const reference = await fullIndex({ [API]: API_SRC, [A]: A_SRC, [B]: B_NOT_A_CLOSER });
    expect(await drainCallees(reference.client)).toEqual(["A#close@1.000"]);
    expect(await drainCallees(project.client)).toEqual(await drainCallees(reference.client));
  });

  it("a change outside every recorded cone re-resolves nothing but the changed file", async () => {
    const project = await makeProject({ [API]: API_SRC, [A]: A_SRC, [B]: B_SRC, [UNRELATED]: UNRELATED_SRC });
    await project.reindex([API, A, B, UNRELATED]);

    project.write(UNRELATED, `${UNRELATED_SRC}\nexport const more = 2;\n`);
    const extracted = await project.reindex([UNRELATED]);

    expect(extracted).toBe(1);
    expect(await drainCallees(project.client)).toEqual(["A#close@0.500", "B#close@0.500"]);
  });
});

// ─── Python: the same invariant through the language-neutral cone ─────────────

const PY_API = "pkg/api.py";
const PY_A = "pkg/a.py";
const PY_B = "pkg/b.py";
const PY_C = "pkg/c.py";

const PY_API_SRC = `from typing import Protocol


class Closer(Protocol):
    def close(self) -> None: ...


def drain(c: Closer) -> None:
    c.close()
`;

const PY_A_SRC = `from pkg.api import Closer


class A(Closer):
    def close(self) -> None:
        print("a")
`;

const PY_B_SRC = `from pkg.api import Closer


class B(Closer):
    def close(self) -> None:
        print("b")
`;

// Structural: satisfies the Protocol without subclassing it.
const PY_C_SRC = `class C:
    def close(self) -> None:
        print("c")
`;

describe("incremental CHA cone == full, Python (bd tea-rags-mcp-7t2ee)", () => {
  it("adding a nominal and a structural implementer re-resolves the unchanged caller", async () => {
    const project = await makeProject({ [PY_API]: PY_API_SRC, [PY_A]: PY_A_SRC });
    await project.reindex([PY_API, PY_A]);

    project.write(PY_B, PY_B_SRC);
    project.write(PY_C, PY_C_SRC);
    await project.reindex([PY_B, PY_C]);

    const reference = await fullIndex({ [PY_API]: PY_API_SRC, [PY_A]: PY_A_SRC, [PY_B]: PY_B_SRC, [PY_C]: PY_C_SRC });
    expect((await drainCallees(reference.client, PY_API)).length).toBeGreaterThan(1);
    expect(await drainCallees(project.client, PY_API)).toEqual(await drainCallees(reference.client, PY_API));
  });

  it("deleting an implementer's file re-resolves the unchanged caller", async () => {
    const project = await makeProject({ [PY_API]: PY_API_SRC, [PY_A]: PY_A_SRC, [PY_B]: PY_B_SRC });
    await project.reindex([PY_API, PY_A, PY_B]);

    project.remove(PY_B);
    await project.reindex([]);

    const reference = await fullIndex({ [PY_API]: PY_API_SRC, [PY_A]: PY_A_SRC });
    expect(await drainCallees(project.client, PY_API)).toEqual(await drainCallees(reference.client, PY_API));
  });
});
