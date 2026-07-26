import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

// G2 (bd tea-rags-mcp-6vfrj) — the provider carries FOUR distinct run-reset
// seams that clear overlapping but NOT identical field sets: `getRunMetrics`
// (read-and-clear, two branches), `beginExtractionRun` (cross-pass run start),
// `clearRunState` (post-finalize), and `onRelease` (worker eviction). The
// collaborator split relocates all of them into `CodegraphRunState`, so pin the
// observable contract of each seam FIRST — these tests are the safety net the
// relocation runs against, not a specification of new behavior.
describe("CodegraphEnrichmentProvider — run-reset seams (G2 characterization)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  const makeRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "cg-reset-seams-"));
    mkdirSync(join(root, "src"), { recursive: true });
    // Foo.bar resolves (constant receiver, target in the symbol table);
    // Mystery.nope does not — one attempted-and-resolved, one attempted-only.
    writeFileSync(join(root, "src", "foo.ts"), "export class Foo {\n  static bar(): number { return 1; }\n}\n");
    writeFileSync(
      join(root, "src", "main.ts"),
      'import { Foo } from "./foo.js";\nexport function main(): void {\n  Foo.bar();\n  Mystery.nope();\n}\n',
    );
    return root;
  };

  const runOnce = async (root: string): Promise<void> => {
    await provider.streamFileBatch(root, ["src/foo.ts"]);
    await provider.streamFileBatch(root, ["src/main.ts"]);
    await provider.finalizeSignals(root);
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-prov-reset-seams-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  // Seam 1 — `getRunMetrics` empty-run branch (provider.ts: the
  // extractedFiles/fileEdgeCount/methodEdgeCount all-zero guard). Returns
  // undefined AND performs the wide reset, so calling it repeatedly on an idle
  // provider is a no-op rather than an accumulating one.
  it("reports an empty run as undefined, idempotently", () => {
    expect(provider.getRunMetrics()).toBeUndefined();
    expect(provider.getRunMetrics()).toBeUndefined();
  });

  // Seam 2 — read-and-clear. CompletionRunner calls this once per enrichment
  // cycle; the SECOND read must see an empty run, otherwise a cached provider
  // on the daemon double-reports the same counts to EnrichmentMetrics.
  it("drains run metrics: the second read after a real run reports an empty run", async () => {
    const root = makeRoot();
    try {
      await runOnce(root);

      const first = provider.getRunMetrics();
      expect(first).toBeDefined();
      expect(first?.extractedFiles).toBe(2);
      expect(first?.callsResolved).toBeGreaterThan(0);

      expect(provider.getRunMetrics()).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Seam 3 — `finalizeSignals` runs `clearRunState`, which clears the
  // run-global resolution inputs but deliberately does NOT touch the resolve
  // tally: `getRunMetrics` owns read-and-clear. A finalize that ate the tally
  // would blank `EnrichmentMetrics.byProvider["codegraph.symbols"]`.
  it("keeps the resolve tally readable after finalizeSignals cleared run state", async () => {
    const root = makeRoot();
    try {
      await runOnce(root);

      const metrics = provider.getRunMetrics();
      expect(metrics?.extractedFiles).toBe(2);
      expect(metrics?.methodEdgeCount).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Seam 4 — `beginExtractionRun` is the cross-pass run-START zero seam (bd
  // tea-rags-mcp-svhqp). It bypasses `ensureRunSink`, so unless it zeroes the
  // tally itself, a prior run whose `getRunMetrics` never fired leaks its
  // counts into the next run and jitters resolveSuccessRate run-to-run.
  it("zeroes a prior run's tally at cross-pass run start", async () => {
    const root = makeRoot();
    try {
      // First run leaves a populated tally behind — getRunMetrics is NOT called.
      await runOnce(root);

      provider.beginExtractionRun();
      // A cross-pass run with nothing fed drains no files: the tally the first
      // run left behind must be gone, so this reads as an empty run.
      expect(provider.getRunMetrics()).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Seam 5 — `onRelease` (worker-pool collection eviction). Clears the
  // run-global maps AND the sink-lifecycle maps, but deliberately NOT the
  // resolve tally: `getRunMetrics` remains the only read-and-clear owner, so a
  // release that lands before the completion-runner's read still reports the
  // finished run's counts. Asymmetric with `beginExtractionRun`, which DOES
  // zero the tally — that asymmetry is current behavior and is pinned here so
  // the G2 relocation cannot change it silently.
  it("clears run state on release while leaving the finished run's tally readable", async () => {
    const root = makeRoot();
    try {
      await runOnce(root);
      await provider.onRelease();

      // Tally survives release — the completion-runner can still read it.
      expect(provider.getRunMetrics()?.extractedFiles).toBe(2);
      // ...and that read drained it.
      expect(provider.getRunMetrics()).toBeUndefined();

      // The released instance still serves a fresh run correctly.
      await runOnce(root);
      expect(provider.getRunMetrics()?.extractedFiles).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Cross-seam invariant: run-global aggregates (ancestors, return types,
  // dispatch tables, hierarchy view) are per-run, so a second run over the same
  // sources reproduces the FIRST run's numbers exactly. Any residue from run 1
  // that survived into run 2 would show up as a different edge count.
  it("reproduces identical metrics across two consecutive runs on one instance", async () => {
    const root = makeRoot();
    try {
      await runOnce(root);
      const first = provider.getRunMetrics();

      await runOnce(root);
      const second = provider.getRunMetrics();

      expect(second?.extractedFiles).toBe(first?.extractedFiles);
      expect(second?.fileEdgeCount).toBe(first?.fileEdgeCount);
      expect(second?.methodEdgeCount).toBe(first?.methodEdgeCount);
      expect(second?.callsResolved).toBe(first?.callsResolved);
      expect(second?.resolveSuccessRate).toBe(first?.resolveSuccessRate);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
