import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  KevResponseError,
  KevStateTooLongError,
  KevUnavailableError,
} from "../../../../src/core/adapters/kev/errors.js";
import {
  candidateClass,
  kevQuestion,
  KevResidualProvider,
} from "../../../../src/core/adapters/kev/kev-residual-provider.js";
import type { ResidualQuestionGroup } from "../../../../src/core/contracts/types/codegraph-residual.js";

const FIXTURES = join(import.meta.dirname, "../../../fixtures/kev");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

interface Recorded {
  url: string;
  method: string;
  body?: unknown;
}

type Route = (url: string, init?: RequestInit) => Response | "refused";

function fakeFetch(route: Route): {
  fetch: typeof fetch;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    const outcome = route(url, init);
    if (outcome === "refused") throw new TypeError("fetch failed: ECONNREFUSED");
    return outcome;
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const GROUP: ResidualQuestionGroup = {
  sourceRelPath: "app/services/sync.rb",
  methodSymbolId: "Sync#run",
  methodSource: "def run(firm, client)\n  firm.users\n  client.users\nend",
  questions: [
    {
      siteKey: "site-a",
      menuHash: "menu-1",
      receiverText: "firm",
      member: "users",
      kind: "ambiguous",
      candidates: ["Firm#users", "Client#users"],
    },
    {
      siteKey: "site-b",
      menuHash: "menu-1",
      receiverText: "client",
      member: "users",
      kind: "ambiguous",
      candidates: ["Firm#users", "Client#users"],
    },
  ],
};

describe("candidateClass", () => {
  it("takes the class part of instance and class method symbolIds", () => {
    expect(candidateClass("Firm#users")).toBe("Firm");
    expect(candidateClass("TaxPreparation::DocDir#client")).toBe("TaxPreparation::DocDir");
    expect(candidateClass("Firm.find_by_slug")).toBe("Firm");
    expect(candidateClass("Firm")).toBe("Firm");
  });
});

describe("KevResidualProvider", () => {
  it("sends one /v1/systemone request per group: state = file header + method source, one choice question per site", async () => {
    const { fetch, requests } = fakeFetch(() => json(fixture("systemone-two-sites.json")));
    const provider = new KevResidualProvider({ urls: ["http://gpu:8090"], threshold: 0.7 }, { fetch });

    await provider.resolveGroup(GROUP);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: "http://gpu:8090/v1/systemone",
      method: "POST",
      body: {
        model: "kev-latest",
        state: "# file: app/services/sync.rb\ndef run(firm, client)\n  firm.users\n  client.users\nend",
        questions: {
          "site-a": kevQuestion("firm", "users", ["Firm", "Client"]),
          "site-b": kevQuestion("client", "users", ["Firm", "Client"]),
        },
      },
    });
    expect(kevQuestion("firm", "users", ["Firm", "Client"])).toEqual({
      type: "choice",
      instructions:
        "In this Ruby method, `firm` is the receiver of the call `firm.users`. " +
        "Which class is the object passed as `firm`?",
      criteria: { Firm: null, Client: null },
    });
  });

  it("maps each answer's class back to the candidate symbolId, p = probability of the choice", async () => {
    const { fetch } = fakeFetch(() => json(fixture("systemone-two-sites.json")));
    const provider = new KevResidualProvider({ urls: ["http://gpu:8090"], threshold: 0.7 }, { fetch });

    const answers = await provider.resolveGroup(GROUP);

    expect(answers).toEqual([
      {
        siteKey: "site-a",
        pick: "Firm#users",
        p: 0.91,
        probabilities: { "Firm#users": 0.91, "Client#users": 0.09 },
        questionPayload: JSON.stringify(kevQuestion("firm", "users", ["Firm", "Client"])),
      },
      {
        siteKey: "site-b",
        pick: "Client#users",
        p: 0.8,
        probabilities: { "Firm#users": 0.2, "Client#users": 0.8 },
        questionPayload: JSON.stringify(kevQuestion("client", "users", ["Firm", "Client"])),
      },
    ]);
  });

  it("rejects an answer naming a class outside the menu", async () => {
    const { fetch } = fakeFetch(() =>
      json({
        answers: {
          "site-a": { choice: "Account", probabilities: { Account: 1 } },
        },
      }),
    );
    const provider = new KevResidualProvider({ urls: ["http://gpu:8090"], threshold: 0.7 }, { fetch });

    await expect(provider.resolveGroup({ ...GROUP, questions: [GROUP.questions[0]] })).rejects.toBeInstanceOf(
      KevResponseError,
    );
  });

  it("round-robins groups across URLs and fails over past a refused one", async () => {
    const { fetch, requests } = fakeFetch((url) =>
      url.startsWith("http://b:1") ? "refused" : json(fixture("systemone-two-sites.json")),
    );
    const provider = new KevResidualProvider({ urls: ["http://a:1", "http://b:1"], threshold: 0.7 }, { fetch });

    await provider.resolveGroup(GROUP);
    await provider.resolveGroup(GROUP);

    expect(requests.map((r) => r.url)).toEqual([
      "http://a:1/v1/systemone",
      "http://b:1/v1/systemone",
      "http://a:1/v1/systemone",
    ]);
  });

  it("throws KevStateTooLongError when Kev refuses the state as too long (HTTP 422)", async () => {
    const { fetch, requests } = fakeFetch(() => new Response("state exceeds SERVE_MAX_STATE", { status: 422 }));
    const provider = new KevResidualProvider({ urls: ["http://a:1", "http://b:1"], threshold: 0.7 }, { fetch });

    const error = await provider.resolveGroup(GROUP).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KevStateTooLongError);
    expect(error).toMatchObject({ code: "INFRA_KEV_STATE_TOO_LONG" });
    expect(requests).toHaveLength(1);
  });

  it("throws KevUnavailableError when every URL is down", async () => {
    const { fetch } = fakeFetch(() => "refused");
    const provider = new KevResidualProvider({ urls: ["http://a:1", "http://b:1"], threshold: 0.7 }, { fetch });

    await expect(provider.resolveGroup(GROUP)).rejects.toBeInstanceOf(KevUnavailableError);
  });

  it("version() is the run of the served model; health() is ok when /v1/models answers", async () => {
    const { fetch, requests } = fakeFetch(() => json(fixture("models.json")));
    const provider = new KevResidualProvider({ urls: ["http://gpu:8090"], threshold: 0.7 }, { fetch });

    expect(await provider.version()).toBe("jaredpalmer/kev-4b@v1.0");
    expect(await provider.health()).toEqual({ ok: true });
    expect(requests.every((r) => r.url === "http://gpu:8090/v1/models" && r.method === "GET")).toBe(true);
  });

  it("health() reports the reason when no URL serves a model", async () => {
    const { fetch } = fakeFetch(() => "refused");
    const provider = new KevResidualProvider({ urls: ["http://gpu:8090"], threshold: 0.7 }, { fetch });

    const health = await provider.health();

    expect(health.ok).toBe(false);
    expect(health).toEqual({
      ok: false,
      reason: expect.stringMatching(/http:\/\/gpu:8090.*ECONNREFUSED/),
    });
  });

  it("carries the configured threshold and id", () => {
    const provider = new KevResidualProvider({
      urls: ["http://gpu:8090"],
      threshold: 0.85,
    });

    expect(provider.id).toBe("kev");
    expect(provider.threshold).toBe(0.85);
  });
});
