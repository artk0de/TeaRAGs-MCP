import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  DispatchFanoutOutcome,
  HierarchyView,
  InheritanceEdge,
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { RustCallResolver } from "../../../../../../src/core/domains/language/rust/resolver/rust-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const sym = (
  symbolId: string,
  relPath: string,
  scope: string[] = [],
  symbolKind: SymbolDefinition["symbolKind"] = symbolId.includes("#") || symbolId.includes(".") ? "method" : "class",
): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/#|\.|::/).pop() ?? symbolId,
  relPath,
  scope,
  symbolKind,
});

function hierarchyWith(descendants: Record<string, string[]>): HierarchyView {
  return {
    getAncestors: () => [],
    getDescendants: (ancestorFqName) =>
      (descendants[ancestorFqName] ?? []).map(
        (sourceFqName): InheritanceEdge => ({
          sourceFqName,
          ancestorFqName,
          ancestorSymbolId: null,
          kind: "implements",
          depth: 1,
        }),
      ),
  };
}

function tableWith(...files: [string, SymbolDefinition[]][]): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [path, definitions] of files) table.upsertFile(path, definitions);
  return table;
}

function ctx(over: Partial<CallContext> = {}): CallContext {
  return {
    callerFile: "src/main.rs",
    callerScope: [],
    imports: [],
    symbolTable: tableWith(
      [
        "src/runner.rs",
        [sym("Runner", "src/runner.rs", [], "interface"), sym("Runner#run", "src/runner.rs", ["Runner"])],
      ],
      ["src/worker.rs", [sym("Worker", "src/worker.rs"), sym("Worker#run", "src/worker.rs", ["Worker"])]],
      ["src/other.rs", [sym("Other#run", "src/other.rs", ["Other"])]],
    ),
    ...over,
  };
}

const call = (callText: string, receiver: string | null, member: string): CallRef => ({
  callText,
  receiver,
  member,
  startLine: 1,
});

function edgesOf(outcome: DispatchFanoutOutcome | undefined) {
  expect(outcome?.kind).toBe("edges");
  return outcome?.kind === "edges" ? outcome.edges : [];
}

describe("Rust trait and impl dispatch", () => {
  it("resolves a qualified trait call to the implementing type's method", () => {
    const resolver = new RustCallResolver();
    const table = tableWith(
      ["src/worker.rs", [sym("Worker", "src/worker.rs"), sym("Worker#run", "src/worker.rs", ["Worker"])]],
      ["src/runner.rs", [sym("Runner#run", "src/runner.rs", ["Runner"])]],
      ["src/other.rs", [sym("Other#run", "src/other.rs", ["Other"])]],
    );

    expect(
      resolver.resolve(
        call("<Worker as Runner>::run(&worker)", "<Worker as Runner>", "run"),
        ctx({ symbolTable: table }),
      ),
    ).toEqual({ targetRelPath: "src/worker.rs", targetSymbolId: "Worker#run" });
  });

  it("resolves an unqualified call inside a trait impl to the implementing type, not the trait declaration", () => {
    const resolver = new RustCallResolver();
    const table = tableWith(
      [
        "src/worker.rs",
        [sym("Runner#run", "src/worker.rs", ["Runner"]), sym("Worker#run", "src/worker.rs", ["Worker"])],
      ],
      ["src/other.rs", [sym("Other#run", "src/other.rs", ["Other"])]],
    );

    expect(
      resolver.resolve(
        call("run()", null, "run"),
        ctx({ callerFile: "src/worker.rs", callerScope: ["Worker"], symbolTable: table }),
      ),
    ).toEqual({ targetRelPath: "src/worker.rs", targetSymbolId: "Worker#run" });
  });

  it("resolves a qualified associated trait function to the implementing type's associated method", () => {
    const resolver = new RustCallResolver();
    const table = tableWith(
      ["src/worker.rs", [sym("Worker", "src/worker.rs"), sym("Worker.make", "src/worker.rs", ["Worker"])]],
      ["src/factory.rs", [sym("Factory.make", "src/factory.rs", ["Factory"])]],
      ["src/other.rs", [sym("Other.make", "src/other.rs", ["Other"])]],
    );

    expect(
      resolver.resolve(call("<Worker as Factory>::make()", "<Worker as Factory>", "make"), ctx({ symbolTable: table })),
    ).toEqual({ targetRelPath: "src/worker.rs", targetSymbolId: "Worker.make" });
  });

  it("fans a trait-object receiver out to every local impl method", () => {
    const { resolver } = new RustLanguage();
    const table = tableWith(
      [
        "src/runner.rs",
        [sym("Runner", "src/runner.rs", [], "interface"), sym("Runner#run", "src/runner.rs", ["Runner"])],
      ],
      ["src/worker.rs", [sym("Worker", "src/worker.rs"), sym("Worker#run", "src/worker.rs", ["Worker"])]],
      ["src/server.rs", [sym("Server", "src/server.rs"), sym("Server#run", "src/server.rs", ["Server"])]],
    );
    const outcome = resolver.resolveDispatch?.(
      call("runner.run()", "runner", "run"),
      ctx({
        symbolTable: table,
        localBindings: { runner: [{ line: 1, type: "Runner" }] },
        hierarchy: hierarchyWith({ Runner: ["Worker", "Server"] }),
      }),
    );

    expect(edgesOf(outcome)).toEqual([
      {
        sourceSymbolId: null,
        targetRelPath: "src/worker.rs",
        targetSymbolId: "Worker#run",
        edgeKind: "cone",
        confidence: 0.5,
      },
      {
        sourceSymbolId: null,
        targetRelPath: "src/server.rs",
        targetSymbolId: "Server#run",
        edgeKind: "cone",
        confidence: 0.5,
      },
    ]);
  });

  it("does not resolve an impl method to an unrelated same-name method when the trait impl is ambiguous", () => {
    const resolver = new RustCallResolver();
    const table = tableWith(
      ["src/worker.rs", [sym("Worker#run", "src/worker.rs", ["Worker"])]],
      ["src/other.rs", [sym("Other#run", "src/other.rs", ["Other"])]],
    );

    expect(
      resolver.resolve(call("<Missing as Runner>::run()", "<Missing as Runner>", "run"), ctx({ symbolTable: table })),
    ).toBeNull();
  });

  it("keeps external traits as constraints while resolving the local impl method", () => {
    const resolver = new RustCallResolver();
    const table = tableWith(
      ["src/worker.rs", [sym("Worker", "src/worker.rs"), sym("Worker#fmt", "src/worker.rs", ["Worker"])]],
      ["src/other.rs", [sym("Other#fmt", "src/other.rs", ["Other"])]],
    );

    expect(
      resolver.resolve(
        call("<Worker as std::fmt::Display>::fmt(&worker)", "<Worker as std::fmt::Display>", "fmt"),
        ctx({ symbolTable: table }),
      ),
    ).toEqual({ targetRelPath: "src/worker.rs", targetSymbolId: "Worker#fmt" });
  });
});
