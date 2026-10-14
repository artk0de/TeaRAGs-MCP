import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EMBEDDING_ENDPOINT_DOWN_VERDICT_TTL_MS,
  EmbeddingEndpointDownVerdictStore,
} from "../../../../src/core/adapters/embeddings/endpoint-down-verdicts.js";

const PRIMARY = "http://192.168.1.71:8091";
const OTHER = "http://192.168.1.71:8092";

describe("EmbeddingEndpointDownVerdictStore", () => {
  let dir: string;
  let file: string;
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "endpoint-down-verdicts-"));
    file = join(dir, "nested", "embedding-endpoint-health.json");
    now = 1_000_000;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a verdict written by one store is live for another store on the same file (another process)", () => {
    new EmbeddingEndpointDownVerdictStore(file, { now: clock }).markDown(PRIMARY, "EHOSTUNREACH: host unreachable");

    const verdicts = new EmbeddingEndpointDownVerdictStore(file, { now: clock }).liveVerdicts();

    expect(verdicts).toEqual([{ url: PRIMARY, downAt: 1_000_000, reason: "EHOSTUNREACH: host unreachable" }]);
  });

  it("a verdict older than the TTL is not live", () => {
    const store = new EmbeddingEndpointDownVerdictStore(file, { now: clock });
    store.markDown(PRIMARY, "ECONNREFUSED");

    now += EMBEDDING_ENDPOINT_DOWN_VERDICT_TTL_MS - 1;
    expect(store.liveVerdicts().map((v) => v.url)).toEqual([PRIMARY]);
    now += 1;
    expect(store.liveVerdicts()).toEqual([]);
  });

  it("keeps the TTL short: at most a minute, at least the 30s failback probe cadence", () => {
    expect(EMBEDDING_ENDPOINT_DOWN_VERDICT_TTL_MS).toBeGreaterThanOrEqual(30_000);
    expect(EMBEDDING_ENDPOINT_DOWN_VERDICT_TTL_MS).toBeLessThanOrEqual(60_000);
  });

  it("a missing file means no verdict", () => {
    expect(new EmbeddingEndpointDownVerdictStore(file, { now: clock }).liveVerdicts()).toEqual([]);
  });

  it("a corrupt file means no verdict, and the next mark replaces it", () => {
    const store = new EmbeddingEndpointDownVerdictStore(file, { now: clock });
    store.markDown(OTHER, "x");
    writeFileSync(file, "{not json", "utf-8");

    expect(store.liveVerdicts()).toEqual([]);

    store.markDown(PRIMARY, "ECONNREFUSED");
    expect(store.liveVerdicts().map((v) => v.url)).toEqual([PRIMARY]);
  });

  it("ignores entries of the wrong shape and keeps the well-formed ones", () => {
    const store = new EmbeddingEndpointDownVerdictStore(file, { now: clock });
    store.markDown(PRIMARY, "ECONNREFUSED");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        endpoints: { [PRIMARY]: { downAt: now, reason: "ECONNREFUSED" }, [OTHER]: { downAt: "yesterday" } },
      }),
      "utf-8",
    );

    expect(store.liveVerdicts().map((v) => v.url)).toEqual([PRIMARY]);
  });

  it("a verdict stamped in the future is not trusted", () => {
    const store = new EmbeddingEndpointDownVerdictStore(file, { now: clock });
    store.markDown(PRIMARY, "ECONNREFUSED");
    now -= 1_000;

    expect(store.liveVerdicts()).toEqual([]);
  });

  it("clear removes one endpoint's verdict and leaves the others", () => {
    const store = new EmbeddingEndpointDownVerdictStore(file, { now: clock });
    store.markDown(PRIMARY, "a");
    store.markDown(OTHER, "b");

    store.clear(PRIMARY);

    expect(store.liveVerdicts().map((v) => v.url)).toEqual([OTHER]);
  });

  it("writes atomically: no temp file is left beside the verdict file", () => {
    const store = new EmbeddingEndpointDownVerdictStore(file, { now: clock });
    store.markDown(PRIMARY, "a");
    store.markDown(OTHER, "b");
    store.clear(OTHER);

    expect(readdirSync(join(dir, "nested"))).toEqual(["embedding-endpoint-health.json"]);
  });

  it("an unwritable location never throws: the verdict is an optimisation", () => {
    writeFileSync(join(dir, "blocker"), "a file, not a directory", "utf-8");
    const store = new EmbeddingEndpointDownVerdictStore(join(dir, "blocker", "verdicts.json"), { now: clock });

    expect(() => {
      store.markDown(PRIMARY, "a");
    }).not.toThrow();
    expect(store.liveVerdicts()).toEqual([]);
  });
});
