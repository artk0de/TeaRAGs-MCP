import { describe, expect, it } from "vitest";

import { describeConnectFailure } from "../../../../../src/core/adapters/embeddings/utils/connect-failure.js";

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
