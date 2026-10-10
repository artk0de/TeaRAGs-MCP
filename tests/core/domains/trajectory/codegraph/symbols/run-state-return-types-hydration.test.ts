/**
 * `returnTypes` is keyed by a bare function NAME within a language family, so
 * two files can declare the same name with different return types — on mastodon
 * the Rails scope `not_excluded_by_account` is declared on both `Account` and
 * `Status`. A full run settles such a collision by its walk: last write wins,
 * and the walk is in relPath order. The barrier's hydration used to settle it by
 * batch-wins instead, so an incremental run that walked `account.rb` kept
 * `Account` where the full run held `Status` — measured offline with
 * `scripts/spikes/incremental-runglobal-delta.ts` on mastodon (bd
 * tea-rags-mcp-39xca.15): windows 8x150 26 lost / 1 phantom / 15 retargeted,
 * random 5% 26 / 1 / 3, all of it recovered by `--ablate fret` alone.
 *
 * The invariant: the map's value for a colliding name does not depend on which
 * files the run walked, nor on the order it absorbed them in. Every file that
 * declares the name is a live declaration — the walked file's own stale row is
 * skipped before hydration — so neither side is "fresher" than the other.
 */
import { describe, expect, it } from "vitest";

import { fromCgPass1Row, toCgPass1Row } from "../../../../../../src/core/adapters/duckdb/cg-pass1-aggregates-row.js";
import { NoopGlobalSymbolTable } from "../../../../../../src/core/adapters/duckdb/daemon/noop-symbol-table.js";
import type {
  CodegraphPass1FileAggregates,
  FileExtraction,
  GlobalSymbolTable,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { buildPass1Aggregates } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/pass1-aggregates.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const noopTable = async (): Promise<GlobalSymbolTable> => new NoopGlobalSymbolTable();

function rubyFile(relPath: string, functionReturnTypes: Record<string, string>): FileExtraction {
  return { relPath, language: "ruby", imports: [], fileScope: [], chunks: [], functionReturnTypes };
}

/** The persisted row of a file, exactly as a later run reads it back. */
function persistedRow(file: FileExtraction): CodegraphPass1FileAggregates[] {
  const slice = buildPass1Aggregates(file, []);
  if (slice === undefined) return [];
  const [relPath, language, json] = toCgPass1Row(slice) as [string, string, string];
  return [fromCgPass1Row({ rel_path: relPath, language, aggregates_json: json })];
}

async function fullRun(files: readonly FileExtraction[]): Promise<CodegraphRunState> {
  const state = new CodegraphRunState();
  for (const file of files) state.absorb(file, []);
  await state.seal(noopTable);
  return state;
}

async function incrementalRun(
  walked: readonly FileExtraction[],
  unwalked: readonly FileExtraction[],
): Promise<CodegraphRunState> {
  const state = new CodegraphRunState();
  for (const file of walked) state.absorb(file, []);
  await state.seal(noopTable, async () => unwalked.flatMap(persistedRow));
  return state;
}

// mastodon's shape: one scope name, two models, two answers.
const account = rubyFile("app/models/account.rb", { not_excluded_by_account: "Account", account_only: "Account" });
const status = rubyFile("app/models/status.rb", { not_excluded_by_account: "Status" });
const corpus = [account, status];

describe("CodegraphRunState.returnTypes settles a same-name collision independently of the walked set", () => {
  it("an incremental run that walked the earlier declarer derives what a full run derives", async () => {
    const full = await fullRun(corpus);
    const inc = await incrementalRun([account], [status]);

    expect(inc.returnTypesFor("ruby")).toEqual(full.returnTypesFor("ruby"));
  });

  it("an incremental run that walked the later declarer derives what a full run derives", async () => {
    const full = await fullRun(corpus);
    const inc = await incrementalRun([status], [account]);

    expect(inc.returnTypesFor("ruby")).toEqual(full.returnTypesFor("ruby"));
  });

  it("does not depend on the order a run absorbs its files in", async () => {
    const forward = await fullRun(corpus);
    const reverse = await fullRun([...corpus].reverse());

    expect(reverse.returnTypesFor("ruby")).toEqual(forward.returnTypesFor("ruby"));
  });

  it("still lets a re-walked file replace its own persisted answer", async () => {
    const edited = rubyFile("app/models/status.rb", { not_excluded_by_account: "StatusRelation" });
    const inc = await incrementalRun([edited], [account, status]);

    expect(inc.returnTypesFor("ruby").not_excluded_by_account).toBe("StatusRelation");
    expect(inc.returnTypesFor("ruby").account_only).toBe("Account");
  });
});
