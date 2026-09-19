/**
 * `QdrantPointStore` point reads, driven through a real `QdrantConnection` so
 * the connection's own failure classification (`call`) runs exactly as in
 * production; only the REST client underneath is a fake.
 *
 * `getPoint` answers `null` for any failure that is not a lost connection —
 * right for its lenient callers, wrong for a reader that must tell "the point is
 * absent" from "the read failed" (bd tea-rags-mcp-k8gac, F3-1): through it a
 * 500 or a timeout on the indexing marker read as "no pending seed", and a
 * `--force-enrichments` recompute stamped over the seed.
 */

import { describe, expect, it, vi } from "vitest";

import { InfraError } from "../../../../src/core/adapters/errors.js";
import { QdrantConnection, type EmbeddedDaemonProbe } from "../../../../src/core/adapters/qdrant/connection.js";
import {
  QdrantOperationError,
  QdrantRecoveringError,
  QdrantStartingError,
  QdrantUnavailableError,
} from "../../../../src/core/adapters/qdrant/errors.js";
import { QdrantPointStore } from "../../../../src/core/adapters/qdrant/point-store.js";

const URL = "http://127.0.0.1:6333";

/** A point store whose client answers `retrieve` with `retrieve`. */
function storeOver(retrieve: () => Promise<unknown>, daemon?: EmbeddedDaemonProbe) {
  const connection = new QdrantConnection(URL, undefined, undefined, daemon);
  const client = { retrieve: vi.fn(retrieve) };
  connection.client = client as never;
  return { store: new QdrantPointStore(connection), client };
}

function daemonIn(phase: "starting" | "recovering"): EmbeddedDaemonProbe {
  return { startupPhase: () => phase, pid: 99999, storagePath: "/tmp/qdrant-test" };
}

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });
const abortError = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" });

describe("QdrantPointStore#getPointOrThrow", () => {
  it("answers the point, its id normalized on the way in", async () => {
    const { store, client } = storeOver(async () => [{ id: 7, payload: { k: "v" } }]);

    await expect(store.getPointOrThrow("col", 7)).resolves.toEqual({ id: 7, payload: { k: "v" } });
    expect(client.retrieve).toHaveBeenCalledWith("col", { ids: [7] });
  });

  it("answers null only when Qdrant answered and the point is not there", async () => {
    const { store } = storeOver(async () => []);

    await expect(store.getPointOrThrow("col", "marker")).resolves.toBeNull();
  });

  // Each of these came back `null` through `getPoint` — "absent" — and only a
  // refused connection reached the caller.
  const answeredFailures: { label: string; make: () => Error }[] = [
    { label: "an HTTP 500", make: () => httpError(500, "Internal Server Error") },
    { label: "an HTTP 503", make: () => httpError(503, "Service Unavailable") },
    { label: "a request timeout (AbortError)", make: abortError },
    { label: "a client error with no status", make: () => new Error("qdrant timeout") },
  ];

  for (const { label, make } of answeredFailures) {
    it(`throws a typed operation error on ${label}, keeping the client's error as cause`, async () => {
      const raw = make();
      const { store } = storeOver(async () => Promise.reject(raw));

      const read = store.getPointOrThrow("col", "marker");

      await expect(read).rejects.toBeInstanceOf(QdrantOperationError);
      await expect(read).rejects.toMatchObject({ code: "INFRA_QDRANT_OPERATION_FAILED", cause: raw });
    });
  }

  it("keeps a daemon that is still starting typed as starting", async () => {
    const { store } = storeOver(async () => Promise.reject(new TypeError("fetch failed")), daemonIn("starting"));

    await expect(store.getPointOrThrow("col", "marker")).rejects.toBeInstanceOf(QdrantStartingError);
  });

  it("keeps a daemon that is recovering shards typed as recovering", async () => {
    const { store } = storeOver(async () => Promise.reject(new TypeError("fetch failed")), daemonIn("recovering"));

    await expect(store.getPointOrThrow("col", "marker")).rejects.toBeInstanceOf(QdrantRecoveringError);
  });

  it("keeps a refused connection typed as unavailability", async () => {
    const { store } = storeOver(async () => Promise.reject(new TypeError("fetch failed")));

    await expect(store.getPointOrThrow("col", "marker")).rejects.toBeInstanceOf(QdrantUnavailableError);
  });

  it("never lets a raw client rejection through, even one that is not an Error", async () => {
    const { store } = storeOver(vi.fn().mockRejectedValue({ status: 500 }));

    const read = store.getPointOrThrow("col", "marker");

    await expect(read).rejects.toBeInstanceOf(InfraError);
    await expect(read).rejects.toMatchObject({ code: "INFRA_QDRANT_OPERATION_FAILED" });
  });
});

describe("QdrantPointStore#getPoint", () => {
  // The lenient read keeps its contract for its other callers: absence and an
  // answered failure look alike, a lost connection does not.
  it("answers null for an answered failure and for a daemon still starting", async () => {
    await expect(
      storeOver(async () => Promise.reject(httpError(500, "Internal Server Error"))).store.getPoint("col", 1),
    ).resolves.toBeNull();
    await expect(
      storeOver(async () => Promise.reject(new TypeError("fetch failed")), daemonIn("starting")).store.getPoint(
        "col",
        1,
      ),
    ).resolves.toBeNull();
  });

  it("still throws when the connection is refused", async () => {
    const { store } = storeOver(async () => Promise.reject(new TypeError("fetch failed")));

    await expect(store.getPoint("col", 1)).rejects.toBeInstanceOf(QdrantUnavailableError);
  });
});
