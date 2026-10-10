import { describe, expect, it } from "vitest";

import type { WorkerMessage } from "../../../src/cli/index-progress/ipc-protocol.js";
import { JsonProgressRenderer } from "../../../src/cli/index-progress/renderer.js";
import { IndexRunReportPrinter } from "../../../src/cli/index-progress/report-printer.js";
import { createColorizer } from "../../../src/cli/infra/color.js";

const plain = createColorizer({ env: {}, isTTY: false });

const status = { isIndexed: true, status: "indexed", collectionName: "code_x", chunksCount: 100 } as const;

function humanPrinter() {
  const out: string[] = [];
  const printer = new IndexRunReportPrinter({
    out: (s) => out.push(s),
    colors: plain,
    jsonRenderer: null,
    projectName: "proj",
    path: "/p",
  });
  return { out, printer };
}

function jsonPrinter(renderer: JsonProgressRenderer) {
  const out: string[] = [];
  const printer = new IndexRunReportPrinter({
    out: (s) => out.push(s),
    colors: plain,
    jsonRenderer: renderer,
    projectName: "proj",
    path: "/p",
  });
  return { out, printer };
}

describe("IndexRunReportPrinter — human mode", () => {
  it("renders a successful run: status block, background ETA fallback, total", () => {
    const { out, printer } = humanPrinter();
    printer.printStatus(status, 0);
    printer.printEta(null);
    printer.printTotal(0);
    expect(out).toEqual([
      "Index status\n  project:    proj\n  status:     indexed\n  collection: code_x\n  chunks:     100",
      "enrichments: running in background…",
      "total 0ms",
    ]);
  });

  it("renders a known ETA rounded up to whole seconds", () => {
    const { out, printer } = humanPrinter();
    printer.printEta(12.2);
    expect(out).toEqual(["enrichments: ~13s remaining (background)"]);
  });

  it("renders failed and degraded enrichment outcome lines, failed first", () => {
    const { out, printer } = humanPrinter();
    printer.printOutcome({ failed: ["git"], degraded: ["codegraph"] });
    expect(out).toEqual(["✗ git: enrichment failed", "⚠ codegraph: enrichment degraded"]);
  });

  it("renders a fatal error with its hint on a second line", () => {
    const { out, printer } = humanPrinter();
    const msg: Extract<WorkerMessage, { type: "error" }> = { type: "error", message: "boom", hint: "do x" };
    printer.printError(msg);
    expect(out).toEqual(["error: boom", "hint: do x"]);
  });

  it("omits the hint line when the fatal has none", () => {
    const { out, printer } = humanPrinter();
    printer.printError({ type: "error", message: "boom" });
    expect(out).toEqual(["error: boom"]);
  });

  it("renders a worker crash with its exit code, null when the code is missing", () => {
    const { out, printer } = humanPrinter();
    printer.printWorkerExit(3);
    printer.printWorkerExit(null);
    expect(out).toEqual([
      "worker exited with code 3 before reporting a result",
      "worker exited with code null before reporting a result",
    ]);
  });
});

describe("IndexRunReportPrinter — --json mode", () => {
  it("emits one JSON status object carrying phases and enrichment outcome", () => {
    const renderer = new JsonProgressRenderer();
    renderer.handle({ type: "phase-done", phase: "scan", elapsedMs: 5 });
    renderer.handle({ type: "done", result: { failed: ["git"], degraded: ["codegraph"] } });
    const { out, printer } = jsonPrinter(renderer);
    printer.printStatus(status, 0);
    expect(out).toEqual([
      '{\n  "projectName": "proj",\n  "path": "/p",\n  "status": "indexed",\n  "collectionName": "code_x",\n  "filesCount": null,\n  "chunksCount": 100,\n  "overallMs": 0,\n  "phases": {\n    "scan": 5\n  },\n  "outcome": {\n    "measured": true,\n    "failed": [\n      "git"\n    ],\n    "degraded": [\n      "codegraph"\n    ]\n  }\n}',
    ]);
  });

  it("stays silent for ETA, outcome lines and total", () => {
    const { out, printer } = jsonPrinter(new JsonProgressRenderer());
    printer.printEta(5);
    printer.printOutcome({ failed: ["git"], degraded: [] });
    printer.printTotal(10);
    expect(out).toEqual([]);
  });

  it("emits a parseable error object with code and hint", () => {
    const { out, printer } = jsonPrinter(new JsonProgressRenderer());
    printer.printError({ type: "error", message: "boom", code: "C", hint: "do x" });
    expect(out).toEqual(['{"error":{"code":"C","message":"boom","hint":"do x"}}']);
  });

  it("defaults the error code to UNKNOWN and drops an absent hint", () => {
    const { out, printer } = jsonPrinter(new JsonProgressRenderer());
    printer.printError({ type: "error", message: "boom" });
    expect(out).toEqual(['{"error":{"code":"UNKNOWN","message":"boom"}}']);
  });

  it("emits a WORKER_EXIT error object on a worker crash", () => {
    const { out, printer } = jsonPrinter(new JsonProgressRenderer());
    printer.printWorkerExit(3);
    expect(out).toEqual([
      '{"error":{"code":"WORKER_EXIT","message":"worker exited with code 3 before reporting a result"}}',
    ]);
  });
});
