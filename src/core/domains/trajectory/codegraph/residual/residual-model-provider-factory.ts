import { BrokeredResidualProvider } from "../../../../adapters/kev/brokered-residual-provider.js";
import { KevResidualProvider, type KevResidualProviderDeps } from "../../../../adapters/kev/kev-residual-provider.js";
import { KevSessionClient } from "../../../../adapters/kev/kev-session-client.js";
import { ConfigValueInvalidError, ConfigValueMissingError } from "../../../../primitives/errors/index.js";
import type { ResidualModelProvider } from "./types.js";

/** Models `--resolve-residual` / `--model` accept. Wave 1: Kev only. */
export const RESIDUAL_MODELS = ["kev"] as const;

/** The slice of `codegraph.residual` a provider is built from. */
export interface ResidualProviderConfig {
  kevUrls?: readonly string[];
  kevThreshold: number;
  /** GPU session broker; set, Kev is leased per pass and asked at the lease's URL. */
  kevSessionUrl?: string;
  kevSessionToken?: string;
}

export class ResidualModelProviderFactory {
  static create(
    model: string,
    config: ResidualProviderConfig,
    deps: KevResidualProviderDeps = {},
  ): ResidualModelProvider {
    switch (model) {
      case "kev": {
        if (config.kevSessionUrl) {
          const session = new KevSessionClient(
            { url: config.kevSessionUrl, ...(config.kevSessionToken ? { token: config.kevSessionToken } : {}) },
            deps,
          );
          return new BrokeredResidualProvider({
            session,
            threshold: config.kevThreshold,
            kevProvider: (kevUrl) => new KevResidualProvider({ urls: [kevUrl], threshold: config.kevThreshold }, deps),
          });
        }
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
}
