/**
 * `DaemonCollectionClientCache` (split out of `GraphDbClientPool` in 0qaht.38):
 * ONE daemon client per collection, shared by concurrent first-callers, with a
 * handle whose `close()` never tears the shared socket down — `closeAll` does.
 * One symbol table per collection, hydrated once by the init hook.
 */

import { describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import type { DaemonBuildHandshakeConnector } from "../../../../../src/core/adapters/duckdb/daemon/build-handshake-connector.js";
import type { DaemonGraphDbClient } from "../../../../../src/core/adapters/duckdb/daemon/client.js";
import { DaemonCollectionClientCache } from "../../../../../src/core/adapters/duckdb/daemon/collection-client-cache.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const name = fixturePhysicalCollectionName("code_a");

function fakeClient() {
  return { isConnected: vi.fn(() => true), close: vi.fn(async () => undefined) };
}

function cacheWith(clients: ReturnType<typeof fakeClient>[]) {
  const connectWithBuildHandshake = vi.fn(async () => clients.shift() as unknown as DaemonGraphDbClient);
  const connector = {
    connectWithBuildHandshake,
    migrateLegacyDaemon: vi.fn(async () => undefined),
  } as unknown as DaemonBuildHandshakeConnector;
  const initHook = vi.fn(async () => undefined);
  const cache = new DaemonCollectionClientCache(
    {
      daemonSocketPath: "/tmp/daemon.sock",
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      initHook,
    },
    connector,
  );
  return { cache, connectWithBuildHandshake, initHook };
}

describe("DaemonCollectionClientCache", () => {
  it("shares one connect and one symbol table between concurrent first-callers", async () => {
    const client = fakeClient();
    const { cache, connectWithBuildHandshake, initHook } = cacheWith([client]);
    const [first, second] = await Promise.all([cache.acquireHandle(name), cache.acquireHandle(name)]);
    const third = await cache.acquireHandle(name);
    expect(connectWithBuildHandshake).toHaveBeenCalledTimes(1);
    expect(initHook).toHaveBeenCalledTimes(1);
    expect(second.symbolTable).toBe(first.symbolTable);
    expect(third.graphDb).toBe(first.graphDb);
  });

  it("hands out a handle whose close is a no-op; closeAll closes the real client", async () => {
    const client = fakeClient();
    const { cache } = cacheWith([client]);
    const handle = await cache.acquireHandle(name);
    await handle.graphDb.close();
    expect(client.close).not.toHaveBeenCalled();
    await cache.closeAll();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("reconnects once the cached client lost its daemon", async () => {
    const stale = fakeClient();
    const fresh = fakeClient();
    const { cache, connectWithBuildHandshake } = cacheWith([stale, fresh]);
    await cache.acquireHandle(name);
    stale.isConnected.mockReturnValue(false);
    await cache.acquireHandle(name);
    expect(connectWithBuildHandshake).toHaveBeenCalledTimes(2);
  });
});
