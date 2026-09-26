/**
 * bd tea-rags-mcp-qea83 — the remaining run-global maps keyed by a bare name
 * are partitioned by LANGUAGE FAMILY, as bd tea-rags-mcp-nbf8q did for the
 * ancestry maps.
 *
 *  - `functionReturnTypes`: Go keys a METHOD by its bare name (`get`), Ruby
 *    keys every method by its bare name, so one run-wide record let a Go
 *    `get` type a Ruby `get`'s result, whichever file was absorbed last.
 *  - `structuredReturnTypes`: Ruby, Python and Swift all key a class member
 *    `Cls#m`, and a top-level class's name is bare in each.
 *  - the inheritance rows behind the hierarchy view: a TypeScript and a Ruby
 *    `Error` shared one `getDescendants("Error")` cone.
 *
 * Each map's collision test hands the runner a file of one language and
 * asserts it never sees the other language's fact.
 */
import { describe, expect, it } from "vitest";

import { NoopGlobalSymbolTable } from "../../../../../../src/core/adapters/duckdb/daemon/noop-symbol-table.js";
import type {
  CallContext,
  CodegraphPass1FileAggregates,
  FileExtraction,
  GlobalSymbolTable,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageFactoryDescriptor } from "../../../../../../src/core/contracts/types/language.js";
