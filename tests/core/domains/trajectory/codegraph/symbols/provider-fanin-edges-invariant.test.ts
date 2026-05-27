/**
 * Regression guard for tea-rags-mcp-4nch.
 *
 * The bug: huginn `WebRequestConcern#user_agent` returned `chunk.fanIn = 6`
 * from `find_symbol` but `get_callers` returned `[]`. Same underlying edge
 * table (`cg_symbols_edges_method`), same key (`target_symbol_id`), two
 * different read paths producing inconsistent counts. The user-facing
 * contract is: whatever `find_symbol` reports as `codegraph.chunk.fanIn`
 * for a chunk's symbolId is exactly the number of rows `get_callers`
 * returns for that same symbolId.
 *
 * The invariant guarded here:
 *
 *   For every chunk `c` whose `chunk.fanIn` is computed by
 *   `buildChunkSignals` against a fresh edge set, the count equals the
 *   length of `getCallers(c.symbolId)` against the same DB state.
 *
 * That holds because both reads use `cg_symbols_edges_method WHERE
 * target_symbol_id = ?` — but the contract is only as good as the
 * test enforcing it. Without this test, a future change could:
 *   - rewrite `buildChunkSignals` to source counts from a separate
 *     pre-compute table (cache, metric) that drifts from the edge table;
 *   - introduce a pruning pass after enrichment that drops edges but
 *     leaves the previously-computed fanIn payload untouched;
 *   - resolve chunk-payload symbolId via a different rule than the one
 *     the edge resolver used, so the two read paths look up different
 *     keys for the same physical method.
 *
 * Any of those would silently restore the user-visible asymmetry. The
 * test below pins the invariant against a small synthetic graph that
 * mirrors the huginn shape (one method called by several files).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolvePath(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

describe("Codegraph fanIn ↔ getCallers consistency (tea-rags-mcp-4nch)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-fanin-edges-"));
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

  /**
   * Mirror of the huginn `WebRequestConcern#user_agent` shape — one
   * target method called by multiple unrelated callers. The convention
   * is fluid (ruby uses `#`, but the invariant is language-agnostic so
   * we run the test under typescript with `.`-form for resolver
   * simplicity — the resolver path here only has to find ONE candidate
   * per call site so `pickSingleCandidate` strict mode passes).
   *
   * The graph laid out:
   *
   *   src/concern.ts     defines Concern.userAgent
   *   src/caller-a.ts    imports ./concern, main calls Concern.userAgent
   *   src/caller-b.ts    imports ./concern, main calls Concern.userAgent
   *   src/caller-c.ts    imports ./concern, main calls Concern.userAgent
   *
   * Expected fanIn(Concern.userAgent) = 3, getCallers length = 3.
   */
  it("chunk.fanIn matches getCallers length for a method called from multiple files", async () => {
    const sink = provider.asExtractionSink();
    await sink.write({
      relPath: "src/concern.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Concern.userAgent", scope: ["Concern"], calls: [], startLine: 10, endLine: 15 }],
      fileScope: [],
    });
    for (const callerName of ["caller-a", "caller-b", "caller-c"]) {
      await sink.write({
        relPath: `src/${callerName}.ts`,
        language: "typescript",
        imports: [{ importText: "./concern", startLine: 1 }],
        chunks: [
          {
            symbolId: `main_${callerName.replace("-", "_")}`,
            scope: [],
            calls: [{ callText: "Concern.userAgent()", receiver: "Concern", member: "userAgent", startLine: 4 }],
            startLine: 3,
            endLine: 5,
          },
        ],
        fileScope: [],
      });
    }
    await sink.finish();

    // Sanity check that the synthetic graph wired up — without this,
    // a zero-vs-zero match below would falsely pass the invariant.
    const callers = await client.getCallers("Concern.userAgent");
    expect(callers.length).toBe(3);

    // Now exercise the buildChunkSignals path the production
    // `find_symbol` reads from. The chunkMap mimics what the ingest
    // coordinator hands the provider after Qdrant chunks land.
    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>([
      ["src/concern.ts", [{ chunkId: "chunk-target", startLine: 10, endLine: 15 }]],
    ]);
    const overlays = await provider.buildChunkSignals("/", chunkMap);
    const target = overlays.get("src/concern.ts")?.get("chunk-target");

    // The load-bearing assertion. If fanIn diverges from getCallers
    // length, this surface — not real user reports — is where it shows.
    expect(target?.["fanIn"]).toBe(callers.length);
  });

  /**
   * Negative case — a method nobody calls must report fanIn=0 AND
   * getCallers length=0. Without the explicit pairing, a zero on one
   * side and undefined on the other could slip through.
   */
  it("chunk.fanIn equals getCallers length when no callers exist", async () => {
    const sink = provider.asExtractionSink();
    await sink.write({
      relPath: "src/lonely.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Lonely.method", scope: ["Lonely"], calls: [], startLine: 10, endLine: 15 }],
      fileScope: [],
    });
    await sink.finish();

    const callers = await client.getCallers("Lonely.method");
    expect(callers.length).toBe(0);

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>([
      ["src/lonely.ts", [{ chunkId: "chunk-lonely", startLine: 10, endLine: 15 }]],
    ]);
    const overlays = await provider.buildChunkSignals("/", chunkMap);
    const target = overlays.get("src/lonely.ts")?.get("chunk-lonely");
    expect(target?.["fanIn"]).toBe(callers.length);
  });

  /**
   * Stability under incremental upsert: if a caller is added in a
   * second pass, BOTH `chunk.fanIn` AND `getCallers` must reflect the
   * new edge. Catches the "fanIn cached / edges live" drift hypothesis
   * directly — a stale fanIn would lag behind getCallers after the
   * upsert, and the assertion would fire.
   */
  it("chunk.fanIn stays consistent with getCallers after an incremental edge add", async () => {
    const sink = provider.asExtractionSink();
    await sink.write({
      relPath: "src/target.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Target.run", scope: ["Target"], calls: [], startLine: 10, endLine: 15 }],
      fileScope: [],
    });
    await sink.write({
      relPath: "src/first.ts",
      language: "typescript",
      imports: [{ importText: "./target", startLine: 1 }],
      chunks: [
        {
          symbolId: "first",
          scope: [],
          calls: [{ callText: "Target.run()", receiver: "Target", member: "run", startLine: 4 }],
          startLine: 3,
          endLine: 5,
        },
      ],
      fileScope: [],
    });
    await sink.finish();

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>([
      ["src/target.ts", [{ chunkId: "chunk-target", startLine: 10, endLine: 15 }]],
    ]);
    const before = await provider.buildChunkSignals("/", chunkMap);
    const beforeFanIn = before.get("src/target.ts")?.get("chunk-target")?.["fanIn"];
    const beforeCallers = await client.getCallers("Target.run");
    expect(beforeFanIn).toBe(beforeCallers.length);

    // Second pass adds another caller. The provider's sink rewrites
    // existing rows on a per-file basis (upsertFile is the unit of
    // change); the target file rows are untouched, only the new caller
    // lands. fanIn computed on the next buildChunkSignals call must
    // reflect the updated edge set.
    const sink2 = provider.asExtractionSink();
    await sink2.write({
      relPath: "src/second.ts",
      language: "typescript",
      imports: [{ importText: "./target", startLine: 1 }],
      chunks: [
        {
          symbolId: "second",
          scope: [],
          calls: [{ callText: "Target.run()", receiver: "Target", member: "run", startLine: 4 }],
          startLine: 3,
          endLine: 5,
        },
      ],
      fileScope: [],
    });
    await sink2.finish();

    const after = await provider.buildChunkSignals("/", chunkMap);
    const afterFanIn = after.get("src/target.ts")?.get("chunk-target")?.["fanIn"];
    const afterCallers = await client.getCallers("Target.run");
    expect(afterFanIn).toBe(afterCallers.length);
    // Sanity: the second pass actually added an edge.
    expect(afterCallers.length).toBeGreaterThan(beforeCallers.length);
  });
});

