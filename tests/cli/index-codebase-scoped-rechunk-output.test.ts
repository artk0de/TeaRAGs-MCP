/**
 * The outcome of a scoped force (bd tea-rags-mcp-j4oww) reaches the CLI output:
 * how many indexed files the selection re-chunked, and the chunk delta — the
 * numbers a live validation reads back from `--json`.
 */

import { describe, expect, it } from "vitest";

import type { WorkerMessage } from "../../src/cli/index-progress/ipc-protocol.js";
import { formatIndexStatus, formatIndexStatusJson } from "../../src/cli/index-progress/status-format.js";
import { runIndexWorker } from "../../src/cli/index-progress/worker.js";
import { createColorizer } from "../../src/cli/infra/color.js";
import type { IndexStatus } from "../../src/core/api/public/index.js";

const status: IndexStatus = { isIndexed: true, status: "indexed", collectionName: "code_x" };

const RECHUNK = { filesRechunked: 42, filesModified: 43, chunksAdded: 120, chunksDeleted: 110 };

describe("scoped force outcome in the run's output", () => {
  it("rides every status message of a scoped run", async () => {
    const app = {
      indexCodebase: async () =>
        Promise.resolve({
          status: "completed",
          changeDetails: {
            filesAdded: 0,
            filesModified: 43,
            filesDeleted: 0,
            filesNewlyIgnored: 0,
            filesNewlyUnignored: 0,
            chunksAdded: 120,
            chunksDeleted: 110,
            filesRetried: 0,
            filesRechunked: 42,
          },
        }),
      getIndexStatus: async () => Promise.resolve(status),
      whenEnrichmentComplete: async () => Promise.resolve(),
    };
    const sent: WorkerMessage[] = [];

    await runIndexWorker(app as never, "/repo", { forceReindex: true, testFile: "only" }, (m) => sent.push(m));

    const statuses = sent.filter((m): m is Extract<WorkerMessage, { type: "status" }> => m.type === "status");
    expect(statuses).toHaveLength(2);
    for (const message of statuses) expect(message.status.scopedRechunk).toEqual(RECHUNK);
  });

  it("is reported verbatim in the --json object and absent otherwise", () => {
    const json = formatIndexStatusJson({ ...status, scopedRechunk: RECHUNK }, { path: "/repo" }) as Record<
      string,
      unknown
    >;
    expect(json.scopedRechunk).toEqual(RECHUNK);
    expect(formatIndexStatusJson(status, { path: "/repo" })).not.toHaveProperty("scopedRechunk");
  });

  it("gets its own line in the human status", () => {
    const colors = createColorizer({ env: { NO_COLOR: "1" }, isTTY: false });
    const text = formatIndexStatus({ ...status, scopedRechunk: RECHUNK }, colors);
    expect(text).toContain("Scoped re-chunk");
    expect(text).toContain("  42 files re-chunked in place (+120 / -110 chunks)");
  });
});
