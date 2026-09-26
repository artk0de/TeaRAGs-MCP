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
  SymbolResolutionPassPlan,
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
      },
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
    Object.keys = (target: object): string[] => {
      const keys = originalKeys(target);
      if (runGlobals.has(target)) keysAllocated += keys.length;
      return keys;
    };

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
    runState.absorb({ ...emptyExtraction("app/models/empty.rb"), classAncestors: {} }, []);
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

describe("CallEdgeResolutionRunner.resolve — file-edge dedup", () => {
  const emptyExtraction = (relPath: string): FileExtraction => ({
    relPath,
    language: "typescript",
    imports: [],
    fileScope: [],
    chunks: [],
  });

  const factoryWith = (resolver: unknown): LanguageFactoryDescriptor =>
    ({ supported: () => ["typescript"], create: () => ({ resolver }) }) as unknown as LanguageFactoryDescriptor;

  it("collapses two imports resolving to the same target file into one fileEdges entry (bd tea-rags-mcp-alew8)", () => {
    // Mirrors a live taxdome crash: AiToasts.tsx imports Button.tsx via both a
    // default and a named import. resolveFileEdges (TS's own, or the generic
    // fallback) pushes one row per import statement with no target dedup, so
    // upsertFilesBulk tried to insert the same (source, target) pair twice in
    // one transaction — DuckDB's PRIMARY KEY constraint doesn't reject that
    // gracefully, it crashes the daemon process outright (native
    // FatalException, taking the whole pass-2 run down with it).
    const resolver = {
      resolve: () => null,
      resolveFileEdges: () => [
        { targetRelPath: "src/ui-kit/Button.tsx", importText: "./Button" },
        { targetRelPath: "src/ui-kit/Button.tsx", importText: "{ ButtonProps } from './Button'" },
      ],
    };
    const runner = new CallEdgeResolutionRunner(factoryWith(resolver), new CodegraphRunState());

    const edges = runner.resolve(emptyExtraction("src/AiToasts.tsx"), {} as GlobalSymbolTable);

    expect(edges.fileEdges).toHaveLength(1);
    expect(edges.fileEdges[0]?.targetRelPath).toBe("src/ui-kit/Button.tsx");
  });

  it("keeps distinct targets from different imports untouched", () => {
    const resolver = {
      resolve: () => null,
      resolveFileEdges: () => [
        { targetRelPath: "src/a.tsx", importText: "./a" },
        { targetRelPath: "src/b.tsx", importText: "./b" },
      ],
    };
    const runner = new CallEdgeResolutionRunner(factoryWith(resolver), new CodegraphRunState());

    const edges = runner.resolve(emptyExtraction("src/caller.tsx"), {} as GlobalSymbolTable);

    expect(edges.fileEdges.map((e) => e.targetRelPath).sort()).toEqual(["src/a.tsx", "src/b.tsx"]);
  });

  it("unions the export names of every import collapsed into one edge (bd tea-rags-mcp-r8hme.2)", () => {
    // `import D from "./Button"` + `import { Props } from "./Button"` +
    // `export { Size } from "./Button"` is ONE persisted edge; dropping the
    // later statements' names would tell the facade check the file imports
    // only `default` from Button.
    const resolver = {
      resolve: () => null,
      resolveFileEdges: () => [
        { targetRelPath: "src/Button.tsx", importText: "./Button", importedExportNames: ["default"] },
        { targetRelPath: "src/Button.tsx", importText: "./Button", importedExportNames: ["Props", "default"] },
        { targetRelPath: "src/Button.tsx", importText: "./Button", reexportedExportNames: ["Size"] },
        { targetRelPath: "src/Button.tsx", importText: "./Button" },
        { targetRelPath: "src/plain.tsx", importText: "./plain" },
      ],
    };
    const runner = new CallEdgeResolutionRunner(factoryWith(resolver), new CodegraphRunState());

    const edges = runner.resolve(emptyExtraction("src/Page.tsx"), {} as GlobalSymbolTable);

    expect(edges.fileEdges).toEqual([
      {
        targetRelPath: "src/Button.tsx",
        importText: "./Button",
        importedExportNames: ["default", "Props"],
        reexportedExportNames: ["Size"],
      },
      { targetRelPath: "src/plain.tsx", importText: "./plain" },
    ]);
    expect(Object.keys(edges.fileEdges[1] ?? {})).toEqual(["targetRelPath", "importText"]);
  });

  it("hands resolveFileEdges this file's already-resolved method edges (bd tea-rags-mcp-y99pg.38)", () => {
    // A language whose imports name no file derives its file graph from where
    // its calls land, so call sites must resolve BEFORE file edges are built.
    const seen: unknown[] = [];
    const resolver = {
      resolve: () => ({ targetSymbolId: "B#go", targetRelPath: "src/b.tsx" }),
      resolveFileEdges: (_extraction: unknown, _ctx: unknown, resolvedMethodEdges: unknown) => {
        seen.push(resolvedMethodEdges);
        return [];
      },
    };
    const runner = new CallEdgeResolutionRunner(factoryWith(resolver), new CodegraphRunState());
    const extraction: FileExtraction = {
      ...emptyExtraction("src/a.tsx"),
      chunks: [
        {
          symbolId: "A#run",
          scope: ["A"],
          calls: [{ callText: "b.go()", receiver: "b", member: "go", startLine: 3 }],
        },
      ],
    };

    const edges = runner.resolve(extraction, { lookupByShortName: () => [] } as unknown as GlobalSymbolTable);

    expect(seen).toEqual([edges.methodEdges]);
    expect(edges.methodEdges.map((e) => e.targetRelPath)).toEqual(["src/b.tsx"]);
  });
});

