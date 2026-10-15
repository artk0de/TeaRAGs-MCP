import { describe, expect, it } from "vitest";

import {
  RESIDUAL_MODELS,
  ResidualModelProviderFactory,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.js";
import { ConfigValueInvalidError } from "../../../../../../src/core/primitives/errors/index.js";

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
});
