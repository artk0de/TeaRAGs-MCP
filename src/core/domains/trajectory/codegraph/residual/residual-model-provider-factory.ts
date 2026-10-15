import { ConfigValueInvalidError } from "../../../../primitives/errors/index.js";
import type { ResidualModelProvider } from "./types.js";

/** Models `--resolve-residual` / `--model` accept. Wave 1: Kev only. */
export const RESIDUAL_MODELS = ["kev"] as const;

/** The slice of `codegraph.residual` a provider is built from. */
export interface ResidualProviderConfig {
  kevUrls?: readonly string[];
  kevThreshold: number;
}

export class ResidualModelProviderFactory {
  static create(model: string, _config: ResidualProviderConfig): ResidualModelProvider {
    switch (model) {
      default:
        throw new ConfigValueInvalidError("residualModel", model, RESIDUAL_MODELS.join(" | "));
    }
  }
}