describe("CallEdgeResolutionRunner.resolve — type-only file edges (bd tea-rags-mcp-r8hme.12)", () => {
  // Maps every import the extraction it is handed carries, by the same
  // import→file path either channel goes through.
  const importDrivenResolver = {
    resolve: () => null,
    resolveFileEdges: (extraction: FileExtraction) =>
      extraction.imports.map((imp) => ({
        targetRelPath: `src/${imp.importText.slice(2)}.ts`,
        importText: imp.importText,
      })),
  };
  const runner = () =>
    new CallEdgeResolutionRunner(
      {
        supported: () => ["typescript"],
        create: () => ({ resolver: importDrivenResolver }),
      } as unknown as LanguageFactoryDescriptor,
      new CodegraphRunState(),
    );
  const extraction = (imports: string[], typeOnlyImports: string[]): FileExtraction => ({
    relPath: "src/server.ts",
    language: "typescript",
    imports: imports.map((importText) => ({ importText, startLine: 1 })),
    typeOnlyImports: typeOnlyImports.map((importText) => ({ importText, startLine: 1 })),
    fileScope: [],
    chunks: [],
  });

  it("resolves type-only imports onto typeOnlyFileEdges and keeps them out of fileEdges", () => {
    const edges = runner().resolve(extraction(["./runner"], ["./protocol", "./protocol"]), {} as GlobalSymbolTable);

    expect(edges.fileEdges).toEqual([{ targetRelPath: "src/runner.ts", importText: "./runner" }]);
    expect(edges.typeOnlyFileEdges).toEqual([{ targetRelPath: "src/protocol.ts", importText: "./protocol" }]);
  });

  it("drops a type-only edge whose target a runtime import already reaches, and a self-edge", () => {
    const edges = runner().resolve(extraction(["./runner"], ["./runner", "./server"]), {} as GlobalSymbolTable);

    expect(edges.fileEdges).toEqual([{ targetRelPath: "src/runner.ts", importText: "./runner" }]);
    expect(edges).not.toHaveProperty("typeOnlyFileEdges");
  });

  it("routes an import flagged typeOnly on imports[] (Python `if TYPE_CHECKING:`) to typeOnlyFileEdges", () => {
    const seenImports: string[][] = [];
    const recordingResolver = {
      resolve: () => null,
      resolveFileEdges: (ext: FileExtraction) => {
        seenImports.push(ext.imports.map((i) => i.importText));
        return importDrivenResolver.resolveFileEdges(ext);
      },
    };
    const pythonRunner = new CallEdgeResolutionRunner(
      {
        supported: () => ["python"],
        create: () => ({ resolver: recordingResolver }),
      } as unknown as LanguageFactoryDescriptor,
      new CodegraphRunState(),
    );
    const edges = pythonRunner.resolve(
      {
        relPath: "src/views.py",
        language: "python",
        imports: [
          { importText: "./forms", startLine: 1 },
          { importText: "./models", startLine: 3, typeOnly: true },
        ],
        fileScope: [],
        chunks: [],
      },
      {} as GlobalSymbolTable,
    );

    expect(edges.fileEdges).toEqual([{ targetRelPath: "src/forms.ts", importText: "./forms" }]);
    expect(edges.typeOnlyFileEdges).toEqual([{ targetRelPath: "src/models.ts", importText: "./models" }]);
    expect(seenImports).toEqual([["./forms"], ["./models"]]);
  });
});

