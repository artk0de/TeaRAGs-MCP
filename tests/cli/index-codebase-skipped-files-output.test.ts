/**
 * The deterministic-skip record (bd tea-rags-mcp-6xdwe) reaches `index-codebase
 * --json` with a bounded sample of paths — the one surface that carries paths;
 * `get_index_status` carries counts only.
 */

import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkerMessage } from "../../src/cli/index-progress/ipc-protocol.js";
import { formatIndexStatusJson } from "../../src/cli/index-progress/status-format.js";
import { runIndexWorker } from "../../src/cli/index-progress/worker.js";
import type { IndexStatus } from "../../src/core/api/public/index.js";
import { SkippedFileStore } from "../../src/core/domains/ingest/sync/skipped-file-store.js";

const collectionName = "code_skipped_out";
const snapshotDir = () => join(process.env.TEA_RAGS_DATA_DIR!, "snapshots");

describe("skipped files in the index-codebase output", () => {
  afterEach(async () => {
    await new SkippedFileStore(snapshotDir(), collectionName).clearAll();
  });

  it("every status message carries the summary with a sample of at most 10 paths", async () => {
    const store = new SkippedFileStore(snapshotDir(), collectionName);
    for (let i = 0; i < 12; i++) await store.record(`f${String(i).padStart(2, "0")}.ts`, "emptyFile", `h${i}`);
    await store.record("creds.ts", "secretsGate", "h");
    const status: IndexStatus = {
      isIndexed: true,
      status: "indexed",
      collectionName,
      skippedFiles: { count: 13, byReason: { emptyFile: 12, secretsGate: 1 } },
    };
    const app = {
      indexCodebase: async () => Promise.resolve({ status: "completed" }),
      getIndexStatus: async () => Promise.resolve(status),
      whenEnrichmentComplete: async () => Promise.resolve(),
    };
    const sent: WorkerMessage[] = [];

    await runIndexWorker(app as never, "/repo", {}, (m) => sent.push(m));

    const statuses = sent.filter((m): m is Extract<WorkerMessage, { type: "status" }> => m.type === "status");
    expect(statuses).toHaveLength(2);
    for (const message of statuses) {
      expect(message.status.skippedFiles?.count).toBe(13);
      expect(message.status.skippedFiles?.byReason).toEqual({ emptyFile: 12, secretsGate: 1 });
      expect(message.status.skippedFiles?.sample).toHaveLength(10);
      expect(message.status.skippedFiles?.sample?.[0]).toEqual({ path: "creds.ts", reason: "secretsGate" });
    }
  });

  it("leaves a status with nothing skipped untouched", async () => {
    const status: IndexStatus = { isIndexed: true, status: "indexed", collectionName };
    const app = {
      indexCodebase: async () => Promise.resolve({ status: "completed" }),
      getIndexStatus: async () => Promise.resolve(status),
      whenEnrichmentComplete: async () => Promise.resolve(),
    };
    const sent: WorkerMessage[] = [];

    await runIndexWorker(app as never, "/repo", {}, (m) => sent.push(m));

    for (const m of sent) if (m.type === "status") expect(m.status).not.toHaveProperty("skippedFiles");
  });

  it("is reported verbatim in the --json object and absent otherwise", () => {
    const skippedFiles = {
      count: 1,
      byReason: { secretsGate: 1 },
      sample: [{ path: "creds.ts", reason: "secretsGate" as const }],
    };
    const base: IndexStatus = { isIndexed: true, status: "indexed", collectionName };

    const json = formatIndexStatusJson({ ...base, skippedFiles }, { path: "/repo" }) as Record<string, unknown>;

    expect(json.skippedFiles).toEqual(skippedFiles);
    expect(formatIndexStatusJson(base, { path: "/repo" })).not.toHaveProperty("skippedFiles");
  });

  it("carries index holes verbatim and nothing when there are none (bd tea-rags-mcp-muj77)", () => {
    const base: IndexStatus = { isIndexed: true, status: "indexed", collectionName };

    const json = formatIndexStatusJson({ ...base, indexHoles: { count: 4 } }, { path: "/repo" }) as Record<
      string,
      unknown
    >;

    expect(json.indexHoles).toEqual({ count: 4 });
    expect(formatIndexStatusJson(base, { path: "/repo" })).not.toHaveProperty("indexHoles");
  });
});
