/**
 * `CodegraphPathLeases` (bd tea-rags-mcp-r4veq, split out of `GraphDbClientPool`
 * in 0qaht.38): one lease per collection path, taken in sorted order so two
 * replacers sharing paths cannot deadlock, always released, and waited out by
 * whoever needs the path next.
 */

import { describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../__helpers__/collection-identity.js";
import { CodegraphPathLeases } from "../../../../src/core/adapters/duckdb/codegraph-path-leases.js";

const a = fixturePhysicalCollectionName("code_a");
const b = fixturePhysicalCollectionName("code_b");

describe("CodegraphPathLeases", () => {
  it("holds every named path while the replacement runs and releases them after", async () => {
    const leases = new CodegraphPathLeases();
    const held = await leases.withLeases([b, a], async () => [leases.isHeld(a), leases.isHeld(b)]);
    expect(held).toEqual([true, true]);
    expect(leases.isHeld(a)).toBe(false);
    expect(leases.isHeld(b)).toBe(false);
  });

  it("releases the leases when the replacement throws", async () => {
    const leases = new CodegraphPathLeases();
    await expect(
      leases.withLeases([a], async () => {
        throw new RangeError("boom");
      }),
    ).rejects.toThrow("boom");
    expect(leases.isHeld(a)).toBe(false);
  });

  it("does not deadlock two replacers taking overlapping paths in opposite order", async () => {
    const leases = new CodegraphPathLeases();
    const order: string[] = [];
    await Promise.all([
      leases.withLeases([a, b], async () => {
        order.push("ab");
      }),
      leases.withLeases([b, a], async () => {
        order.push("ba");
      }),
    ]);
    expect(order).toEqual(["ab", "ba"]);
  });

  it("waitForRelease resolves only once the current holder releases", async () => {
    const leases = new CodegraphPathLeases();
    let finish!: () => void;
    const replacing = leases.withLeases(
      [a],
      async () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    let waited = false;
    const waiting = leases.waitForRelease(a).then(() => {
      waited = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(waited).toBe(false);
    finish();
    await replacing;
    await waiting;
    expect(waited).toBe(true);
  });
});