describe("CallEdgeResolutionRunner.prepareResolvePass (bd tea-rags-mcp-6aytq)", () => {
  function absorbFiles(runState: CodegraphRunState, language: string, count: number): void {
    for (let i = 0; i < count; i++) {
      runState.absorb({ relPath: `f${i}.${language}`, language, imports: [], fileScope: [], chunks: [] }, []);
    }
  }

  it("hands every language its OWN file count, file list, and the run's project root", () => {
    const runState = new CodegraphRunState();
    runState.projectRoot = "/repo";
    absorbFiles(runState, "typescript", 3);
    absorbFiles(runState, "ruby", 1);
    const plans: Record<string, SymbolResolutionPassPlan> = {};
    const languageFactory = {
      supported: () => ["typescript", "ruby"],
      create: (language: string) => ({
        resolver: {
          resolve: () => null,
          prepareResolvePass: (plan: SymbolResolutionPassPlan) => {
            plans[language] = plan;
          },
        },
      }),
    } as unknown as LanguageFactoryDescriptor;

    new CallEdgeResolutionRunner(languageFactory, runState).prepareResolvePass();

    // The LIST joins the count because the two answer different questions (bd
    // tea-rags-mcp-6aytq): the count says whether a bulk-only cache is worth
    // priming, the list says which files that cache must be rooted at — on
    // taxdome 936 of the run's TypeScript files are outside the set the
    // project's own tsconfig claims.
    expect(plans["typescript"]).toEqual({
      expectedFileCount: 3,
      expectedRelPaths: ["f0.typescript", "f1.typescript", "f2.typescript"],
      projectRoot: "/repo",
    });
    expect(plans["ruby"]).toEqual({
      expectedFileCount: 1,
      expectedRelPaths: ["f0.ruby"],
      projectRoot: "/repo",
    });
  });

  it("collects each language resolver's diagnostics, skipping the ones that declare none", () => {
    const runState = new CodegraphRunState();
    absorbFiles(runState, "typescript", 2);
    absorbFiles(runState, "ruby", 1);
    const languageFactory = {
      supported: () => ["typescript", "ruby"],
      create: (language: string) => ({
        resolver:
          language === "typescript"
            ? { resolve: () => null, diagnostics: () => ({ wholeProgramFiles: 18042, entryBuilds: 0 }) }
            : { resolve: () => null },
      }),
    } as unknown as LanguageFactoryDescriptor;

    const diagnostics = new CallEdgeResolutionRunner(languageFactory, runState).resolverDiagnostics();

    expect(diagnostics).toEqual({ typescript: { wholeProgramFiles: 18042, entryBuilds: 0 } });
  });

  it("never creates a resolver for a language the factory does not support", () => {
    const runState = new CodegraphRunState();
    absorbFiles(runState, "python", 500);
    const languageFactory = {
      supported: () => ["typescript"],
      create: () => {
        throw new Error("must not be called for an unregistered language");
      },
    } as unknown as LanguageFactoryDescriptor;
    const runner = new CallEdgeResolutionRunner(languageFactory, runState);

    expect(() => {
      runner.prepareResolvePass();
    }).not.toThrow();
  });

  it("is a no-op for a language whose resolver declares no prepare hook", () => {
    const runState = new CodegraphRunState();
    absorbFiles(runState, "ruby", 500);
    const languageFactory = {
      supported: () => ["ruby"],
      create: () => ({ resolver: { resolve: () => null } }),
    } as unknown as LanguageFactoryDescriptor;
    const runner = new CallEdgeResolutionRunner(languageFactory, runState);

    expect(() => {
      runner.prepareResolvePass();
    }).not.toThrow();
  });
});

