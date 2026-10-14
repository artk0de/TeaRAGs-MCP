import { describe, expect, it } from "vitest";

import {
  describeConnectFailure,
  isConnectClassFailure,
} from "../../../../../src/core/adapters/embeddings/utils/connect-failure.js";

describe("describeConnectFailure", () => {
  it("maps an errno code on the direct cause (existing behaviour)", () => {
    const error = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

    expect(describeConnectFailure(error)).toBe("ECONNREFUSED: connection refused - nothing listening on that port");
  });

  it("maps an errno code nested two causes deep", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const middle = new Error("socket error", { cause: inner });
    const error = new TypeError("fetch failed", { cause: middle });

    expect(describeConnectFailure(error)).toContain("ECONNREFUSED: connection refused");
  });

  it("falls back to the innermost cause message when no errno code exists (undici bad port)", () => {
    const error = new TypeError("fetch failed", { cause: new Error("bad port") });

    expect(describeConnectFailure(error)).toBe("bad port");
  });

  it("falls back to the innermost message across several wrappers", () => {
    const error = new TypeError("fetch failed", { cause: new Error("wrapper", { cause: new Error("bad port") }) });

    expect(describeConnectFailure(error)).toBe("bad port");
  });

  it("returns a plain error's message unchanged", () => {
    expect(describeConnectFailure(new Error("boom"))).toBe("boom");
  });

  it("keeps the TimeoutError mapping", () => {
    const error = new Error("aborted");
    error.name = "TimeoutError";

    expect(describeConnectFailure(error)).toBe("ETIMEDOUT: request timed out");
  });

  it("terminates on a cyclic cause chain", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b", { cause: a });
    a.cause = b;

    expect(() => describeConnectFailure(a)).not.toThrow();
  });
});

describe("isConnectClassFailure", () => {
  const fetchFailed = (code: string) =>
    new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code}`), { code }) });

  it.each(["ECONNREFUSED", "EHOSTUNREACH", "EHOSTDOWN", "ENETUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"])(
    "%s is a connect-class failure",
    (code) => {
      expect(isConnectClassFailure(fetchFailed(code))).toBe(true);
    },
  );

  it("a reset mid-request, a request-level abort and a plain error are not", () => {
    const aborted = new Error("aborted");
    aborted.name = "TimeoutError";

    expect(isConnectClassFailure(fetchFailed("ECONNRESET"))).toBe(false);
    expect(isConnectClassFailure(fetchFailed("UND_ERR_SOCKET"))).toBe(false);
    expect(isConnectClassFailure(aborted)).toBe(false);
    expect(isConnectClassFailure(new Error("HTTP 503"))).toBe(false);
    expect(isConnectClassFailure("HTTP 500: boom")).toBe(false);
  });
});
