import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

// bd tea-rags-mcp-2jet-D — the provider already tallies the per-receiver-kind
// breakdown (j431) but nothing flushed it to `cg_run_stats`. finalizeSignals
// must persist `runStats.byReceiverKind` via `graphDb.recordRunStats` so the
// daemon-readable proxy surfaces each cai0 slice's per-bucket delta.
describe("CodegraphEnrichmentProvider — run-stats persistence (2jet-D)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  const makeRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "cg-runstats-"));
    mkdirSync(join(root, "src"), { recursive: true });
    // Foo.bar resolves (constant receiver, target in symbol table); Mystery.nope
    // does not resolve → both land in the `constant` bucket, 1 of 2 resolved.
    writeFileSync(join(root, "src", "foo.ts"), "export class Foo {\n  static bar(): number { return 1; }\n}\n");
    writeFileSync(
      join(root, "src", "main.ts"),
      'import { Foo } from "./foo.js";\nexport function main(): void {\n  Foo.bar();\n  Mystery.nope();\n}\n',
    );
    return root;
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-prov-runstats-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
      composer: new DefaultSymbolIdComposer(),
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("finalizeSignals flushes the per-receiver-kind breakdown via recordRunStats", async () => {
    const root = makeRoot();
    const spy = vi.spyOn(client, "recordRunStats");
    try {
      await provider.streamFileBatch(root, ["src/foo.ts"]);
      await provider.streamFileBatch(root, ["src/main.ts"]);
      await provider.finalizeSignals(root);

      expect(spy).toHaveBeenCalledTimes(1);
      const rows = spy.mock.calls[0][0];
      // One row per receiver kind the provider tallies (j431 RECEIVER_KINDS).
      const byKind = new Map(rows.map((r) => [r.receiverKind, r]));
      expect(byKind.get("constant")).toMatchObject({ attempted: 2, resolved: 1 });
      expect(byKind.has("dynamic")).toBe(true);
      // Every row carries the {receiverKind, attempted, resolved} shape.
      for (const r of rows) {
        expect(r).toHaveProperty("receiverKind");
        expect(typeof r.attempted).toBe("number");
        expect(typeof r.resolved).toBe("number");
      }
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persisted run-stats are readable back through getRunStats (overwrite semantics)", async () => {
    const root = makeRoot();
    try {
      await provider.streamFileBatch(root, ["src/foo.ts"]);
      await provider.streamFileBatch(root, ["src/main.ts"]);
      await provider.finalizeSignals(root);

      const persisted = await client.getRunStats();
      const constant = persisted.find((r) => r.receiverKind === "constant");
      expect(constant).toMatchObject({ attempted: 2, resolved: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // bd tea-rags-mcp-svhqp — runStats is a single mutable instance field reset
  // ONLY by getRunMetrics (read-and-clear, driven by the completion-runner),
  // never by the per-run cleanup paths (clearRunState / onRelease). On the
  // long-lived daemon the provider is cached per (collection, worker) and
  // reused for the next reindex, so the prior run's tally LEAKS into the next
  // run's recordRunStats → callsAttempted jitters run-to-run (huginn observed
  // 12299 <-> 16616). A second full cycle on the same instance must persist
  // ONLY the second run's counts, not the accumulation.
  it("resets run-stats at run START so a re-run on a cached provider does not accumulate (svhqp)", async () => {
    const root = makeRoot();
    try {
      await provider.streamFileBatch(root, ["src/foo.ts"]);
      await provider.streamFileBatch(root, ["src/main.ts"]);
      await provider.finalizeSignals(root);
      const after1 = (await client.getRunStats()).find((r) => r.receiverKind === "constant");
      expect(after1).toMatchObject({ attempted: 2, resolved: 1 });

      // Second reindex on the SAME provider instance — getRunMetrics is NOT
      // called between runs (mirrors a daemon worker whose completion-runner
      // hasn't fired, or fired after the deferred chunk pass). Without a
      // run-start reset the persisted breakdown doubles to attempted: 4.
      await provider.streamFileBatch(root, ["src/foo.ts"]);
      await provider.streamFileBatch(root, ["src/main.ts"]);
      await provider.finalizeSignals(root);
      const after2 = (await client.getRunStats()).find((r) => r.receiverKind === "constant");
      expect(after2).toMatchObject({ attempted: 2, resolved: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // bd tea-rags-mcp-svhqp (residual) — `file-phase` dedups relPaths WITHIN a
  // batch (uniqueRelPaths) but NOT across batches: a file whose chunks span
  // several streamed batches reaches streamFileBatch more than once. Without a
  // cross-batch guard the file is extracted + spilled each time and its calls
  // are tallied per spill, so callsAttempted jitters ±3% run-to-run with batch
  // composition. The provider must extract each file ONCE per run.
  it("does not double-count a file re-delivered across batches in one run (svhqp residual)", async () => {
    const root = makeRoot();
    try {
      await provider.streamFileBatch(root, ["src/foo.ts"]);
      await provider.streamFileBatch(root, ["src/main.ts"]);
      // Same file again in a later batch (its chunks spanned batches).
      await provider.streamFileBatch(root, ["src/main.ts"]);
      await provider.finalizeSignals(root);
      const constant = (await client.getRunStats()).find((r) => r.receiverKind === "constant");
      // main.ts has 2 constant-receiver calls (Foo.bar resolved, Mystery.nope
      // not). Counted ONCE, not doubled to attempted: 4.
      expect(constant).toMatchObject({ attempted: 2, resolved: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // tea-rags-mcp-ykj7 — an external-library call is tallied per receiver-kind
  // as externalSkipped and persisted to cg_run_stats.external_skipped, so the
  // daemon-readable breakdown shows WHY the denominator shrank.
  it("persists per-receiver-kind externalSkipped for external-library calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-runstats-ext-"));
    mkdirSync(join(root, "src"), { recursive: true });
    // `Math.max` — ECMAScript ambient global → external; `Math` matches the
    // constant receiver-kind, so the constant bucket carries externalSkipped=1.
    writeFileSync(join(root, "src", "calc.ts"), "export function run(): number {\n  return Math.max(1, 2);\n}\n");
    try {
      await provider.streamFileBatch(root, ["src/calc.ts"]);
      await provider.finalizeSignals(root);

      const persisted = await client.getRunStats();
      const constant = persisted.find((r) => r.receiverKind === "constant");
      expect(constant).toMatchObject({ attempted: 1, resolved: 0, externalSkipped: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
