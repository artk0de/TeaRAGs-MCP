/**
 * The run-global channel contract (bd tea-rags-mcp-w205u, E4.6-close).
 *
 * `ResolverInputs` is the "run-global if any file contributed, else this file's
 * own" selection the runner resolves ONCE per file. Every channel it carries
 * must reach the resolver, and the runner builds TWO `CallContext`s — one for
 * file edges, one per call site. Between bd tea-rags-mcp-f0xaa and E4.6c
 * `classFieldTypesByClassKey` reached NEITHER: the field was added, populated
 * from run state, and hand-copied into no literal, so production resolved
 * without an arm both measurement harnesses had. `functionReturnTypes` and
 * `instantiatedTypes` carried the same asymmetry on the file-edge literal,
 * inherited from the pre-`CallEdgeResolutionRunner` provider.
 *
 * This file is the guard that bug lacked. The channel list is derived from
 * `keyof ResolverInputs`, so a NEW channel fails the type check until it is
 * mapped, and fails the assertion until it is threaded.
 */

import { describe, expect, it } from "vitest";

import type {
  CallContext,
  FileExtraction,
  GlobalSymbolTable,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageFactoryDescriptor } from "../../../../../../src/core/contracts/types/language.js";
import {
  CallEdgeResolutionRunner,
  type ResolverInputs,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

/**
 * Where each `ResolverInputs` channel lands on a `CallContext`. The `satisfies`
 * is the compile-time half of the guard: adding a channel to `ResolverInputs`
 * without naming its destination here stops type-checking.
 */
const CHANNEL_DESTINATION = {
  ancestors: "classAncestors",
  prependedAncestors: "classPrependedAncestors",
  includedBy: "includedBy",
  classExtends: "classExtends",
  returnTypes: "functionReturnTypes",
  instantiatedTypes: "instantiatedTypes",
  ivarTypes: "ivarTypes",
  structuredReturnTypes: "structuredReturnTypes",
  classFieldTypes: "classFieldTypes",
  classFieldTypesByClassKey: "classFieldTypesByClassKey",
  classFieldCallResults: "classFieldCallResults",
  moduleReexports: "moduleReexports",
} as const satisfies Record<keyof ResolverInputs, keyof CallContext>;

const CLASS_KEY = "src/pkg/svc.py::Svc";

/**
 * A run state with EVERY run-global channel non-empty, seeded the way pass-1
 * seeds it. `absorb` is the only writer that flips `hasRunGlobalEntries`, and
 * that flag is what sends `buildResolverInputs` down the run-global arm rather
 * than the per-file fallback — assigning the maps by hand would test the
 * fallback and call it the real thing.
 */
function seededRunState(): CodegraphRunState {
  const state = new CodegraphRunState();
  state.absorb(
    {
      relPath: "src/pkg/svc.py",
      language: "python",
      fileScope: [],
      imports: [],
      chunks: [],
      classAncestors: { Svc: ["Base"] },
      classPrependedAncestors: { Svc: ["Mixin"] },
      classExtends: { Svc: "Base" },
      functionReturnTypes: { get_client: "Client" },
      instantiatedTypes: ["Svc"],
      ivarTypes: { Svc: { "@client": "Client" } },
      structuredReturnTypes: { "Svc#build": { form: "instance", name: "Client" } },
      classFieldTypesByClassKey: { [CLASS_KEY]: { client: "Client" } },
      classFieldCallResults: { [CLASS_KEY]: { repo: "from_session" } },
      moduleReexports: [{ exportedName: "svc", sourceModule: ".", sourceName: "_svc" }],
    },
    [],
  );
  return state;
}

/** One import (drives the file-edge context) and one call (drives the call-site one). */
const EXTRACTION: FileExtraction = {
  relPath: "src/pkg/caller.py",
  language: "python",
  fileScope: [],
  imports: [{ importText: "pkg.svc", startLine: 1 }],
  classFieldTypes: { Svc: { client: "Client" } },
  chunks: [
    {
      symbolId: "Caller#run",
      scope: ["Caller"],
      startLine: 10,
      calls: [{ callText: "self.client.send()", receiver: "self.client", member: "send", startLine: 12 }],
    },
  ],
};

/** Both contexts the runner builds for one file, captured off the resolver. */
function capturedContexts(): { fileEdge: CallContext; callSite: CallContext } {
  const seen: CallContext[] = [];
  const languageFactory = {
    supported: () => ["python"],
    create: () => ({
      resolver: {
        resolve: (_call: unknown, ctx: CallContext) => {
          seen.push(ctx);
          return null;
        },
      },
    }),
  } as unknown as LanguageFactoryDescriptor;

  new CallEdgeResolutionRunner(languageFactory, seededRunState()).resolve(EXTRACTION, {
    lookup: () => [],
    lookupByShortName: () => [],
  } as unknown as GlobalSymbolTable);

  // The file-edge context has no caller symbol — it addresses the FILE, not a
  // chunk. That is the only structural difference that separates the two.
  const fileEdge = seen.find((ctx) => ctx.callerSymbolId === undefined);
  const callSite = seen.find((ctx) => ctx.callerSymbolId === "Caller#run");
  if (!fileEdge || !callSite) throw new Error(`expected both contexts, saw ${seen.length}`);
  return { fileEdge, callSite };
}

describe("CallEdgeResolutionRunner run-global channel threading", () => {
  const { fileEdge, callSite } = capturedContexts();
  const channels = Object.entries(CHANNEL_DESTINATION) as [keyof ResolverInputs, keyof CallContext][];

  it("enumerates every ResolverInputs channel, so a new one cannot be skipped", () => {
    expect(channels).toHaveLength(12);
  });

  it.each(channels)("threads %s into the call-site CallContext as %s", (_input, destination) => {
    expect(callSite[destination]).toBeDefined();
  });

  it.each(channels)("threads %s into the file-edge CallContext as %s", (_input, destination) => {
    expect(fileEdge[destination]).toBeDefined();
  });

  it("hands both contexts the SAME run-global objects, not per-site copies", () => {
    for (const [, destination] of channels) {
      expect(callSite[destination]).toBe(fileEdge[destination]);
    }
  });

  it("carries the content the run state holds, not an empty placeholder", () => {
    // The RF.10 shape: present-but-empty reads identically to absent at every
    // call site, so a threading guard that only checks for a key is no guard.
    expect(callSite.classFieldTypesByClassKey?.[CLASS_KEY]).toEqual({ client: "Client" });
    expect(callSite.classFieldCallResults?.[CLASS_KEY]).toEqual({ repo: "from_session" });
    expect(callSite.moduleReexports?.["src/pkg/svc.py"]).toHaveLength(1);
    expect(callSite.functionReturnTypes).toEqual({ get_client: "Client" });
    expect(fileEdge.classFieldTypesByClassKey?.[CLASS_KEY]).toEqual({ client: "Client" });
    expect(fileEdge.instantiatedTypes?.has("Svc")).toBe(true);
  });
});
