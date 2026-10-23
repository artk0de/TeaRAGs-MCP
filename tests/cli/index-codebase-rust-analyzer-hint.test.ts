/**
 * `index-codebase` and the rust-analyzer install hint (bd s3i8m.6): the hint
 * originates once on `IndexStats.rustAnalyzerHint`; the worker carries it on the
 * status messages and both the human block and the `--json` object render it.
 */

import { describe, expect, it } from "vitest";

import type { WorkerMessage } from "../../src/cli/index-progress/ipc-protocol.js";
import { formatIndexStatus, formatIndexStatusJson } from "../../src/cli/index-progress/status-format.js";
import { runIndexWorker } from "../../src/cli/index-progress/worker.js";
import { createColorizer } from "../../src/cli/infra/color.js";
import type { IndexStatus } from "../../src/core/api/public/index.js";

const HINT = "rust-analyzer not found — install with 'rustup component add rust-analyzer'";
const status: IndexStatus = { isIndexed: true, status: "indexed", collectionName: "code_rs" };
const colors = createColorizer({ env: { NO_COLOR: "1" }, isTTY: false });

describe("the rust-analyzer hint in the run's output", () => {
  it("rides every status message the worker sends", async () => {
    const app = {
      indexCodebase: async () => Promise.resolve({ status: "completed", rustAnalyzerHint: HINT }),
      getIndexStatus: async () => Promise.resolve(status),
      whenEnrichmentComplete: async () => Promise.resolve(),
    };
    const sent: WorkerMessage[] = [];

    await runIndexWorker(app as never, "/repo/rs", {}, (m) => sent.push(m));

    const statuses = sent.filter((m): m is Extract<WorkerMessage, { type: "status" }> => m.type === "status");
    expect(statuses).toHaveLength(2);
    for (const message of statuses) expect(message.status.rustAnalyzerHint).toBe(HINT);
  });

  it("adds nothing to the status messages of a run without a hint", async () => {
    const app = {
      indexCodebase: async () => Promise.resolve({ status: "completed" }),
      getIndexStatus: async () => Promise.resolve(status),
      whenEnrichmentComplete: async () => Promise.resolve(),
    };
    const sent: WorkerMessage[] = [];

    await runIndexWorker(app as never, "/repo/rs", {}, (m) => sent.push(m));

    for (const message of sent) {
      if (message.type === "status") expect(message.status).not.toHaveProperty("rustAnalyzerHint");
    }
  });

  it("is one line in the human status", () => {
    const text = formatIndexStatus({ ...status, rustAnalyzerHint: HINT }, colors);
    expect(text.split("\n").filter((l) => l.includes("rust-analyzer not found"))).toEqual([`⚠ ${HINT}`]);
  });

  it("is absent from the human status without a hint", () => {
    expect(formatIndexStatus(status, colors)).not.toContain("rust-analyzer");
  });

  it("is reported in the --json object as `rustAnalyzerHint`, alongside the other fields", () => {
    const json = formatIndexStatusJson({ ...status, rustAnalyzerHint: HINT }, { path: "/repo/rs" }) as Record<
      string,
      unknown
    >;
    expect(json.rustAnalyzerHint).toBe(HINT);
    expect(JSON.parse(JSON.stringify(json)).status).toBe("indexed");
  });

  it("is absent from the --json object without a hint", () => {
    const json = formatIndexStatusJson(status, { path: "/repo/rs" }) as Record<string, unknown>;
    expect(json).not.toHaveProperty("rustAnalyzerHint");
  });
});

describe("the rustc driver line in the run's output (s3i8m T9)", () => {
  const rustcDriver = { outcome: "latched", reason: "driverBuild", detail: "cargo build failed" } as const;

  it("rides every status message the worker sends", async () => {
    const app = {
      indexCodebase: async () => Promise.resolve({ status: "completed", rustcDriver }),
      getIndexStatus: async () => Promise.resolve(status),
      whenEnrichmentComplete: async () => Promise.resolve(),
    };
    const sent: WorkerMessage[] = [];

    await runIndexWorker(app as never, "/repo/rs", {}, (m) => sent.push(m));

    const statuses = sent.filter((m): m is Extract<WorkerMessage, { type: "status" }> => m.type === "status");
    expect(statuses).toHaveLength(2);
    for (const message of statuses) expect(message.status.rustcDriver).toEqual(rustcDriver);
  });

  it("adds nothing to the status messages of a run without a driver status", async () => {
    const app = {
      indexCodebase: async () => Promise.resolve({ status: "completed" }),
      getIndexStatus: async () => Promise.resolve(status),
      whenEnrichmentComplete: async () => Promise.resolve(),
    };
    const sent: WorkerMessage[] = [];

    await runIndexWorker(app as never, "/repo/rs", {}, (m) => sent.push(m));

    for (const message of sent) {
      if (message.type === "status") expect(message.status).not.toHaveProperty("rustcDriver");
    }
  });

  it("is one line in the human status", () => {
    const text = formatIndexStatus({ ...status, rustcDriver }, colors);
    expect(text.split("\n").filter((l) => l.includes("rustc driver"))).toEqual([
      "rustc driver: latched — driverBuild (cargo build failed)",
    ]);
  });

  it("is absent from the human status without a driver status", () => {
    expect(formatIndexStatus(status, colors)).not.toContain("rustc driver");
  });

  it("is reported in the --json object as `rustcDriver` with the rendered line", () => {
    const json = formatIndexStatusJson({ ...status, rustcDriver }, { path: "/repo/rs" }) as Record<string, unknown>;
    expect(json.rustcDriver).toEqual(rustcDriver);
    expect(json.rustcDriverLine).toBe("rustc driver: latched — driverBuild (cargo build failed)");
  });

  it("is absent from the --json object without a driver status", () => {
    const json = formatIndexStatusJson(status, { path: "/repo/rs" }) as Record<string, unknown>;
    expect(json).not.toHaveProperty("rustcDriver");
    expect(json).not.toHaveProperty("rustcDriverLine");
  });
});
