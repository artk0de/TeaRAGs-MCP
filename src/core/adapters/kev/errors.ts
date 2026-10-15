/** Kev residual-model provider errors. */

import { InfraError } from "../errors.js";

/** No configured Kev URL answered. */
export class KevUnavailableError extends InfraError {
  constructor(urls: readonly string[], cause?: Error) {
    super({
      code: "INFRA_KEV_UNAVAILABLE",
      message: `No Kev endpoint is reachable at ${urls.join(", ")}`,
      hint:
        "Start the Kev server on the GPU host, check that its port is reachable from here, " +
        `and verify CODEGRAPH_RESIDUAL_KEV_URL=${urls.join(",")}`,
      httpStatus: 503,
      cause,
    });
  }
}

/** Kev answered, but not with what was asked. */
export class KevResponseError extends InfraError {
  constructor(url: string, detail: string) {
    super({
      code: "INFRA_KEV_RESPONSE_ERROR",
      message: `Kev at ${url} returned an unusable response: ${detail}`,
      hint: "Check that the endpoint serves the Kev systemone API (POST /v1/systemone, GET /v1/models).",
      httpStatus: 502,
    });
  }
}