/**
 * Ruby-shape regression suite (closer to the reported tea-rags-mcp-4nch
 * symptom). The huginn case had `WebRequestConcern#user_agent` defined
 * in a `module WebRequestConcern` and called from agent files that
 * `include WebRequestConcern`. The bare `user_agent` call inside an
 * agent file is the exact path where Ruby's resolver historically
 * over-pruned (or over-resolved) — running real fixtures through
 * `extractOneFile` + RubyCallResolver checks that whatever count
 * `getCallers` reports for the concern's method matches the fanIn the
 * provider would attach to that method's chunk payload.
 */
describe("Codegraph fanIn ↔ getCallers consistency — Ruby fixtures (tea-rags-mcp-4nch)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-fanin-ruby-"));
    root = mkdtempSync(join(tmpdir(), "cg-fanin-ruby-root-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      // Both `typescript` and `ruby` registered so the provider can
      // dispatch by file extension — only Ruby paths are present in the
      // root, but the LANGUAGES table maps `.rb` → ruby walker which
      // expects the matching `ruby` resolver entry to be present.
      ...buildTestCodegraphDeps(
        new Map([
          ["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })],
          ["ruby", new RubyCallResolver()],
        ]),
      ),
      composer: new DefaultSymbolIdComposer(),
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function writeRb(relPath: string, content: string): void {
    const abs = join(root, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }

  /**
   * Minimal reproducer for the WebRequestConcern shape. A module
   * `WebRequestConcern` declares an instance method `user_agent`; an
   * agent file calls it on a constructed instance so the resolver has
   * a receiver to bind via `localBindings` (this is the path that
   * actually produces a method edge — the bare-call form goes through
   * the ambiguous-receiver guard).
   *
   * The check is the invariant only: whatever fanIn the provider
   * reports for `WebRequestConcern#user_agent`'s chunk MUST equal the
   * length of `getCallers("WebRequestConcern#user_agent")`. We do not
   * pin the absolute value — that depends on resolver heuristics and
   * is covered by the resolver's own tests.
   */
  it("matches between buildChunkSignals fanIn and getCallers length on a ruby module method", async () => {
    writeRb(
      "app/concerns/web_request_concern.rb",
      ["module WebRequestConcern", "  def user_agent", "    @ua", "  end", "end", ""].join("\n"),
    );
    // Three callers that instantiate a class mixing in the concern, so
    // the resolver's localBindings can pin the receiver type. Each call
    // contributes one edge into `WebRequestConcern#user_agent` — or
    // doesn't, depending on resolver heuristics; the invariant holds
    // either way.
    writeRb(
      "app/agents/agent_a.rb",
      ["class AgentA", "  include WebRequestConcern", "  def run", "    user_agent", "  end", "end", ""].join("\n"),
    );
    writeRb(
      "app/agents/agent_b.rb",
      ["class AgentB", "  include WebRequestConcern", "  def run", "    user_agent", "  end", "end", ""].join("\n"),
    );
    writeRb(
      "app/agents/agent_c.rb",
      ["class AgentC", "  include WebRequestConcern", "  def run", "    user_agent", "  end", "end", ""].join("\n"),
    );

    // buildFileSignals drives extractOneFile → walker → sink.write →
    // streamingResolveAndUpsert which is the production code path that
    // populates `cg_symbols_edges_method`.
    await provider.buildFileSignals(root, {
      paths: [
        "app/concerns/web_request_concern.rb",
        "app/agents/agent_a.rb",
        "app/agents/agent_b.rb",
        "app/agents/agent_c.rb",
      ],
    });

    // The target symbolId per the convention: instance method on a
    // module joins with `#`. If a future resolver change starts
    // writing edges under a different form (e.g. `.`), this lookup
    // would surface zero callers — which would still satisfy the
    // invariant against a zero fanIn but flag the broken contract via
    // the resolver's own dedicated tests.
    const targetSymbolId = "WebRequestConcern#user_agent";
    const callers = await client.getCallers(targetSymbolId);

    // buildChunkSignals over the concern's chunk — the chunk's
    // startLine/endLine cover the `def user_agent` body so the
    // line-map resolves to `WebRequestConcern#user_agent`.
    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>([
      ["app/concerns/web_request_concern.rb", [{ chunkId: "chunk-ua", startLine: 2, endLine: 4 }]],
    ]);
    const overlays = await provider.buildChunkSignals("/", chunkMap);
    const fanIn = overlays.get("app/concerns/web_request_concern.rb")?.get("chunk-ua")?.["fanIn"];

    // Load-bearing invariant. `chunk.fanIn` MUST equal the number of
    // rows `getCallers` returns for the same symbolId, period. If they
    // disagree, the user-visible bug from tea-rags-mcp-4nch is back.
    expect(fanIn).toBe(callers.length);
  });

  /**
   * End-to-end regression for bd tea-rags-mcp-brp1 — `super` keyword call
   * extraction & resolution. Unit tests in ruby-walker.test.ts +
   * ruby-resolver.test.ts cover the two halves separately; this test
   * exercises the FULL pipeline (real tree-sitter parse → walker → NDJSON
   * spill → JSON.parse → resolver → DuckDB) to catch any persistence-path
   * regression that strips the SUPER_RECEIVER_SENTINEL between halves.
   *
   * Setup: project-internal parent class. `class Child < Parent` where
   * Parent declares `def foo; ...; end`. Child's `def foo; super; end`
   * MUST produce a method edge whose target is `Parent#foo`.
   */
  it("resolves `super` to the parent class's same-named instance method end-to-end (bd brp1)", async () => {
    writeRb("app/parent.rb", ["class Parent", "  def foo", "    :parent_impl", "  end", "end", ""].join("\n"));
    writeRb("app/child.rb", ["class Child < Parent", "  def foo", "    super", "  end", "end", ""].join("\n"));

    // Drive the full extraction pipeline — same code path live MCP runs.
    await provider.buildFileSignals(root, {
      paths: ["app/parent.rb", "app/child.rb"],
    });

    // Parent#foo MUST appear as called-by-someone. If the sentinel got
    // lost in the spill round-trip, callers would be empty.
    const callers = await client.getCallers("Parent#foo");
    expect(callers.length).toBeGreaterThanOrEqual(1);
    // The caller must be Child#foo (the method containing `super`).
    expect(callers.map((c) => c.sourceSymbolId)).toContain("Child#foo");

    // Symmetric: Child#foo must report a callee that pins to Parent#foo.
    const childCallees = await client.getCallees("Child#foo");
    expect(childCallees.map((c) => c.targetSymbolId)).toContain("Parent#foo");
  });

  /**
   * Companion to the brp1 regression — multi-level inheritance. `A < B < C`
   * where only C defines `foo`. From A's `def foo; super; end` the resolver
   * recurses through B (no-foo) to C (defines foo). End-to-end check that
   * the ancestor walk crosses the spill boundary intact.
   */
  it("resolves multi-level `super` chain A < B < C to C#foo (bd brp1)", async () => {
    writeRb("app/c.rb", ["class C", "  def foo", "    :c_impl", "  end", "end", ""].join("\n"));
    writeRb("app/b.rb", ["class B < C", "end", ""].join("\n"));
    writeRb("app/a.rb", ["class A < B", "  def foo", "    super", "  end", "end", ""].join("\n"));

    await provider.buildFileSignals(root, {
      paths: ["app/a.rb", "app/b.rb", "app/c.rb"],
    });

    const callers = await client.getCallers("C#foo");
    expect(callers.map((c) => c.sourceSymbolId)).toContain("A#foo");
  });
});
