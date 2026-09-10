/**
 * bd tea-rags-mcp-8qyax — the RETURN-TYPE half of the batch-scoped run-global
 * defect class, e2e through the real provider two-pass.
 *
 * znxg8 closed the ancestry / self-dispatch half by persisting a per-file pass-1
 * slice and hydrating it at the barrier for files the run did not walk. The
 * type-inference maps were left batch-scoped on the grounds that they are
 * per-METHOD and would blow up the slice. Measured on taxdome
 * (`scripts/spikes/ruby-incremental-runglobal-delta.ts`, 9945 attempted calls):
 * an incremental run loses 168 edges, and handing it `structuredReturnTypes` +
 * `returnTypes` recovers 131 of them, while every other family recovers ZERO.
 * The size premise did not hold either — 6518 + 2597 entries against the 11099
 * per-class ancestry keys the slice already carries.
 *
 * What this pins is the observable consequence: a chained call whose receiver
 * type comes from a method DECLARED IN ANOTHER FILE must keep resolving when
 * only the caller is re-walked. Unit tests that inject hand-built maps cannot
 * catch it — the map has to actually survive the barrier.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolvePath(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

interface MethodEdge {
  source_symbol_id: string;
  target_symbol_id: string;
  call_expression: string;
}

describe("CodegraphEnrichmentProvider — cross-file return types on an incremental run (8qyax)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  /**
   * Four files, and the chain `repo.fetch.render` can only resolve if the
   * return type of `Repo#fetch` — declared in a DIFFERENT file from both the
   * caller and the target — is in scope at pass-2.
   *
   * `Gadget` exists to make the short name AMBIGUOUS. With a single `render` in
   * the project the resolver pins it by short name alone and the return type is
   * never consulted, so the fixture would pass with the maps missing entirely —
   * a test that proves nothing.
   */
  const writeFixture = (): string[] => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "widget.rb"),
      ["class Widget", "  def render", "    :ok", "  end", "end", ""].join("\n"),
    );
    writeFileSync(
      join(root, "src", "gadget.rb"),
      ["class Gadget", "  def render", "    :other", "  end", "end", ""].join("\n"),
    );
    writeFileSync(
      join(root, "src", "repo.rb"),
      ["class Repo", "  # @return [Widget]", "  def fetch", "    Widget.new", "  end", "end", ""].join("\n"),
    );
    writeFileSync(
      join(root, "src", "caller.rb"),
      ["class Caller", "  def go", "    repo = Repo.new", "    repo.fetch.render", "  end", "end", ""].join("\n"),
    );
    return ["src/widget.rb", "src/gadget.rb", "src/repo.rb", "src/caller.rb"];
  };

  const methodEdges = async (): Promise<MethodEdge[]> =>
    client.queryAll<MethodEdge>(
      "SELECT source_symbol_id, target_symbol_id, call_expression FROM cg_symbols_edges_method",
    );

  /**
   * The targets of the chained call, SORTED — asserted as a whole rather than
   * with `toContainEqual`, because the failure mode is a fan-out that contains
   * the right answer beside a wrong one. Losing the return type turns a pinned
   * edge into a cone over every class declaring `render`, and a containment
   * assertion reads that as a pass.
   */
  const chainTargets = async (): Promise<string[]> =>
    (await methodEdges())
      .filter((e) => e.source_symbol_id === "Caller#go" && e.call_expression === "repo.fetch.render")
      .map((e) => e.target_symbol_id)
      .sort();

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-rettype-prov-"));
    root = mkdtempSync(join(tmpdir(), "cg-rettype-fixture-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps `repo.fetch.render` on Widget#render when only the CALLER is re-walked", async () => {
    const paths = writeFixture();

    // Run 1 — full corpus. Every map is complete by construction, so this only
    // establishes that the fixture resolves at all; if it does not, the
    // incremental assertion below would pass for the wrong reason.
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);
    expect(await chainTargets()).toEqual(["Widget#render"]);

    // Run 2 — the caller alone changed, which is what an incremental reindex
    // walks. Neither `Repo`'s file (which owns the return fact) nor `Widget`'s
    // is in the batch.
    writeFileSync(
      join(root, "src", "caller.rb"),
      [
        "class Caller",
        "  def go",
        "    repo = Repo.new",
        "    repo.fetch.render",
        "  end",
        "  def added_later",
        "    :noop",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    await provider.streamFileBatch(root, ["src/caller.rb"]);
    await provider.finalizeSignals(root);

    expect(await chainTargets()).toEqual(["Widget#render"]);
  });
});
