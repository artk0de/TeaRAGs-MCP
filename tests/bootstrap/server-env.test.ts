/**
 * Tests for SERVER_* env var naming convention.
 *
 * Verifies: new name works, old name works as fallback, new name takes priority, default when neither set.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Env var mapping: [newName, oldName, configKey, testValue, defaultValue] */
const _ENV_MAPPINGS: [string, string, keyof Awaited<ReturnType<typeof freshImport>>["AppConfig"], string, string][] =
  [];

/** All env var names involved (for cleanup) */
const ALL_KEYS = [
  "SERVER_TRANSPORT",
  "TRANSPORT_MODE",
  "SERVER_HTTP_PORT",
  "HTTP_PORT",
  "SERVER_HTTP_TIMEOUT_MS",
  "HTTP_REQUEST_TIMEOUT_MS",
  "SERVER_PROMPTS_FILE",
  "PROMPTS_CONFIG_FILE",
];

/** Fresh import of config.ts to pick up env var changes */
async function freshImport() {
  const mod = await import("../../src/bootstrap/config/index.js");
  return mod;
}

describe("SERVER_* env var naming", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ALL_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ALL_KEYS) {
      if (saved[key] !== undefined) {
        process.env[key] = saved[key];
      } else {
        delete process.env[key];
      }
    }
  });

  describe("SERVER_TRANSPORT (was TRANSPORT_MODE)", () => {
    it("should read SERVER_TRANSPORT (new name)", async () => {
      process.env.SERVER_TRANSPORT = "http";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.transportMode).toBe("http");
    });

    it("should fall back to TRANSPORT_MODE (old name)", async () => {
      process.env.TRANSPORT_MODE = "http";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.transportMode).toBe("http");
    });

    it("should prefer SERVER_TRANSPORT over TRANSPORT_MODE", async () => {
      process.env.SERVER_TRANSPORT = "stdio";
      process.env.TRANSPORT_MODE = "http";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.transportMode).toBe("stdio");
    });

    it("should default to stdio when neither is set", async () => {
      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.transportMode).toBe("stdio");
    });
  });

  describe("SERVER_HTTP_PORT (was HTTP_PORT)", () => {
    it("should read SERVER_HTTP_PORT (new name)", async () => {
      process.env.SERVER_HTTP_PORT = "8080";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.httpPort).toBe(8080);
    });

    it("should fall back to HTTP_PORT (old name)", async () => {
      process.env.HTTP_PORT = "8080";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.httpPort).toBe(8080);
    });

    it("should prefer SERVER_HTTP_PORT over HTTP_PORT", async () => {
      process.env.SERVER_HTTP_PORT = "9090";
      process.env.HTTP_PORT = "8080";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.httpPort).toBe(9090);
    });

    it("should default to 3000 when neither is set", async () => {
      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.httpPort).toBe(3000);
    });
  });

  describe("SERVER_HTTP_TIMEOUT_MS (was HTTP_REQUEST_TIMEOUT_MS)", () => {
    it("should read SERVER_HTTP_TIMEOUT_MS (new name)", async () => {
      process.env.SERVER_HTTP_TIMEOUT_MS = "60000";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.requestTimeoutMs).toBe(60000);
    });

    it("should fall back to HTTP_REQUEST_TIMEOUT_MS (old name)", async () => {
      process.env.HTTP_REQUEST_TIMEOUT_MS = "60000";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.requestTimeoutMs).toBe(60000);
    });

    it("should prefer SERVER_HTTP_TIMEOUT_MS over HTTP_REQUEST_TIMEOUT_MS", async () => {
      process.env.SERVER_HTTP_TIMEOUT_MS = "10000";
      process.env.HTTP_REQUEST_TIMEOUT_MS = "60000";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.requestTimeoutMs).toBe(10000);
    });

    it("should default to 300000 when neither is set", async () => {
      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.requestTimeoutMs).toBe(300000);
    });
  });

  describe("SERVER_PROMPTS_FILE (was PROMPTS_CONFIG_FILE)", () => {
    it("should read SERVER_PROMPTS_FILE (new name)", async () => {
      process.env.SERVER_PROMPTS_FILE = "/tmp/custom-prompts.json";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.promptsConfigFile).toBe("/tmp/custom-prompts.json");
    });

    it("should fall back to PROMPTS_CONFIG_FILE (old name)", async () => {
      process.env.PROMPTS_CONFIG_FILE = "/tmp/custom-prompts.json";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.promptsConfigFile).toBe("/tmp/custom-prompts.json");
    });

    it("should prefer SERVER_PROMPTS_FILE over PROMPTS_CONFIG_FILE", async () => {
      process.env.SERVER_PROMPTS_FILE = "/tmp/new-prompts.json";
      process.env.PROMPTS_CONFIG_FILE = "/tmp/old-prompts.json";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.promptsConfigFile).toBe("/tmp/new-prompts.json");
    });

    it("should default to prompts.json when neither is set", async () => {
      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.promptsConfigFile).toContain("prompts.json");
    });
  });
});
