/**
 * resolver-batch (bd tea-rags-mcp-4qdj0) — the batch-shaped decoration
 * resolvers. Pins the two contracts that make a symbols[] batch cheap without
 * changing any answer: prefetch collapses the DERIVABLE ids into one inner
 * call per resolver, and repeat ids (across addresses) never re-fetch. A miss
 * falls through to the inner resolver — same rows as unwrapped.
 */

import { describe, expect, it, vi } from "vitest";

import type {
  ContainerAncestorResolver,
  InheritanceEdge,
  SymbolVisibilityResolver,
} from "../../../../src/core/contracts/types/codegraph.js";
import { batchedResolvers, containerIdsOf } from "../../../../src/core/domains/explore/resolver-batch.js";

const TREE = {} as never; // stand-in reader — only identity/keying matters here

describe("containerIdsOf", () => {
  it("derives the member's container and the container's parent namespace", () => {
    expect(containerIdsOf(["Tax::Automations::Registry#capabilities_for"])).toEqual([
      "Tax::Automations::Registry",
      "Tax::Automations",
    ]);
  });

  it("keeps a scope id as its own container and skips bare names' unknowable parents", () => {
    expect(containerIdsOf(["Foo::Bar", "Registry"])).toEqual(["Foo::Bar", "Foo", "Registry"]);
  });
});

describe("batchedResolvers", () => {
  it("prefetch issues ONE inner call per resolver and serves every prefetched id from cache", async () => {
    const ancestors: ContainerAncestorResolver = {
      resolveContainerAncestors: vi.fn(
        async (_c: string, ids: readonly string[]): Promise<InheritanceEdge[]> =>
          ids.flatMap((id) => [
            {
              sourceFqName: id,
              ancestorFqName: `${id}::Parent`,
              ancestorSymbolId: null,
              kind: "extend" as const,
              depth: 1,
            },
          ]),
      ),
    };
    const visibility: SymbolVisibilityResolver = {
      resolveSymbolVisibilities: vi.fn(async (_c: string, ids: readonly string[]) =>
        ids.map((id) => ({ relPath: "a.rb", symbolId: id, visibility: "public" as const })),
      ),
    };

    const batch = batchedResolvers(ancestors, visibility);
    await batch.prefetch("c", ["A::B", "A"]);

    expect(ancestors.resolveContainerAncestors).toHaveBeenCalledTimes(1);
    expect(visibility.resolveSymbolVisibilities).toHaveBeenCalledTimes(1);

    // Per-address resolves over the prefetched ids: no further inner calls.
    const edges = await batch.ancestors!.resolveContainerAncestors("c", ["A::B"]);
    expect(edges).toEqual([
      { sourceFqName: "A::B", ancestorFqName: "A::B::Parent", ancestorSymbolId: null, kind: "extend", depth: 1 },
    ]);
    const rows = await batch.visibility!.resolveSymbolVisibilities("c", ["A::B", "A"]);
    expect(rows.map((r) => r.symbolId)).toEqual(["A::B", "A"]);
    expect(ancestors.resolveContainerAncestors).toHaveBeenCalledTimes(1);
    expect(visibility.resolveSymbolVisibilities).toHaveBeenCalledTimes(1);
  });

  it("falls through to the inner resolver for a miss and caches it for the next address", async () => {
    const ancestors: ContainerAncestorResolver = {
      resolveContainerAncestors: vi.fn(
        async (_c: string, ids: readonly string[]): Promise<InheritanceEdge[]> =>
          ids.map((id) => ({
            sourceFqName: id,
            ancestorFqName: "Any",
            ancestorSymbolId: null,
            kind: "extend" as const,
            depth: 1,
          })),
      ),
    };
    const batch = batchedResolvers(ancestors, undefined);
    await batch.prefetch("c", ["A"]);

    const miss = await batch.ancestors!.resolveContainerAncestors("c", ["A", "Missed::Id"]);
    expect(miss.map((e) => e.sourceFqName)).toEqual(["A", "Missed::Id"]);
    expect(ancestors.resolveContainerAncestors).toHaveBeenCalledTimes(2);

    const repeat = await batch.ancestors!.resolveContainerAncestors("c", ["Missed::Id"]);
    expect(repeat.map((e) => e.sourceFqName)).toEqual(["Missed::Id"]);
    expect(ancestors.resolveContainerAncestors).toHaveBeenCalledTimes(2);
  });

  it("keeps tree reads and index reads in separate cache slots", async () => {
    const ancestors: ContainerAncestorResolver = {
      resolveContainerAncestors: vi.fn(
        async (_c: string, ids: readonly string[]): Promise<InheritanceEdge[]> =>
          ids.map((id) => ({
            sourceFqName: id,
            ancestorFqName: "Any",
            ancestorSymbolId: null,
            kind: "extend" as const,
            depth: 1,
          })),
      ),
    };
    const batch = batchedResolvers(ancestors, undefined);
    await batch.prefetch("c", ["A"]);

    await batch.ancestors!.resolveContainerAncestors("c", ["A"], TREE);
    expect(ancestors.resolveContainerAncestors).toHaveBeenCalledTimes(2);
    await batch.ancestors!.resolveContainerAncestors("c", ["A"], TREE);
    expect(ancestors.resolveContainerAncestors).toHaveBeenCalledTimes(2);
  });

  it("passes inner failures through unwrapped-style and reserves the ids against retry storms", async () => {
    let calls = 0;
    const ancestors: ContainerAncestorResolver = {
      resolveContainerAncestors: vi.fn(async () => {
        calls += 1;
        throw new Error("graph down");
      }),
    };
    const batch = batchedResolvers(ancestors, undefined);
    await expect(batch.prefetch("c", ["A"])).resolves.toBeUndefined(); // prefetch never fails the batch

    // The wave swallows the fetch failure (the consumers degrade on resolver
    // errors anyway) and reserves the ids: every address reads empty
    // decoration, and the failing resolver is not re-asked per address.
    await expect(batch.ancestors!.resolveContainerAncestors("c", ["A"])).resolves.toEqual([]);
    await expect(batch.ancestors!.resolveContainerAncestors("c", ["A"])).resolves.toEqual([]);
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("merges misses arriving inside the wave window into ONE inner call", async () => {
    const ancestors: ContainerAncestorResolver = {
      resolveContainerAncestors: vi.fn(
        async (_c: string, ids: readonly string[]): Promise<InheritanceEdge[]> =>
          ids.map((id) => ({
            sourceFqName: id,
            ancestorFqName: "Any",
            ancestorSymbolId: null,
            kind: "extend" as const,
            depth: 1,
          })),
      ),
    };
    const batch = batchedResolvers(ancestors, undefined);

    // Four addresses resolve concurrently, each missing a disjoint id — they
    // all land inside the 20ms departure window.
    const answers = await Promise.all(
      ["A", "B", "C", "D"].map(async (id) => batch.ancestors!.resolveContainerAncestors("c", [id])),
    );
    expect(answers.map((edges) => edges[0].sourceFqName)).toEqual(["A", "B", "C", "D"]);
    expect(ancestors.resolveContainerAncestors).toHaveBeenCalledTimes(1);
    expect(ancestors.resolveContainerAncestors).toHaveBeenCalledWith("c", ["A", "B", "C", "D"]);
  });

  it("stays undefined where the wrapped resolver was undefined (codegraph off)", () => {
    const batch = batchedResolvers(undefined, undefined);
    expect(batch.ancestors).toBeUndefined();
    expect(batch.visibility).toBeUndefined();
  });
});
