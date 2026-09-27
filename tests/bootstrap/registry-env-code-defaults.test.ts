import { describe, expect, it } from "vitest";

import { buildRegistryEnvSnapshot } from "../../src/bootstrap/config/env-snapshot.js";
import { parseAppConfigZod } from "../../src/bootstrap/config/parse.js";
import { resolveRegistryEnvCodeDefaults } from "../../src/bootstrap/config/registry-env-code-defaults.js";

describe("resolveRegistryEnvCodeDefaults (bd tea-rags-mcp-h4l6k)", () => {
  it("is the registry snapshot of a config parsed from an env that sets nothing", () => {
    const env = { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" };
    expect(resolveRegistryEnvCodeDefaults(env)).toEqual(buildRegistryEnvSnapshot(parseAppConfigZod(env)));
  });

  it("ignores every tea-rags knob the process env sets — defaults, not the running config", () => {
    const env = {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES: "777",
    };
    expect(resolveRegistryEnvCodeDefaults(env).TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES).toBe("5000");
  });
});
