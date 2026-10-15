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

/** Kev refused the method source as longer than its state limit (HTTP 422); the group cannot be asked as is. */
export class KevStateTooLongError extends InfraError {
  constructor(url: string, detail: string) {
    super({
      code: "INFRA_KEV_STATE_TOO_LONG",
      message: `Kev at ${url} refused the state as too long: ${detail}`,
      hint: "Raise SERVE_MAX_STATE on the Kev server, or start it with KEV_TRUNCATE_STATES=1.",
      httpStatus: 422,
    });
  }
}

/** The GPU session broker holds the card for another client, or is mid-switch (HTTP 409). */
export class KevSessionBusyError extends InfraError {
  constructor(brokerUrl: string, holder: string | undefined, state: string | undefined) {
    super({
      code: "INFRA_KEV_SESSION_BUSY",
      message: `gpu-session-busy: ${holder ?? "no holder"} (${state ?? "unknown state"}) at ${brokerUrl}`,
      hint: "Another run holds the Kev GPU session, or the broker is switching the card; retry when it is back in EMBED.",
      httpStatus: 409,
    });
  }
}

/** The broker refused the session or could not be reached; nothing on the host changed for us. */
export class KevSessionUnavailableError extends InfraError {
  constructor(brokerUrl: string, reason: string, cause?: Error) {
    super({
      code: "INFRA_KEV_SESSION_UNAVAILABLE",
      message: `gpu-session-unavailable: ${reason} at ${brokerUrl}`,
      hint:
        "An embedding run in flight keeps the broker from switching the card to Kev; let it finish. " +
        `Otherwise check the broker log on the GPU host and CODEGRAPH_RESIDUAL_KEV_SESSION_URL=${brokerUrl}`,
      httpStatus: 503,
      cause,
    });
  }
}

/** The broker no longer knows the lease (expired or restarted); Kev may already be gone. */
export class KevSessionLostError extends InfraError {
  constructor(brokerUrl: string, lease: string) {
    super({
      code: "INFRA_KEV_SESSION_LOST",
      message: `gpu-session-lost: lease ${lease} at ${brokerUrl}`,
      hint: "The lease expired or the broker restarted mid-pass; run the residual pass again.",
      httpStatus: 503,
    });
  }
}
