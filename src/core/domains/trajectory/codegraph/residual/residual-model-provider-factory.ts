import { KevResidualProvider, type KevResidualProviderDeps } from "../../../../adapters/kev/kev-residual-provider.js";
import { ConfigValueInvalidError, ConfigValueMissingError } from "../../../../primitives/errors/index.js";
import type { ResidualModelProvider } from "./types.js";

/** Models `--resolve-residual` / `--model` accept. Wave 1: Kev only. */
export const RESIDUAL_MODELS = ["kev"] as const;

/** The slice of `codegraph.residual` a provider is built from. */
export interface ResidualProviderConfig {
  kevUrls?: readonly string[];
  kevThreshold: number;
}

export class ResidualModelProviderFactory {
  static create(
    model: string,
    config: ResidualProviderConfig,
    deps: KevResidualProviderDeps = {},
  ): ResidualModelProvider {
    switch (model) {
      case "kev": {
        const urls = (config.kevUrls ?? []).filter((url) => url.length > 0);
        if (urls.length === 0) {
          throw new ConfigValueMissingError("codegraph.residual.kevUrls", "CODEGRAPH_RESIDUAL_KEV_URL");
        }
        return new KevResidualProvider({ urls, threshold: config.kevThreshold }, deps);
      }
      default:
        throw new ConfigValueInvalidError("residualModel", model, RESIDUAL_MODELS.join(" | "));
    }
  }

  /**
   * The model's id and threshold for a `cacheOnly` pass, which never asks it —
   * so no URL is needed, and every call that would reach the model throws.
   */
  static cacheOnly(model: string, config: Pick<ResidualProviderConfig, "kevThreshold">): ResidualModelProvider {
    switch (model) {
      case "kev":
        return cacheOnlyProvider(model, config.kevThreshold);
      default:
        throw new ConfigValueInvalidError("residualModel", model, RESIDUAL_MODELS.join(" | "));
    }
  }
}

function cacheOnlyProvider(id: string, threshold: number): ResidualModelProvider {
  const neverAsked = async (): Promise<never> => Promise.reject(new Error(`${id}: cache-only provider is never asked`));
  return {
    id,
    threshold,
    version: neverAsked,
    health: async () => ({ ok: false, reason: "cache-only provider is never asked" }),
    resolveGroup: neverAsked,
  };
}
