import { describe, expect, it } from "vitest";

import { parseAppConfigZod } from "../../src/bootstrap/config/index.js";

describe("codegraph.residual config", () => {
  it("defaults: no Kev URL, threshold 0.7, concurrency 16, request timeout 300 s, menu limit 40, menu floor 1, none threshold 0.8, tournament floor 0.5 and budget 5000, confirm stage and origin context off, retention 180 days", () => {
    const { codegraph } = parseAppConfigZod({});

    expect(codegraph.residual).toEqual({
      kevUrls: undefined,
      kevThreshold: 0.7,
      concurrency: 16,
      requestTimeoutSec: 300,
      maxQuestionsPerRequest: 8,
      maxCriteriaPerRequest: 120,
      menuLimit: 40,
      minMenu: 1,
      noneThreshold: 0.8,
      tournamentFloor: 0.5,
      tournamentBudget: 5000,
      confirmStage: false,
      originContext: false,
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
      CODEGRAPH_RESIDUAL_REQUEST_TIMEOUT_SEC: "600",
      CODEGRAPH_RESIDUAL_MAX_QUESTIONS_PER_REQUEST: "4",
      CODEGRAPH_RESIDUAL_MAX_CRITERIA_PER_REQUEST: "80",
      CODEGRAPH_RESIDUAL_MENU_LIMIT: "20",
      CODEGRAPH_RESIDUAL_MIN_MENU: "2",
      CODEGRAPH_RESIDUAL_NONE_THRESHOLD: "0.9",
      CODEGRAPH_RESIDUAL_TOURNAMENT_FLOOR: "0.4",
      CODEGRAPH_RESIDUAL_TOURNAMENT_BUDGET: "200",
      CODEGRAPH_RESIDUAL_CONFIRM_STAGE: "true",
      CODEGRAPH_RESIDUAL_ORIGIN_CONTEXT: "true",
      CODEGRAPH_RESIDUAL_VERDICT_RETENTION_DAYS: "30",
      CODEGRAPH_RESIDUAL_KEV_SESSION_URL: "http://192.168.1.71:8008",
      CODEGRAPH_RESIDUAL_KEV_SESSION_TOKEN: "s3cret",
    });

    expect(codegraph.residual).toEqual({
      kevUrls: ["http://gpu:8090", "http://gpu:8091"],
      kevThreshold: 0.85,
      concurrency: 8,
      requestTimeoutSec: 600,
      maxQuestionsPerRequest: 4,
      maxCriteriaPerRequest: 80,
      menuLimit: 20,
      minMenu: 2,
      noneThreshold: 0.9,
      tournamentFloor: 0.4,
      tournamentBudget: 200,
      confirmStage: true,
      originContext: true,
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
