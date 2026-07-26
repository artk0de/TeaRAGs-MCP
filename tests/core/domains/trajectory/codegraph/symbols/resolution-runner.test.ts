/**
 * CallEdgeResolutionRunner (bd tea-rags-mcp-6vfrj / G2) — pass-2 per-file call
 * resolution, extracted verbatim from
 * `CodegraphEnrichmentProvider#resolveExtraction`. Language capability arrives
 * ONLY through the injected `LanguageFactoryDescriptor` (leaf-domain guard),
 * and every resolve outcome is tallied back into `CodegraphRunState.stats`.
 */

import { describe, expect, it } from "vitest";

import type { FileExtraction, GlobalSymbolTable } from "../../../../../../src/core/contracts/types/codegraph.js";
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
