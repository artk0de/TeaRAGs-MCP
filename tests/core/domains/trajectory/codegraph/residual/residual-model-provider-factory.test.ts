import { describe, expect, it } from "vitest";

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

  it("refuses kev without CODEGRAPH_RESIDUAL_KEV_URL", () => {
    expect(() => ResidualModelProviderFactory.create("kev", { kevThreshold: 0.7 })).toThrow(ConfigValueMissingError);
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