describe("CallEdgeResolutionRunner closure-batch visit order (bd tea-rags-mcp-vtuu4)", () => {
  function extraction(relPath: string, language: string, callCount: number): FileExtraction {
    return {
      relPath,
      language,
      imports: [],
      fileScope: [],
      chunks: [
        {
          symbolId: "f",
          scope: [],
          calls: Array.from({ length: callCount }, (_, i) => ({
            callText: `g${i}()`,
            receiver: null,
            member: `g${i}`,
            startLine: i,
          })),
        },
      ],
    };
  }

  it("passes pass-1 call-site counts on the resolve plan", () => {
    const runState = new CodegraphRunState();
    runState.absorb(extraction("a.ts", "typescript", 3), []);
    runState.absorb(extraction("b.ts", "typescript", 0), []);
    runState.absorb(extraction("c.rb", "ruby", 2), []);
    const plans: Record<string, SymbolResolutionPassPlan> = {};
    const languageFactory = {
      supported: () => ["typescript", "ruby"],
      create: (language: string) => ({
        resolver: {
          resolve: () => null,
          prepareResolvePass: (plan: SymbolResolutionPassPlan) => {
            plans[language] = plan;
          },
        },
      }),
    } as unknown as LanguageFactoryDescriptor;

    new CallEdgeResolutionRunner(languageFactory, runState).prepareResolvePass();

    // Per language, and only files that have calls: a file the map does not
    // name counts zero.
    expect(plans["typescript"]?.expectedCallSites).toEqual(new Map([["a.ts", 3]]));
    expect(plans["ruby"]?.expectedCallSites).toEqual(new Map([["c.rb", 2]]));
  });

  it("hands each language's visit plan to pass-2 and forwards group ends", () => {
    const runState = new CodegraphRunState();
    runState.absorb(extraction("a.ts", "typescript", 0), []);
    runState.absorb(extraction("c.rb", "ruby", 0), []);
    let groupEnds = 0;
    const languageFactory = {
      supported: () => ["typescript", "ruby"],
      create: (language: string) => ({
        resolver:
          language === "typescript"
            ? {
                resolve: () => null,
                planResolveVisits: () => [["a.ts"], ["big.ts"]],
                endResolveVisitGroup: () => {
                  groupEnds += 1;
                },
              }
            : { resolve: () => null },
      }),
    } as unknown as LanguageFactoryDescriptor;

    const plans = new CallEdgeResolutionRunner(languageFactory, runState).resolveVisitPlans();

    expect(plans.map(({ language, groups }) => ({ language, groups }))).toEqual([
      { language: "typescript", groups: [["a.ts"], ["big.ts"]] },
    ]);
    plans[0]?.endGroup();
    expect(groupEnds).toBe(1);
  });

  it("offers no visit plan for a resolver that answers without one", () => {
    const runState = new CodegraphRunState();
    runState.absorb(extraction("a.ts", "typescript", 0), []);
    const languageFactory = {
      supported: () => ["typescript"],
      create: () => ({ resolver: { resolve: () => null, planResolveVisits: () => undefined } }),
    } as unknown as LanguageFactoryDescriptor;

    expect(new CallEdgeResolutionRunner(languageFactory, runState).resolveVisitPlans()).toEqual([]);
  });
});
