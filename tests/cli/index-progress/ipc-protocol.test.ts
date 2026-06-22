import { describe, expect, it } from "vitest";

import { isWorkerMessage } from "../../../src/cli/index-progress/ipc-protocol.js";

describe("isWorkerMessage", () => {
  it.each([
    { type: "embedding", phase: "embedding", percentage: 45, current: 45, total: 100 },
    { type: "enrichment", providerKey: "git", level: "file", applied: 10, total: 20 },
    { type: "status", status: { isIndexed: true, status: "indexed" } },
    { type: "done", result: { failed: [], degraded: [] } },
    { type: "error", message: "boom" },
  ])("accepts valid $type message", (msg) => {
    expect(isWorkerMessage(msg)).toBe(true);
  });

  it.each([
    null,
    undefined,
    "string",
    42,
    {},
    { type: "unknown" },
    { type: "enrichment", level: "file" }, // missing providerKey
  ])("rejects invalid payload %o", (bad) => {
    expect(isWorkerMessage(bad)).toBe(false);
  });
});
