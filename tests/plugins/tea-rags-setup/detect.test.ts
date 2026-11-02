import { describe, expect, it } from "vitest";

import { runScript } from "./fixtures.js";

const CLEAN_ENV = {
  CLAUDECODE: undefined,
  CURSOR_AGENT: undefined,
  CODEX_HOME: undefined,
  CODEX_SANDBOX: undefined,
};

describe("detect.mjs", () => {
  it("reports the host facts as one JSON object", () => {
    const { status, json } = runScript("detect.mjs", [], CLEAN_ENV);
    expect(status).toBe(0);
    expect(json).toMatchObject({
      os: process.platform,
      arch: process.arch,
      harness: "unknown",
      node: { version: process.versions.node, ok: true },
    });
    expect(typeof json.ramGb).toBe("number");
    expect(["metal", "cuda", "rocm", "vulkan", "cpu"]).toContain(json.gpuBackend);
    expect(json).toHaveProperty("teaRags");
    expect(json).toHaveProperty("registered");
  });

  it("reports harness codex when CODEX_HOME is set", () => {
    expect(runScript("detect.mjs", [], { ...CLEAN_ENV, CODEX_HOME: "/tmp/codex" }).json.harness).toBe("codex");
  });

  it("reports harness claude when CLAUDECODE is set", () => {
    expect(runScript("detect.mjs", [], { ...CLEAN_ENV, CLAUDECODE: "1" }).json.harness).toBe("claude");
  });

  it("reports harness cursor when CURSOR_AGENT is set", () => {
    expect(runScript("detect.mjs", [], { ...CLEAN_ENV, CURSOR_AGENT: "1" }).json.harness).toBe("cursor");
  });
});
