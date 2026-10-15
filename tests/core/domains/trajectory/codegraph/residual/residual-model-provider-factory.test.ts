import { describe, expect, it, vi } from "vitest";

import { BrokeredResidualProvider } from "../../../../../../src/core/adapters/kev/brokered-residual-provider.js";
import { KevResidualProvider } from "../../../../../../src/core/adapters/kev/kev-residual-provider.js";
import {
  RESIDUAL_MODELS,
  ResidualModelProviderFactory,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.js";
import {
  ConfigValueInvalidError,
  ConfigValueMissingError,
} from "../../../../../../src/core/primitives/errors/index.js";

describe("ResidualModelProviderFactory", () => {
  it("rejects an unknown model with a typed config error naming the supported models", () => {
    const create = () =>
      ResidualModelProviderFactory.create("gpt-9", { kevUrls: ["http://gpu:8090"], kevThreshold: 0.7 });

    expect(create).toThrow(ConfigValueInvalidError);
    expect(create).toThrow(/Invalid value "gpt-9" for configuration field "residualModel"/);
  });

  it("lists kev as the only wave-1 model", () => {
    expect(RESIDUAL_MODELS).toEqual(["kev"]);
  });

  it("builds a KevResidualProvider for kev with the configured threshold", () => {
    const provider = ResidualModelProviderFactory.create("kev", {
      kevUrls: ["http://gpu:8090"],
      kevThreshold: 0.8,
    });

    expect(provider).toBeInstanceOf(KevResidualProvider);
    expect(provider.threshold).toBe(0.8);
  });

  it("gives Kev requests the configured timeout, in seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const refused = (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    const provider = ResidualModelProviderFactory.create(
      "kev",
      { kevUrls: ["http://gpu:8090"], kevThreshold: 0.7, requestTimeoutSec: 450 },
      { fetch: refused },
    );

    await provider
      .resolveGroup({ sourceRelPath: "a.rb", methodSymbolId: "A#run", methodSource: "def run; end", questions: [] })
      .catch(() => undefined);

    expect(timeout).toHaveBeenCalledWith(450_000);
    timeout.mockRestore();
  });

  it("refuses kev without CODEGRAPH_RESIDUAL_KEV_URL", () => {
    expect(() => ResidualModelProviderFactory.create("kev", { kevThreshold: 0.7 })).toThrow(ConfigValueMissingError);
  });

  it("leases Kev through the session broker when CODEGRAPH_RESIDUAL_KEV_SESSION_URL is set; no Kev URL needed", async () => {
    const requests: { url: string; token: string | null }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: input instanceof Request ? input.url : input.toString(),
        token: new Headers(init?.headers).get("x-broker-token"),
      });
      return new Response(JSON.stringify({ state: "EMBED", kev: { run: "jaredpalmer/kev-4b@v1.0" } }));
    }) as typeof fetch;

    const provider = ResidualModelProviderFactory.create(
      "kev",
      { kevThreshold: 0.8, kevSessionUrl: "http://gpu:8008", kevSessionToken: "s3cret" },
      { fetch: fetchFn },
    );

    expect(provider).toBeInstanceOf(BrokeredResidualProvider);
    expect(provider.threshold).toBe(0.8);
    await expect(provider.version()).resolves.toBe("jaredpalmer/kev-4b@v1.0");
    expect(requests).toEqual([{ url: "http://gpu:8008/v1/state", token: "s3cret" }]);
  });

  it("builds a cache-only kev provider without a URL: its threshold applies, asking it throws", async () => {
    const provider = ResidualModelProviderFactory.cacheOnly("kev", { kevThreshold: 0.8 });

    expect(provider.id).toBe("kev");
    expect(provider.threshold).toBe(0.8);
    await expect(provider.health()).resolves.toEqual({ ok: false, reason: "cache-only provider is never asked" });
    await expect(provider.version()).rejects.toThrow(/cache-only/);
  });

  it("refuses an unknown model for a cache-only provider too", () => {
    expect(() => ResidualModelProviderFactory.cacheOnly("gpt-9", { kevThreshold: 0.7 })).toThrow(
      ConfigValueInvalidError,
    );
  });
});
