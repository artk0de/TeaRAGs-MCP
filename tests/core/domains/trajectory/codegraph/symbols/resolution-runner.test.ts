/**
 * CallEdgeResolutionRunner (bd tea-rags-mcp-6vfrj / G2) — pass-2 per-file call
 * resolution, extracted verbatim from
 * `CodegraphEnrichmentProvider#resolveExtraction`. Language capability arrives
 * ONLY through the injected `LanguageFactoryDescriptor` (leaf-domain guard),
 * and every resolve outcome is tallied back into `CodegraphRunState.stats`.
 */

import { afterEach, describe, expect, it } from "vitest";

import type {
  CallContext,
  FileExtraction,
  GlobalSymbolTable,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageFactoryDescriptor } from "../../../../../../src/core/contracts/types/language.js";
import { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

describe("CallEdgeResolutionRunner.resolve", () => {
  it("returns empty edges for a language the factory does not support, without ever creating a resolver", () => {
    const languageFactory = {
      supported: () => ["typescript"],
      create: () => {
        throw new Error("must not be called for an unregistered language");
      },
    } as unknown as LanguageFactoryDescriptor;
    const runner = new CallEdgeResolutionRunner(languageFactory, new CodegraphRunState());
    const extraction: FileExtraction = {
      relPath: "src/a.py",
      language: "python",
      imports: [],
      chunks: [],
      fileScope: [],
    };

    const edges = runner.resolve(extraction, {} as GlobalSymbolTable);

    expect(edges).toEqual({ fileEdges: [], methodEdges: [] });
  });

  it("buckets a dynamicSend call as unresolvable rather than a genuine or external miss", () => {
    const runState = new CodegraphRunState();
    const languageFactory = {
      supported: () => ["ruby"],
      create: () => ({
        resolver: {
          // Never resolves — the point is to reach classifyMiss, which
          // dynamicSend short-circuits BEFORE the external / no-in-project-def
          // classifiers run.
          resolve: () => null,
        },
      }),
    } as unknown as LanguageFactoryDescriptor;
    const runner = new CallEdgeResolutionRunner(languageFactory, runState);
    const extraction: FileExtraction = {
      relPath: "app/models/account.rb",
      language: "ruby",
      imports: [],
      fileScope: [],
      chunks: [
        {
          symbolId: "Account#dispatch",
          scope: ["Account"],
          calls: [
            {
              callText: "send(action)",
              receiver: null,
              member: "action",
              startLine: 10,
              dynamicSend: true,
            },
          ],
        },
      ],
    };

    const edges = runner.resolve(extraction, {} as GlobalSymbolTable);

    expect(edges.methodEdges).toHaveLength(0);
    expect(runState.stats.callsAttempted).toBe(1);
    expect(runState.stats.callsResolved).toBe(0);
    expect(runState.stats.callsUnresolvable).toBe(1);
    // Not a genuine miss and not external — dynamicSend has its own bucket.
    expect(runState.stats.callsNoInProjectDef).toBe(0);
    expect(runState.stats.callsExternalSkipped).toBe(0);
  });
});

describe("CallEdgeResolutionRunner picks its run-global inputs in constant time (bd tea-rags-mcp-8zwl9)", () => {
  const originalKeys = Object.keys;

  afterEach(() => {
    Object.keys = originalKeys;
  });

  /** Fill every run-global map `buildResolverInputs` consults, via pass-1 absorb. */
  function absorbLargeRunGlobals(runState: CodegraphRunState, entries: number): void {
    const classAncestors: Record<string, string[]> = {};
    const classPrependedAncestors: Record<string, string[]> = {};
    const classExtends: Record<string, string> = {};
    const functionReturnTypes: Record<string, string> = {};
    const ivarTypes: Record<string, Record<string, string>> = {};
    const structuredReturnTypes: Record<string, { form: "instance"; name: string }> = {};
    for (let i = 0; i < entries; i++) {
      classAncestors[`C${i}`] = [`Base${i}`];
      classPrependedAncestors[`C${i}`] = [`Pre${i}`];
      classExtends[`C${i}`] = `Base${i}`;
      functionReturnTypes[`f${i}`] = `T${i}`;
      ivarTypes[`C${i}`] = { "@x": `T${i}` };
      structuredReturnTypes[`C${i}#m`] = { form: "instance", name: `T${i}` };
    }
    runState.absorb(
      {
        relPath: "app/models/seed.rb",
        language: "ruby",
        imports: [],
        fileScope: [],
        chunks: [],
        classAncestors,
        classPrependedAncestors,
        classExtends,
        functionReturnTypes,
        ivarTypes,
        structuredReturnTypes,
      } as unknown as FileExtraction,
      [],
    );
  }

  function emptyExtraction(relPath: string): FileExtraction {
    return { relPath, language: "ruby", imports: [], fileScope: [], chunks: [] };
  }

  const factoryWith = (resolver: unknown): LanguageFactoryDescriptor =>
    ({ supported: () => ["ruby"], create: () => ({ resolver }) }) as unknown as LanguageFactoryDescriptor;

  /** Enough symbol table for `normalizeInheritanceEdges` to resolve nothing. */
  const noSymbols = { lookup: () => [] } as unknown as GlobalSymbolTable;

  it("does not allocate a key array per run-global map per resolved file", () => {
    const runState = new CodegraphRunState();
    absorbLargeRunGlobals(runState, 2000);
    const runner = new CallEdgeResolutionRunner(factoryWith({ resolve: () => null }), runState);

    // Count ONLY key arrays taken of the run-global maps themselves — `absorb`
    // and the inheritance normalizer legitimately walk the per-file extraction.
    const runGlobals = new Set<object>([
      runState.ancestors,
      runState.prependedAncestors,
      runState.classExtends,
      runState.returnTypes,
      runState.ivarTypes,
      runState.structuredReturnTypes,
    ]);
    let keysAllocated = 0;
    Object.keys = ((target: object): string[] => {
      const keys = originalKeys(target);
      if (runGlobals.has(target)) keysAllocated += keys.length;
      return keys;
    }) as typeof Object.keys;

    for (let i = 0; i < 10; i++) runner.resolve(emptyExtraction(`app/models/m${i}.rb`), noSymbols);

    // Asking "is this map empty" must not cost a full key array of a map that
    // grows across the WHOLE run: this is files x maps x map-size of pure
    // waste, the same shape already fixed once here for `includedBy`.
    expect(keysAllocated).toBe(0);
  });

  it("still prefers the run-global map when populated and the file's own when not", () => {
    const captured: CallContext[] = [];
    const resolver = {
      resolve: () => null,
      resolveFileEdges: (_extraction: FileExtraction, ctx: CallContext) => {
        captured.push(ctx);
        return [];
      },
    };
    const fileOwn = {
      classAncestors: { Local: ["LocalBase"] },
      classPrependedAncestors: { Local: ["LocalPre"] },
      classExtends: { Local: "LocalBase" },
      ivarTypes: { Local: { "@y": "LocalT" } },
      structuredReturnTypes: { "Local#m": { form: "instance" as const, name: "LocalT" } },
    };
    const extraction = { ...emptyExtraction("app/models/local.rb"), ...fileOwn } as unknown as FileExtraction;

    // Nothing absorbed: the file's own maps are the only evidence there is.
    const cold = new CodegraphRunState();
    new CallEdgeResolutionRunner(factoryWith(resolver), cold).resolve(extraction, noSymbols);

    // Pass-1 contributed: the run-global maps win, because the declaring file
    // is usually not the calling file.
    const warm = new CodegraphRunState();
    absorbLargeRunGlobals(warm, 3);
    new CallEdgeResolutionRunner(factoryWith(resolver), warm).resolve(extraction, noSymbols);

    expect(captured).toHaveLength(2);
    const [fromCold, fromWarm] = captured;
    expect(fromCold?.classAncestors).toBe(extraction.classAncestors);
    expect(fromCold?.classPrependedAncestors).toBe(extraction.classPrependedAncestors);
    expect(fromCold?.classExtends).toBe(extraction.classExtends);
    expect(fromCold?.ivarTypes).toBe(extraction.ivarTypes);
    expect(fromCold?.structuredReturnTypes).toBe(extraction.structuredReturnTypes);
    expect(fromWarm?.classAncestors).toBe(warm.ancestors);
    expect(fromWarm?.classPrependedAncestors).toBe(warm.prependedAncestors);
    expect(fromWarm?.classExtends).toBe(warm.classExtends);
    expect(fromWarm?.ivarTypes).toBe(warm.ivarTypes);
    expect(fromWarm?.structuredReturnTypes).toBe(warm.structuredReturnTypes);
  });

  it("treats a map an extraction declared but left empty as unpopulated", () => {
    const runState = new CodegraphRunState();
    // The field is PRESENT but contributes no entry — `Object.keys().length > 0`
    // reads false here, and a flag set on field presence rather than on an
    // actual write would read true.
    runState.absorb({ ...emptyExtraction("app/models/empty.rb"), classAncestors: {} } as unknown as FileExtraction, []);
    const captured: CallContext[] = [];
    const resolver = {
      resolve: () => null,
      resolveFileEdges: (_e: FileExtraction, ctx: CallContext) => {
        captured.push(ctx);
        return [];
      },
    };
    const extraction = {
      ...emptyExtraction("app/models/local.rb"),
      classAncestors: { Local: ["LocalBase"] },
    } as unknown as FileExtraction;

    new CallEdgeResolutionRunner(factoryWith(resolver), runState).resolve(extraction, noSymbols);

    expect(captured[0]?.classAncestors).toBe(extraction.classAncestors);
  });
});
