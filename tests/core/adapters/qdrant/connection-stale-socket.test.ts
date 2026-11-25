import { describe, expect, it, vi } from "vitest";

import { QdrantConnection } from "../../../../src/core/adapters/qdrant/connection.js";
import { QdrantUnavailableError } from "../../../../src/core/adapters/qdrant/errors.js";

/**
 * The shape undici rejects with when a request is written onto a pooled
 * keep-alive socket the server already closed: a bare `TypeError("fetch failed")`
 * whose `cause` carries the socket-level code.
 */
function undiciFetchFailed(code: string, causeMessage: string): TypeError {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(causeMessage), { code }),
  });
}

const staleSocketResets = [
  undiciFetchFailed("ECONNRESET", "read ECONNRESET"),
  undiciFetchFailed("UND_ERR_SOCKET", "other side closed"),
];

describe("QdrantConnection#call — stale keep-alive socket reset", () => {
  for (const reset of staleSocketResets) {
    const { code } = reset.cause as { code: string };

    it(`retries once on a ${code} reset against a live daemon whose reconnect declines, returning the retry's result`, async () => {
      const reconnect = vi.fn(async () => null); // live daemon, port unchanged
      const connection = new QdrantConnection("http://127.0.0.1:6333", undefined, reconnect);
      const fn = vi.fn().mockRejectedValueOnce(reset).mockResolvedValueOnce("second");

      await expect(connection.call(fn)).resolves.toBe("second");
      expect(fn).toHaveBeenCalledTimes(2);
      expect(reconnect).not.toHaveBeenCalled();
    });

    it(`retries once on a ${code} reset against an external Qdrant with no reconnect`, async () => {
      const connection = new QdrantConnection("http://qdrant.example:6333");
      const fn = vi.fn().mockRejectedValueOnce(reset).mockResolvedValueOnce({ ok: true });

      await expect(connection.call(fn)).resolves.toEqual({ ok: true });
      expect(fn).toHaveBeenCalledTimes(2);
    });
  }

  it("retries once when the reset is only named by the cause message (no socket code)", async () => {
    const connection = new QdrantConnection("http://qdrant.example:6333");
    const reset = Object.assign(new TypeError("fetch failed"), { cause: new Error("socket hang up") });
    const fn = vi.fn().mockRejectedValueOnce(reset).mockResolvedValueOnce("second");

    await expect(connection.call(fn)).resolves.toBe("second");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not fast-retry a fetch failure whose cause is not a socket reset", async () => {
    const connection = new QdrantConnection("http://qdrant.example:6333");
    const failure = Object.assign(new TypeError("fetch failed"), { cause: new Error("certificate has expired") });
    const fn = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce("must not be reached");

    await expect(connection.call(fn)).rejects.toThrow(QdrantUnavailableError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT fast-retry ECONNREFUSED — a down daemon keeps the reconnect path", async () => {
    const reconnect = vi.fn(async () => null);
    const connection = new QdrantConnection("http://127.0.0.1:6333", undefined, reconnect);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(undiciFetchFailed("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:6333"))
      .mockResolvedValueOnce("must not be reached");

    await expect(connection.call(fn)).rejects.toThrow(QdrantUnavailableError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it("falls through to the existing typed error when the retry is reset too", async () => {
    const reconnect = vi.fn(async () => null);
    const connection = new QdrantConnection("http://127.0.0.1:6333", undefined, reconnect);
    const second = undiciFetchFailed("ECONNRESET", "read ECONNRESET");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(undiciFetchFailed("UND_ERR_SOCKET", "other side closed"))
      .mockRejectedValueOnce(second);

    const err = await connection.call(fn).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QdrantUnavailableError);
    expect((err as QdrantUnavailableError).cause).toBe(second);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it("surfaces a business error from the reset retry untouched", async () => {
    const reconnect = vi.fn(async () => null);
    const connection = new QdrantConnection("http://127.0.0.1:6333", undefined, reconnect);
    const business = Object.assign(new Error("Not Found"), { status: 404 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(undiciFetchFailed("ECONNRESET", "read ECONNRESET"))
      .mockRejectedValueOnce(business);

    await expect(connection.call(fn)).rejects.toBe(business);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("does not retry an HTTP business error", async () => {
    const connection = new QdrantConnection("http://127.0.0.1:6333");
    const business = Object.assign(new Error("Conflict"), { status: 409 });
    const fn = vi.fn().mockRejectedValueOnce(business).mockResolvedValueOnce("must not be reached");

    await expect(connection.call(fn)).rejects.toBe(business);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

/**
 * The other face of a dead keep-alive socket: the request sits on it until the
 * client aborts, and undici surfaces that as `AbortError` / `TimeoutError` /
 * `QdrantClientTimeoutError` — or only as a message — rather than ECONNRESET.
 * `call` treats every one of them as transport, retried once on a fresh client.
 */
describe("QdrantConnection#call — hung keep-alive socket until abort", () => {
  const abortError = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" });

  const hungTransports: { label: string; make: () => Error }[] = [
    { label: "an AbortError name", make: abortError },
    {
      label: "a TimeoutError name",
      make: () => Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }),
    },
    {
      label: "a QdrantClientTimeoutError name",
      make: () => Object.assign(new Error("client timed out"), { name: "QdrantClientTimeoutError" }),
    },
    {
      label: "an aborted message on a plain Error",
      make: () => new Error("This operation was aborted due to timeout"),
    },
    { label: "a headers timeout message", make: () => new Error("headers timeout") },
    { label: "a body timeout message", make: () => new Error("body timeout") },
  ];

  for (const { label, make } of hungTransports) {
    it(`retries once on ${label} and returns the retry's result`, async () => {
      const connection = new QdrantConnection("http://qdrant.example:6333");
      const fn = vi.fn().mockRejectedValueOnce(make()).mockResolvedValueOnce("second");

      await expect(connection.call(fn)).resolves.toBe("second");
      expect(fn).toHaveBeenCalledTimes(2);
    });
  }

  it("drops the pooled client before the retry", async () => {
    const connection = new QdrantConnection("http://qdrant.example:6333");
    const pooled = connection.client;
    const fn = vi.fn().mockRejectedValueOnce(abortError()).mockResolvedValueOnce("ok");

    await expect(connection.call(fn)).resolves.toBe("ok");
    expect(connection.client).not.toBe(pooled);
  });

  it("keeps the abort as the cause of the typed unavailability when the fresh client hangs too", async () => {
    const reconnect = vi.fn(async () => null);
    const connection = new QdrantConnection("http://127.0.0.1:6333", undefined, reconnect);
    const raw = abortError();
    const fn = vi.fn().mockRejectedValue(raw);

    const err = await connection.call(fn).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QdrantUnavailableError);
    expect((err as QdrantUnavailableError).cause).toBe(raw);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it("terminates the cause-chain walk on a cycle instead of looping", async () => {
    const connection = new QdrantConnection("http://qdrant.example:6333");
    const looped = new TypeError("fetch failed");
    (looped as { cause?: unknown }).cause = looped; // self-referential chain
    const fn = vi.fn().mockRejectedValueOnce(looped).mockResolvedValueOnce("must not be reached");

    // A fetch failure that is no reset: no fast retry, and with no reconnect
    // it stays typed unavailability.
    await expect(connection.call(fn)).rejects.toThrow(QdrantUnavailableError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
