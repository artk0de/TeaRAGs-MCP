/**
 * bd tea-rags-mcp-nbf8q item 3 — the run-global ancestry maps are keyed by
 * class name PER LANGUAGE FAMILY.
 *
 * `classAncestors`, `classPrependedAncestors` and `classExtends` are keyed by a
 * class name a walker writes, and a top-level class's name is its bare name in
 * most languages. One run-wide record therefore let a TypeScript `class Error
 * extends BaseError` and a Ruby `class Error < StandardError` share ONE key:
 * whichever file was absorbed last answered `super` and the MRO for both. The
 * run state now partitions each map by language family (TypeScript and
 * JavaScript are one family — they resolve into each other), and the runner
 * hands a file only its own family's maps.
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
import { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const noopTable = async (): Promise<GlobalSymbolTable> => new NoopGlobalSymbolTable();
const noSymbols = { lookup: () => [] } as unknown as GlobalSymbolTable;

function file(relPath: string, language: string, extra: Partial<FileExtraction> = {}): FileExtraction {
  return { relPath, language, imports: [], fileScope: [], chunks: [], ...extra };
}

/** A TypeScript and a Ruby `Error`, each with its own parent and mixin. */
function seededState(): CodegraphRunState {
  const state = new CodegraphRunState();
  state.absorb(
    file("web/errors.ts", "typescript", {
      classAncestors: { Error: ["BaseError"], Banner: ["Reportable"] },
      classExtends: { Error: "BaseError" },
    }),
    [],
  );
  state.absorb(
    file("app/errors.rb", "ruby", {
      classAncestors: { Error: ["StandardError", "Reportable"] },
      classPrependedAncestors: { Error: ["Traced"] },
      classExtends: { Error: "StandardError" },
    }),
    [],
  );
  // A JavaScript file of the SAME family as the TypeScript one.
  state.absorb(file("web/legacy.js", "javascript", { classExtends: { LegacyError: "Error" } }), []);
  return state;
}

/** The call-site context the runner builds for `extraction`. */
async function contextFor(state: CodegraphRunState, extraction: FileExtraction): Promise<CallContext> {
  await state.seal(noopTable);
  const seen: CallContext[] = [];
  const factory = {
    supported: () => [extraction.language],
    create: () => ({
      resolver: {
        resolve: () => null,
        resolveFileEdges: (_x: FileExtraction, ctx: CallContext) => {
          seen.push(ctx);
          return [];
        },
      },
    }),
  } as unknown as LanguageFactoryDescriptor;
  new CallEdgeResolutionRunner(factory, state).resolve(extraction, noSymbols);
  const ctx = seen[0];
  if (ctx === undefined) throw new Error("runner built no context");
  return ctx;
}

describe("run-global ancestry maps are partitioned by language family (nbf8q)", () => {
  it("hands a Ruby file the Ruby `Error`, not the TypeScript one absorbed beside it", async () => {
    const ctx = await contextFor(seededState(), file("app/services/report.rb", "ruby"));
    expect(ctx.classExtends?.Error).toBe("StandardError");
    expect(ctx.classAncestors?.Error).toEqual(["StandardError", "Reportable"]);
    expect(ctx.classPrependedAncestors?.Error).toEqual(["Traced"]);
    expect(ctx.classExtends?.LegacyError).toBeUndefined();
  });

  it("hands a TypeScript file its own family's maps, JavaScript included", async () => {
    const ctx = await contextFor(seededState(), file("web/app.ts", "typescript"));
    expect(ctx.classExtends?.Error).toBe("BaseError");
    expect(ctx.classExtends?.LegacyError).toBe("Error");
    expect(ctx.classAncestors?.Error).toEqual(["BaseError"]);
  });

  it("builds the include-by index inside the family", async () => {
    const ctx = await contextFor(seededState(), file("app/services/report.rb", "ruby"));
    expect(ctx.includedBy?.Reportable).toEqual(["Error"]);
    expect(ctx.includedBy?.BaseError).toBeUndefined();
  });

  it("hydrates a persisted slice into ITS language's partition, batch-wins per family", async () => {
    const state = new CodegraphRunState();
    state.absorb(file("app/errors.rb", "ruby", { classExtends: { Error: "StandardError" } }), []);
    const slices: CodegraphPass1FileAggregates[] = [
      { relPath: "web/errors.ts", language: "typescript", classExtends: { Error: "BaseError" } },
      { relPath: "app/old_errors.rb", language: "ruby", classExtends: { Error: "RuntimeError" } },
    ];
    await state.seal(noopTable, async () => slices);
    const seen: CallContext[] = [];
    const factory = {
      supported: () => ["typescript", "ruby"],
      create: () => ({
        resolver: {
          resolve: () => null,
          resolveFileEdges: (_x: FileExtraction, ctx: CallContext) => {
            seen.push(ctx);
            return [];
          },
        },
      }),
    } as unknown as LanguageFactoryDescriptor;
    const runner = new CallEdgeResolutionRunner(factory, state);
    runner.resolve(file("web/app.ts", "typescript"), noSymbols);
    runner.resolve(file("app/report.rb", "ruby"), noSymbols);
    expect(seen.map((ctx) => ctx.classExtends?.Error)).toEqual(["BaseError", "StandardError"]);
  });
});