import { normalizeInheritanceEdges } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/inheritance-edges.js";
import { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const noopTable = async (): Promise<GlobalSymbolTable> => new NoopGlobalSymbolTable();
const noSymbols: GlobalSymbolTable = new NoopGlobalSymbolTable();

function file(relPath: string, language: string, extra: Partial<FileExtraction> = {}): FileExtraction {
  return { relPath, language, imports: [], fileScope: [], chunks: [], ...extra };
}

/** `file` with ONE chunk making ONE call, so the runner builds a call-site context. */
function callingFile(relPath: string, language: string): FileExtraction {
  const chunk = {
    symbolId: "Caller#run",
    startLine: 1,
    endLine: 3,
    calls: [{ callText: "x.go()", receiver: "x", member: "go", startLine: 2 }],
  };
  return file(relPath, language, { chunks: [chunk] as unknown as FileExtraction["chunks"] });
}

/** Every call-site context the runner builds for `extractions`, in order. */
function callContexts(state: CodegraphRunState, extractions: FileExtraction[]): CallContext[] {
  const seen: CallContext[] = [];
  const factory = {
    supported: () => extractions.map((x) => x.language),
    create: () => ({
      resolver: {
        resolve: (_call: unknown, ctx: CallContext) => {
          seen.push(ctx);
          return null;
        },
      },
    }),
  } as unknown as LanguageFactoryDescriptor;
  const runner = new CallEdgeResolutionRunner(factory, state);
  for (const extraction of extractions) runner.resolve(extraction, noSymbols);
  return seen;
}

describe("run-global return-type maps are partitioned by language family (qea83)", () => {
  it("never lets a Go method's bare-name return type answer for a Ruby method", async () => {
    const state = new CodegraphRunState();
    state.absorb(file("app/repo.rb", "ruby", { functionReturnTypes: { get: "RubyRecord" } }), []);
    state.absorb(file("pkg/repo.go", "go", { functionReturnTypes: { get: "GoRecord" } }), []);
    await state.seal(noopTable);

    const [rubyCtx, goCtx] = callContexts(state, [callingFile("app/x.rb", "ruby"), callingFile("pkg/x.go", "go")]);

    expect(rubyCtx?.functionReturnTypes?.get).toBe("RubyRecord");
    expect(goCtx?.functionReturnTypes?.get).toBe("GoRecord");
  });

  it("never lets a Python member's structured return answer for a Ruby one", async () => {
    const state = new CodegraphRunState();
    state.absorb(
      file("app/store.rb", "ruby", { structuredReturnTypes: { "Store#load": { form: "instance", name: "RubyRow" } } }),
      [],
    );
    state.absorb(
      file("pkg/store.py", "python", { structuredReturnTypes: { "Store#load": { form: "instance", name: "PyRow" } } }),
      [],
    );
    await state.seal(noopTable);

    const [rubyCtx, pyCtx] = callContexts(state, [callingFile("app/x.rb", "ruby"), callingFile("pkg/x.py", "python")]);

    expect(rubyCtx?.structuredReturnTypes?.["Store#load"]).toEqual({ form: "instance", name: "RubyRow" });
    expect(pyCtx?.structuredReturnTypes?.["Store#load"]).toEqual({ form: "instance", name: "PyRow" });
  });

  it("hydrates persisted return types into the slice's family, batch-wins per family", async () => {
    const state = new CodegraphRunState();
    state.absorb(file("app/repo.rb", "ruby", { functionReturnTypes: { get: "RubyRecord" } }), []);
    // The Go caller below is walked too: the barrier hydrates only walked families.
    state.absorb(file("pkg/x.go", "go"), []);
    const slices: CodegraphPass1FileAggregates[] = [
      { relPath: "pkg/repo.go", language: "go", functionReturnTypes: { get: "GoRecord" } },
      { relPath: "app/old_repo.rb", language: "ruby", functionReturnTypes: { get: "StaleRecord" } },
    ];
    await state.seal(noopTable, async () => slices);

    const [goCtx, rubyCtx] = callContexts(state, [callingFile("pkg/x.go", "go"), callingFile("app/x.rb", "ruby")]);

    expect(goCtx?.functionReturnTypes?.get).toBe("GoRecord");
    expect(rubyCtx?.functionReturnTypes?.get).toBe("RubyRecord");
  });
});

describe("the run-global class hierarchy is partitioned by language family (qea83)", () => {
  const tsErrors = file("web/errors.ts", "typescript", {
    inheritanceEdges: [{ source: "AppError", ancestor: "Error", kind: "super", ordinal: 0 }],
  });
  const rubyErrors = file("app/errors.rb", "ruby", { classExtends: { NotFound: "Error" } });

  it("gives a Ruby caller's cone only Ruby descendants of a shared class name", async () => {
    const state = new CodegraphRunState();
    for (const x of [tsErrors, rubyErrors]) {
      state.absorbInheritanceRows(
        x.language,
        normalizeInheritanceEdges(x, () => null),
      );
    }
    await state.seal(noopTable);

    const [rubyCtx, tsCtx] = callContexts(state, [
      callingFile("app/x.rb", "ruby"),
      callingFile("web/x.js", "javascript"),
    ]);

    expect(rubyCtx?.hierarchy?.getDescendants("Error").map((e) => e.sourceFqName)).toEqual(["NotFound"]);
    // JavaScript shares the TypeScript family's hierarchy.
    expect(tsCtx?.hierarchy?.getDescendants("Error").map((e) => e.sourceFqName)).toEqual(["AppError"]);
  });

  it("hydrates persisted inheritance into the slice's family", async () => {
    const state = new CodegraphRunState();
    // The Ruby caller below is walked: the barrier hydrates only walked families.
    state.absorb(file("app/x.rb", "ruby"), []);
    const slices: CodegraphPass1FileAggregates[] = [
      { relPath: "web/errors.ts", language: "typescript", inheritanceEdges: tsErrors.inheritanceEdges },
      { relPath: "app/errors.rb", language: "ruby", classExtends: { NotFound: "Error" } },
    ];
    await state.seal(noopTable, async () => slices);

    const [rubyCtx] = callContexts(state, [callingFile("app/x.rb", "ruby")]);

    expect(rubyCtx?.hierarchy?.getDescendants("Error").map((e) => e.sourceFqName)).toEqual(["NotFound"]);
  });

  it("keeps the all-family `inheritanceRows` / `hierarchyView` views for diagnostics", async () => {
    const state = new CodegraphRunState();
    for (const x of [tsErrors, rubyErrors]) {
      state.absorbInheritanceRows(
        x.language,
        normalizeInheritanceEdges(x, () => null),
      );
    }
    await state.seal(noopTable);

    expect(state.inheritanceRows.map((r) => r.sourceFqName).sort()).toEqual(["AppError", "NotFound"]);
    expect(
      state.hierarchyView
        ?.getDescendants("Error")
        .map((e) => e.sourceFqName)
        .sort(),
    ).toEqual(["AppError", "NotFound"]);
  });
});
