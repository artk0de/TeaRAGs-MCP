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
