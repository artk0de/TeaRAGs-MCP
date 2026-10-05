/**
 * The Ruby interprocedural PARAMETER family (bd tea-rags-mcp-bvalc) is cross-file
 * by construction, so an incremental run must hydrate it (bd tea-rags-mcp-39xca.15).
 *
 * `seal` folds four raw channels into `paramTypes` / `derivedClassFieldTypes`:
 * the call sites' argument types (`knownTargetCallArgs`, the CALLER's file), the
 * callee's positional parameter names (`paramNames`, the CALLEE's file), the
 * `@ivar = <param>` links and the coordinates a walker already typed (the
 * CLASS's files, possibly several for a reopened class). An incremental run
 * walks the changed files only, so each of those facts sits in a file it did
 * not walk — and the fold then answers differently from a full run in BOTH
 * directions, measured offline with `scripts/spikes/incremental-runglobal-delta.ts`:
 *
 *  - huginn: `@agent` in `FormConfigurableAgentPresenter` is typed by
 *    `FormConfigurableAgentPresenter.new(agent, …)` in another file; without it
 *    four call sites degrade from a pinned edge to a dynamic fan-out;
 *  - octokit.rb: `Octokit::Gist#initialize(gist)` is called with a `String` from
 *    `client/gists.rb`; without that record the veto disappears and the
 *    convention tier types `gist` as a `Gist`, emitting a phantom
 *    `Octokit::Gist#to_s` edge.
 *
 * Each case below states the invariant as "an incremental run that walked X
 * derives what a full run derives", with the unwalked files reaching the seal
 * only as persisted rows round-tripped through the real row codec.
 */
import { describe, expect, it } from "vitest";

import { fromCgPass1Row, toCgPass1Row } from "../../../../../../src/core/adapters/duckdb/cg-pass1-aggregates-row.js";
import { NoopGlobalSymbolTable } from "../../../../../../src/core/adapters/duckdb/daemon/noop-symbol-table.js";
import type {
  ChunkExtraction,
  CodegraphPass1FileAggregates,
  FileExtraction,
  GlobalSymbolTable,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { buildPass1Aggregates } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/pass1-aggregates.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const noopTable = async (): Promise<GlobalSymbolTable> => new NoopGlobalSymbolTable();

function method(symbolId: string, paramNames?: string[]): ChunkExtraction {
  return { symbolId, scope: [], calls: [], ...(paramNames === undefined ? {} : { paramNames }) };
}

function rubyFile(relPath: string, extra: Partial<FileExtraction> = {}): FileExtraction {
  return { relPath, language: "ruby", imports: [], fileScope: [], chunks: [], ...extra };
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

// ── huginn's shape: the caller types the callee's param, which feeds an ivar ──
const presenter = rubyFile("app/presenters/presenter.rb", {
  chunks: [method("Presenter#initialize", ["agent", "view"])],
  classFieldParamLinks: { Presenter: { "@agent": { method: "initialize", param: "agent" } } },
});
const controller = rubyFile("app/controllers/agents_controller.rb", {
  knownTargetCallArgs: [{ targets: ["Presenter#initialize"], argTypes: [{ form: "instance", name: "Agent" }, null] }],
});

// ── octokit's shape: two call sites disagree, and the disagreement is a veto ──
const gist = rubyFile("lib/octokit/gist.rb", {
  chunks: [method("Octokit::Gist#initialize", ["gist"])],
  knownTargetCallArgs: [
    { targets: ["Octokit::Gist#initialize"], argTypes: [{ form: "instance", name: "Octokit::Gist" }] },
  ],
});
const gistsClient = rubyFile("lib/octokit/client/gists.rb", {
  knownTargetCallArgs: [{ targets: ["Octokit::Gist#initialize"], argTypes: [{ form: "instance", name: "String" }] }],
});

describe("CodegraphRunState.seal hydrates the Ruby parameter family of files this run did not walk", () => {
  it("types a callee's parameter from a call site in an unwalked file, as a full run does", async () => {
    const full = await fullRun([presenter, controller]);
    const inc = await incrementalRun([presenter], [controller]);

    expect(full.paramTypes["Presenter#initialize"]).toEqual({ agent: { form: "instance", name: "Agent" } });
    expect(inc.paramTypes).toEqual(full.paramTypes);
    expect(inc.derivedClassFieldTypes).toEqual(full.derivedClassFieldTypes);
  });

  it("maps a walked call site onto an unwalked callee's parameter names and ivar links", async () => {
    const full = await fullRun([presenter, controller]);
    const inc = await incrementalRun([controller], [presenter]);

    expect(full.derivedClassFieldTypes).toEqual({ Presenter: { "@agent": "Agent" } });
    expect(inc.paramTypes).toEqual(full.paramTypes);
    expect(inc.derivedClassFieldTypes).toEqual(full.derivedClassFieldTypes);
  });

  it("keeps the veto a disagreeing call site in an unwalked file casts", async () => {
    const full = await fullRun([gist, gistsClient]);
    const inc = await incrementalRun([gist], [gistsClient]);

    expect(full.paramTypes["Octokit::Gist#initialize"]).toBeUndefined();
    expect(inc.paramTypes).toEqual(full.paramTypes);
  });

  it("lets a field another file of a reopened class typed suppress the derivation, as a full run does", async () => {
    const reopened = rubyFile("app/presenters/presenter_typing.rb", {
      classFieldTypes: { Presenter: { "@agent": "LegacyAgent" } },
    });
    const full = await fullRun([presenter, controller, reopened]);
    const inc = await incrementalRun([presenter, controller], [reopened]);

    expect(full.derivedClassFieldTypes).toEqual({});
    expect(inc.derivedClassFieldTypes).toEqual(full.derivedClassFieldTypes);
  });

  it("never lets a persisted row resurrect a call site the re-walked caller no longer makes", async () => {
    const stale = persistedRow(controller);
    const rewalkedController = rubyFile(controller.relPath);
    const inc = new CodegraphRunState();
    inc.absorb(presenter, []);
    inc.absorb(rewalkedController, []);
    await inc.seal(noopTable, async () => stale);

    expect(inc.paramTypes).toEqual({});
  });

  it("persists none of the family for a language whose walker does not feed the fold", () => {
    const go = { ...presenter, relPath: "app/presenter.go", language: "go" };
    expect(buildPass1Aggregates({ ...go, ...{ knownTargetCallArgs: controller.knownTargetCallArgs } }, [])).toBe(
      undefined,
    );
  });
});
