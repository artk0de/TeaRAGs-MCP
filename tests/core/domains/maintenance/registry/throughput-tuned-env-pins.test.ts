/**
 * A registry stamp of a THROUGHPUT-TUNED key is not an operator ceiling (bd
 * tea-rags-mcp-y1ynz).
 *
 * `INGEST_PIPELINE_CONCURRENCY` and the `EMBEDDING_TUNE_*` batch keys bound the
 * embedding throughput tuner. A value a run stamped into `entry.env` (or a
 * `tea-rags tune` measurement) was measured against ONE embedding backend;
 * replaying it made it an explicit setting of every later run, so a project
 * indexed once through a single-slot Ollama kept a concurrency ceiling of 2 on
 * a 16-slot llama-server cluster forever. Only a value the operator pinned with
 * `tea-rags projects set-env` (recorded in `operatorPinnedEnvKeys`) replays.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CollectionEntry } from "../../../../../src/core/contracts/types/registry.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";
import { applyOperatorEnvPinEdit } from "../../../../../src/core/domains/maintenance/registry/env-edit.js";
import {
  isThroughputTunedEnvKey,
  THROUGHPUT_TUNED_ENV_KEYS,
} from "../../../../../src/core/domains/maintenance/registry/env-groups.js";
import {
  replayableRegistryEnv,
  resolveRegistryEnv,
} from "../../../../../src/core/domains/maintenance/registry/env-resolution.js";

function entry(over: Partial<CollectionEntry> = {}): CollectionEntry {
  return {
    collectionName: "code_27622aef",
    path: "/repo/taxdome",
    name: "taxdome",
    embeddingModel: "CodeRankEmbed",
    embeddingDimensions: 768,
    qdrantUrl: "http://127.0.0.1:6333",
    indexedAt: "2026-10-01T00:00:00.000Z",
    teaRagsVersion: "1.44.0",
    chunksCount: 10,
    ...over,
  };
}

/** The stamp the taxdome entry carried on 2026-10-03, written in its Ollama era. */
const OLLAMA_ERA_STAMP = {
  INGEST_PIPELINE_CONCURRENCY: "2",
  EMBEDDING_TUNE_BATCH_SIZE: "256",
  EMBEDDING_TUNE_MIN_BATCH_SIZE: "32",
  EMBEDDING_TUNE_BATCH_TIMEOUT_MS: "100",
  INGEST_TUNE_FILE_CONCURRENCY: "40",
};

describe("THROUGHPUT_TUNED_ENV_KEYS", () => {
  it("names the pipeline concurrency and the three embedding batch-shape keys", () => {
    expect([...THROUGHPUT_TUNED_ENV_KEYS].sort()).toEqual([
      "EMBEDDING_TUNE_BATCH_SIZE",
      "EMBEDDING_TUNE_BATCH_TIMEOUT_MS",
      "EMBEDDING_TUNE_MIN_BATCH_SIZE",
      "INGEST_PIPELINE_CONCURRENCY",
    ]);
  });

  it("recognizes every spelling of a tuned family, and nothing else", () => {
    expect(isThroughputTunedEnvKey("EMBEDDING_CONCURRENCY")).toBe(true);
    expect(isThroughputTunedEnvKey("EMBEDDING_TUNE_CONCURRENCY")).toBe(true);
    expect(isThroughputTunedEnvKey("BATCH_FORMATION_TIMEOUT_MS")).toBe(true);
    expect(isThroughputTunedEnvKey("MIN_BATCH_SIZE")).toBe(true);
    expect(isThroughputTunedEnvKey("INGEST_TUNE_FILE_CONCURRENCY")).toBe(false);
    expect(isThroughputTunedEnvKey("EMBEDDING_TUNE_RETRY_ATTEMPTS")).toBe(false);
  });
});

