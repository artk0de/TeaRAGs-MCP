/**
 * The interprocedural PARAMETER family (bd tea-rags-mcp-bvalc) admits every
 * language whose walker feeds it, not only Ruby (bd tea-rags-mcp-m99j1.1.17).
 *
 * The walker spells the fold coordinate; the trajectory never re-spells it. A
 * Python def is `View#__init__` by symbolId but `pkg/a.py::View#__init__` by
 * class key, so the chunk carries `paramCoordinate` and every consumer — the
 * fold's existence index, the pass-1 slice, the pass-2 seeding lookup — reads
 * it in place of the symbolId. A Python-derived field lands on the run-global
 * class-keyed channel (Python's own field address), under the facts the walker
 * typed there, which also serve as the derivation's typed-field gate. A Ruby
 * run keeps the per-file channel and leaves the class-keyed map untouched.
 *
 * Each Python case is checked for a full run AND for an incremental run whose
 * unwalked files reach the seal only as persisted rows through the real codec.
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
import type { KnownTargetCalleeLocatorFactory } from "../../../../../../src/core/contracts/types/language.js";
import {
  paramTypesOfChunk,
  seedParamLocalBindings,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/call-arg-param-types.js";
import { buildPass1Aggregates } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/pass1-aggregates.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const noopTable = async (): Promise<GlobalSymbolTable> => new NoopGlobalSymbolTable();

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

// ── Python's shape: `def __init__(self, request): self.request = request` ──
const VIEW_KEY = "pkg/a.py::View";
const viewInit: ChunkExtraction = {
  symbolId: "View#__init__",
  paramCoordinate: `${VIEW_KEY}#__init__`,
  scope: [],
  calls: [],
  startLine: 3,
  paramNames: ["request"],
};
const viewFile: FileExtraction = {
  relPath: "pkg/a.py",
  language: "python",
  imports: [],
  fileScope: [],
  chunks: [viewInit],
  classFieldParamLinks: { [VIEW_KEY]: { request: { method: "__init__", param: "request" } } },
};
// `View(HttpRequest())` in another module.
const callerFile: FileExtraction = {
  relPath: "pkg/b.py",
  language: "python",
  imports: [],
  fileScope: [],
  chunks: [],
  knownTargetCallArgs: [{ targets: [`${VIEW_KEY}#__init__`], argTypes: [{ form: "instance", name: "HttpRequest" }] }],
};

describe("the parameter family admits a Python-shaped extraction via its walker-spelled coordinate", () => {
  it("folds the call site into the def named by paramCoordinate, not by symbolId", async () => {
    const state = await fullRun([viewFile, callerFile]);

    expect(state.paramTypes[`${VIEW_KEY}#__init__`]).toEqual({ request: { form: "instance", name: "HttpRequest" } });
    expect(state.paramTypes["View#__init__"]).toBeUndefined();
  });

  it("derives the copied field onto the run-global class-keyed channel, leaving the per-file channel empty", async () => {
    const state = await fullRun([viewFile, callerFile]);

    expect(state.classFieldTypesByClassKey[VIEW_KEY]).toEqual({ request: "HttpRequest" });
    expect(state.derivedClassFieldTypes).toEqual({});
  });

  it("never overrides a field the walker typed on the class-keyed channel", async () => {
    const typed: FileExtraction = {
      ...viewFile,
      classFieldTypesByClassKey: { [VIEW_KEY]: { request: "WSGIRequest" } },
    };
    const state = await fullRun([typed, callerFile]);

    expect(state.classFieldTypesByClassKey[VIEW_KEY]).toEqual({ request: "WSGIRequest" });
  });

  it("keeps the walker's other fields of the class beside the derived one", async () => {
    const typed: FileExtraction = { ...viewFile, classFieldTypesByClassKey: { [VIEW_KEY]: { kwargs: "dict" } } };
    const state = await fullRun([typed, callerFile]);

    expect(state.classFieldTypesByClassKey[VIEW_KEY]).toEqual({ request: "HttpRequest", kwargs: "dict" });
  });

  it("seeds the folded type at the def line through the chunk's coordinate", async () => {
    const state = await fullRun([viewFile, callerFile]);

    const seeded = seedParamLocalBindings(
      viewInit.localBindings,
      paramTypesOfChunk(state.paramTypes, viewInit),
      viewInit.startLine,
    );
    expect(seeded).toEqual({ request: [{ line: 3, type: "HttpRequest" }] });
  });

  it("persists the def's parameter names under its coordinate", () => {
    expect(buildPass1Aggregates(viewFile, [])?.methodParamNames).toEqual({ [`${VIEW_KEY}#__init__`]: ["request"] });
  });

  it("derives what a full run derives when the call site's file was not walked", async () => {
    const full = await fullRun([viewFile, callerFile]);
    const inc = await incrementalRun([viewFile], [callerFile]);

    expect(inc.paramTypes).toEqual(full.paramTypes);
    expect(inc.classFieldTypesByClassKey).toEqual(full.classFieldTypesByClassKey);
    expect(inc.classFieldTypesByClassKey[VIEW_KEY]).toEqual({ request: "HttpRequest" });
  });

  it("derives what a full run derives when the def's file was not walked", async () => {
    const full = await fullRun([viewFile, callerFile]);
    const inc = await incrementalRun([callerFile], [viewFile]);

    expect(inc.paramTypes).toEqual(full.paramTypes);
    expect(inc.classFieldTypesByClassKey).toEqual(full.classFieldTypesByClassKey);
    expect(inc.classFieldTypesByClassKey[VIEW_KEY]).toEqual({ request: "HttpRequest" });
  });

  it("gates an unwalked file's typed class-keyed field exactly as a full run does", async () => {
    const typed: FileExtraction = {
      ...viewFile,
      classFieldTypesByClassKey: { [VIEW_KEY]: { request: "WSGIRequest" } },
    };
    const full = await fullRun([typed, callerFile]);
    const inc = await incrementalRun([callerFile], [typed]);

    expect(inc.classFieldTypesByClassKey).toEqual(full.classFieldTypesByClassKey);
    expect(inc.classFieldTypesByClassKey[VIEW_KEY]).toEqual({ request: "WSGIRequest" });
  });
});

// ── Barrier-side candidate expansion (bd tea-rags-mcp-m99j1.1.42) ──
// `from pkg import Response; Response(HttpRequest())` where `pkg/__init__.py`
// re-exports `Response` from `pkg/response.py`, and `Child(HttpRequest())`
// where `Child(View)` declares no `__init__` of its own.
const REEXPORTED_TARGET = "pkg/__init__.py::Response#__init__";
const RESPONSE_KEY = "pkg/response.py::Response";
const CHILD_KEY = "pkg/c.py::Child";
const responseFile: FileExtraction = {
  relPath: "pkg/response.py",
  language: "python",
  imports: [],
  fileScope: [],
  chunks: [
    {
      symbolId: "Response#__init__",
      paramCoordinate: `${RESPONSE_KEY}#__init__`,
      scope: [],
      calls: [],
      startLine: 2,
      paramNames: ["content"],
    },
  ],
  classFieldParamLinks: { [RESPONSE_KEY]: { content: { method: "__init__", param: "content" } } },
};
const expandingCallerFile: FileExtraction = {
  relPath: "pkg/d.py",
  language: "python",
  imports: [],
  fileScope: [],
  chunks: [],
  knownTargetCallArgs: [
    { targets: [REEXPORTED_TARGET], argTypes: [{ form: "instance", name: "HttpRequest" }] },
    { targets: [`${CHILD_KEY}#__init__`], argTypes: [{ form: "instance", name: "HttpRequest" }] },
  ],
};
const fakeLocatorFactory: KnownTargetCalleeLocatorFactory = () => (coordinate) => {
  if (coordinate === REEXPORTED_TARGET) return { definingClassKey: RESPONSE_KEY, instanceClassKey: RESPONSE_KEY };
  if (coordinate === `${CHILD_KEY}#__init__`) return { definingClassKey: VIEW_KEY, instanceClassKey: CHILD_KEY };
  return null;
};

function expandingState(): CodegraphRunState {
  return new CodegraphRunState([], new Map(), new Map(), undefined, new Map([["python", fakeLocatorFactory]]));
}

async function expandingFullRun(files: readonly FileExtraction[]): Promise<CodegraphRunState> {
  const state = expandingState();
  for (const file of files) state.absorb(file, []);
  await state.seal(noopTable);
  return state;
}

async function expandingIncrementalRun(
  walked: readonly FileExtraction[],
  unwalked: readonly FileExtraction[],
): Promise<CodegraphRunState> {
  const state = expandingState();
  for (const file of walked) state.absorb(file, []);
  await state.seal(noopTable, async () => unwalked.flatMap(persistedRow));
  return state;
}

describe("the barrier expands a Python candidate no indexed def answers (m99j1.1.42)", () => {
  const files = [viewFile, responseFile, expandingCallerFile];

  it("follows a re-export to the declaring file's def and derives its field there", async () => {
    const state = await expandingFullRun(files);

    expect(state.paramTypes[`${RESPONSE_KEY}#__init__`]).toEqual({
      content: { form: "instance", name: "HttpRequest" },
    });
    expect(state.classFieldTypesByClassKey[RESPONSE_KEY]).toEqual({ content: "HttpRequest" });
  });

  it("joins an inherited constructor against the ancestor's def and keys the field on the asking class too", async () => {
    const state = await expandingFullRun(files);

    expect(state.paramTypes[`${VIEW_KEY}#__init__`]).toEqual({ request: { form: "instance", name: "HttpRequest" } });
    expect(state.classFieldTypesByClassKey[VIEW_KEY]).toEqual({ request: "HttpRequest" });
    expect(state.classFieldTypesByClassKey[CHILD_KEY]).toEqual({ request: "HttpRequest" });
  });

  it("never derives an inherited field the defining class's walker already typed", async () => {
    const typed: FileExtraction = {
      ...viewFile,
      classFieldTypesByClassKey: { [VIEW_KEY]: { request: "WSGIRequest" } },
    };
    const state = await expandingFullRun([typed, responseFile, expandingCallerFile]);

    expect(state.classFieldTypesByClassKey[VIEW_KEY]).toEqual({ request: "WSGIRequest" });
    expect(state.classFieldTypesByClassKey[CHILD_KEY]).toBeUndefined();
  });

  it("expands nothing without a locator — the pre-expansion run", async () => {
    const state = await fullRun(files);

    expect(state.paramTypes[`${RESPONSE_KEY}#__init__`]).toBeUndefined();
    expect(state.classFieldTypesByClassKey[CHILD_KEY]).toBeUndefined();
  });

  it("derives what a full run derives when the call site's file was not walked", async () => {
    const full = await expandingFullRun(files);
    const inc = await expandingIncrementalRun([viewFile, responseFile], [expandingCallerFile]);

    expect(inc.paramTypes).toEqual(full.paramTypes);
    expect(inc.classFieldTypesByClassKey).toEqual(full.classFieldTypesByClassKey);
  });

  it("derives what a full run derives when the defs' files were not walked", async () => {
    const full = await expandingFullRun(files);
    const inc = await expandingIncrementalRun([expandingCallerFile], [viewFile, responseFile]);

    expect(inc.paramTypes).toEqual(full.paramTypes);
    expect(inc.classFieldTypesByClassKey).toEqual(full.classFieldTypesByClassKey);
    expect(inc.classFieldTypesByClassKey[CHILD_KEY]).toEqual({ request: "HttpRequest" });
  });
});

describe("a Ruby-shaped extraction keeps the per-file channel and its symbolId coordinate", () => {
  const presenterInit: ChunkExtraction = {
    symbolId: "Presenter#initialize",
    scope: [],
    calls: [],
    startLine: 2,
    paramNames: ["agent"],
  };
  const presenter: FileExtraction = {
    relPath: "app/presenter.rb",
    language: "ruby",
    imports: [],
    fileScope: [],
    chunks: [presenterInit],
    classFieldParamLinks: { Presenter: { "@agent": { method: "initialize", param: "agent" } } },
  };
  const controller: FileExtraction = {
    relPath: "app/controller.rb",
    language: "ruby",
    imports: [],
    fileScope: [],
    chunks: [],
    knownTargetCallArgs: [{ targets: ["Presenter#initialize"], argTypes: [{ form: "instance", name: "Agent" }] }],
  };

  it("derives onto derivedClassFieldTypes and leaves the class-keyed map empty", async () => {
    const state = await fullRun([presenter, controller]);

    expect(state.derivedClassFieldTypes).toEqual({ Presenter: { "@agent": "Agent" } });
    expect(state.classFieldTypesByClassKey).toEqual({});
  });

  it("seeds through the symbolId when the chunk spells no coordinate", async () => {
    const state = await fullRun([presenter, controller]);

    expect(paramTypesOfChunk(state.paramTypes, presenterInit)).toEqual({ agent: { form: "instance", name: "Agent" } });
  });
});
