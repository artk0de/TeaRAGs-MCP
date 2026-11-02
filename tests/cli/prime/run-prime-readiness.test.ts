import type * as NodeFs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPrime, type PrimeRegistryRuntime } from "../../../src/cli/prime/run-prime.js";
import type { CollectionEntry } from "../../../src/core/api/public/index.js";

const { ping } = vi.hoisted(() => ({ ping: vi.fn() }));
vi.mock("node:fs", async () => ({ ...(await vi.importActual<typeof NodeFs>("node:fs")), existsSync: () => true }));
vi.mock("../../../src/cli/prime/qdrant-ping.js", () => ({ pingQdrant: ping }));
vi.mock("../../../src/bootstrap/config/index.js", () => ({ parseAppConfig: () => ({}) }));

const entry: CollectionEntry = {
  collectionName: "code_proj",
  name: "proj",
  path: "/repo/proj",
  embeddingModel: "m",
  embeddingDimensions: 384,
  qdrantUrl: "http://localhost:6333",
  indexedAt: "2026-10-23T00:00:00Z",
  teaRagsVersion: "1.0.0",
  chunksCount: 10,
};
const registryRuntime: PrimeRegistryRuntime = {
  openRegistry: () => ({ findByName: () => entry, get: () => entry }) as never,
  createFreshness: () => ({}) as never,
  externalQdrantUrlOf: () => "http://localhost:6333",
  replayEntryEnv: () => undefined,
};
let out = "";
beforeEach(() => {
  out = "";
  ping.mockResolvedValue(false);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("prime — unconfirmed startup readiness", () => {
  it.each([false, true])("keeps registered addressing when a probe is unconfirmed, agent=%s", async (agent) => {
    const openSession = vi.fn();
    await runPrime({
      path: "/repo/proj",
      agent,
      createPathCollectionResolver: (() => async () => "code_proj") as never,
      registryRuntime,
      openSession,
      clientUpdateTrigger: { maybeSpawn: () => "disabled", manualUpdateHint: () => null },
    });
    expect(out).toContain("project `proj` · collection `code_proj`");
    expect(out).toContain("readiness and freshness unconfirmed");
    expect(out).not.toMatch(/warm-up pending|not indexed|index behind/);
    expect(openSession).not.toHaveBeenCalled();
  });

  it("retains a refused client-update hint even when readiness cannot be confirmed", async () => {
    const hint = "run `tea-rags update` by hand";
    await runPrime({
      path: "/repo/proj",
      createPathCollectionResolver: (() => async () => "code_proj") as never,
      registryRuntime,
      openSession: vi.fn(),
      clientUpdateTrigger: { maybeSpawn: () => "disabled", manualUpdateHint: () => hint },
    });
    expect(out).toContain(`tea-rags client: ${hint}`);
  });
});
