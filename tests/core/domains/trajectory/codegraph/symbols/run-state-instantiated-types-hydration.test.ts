/**
 * The RTA instantiation set (bd tea-rags-mcp-pffv) prunes a CHA cone to the
 * subtypes some file instantiates, so it is cross-file by construction: the
 * `System.new` that keeps `System#id` in a cone lives far from the call site.
 * Batch-scoped, an incremental run pruned against the instantiations of the
 * files it walked — and when none of them named a cone member, the prune came
 * back empty and the run kept the WHOLE cone where a full run kept one member.
 * Measured offline with `scripts/spikes/incremental-runglobal-delta.ts` on
 * taxdome, random 5% seed 1 (bd tea-rags-mcp-39xca.15): one phantom
 * `Guest#id` cone edge beside `System#id` at `actor.id` in
 * `Platform::EventDispatcher.publish`, recovered by `--ablate rta` alone.
 *
 * Each case states "an incremental run that walked X derives what a full run
 * derives", with the unwalked files reaching the seal only as persisted rows
 * round-tripped through the real row codec.
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

function rubyFile(relPath: string, instantiatedTypes?: string[]): FileExtraction {
  return {
    relPath,
    language: "ruby",
    imports: [],
    fileScope: [],
    chunks: [],
    ...(instantiatedTypes === undefined ? {} : { instantiatedTypes }),
  };
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

// taxdome's shape: the call site's file instantiates nothing; the instantiation
// that keeps one cone member alive sits in another file.
const dispatcher = rubyFile("lib/platform/event_dispatcher.rb");
const systemActor = rubyFile("app/services/system_actor.rb", ["System"]);
const signup = rubyFile("app/services/signup.rb", ["Account", "User"]);

describe("CodegraphRunState.instantiatedTypes is project-wide on an incremental run", () => {
  it("an incremental run that walked a non-instantiating caller derives the full run's set", async () => {
    const full = await fullRun([dispatcher, systemActor, signup]);
    const inc = await incrementalRun([dispatcher], [systemActor, signup]);

    expect([...inc.instantiatedTypes].sort()).toEqual([...full.instantiatedTypes].sort());
  });

  it("drops an instantiation the re-walked file no longer makes", async () => {
    const editedSignup = rubyFile("app/services/signup.rb", ["Account"]);
    const full = await fullRun([dispatcher, systemActor, editedSignup]);
    const inc = await incrementalRun([editedSignup], [dispatcher, systemActor, signup]);

    expect([...inc.instantiatedTypes].sort()).toEqual([...full.instantiatedTypes].sort());
    expect(inc.instantiatedTypes.has("User")).toBe(false);
  });
});
