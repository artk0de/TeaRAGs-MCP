import { BrokeredResidualProvider } from "../../../../adapters/kev/brokered-residual-provider.js";
import {
  KEV_PROMPT_TEMPLATE,
  KevResidualProvider,
  type KevResidualProviderDeps,
} from "../../../../adapters/kev/kev-residual-provider.js";
import { KevSessionClient } from "../../../../adapters/kev/kev-session-client.js";
import { ConfigValueInvalidError, ConfigValueMissingError } from "../../../../primitives/errors/index.js";
import type { ResidualModelProvider } from "./types.js";

/** Models `--resolve-residual` / `--model` accept. Wave 1: Kev only. */
export const RESIDUAL_MODELS = ["kev"] as const;

/** The slice of `codegraph.residual` a provider is built from. */
export interface ResidualProviderConfig {
  kevUrls?: readonly string[];
  kevThreshold: number;
  /** Per-request Kev budget, seconds; the provider's default when unset. */
  requestTimeoutSec?: number;
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
        const kevOptions = {
          threshold: config.kevThreshold,
          ...(config.requestTimeoutSec !== undefined ? { resolveTimeoutMs: config.requestTimeoutSec * 1000 } : {}),
        };
        if (config.kevSessionUrl) {
          const session = new KevSessionClient(
            { url: config.kevSessionUrl, ...(config.kevSessionToken ? { token: config.kevSessionToken } : {}) },
            deps,
          );
          return new BrokeredResidualProvider({
            session,
            threshold: config.kevThreshold,
            kevProvider: (kevUrl) => new KevResidualProvider({ urls: [kevUrl], ...kevOptions }, deps),
          });
        }
        const urls = (config.kevUrls ?? []).filter((url) => url.length > 0);
        if (urls.length === 0) {
          throw new ConfigValueMissingError("codegraph.residual.kevUrls", "CODEGRAPH_RESIDUAL_KEV_URL");
        }
        return new KevResidualProvider({ urls, ...kevOptions }, deps);
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
        return cacheOnlyProvider(model, config.kevThreshold, KEV_PROMPT_TEMPLATE);
      default:
        throw new ConfigValueInvalidError("residualModel", model, RESIDUAL_MODELS.join(" | "));
    }
  }
}

function cacheOnlyProvider(id: string, threshold: number, promptTemplate: string): ResidualModelProvider {
  const neverAsked = async (): Promise<never> => Promise.reject(new Error(`${id}: cache-only provider is never asked`));
  return {
    id,
    threshold,
    promptTemplate,
    version: neverAsked,
    health: async () => ({ ok: false, reason: "cache-only provider is never asked" }),
    resolveGroup: neverAsked,
  };
}
