import { describe, expect, it } from "vitest";

import { parseAppConfigZod } from "../../src/bootstrap/config/index.js";

describe("codegraph.residual config", () => {
  it("defaults: no Kev URL, threshold 0.7, concurrency 16, menu limit 40, retention 180 days", () => {
    const { codegraph } = parseAppConfigZod({});

    expect(codegraph.residual).toEqual({
      kevUrls: undefined,
      kevThreshold: 0.7,
      concurrency: 16,
      menuLimit: 40,
      retentionDays: 180,
      kevSessionUrl: undefined,
      kevSessionToken: undefined,
    });
  });

  it("reads every CODEGRAPH_RESIDUAL_* variable; the Kev URL list is comma-separated", () => {
    const { codegraph } = parseAppConfigZod({
      CODEGRAPH_RESIDUAL_KEV_URL: "http://gpu:8090, http://gpu:8091",
      CODEGRAPH_RESIDUAL_KEV_THRESHOLD: "0.85",
      CODEGRAPH_RESIDUAL_CONCURRENCY: "8",
      CODEGRAPH_RESIDUAL_MENU_LIMIT: "20",
      CODEGRAPH_RESIDUAL_VERDICT_RETENTION_DAYS: "30",
      CODEGRAPH_RESIDUAL_KEV_SESSION_URL: "http://192.168.1.71:8008",
      CODEGRAPH_RESIDUAL_KEV_SESSION_TOKEN: "s3cret",
    });

    expect(codegraph.residual).toEqual({
      kevUrls: ["http://gpu:8090", "http://gpu:8091"],
      kevThreshold: 0.85,
      concurrency: 8,
      menuLimit: 20,
      retentionDays: 30,
      kevSessionUrl: "http://192.168.1.71:8008",
      kevSessionToken: "s3cret",
    });
  });

  it("records the residual keys as explicitly set", () => {
    const { flags } = parseAppConfigZod({ CODEGRAPH_RESIDUAL_KEV_URL: "http://gpu:8090" });

    expect(flags.explicitEnvKeys).toContain("CODEGRAPH_RESIDUAL_KEV_URL");
  });
});
