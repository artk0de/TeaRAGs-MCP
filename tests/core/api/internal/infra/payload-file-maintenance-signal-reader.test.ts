/**
 * readPayloadFileMaintenanceSignals (bd tea-rags-mcp-r8hme.20): every file's
 * `git.file.{commitCount,bugFixRate,ageDays}`, read in one payload-narrowed
 * pass — the readings an architecture violation's maintenance cost is
 * positioned from. The first chunk seen answers for its file.
 */
import { describe, expect, it, vi } from "vitest";

import { readPayloadFileMaintenanceSignals } from "../../../../../src/core/api/internal/infra/payload-file-maintenance-signal-reader.js";

function pages(...batches: Record<string, unknown>[][]) {
  return vi.fn(async function* () {
    for (const batch of batches) yield batch.map((payload, i) => ({ id: i, payload }));
  });
}

describe("readPayloadFileMaintenanceSignals", () => {
  it("reads each measured file's three readings once, leaving out files missing any of them", async () => {
    const full = { commitCount: 7, bugFixRate: 40, ageDays: 3 };
    const scrollPayloadPages = pages(
      [
        { relativePath: "src/a.ts", git: { file: full } },
        { relativePath: "src/a.ts", git: { file: { ...full, commitCount: 99 } } },
        { relativePath: "src/b.ts", git: { file: { commitCount: 2, ageDays: 1 } } },
      ],
      [
        { relativePath: "src/c.ts" },
        { relativePath: "src/d.ts", git: { file: { commitCount: 1, bugFixRate: 0, ageDays: 200 } } },
        { git: { file: full } },
      ],
    );

    const signals = await readPayloadFileMaintenanceSignals({ scrollPayloadPages }, "code_x");

    expect(signals).toEqual(
      new Map([
        ["src/a.ts", full],
        ["src/d.ts", { commitCount: 1, bugFixRate: 0, ageDays: 200 }],
      ]),
    );
    expect(scrollPayloadPages).toHaveBeenCalledWith("code_x", [
      "relativePath",
      "git.file.commitCount",
      "git.file.bugFixRate",
      "git.file.ageDays",
    ]);
  });
});
