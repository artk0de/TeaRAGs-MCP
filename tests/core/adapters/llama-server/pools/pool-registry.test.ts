import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  llamaServerPoolsPath,
  readLlamaServerPoolRecords,
  writeLlamaServerPoolRecords,
  type LlamaServerPoolRecord,
} from "../../../../../src/core/adapters/llama-server/pools/pool-registry.js";

const RECORD: LlamaServerPoolRecord = {
  model: "nomic-ai/CodeRankEmbed",
  ggufPath: "/data/models/coderankembed-q8_0.gguf",
  binary: "/data/llama.cpp/b1-metal/llama-server",
  instances: [
    { pid: 101, port: 21000, logPath: "/data/llama-server/logs/a.log" },
    { pid: 102, port: 22000, logPath: "/data/llama-server/logs/b.log" },
  ],
  args: ["-m", "/data/models/coderankembed-q8_0.gguf", "--embedding"],
  startedAt: "2026-11-02T10:00:00.000Z",
};

describe("llama-server pool registry", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pool-registry-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("lives at <dataDir>/llama-server/pools.json", () => {
    expect(llamaServerPoolsPath(dataDir)).toBe(join(dataDir, "llama-server", "pools.json"));
  });

  it("reads no records when pools.json does not exist", async () => {
    expect(await readLlamaServerPoolRecords(dataDir)).toEqual([]);
  });

  it("survives a write → read round trip", async () => {
    await writeLlamaServerPoolRecords(dataDir, [RECORD]);

    expect(await readLlamaServerPoolRecords(dataDir)).toEqual([RECORD]);
  });

  it("refuses a corrupt pools.json instead of forgetting the running processes", async () => {
    await writeLlamaServerPoolRecords(dataDir, []);
    writeFileSync(llamaServerPoolsPath(dataDir), "{not json");

    await expect(readLlamaServerPoolRecords(dataDir)).rejects.toThrow(llamaServerPoolsPath(dataDir));
  });
});
