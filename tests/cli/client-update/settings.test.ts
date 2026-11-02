import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readClientAutoUpdateSetting, writeClientAutoUpdateSetting } from "../../../src/cli/client-update/settings.js";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "client-update-settings-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("client auto-update setting", () => {
  it("defaults to on when neither the env nor settings.json say otherwise", () => {
    expect(readClientAutoUpdateSetting(dataDir, {})).toEqual({ enabled: true, source: "default" });
  });

  it("reads clientAutoUpdate from <dataDir>/settings.json", () => {
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ clientAutoUpdate: false }));
    expect(readClientAutoUpdateSetting(dataDir, {})).toEqual({ enabled: false, source: "file" });
  });

  it("lets TEA_RAGS_AUTO_UPDATE win over the file", () => {
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ clientAutoUpdate: false }));
    expect(readClientAutoUpdateSetting(dataDir, { TEA_RAGS_AUTO_UPDATE: "1" })).toEqual({
      enabled: true,
      source: "env",
    });
    writeClientAutoUpdateSetting(dataDir, true);
    expect(readClientAutoUpdateSetting(dataDir, { TEA_RAGS_AUTO_UPDATE: "0" })).toEqual({
      enabled: false,
      source: "env",
    });
  });

  it("ignores an unrecognised env value and a corrupt file", () => {
    writeFileSync(join(dataDir, "settings.json"), "{not json");
    expect(readClientAutoUpdateSetting(dataDir, { TEA_RAGS_AUTO_UPDATE: "maybe" })).toEqual({
      enabled: true,
      source: "default",
    });
  });

  it("writes the flag and keeps the other keys of settings.json", () => {
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ other: 42 }));
    writeClientAutoUpdateSetting(dataDir, false);
    expect(JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"))).toEqual({
      other: 42,
      clientAutoUpdate: false,
    });
    expect(readClientAutoUpdateSetting(dataDir, {})).toEqual({ enabled: false, source: "file" });
  });

  it("creates the data dir when it does not exist yet", () => {
    const nested = join(dataDir, "fresh");
    writeClientAutoUpdateSetting(nested, false);
    expect(readClientAutoUpdateSetting(nested, {}).enabled).toBe(false);
  });
});