describe("replayableRegistryEnv", () => {
  it("drops a stamped throughput-tuned value the operator never pinned", () => {
    expect(replayableRegistryEnv(entry({ env: OLLAMA_ERA_STAMP }))).toEqual({ INGEST_TUNE_FILE_CONCURRENCY: "40" });
  });

  it("keeps a throughput-tuned value the operator pinned", () => {
    expect(
      replayableRegistryEnv(entry({ env: OLLAMA_ERA_STAMP, operatorPinnedEnvKeys: ["INGEST_PIPELINE_CONCURRENCY"] })),
    ).toEqual({ INGEST_PIPELINE_CONCURRENCY: "2", INGEST_TUNE_FILE_CONCURRENCY: "40" });
  });

  it("drops a deprecated spelling of a tuned family from a legacy `tuning` stamp", () => {
    expect(replayableRegistryEnv(entry({ tuning: { EMBEDDING_CONCURRENCY: "2", GIT_ADAPTER: "cli" } }))).toEqual({
      GIT_ADAPTER: "cli",
    });
  });

  it("is undefined for an entry with no stamp at all", () => {
    expect(replayableRegistryEnv(entry())).toBeUndefined();
    expect(replayableRegistryEnv(null)).toBeUndefined();
  });
});

describe("resolveRegistryEnv — throughput-tuned keys", () => {
  it("does not replay an unpinned stamp, so the run sees no explicit ceiling", () => {
    const env = resolveRegistryEnv(entry({ env: OLLAMA_ERA_STAMP }), {});
    for (const key of THROUGHPUT_TUNED_ENV_KEYS) expect(env).not.toHaveProperty(key);
    expect(env.INGEST_TUNE_FILE_CONCURRENCY).toBe("40");
  });

  it("replays a pinned value", () => {
    const env = resolveRegistryEnv(
      entry({ env: OLLAMA_ERA_STAMP, operatorPinnedEnvKeys: ["EMBEDDING_TUNE_BATCH_SIZE"] }),
      {},
    );
    expect(env.EMBEDDING_TUNE_BATCH_SIZE).toBe("256");
    expect(env).not.toHaveProperty("INGEST_PIPELINE_CONCURRENCY");
  });
});

describe("applyOperatorEnvPinEdit", () => {
  it("records the canonical key of every general key the operator sets", () => {
    const next = applyOperatorEnvPinEdit(entry(), {
      set: { EMBEDDING_CONCURRENCY: "8", GIT_ADAPTER: "cli" },
    });
    expect(next.operatorPinnedEnvKeys).toEqual(["GIT_ADAPTER", "INGEST_PIPELINE_CONCURRENCY"]);
  });

  it("forgets every family the operator unsets, under any spelling", () => {
    const next = applyOperatorEnvPinEdit(
      entry({ operatorPinnedEnvKeys: ["GIT_ADAPTER", "INGEST_PIPELINE_CONCURRENCY"] }),
      { unset: ["EMBEDDING_TUNE_CONCURRENCY"] },
    );
    expect(next.operatorPinnedEnvKeys).toEqual(["GIT_ADAPTER"]);
  });

  it("does not record a dedicated identity field as an env pin", () => {
    const next = applyOperatorEnvPinEdit(entry(), { set: { EMBEDDING_BASE_URL: "http://gpu:8080" } });
    expect(next.operatorPinnedEnvKeys ?? []).toEqual([]);
  });

  it("does not mutate its input", () => {
    const before = entry({ operatorPinnedEnvKeys: ["GIT_ADAPTER"] });
    applyOperatorEnvPinEdit(before, { set: { INGEST_PIPELINE_CONCURRENCY: "4" } });
    expect(before.operatorPinnedEnvKeys).toEqual(["GIT_ADAPTER"]);
  });
});

describe("CollectionRegistry#record — operator pins", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creg-y1ynz-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function recordable(over: Partial<CollectionEntry> = {}): Omit<CollectionEntry, "name"> {
    const { name: _name, ...rest } = entry(over);
    return rest;
  }

  it("keeps the operator's pins across a pipeline record() that does not pass them", () => {
    const r = new CollectionRegistry(dir);
    r.record(recordable({ operatorPinnedEnvKeys: ["INGEST_PIPELINE_CONCURRENCY"] }));
    r.record(recordable({ env: { INGEST_PIPELINE_CONCURRENCY: "4" }, chunksCount: 99 }));
    expect(new CollectionRegistry(dir).get("code_27622aef")?.operatorPinnedEnvKeys).toEqual([
      "INGEST_PIPELINE_CONCURRENCY",
    ]);
  });

  it("lets a caller that passes pins replace them (set-env / unset-env)", () => {
    const r = new CollectionRegistry(dir);
    r.record(recordable({ operatorPinnedEnvKeys: ["INGEST_PIPELINE_CONCURRENCY"] }));
    r.record(recordable({ operatorPinnedEnvKeys: [] }));
    expect(r.get("code_27622aef")?.operatorPinnedEnvKeys).toEqual([]);
  });
});
