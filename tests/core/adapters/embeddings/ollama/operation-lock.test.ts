import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OperationLock } from "../../../../../src/core/adapters/embeddings/ollama/operation-lock.js";

describe("OperationLock", () => {
  let lock: OperationLock;

  beforeEach(() => {
    lock = new OperationLock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("acquire", () => {
    it("should resolve URL via resolveUrl on first acquire", async () => {
      const resolveUrl = vi.fn().mockResolvedValue("http://primary:11434");

      const url = await lock.acquire(resolveUrl);

      expect(url).toBe("http://primary:11434");
      expect(resolveUrl).toHaveBeenCalledOnce();
    });

    it("should resolve URL once — parallel callers wait on mutex", async () => {
      let resolvePromise: (url: string) => void;
      const resolveUrl = vi.fn().mockReturnValue(
        new Promise<string>((resolve) => {
          resolvePromise = resolve;
        }),
      );

      // Two concurrent acquires
      const p1 = lock.acquire(resolveUrl);
      const p2 = lock.acquire(resolveUrl);

      // Resolve the URL
      resolvePromise!("http://primary:11434");

      const [url1, url2] = await Promise.all([p1, p2]);

      expect(url1).toBe("http://primary:11434");
      expect(url2).toBe("http://primary:11434");
      // resolveUrl called only once — second caller waited on mutex
      expect(resolveUrl).toHaveBeenCalledOnce();
    });

    it("should rollback count on resolveUrl failure", async () => {
      const resolveUrl = vi.fn().mockRejectedValue(new Error("health check failed"));

      await expect(lock.acquire(resolveUrl)).rejects.toThrow("health check failed");

      expect(lock.isActive).toBe(false);
    });

    it("should propagate error to parallel callers on resolveUrl failure", async () => {
      const resolveUrl = vi.fn().mockRejectedValue(new Error("both dead"));

      const p1 = lock.acquire(resolveUrl);
      const p2 = lock.acquire(resolveUrl);

      await expect(p1).rejects.toThrow("both dead");
      await expect(p2).rejects.toThrow("both dead");
      expect(lock.isActive).toBe(false);
    });

    it("should return locked URL for subsequent acquires after first resolves", async () => {
      const resolveUrl = vi.fn().mockResolvedValue("http://fallback:11434");

      await lock.acquire(resolveUrl);
      const url2 = await lock.acquire(resolveUrl);

      expect(url2).toBe("http://fallback:11434");
      // Only first acquire calls resolveUrl
      expect(resolveUrl).toHaveBeenCalledOnce();
    });
  });

  describe("release", () => {
    it("should return recovered=false when no deferred recovery", async () => {
      await lock.acquire(async () => "http://primary:11434");

      const { recovered } = lock.release();

      expect(recovered).toBe(false);
    });

    it("should clear lockedUrl when count reaches 0", async () => {
      await lock.acquire(async () => "http://primary:11434");
      lock.release();

      expect(lock.isActive).toBe(false);
      expect(lock.url).toBeNull();
    });

    it("should not go below 0", () => {
      const { recovered } = lock.release();
      expect(recovered).toBe(false);
      expect(lock.isActive).toBe(false);
    });

    it("should decrement refcount correctly with multiple acquires", async () => {
      const resolveUrl = async () => "http://primary:11434";

      await lock.acquire(resolveUrl);
      await lock.acquire(resolveUrl);

      lock.release(); // count = 1
      expect(lock.isActive).toBe(true);

      lock.release(); // count = 0
      expect(lock.isActive).toBe(false);
    });
  });

  describe("deferRecovery", () => {
    it("should apply deferred recovery on last release", async () => {
      await lock.acquire(async () => "http://fallback:11434");

      lock.deferRecovery();
      const { recovered } = lock.release();

      expect(recovered).toBe(true);
    });

    it("should not apply deferred recovery before count reaches 0", async () => {
      const resolveUrl = async () => "http://fallback:11434";
      await lock.acquire(resolveUrl);
      await lock.acquire(resolveUrl);

      lock.deferRecovery();

      const first = lock.release(); // count = 1
      expect(first.recovered).toBe(false);

      const last = lock.release(); // count = 0
      expect(last.recovered).toBe(true);
    });

    it("should clear pending recovery after it is consumed", async () => {
      await lock.acquire(async () => "http://fallback:11434");
      lock.deferRecovery();
      lock.release(); // consumed

      // New acquire + release — no recovery pending
      await lock.acquire(async () => "http://primary:11434");
      const { recovered } = lock.release();

      expect(recovered).toBe(false);
    });
  });

  describe("isActive", () => {
    it("should be false initially", () => {
      expect(lock.isActive).toBe(false);
    });

    it("should be true after acquire", async () => {
      await lock.acquire(async () => "http://primary:11434");
      expect(lock.isActive).toBe(true);
    });

    it("should be false after all releases", async () => {
      await lock.acquire(async () => "http://primary:11434");
      lock.release();
      expect(lock.isActive).toBe(false);
    });
  });

  describe("url", () => {
    it("should be null initially", () => {
      expect(lock.url).toBeNull();
    });

    it("should return locked URL while active", async () => {
      await lock.acquire(async () => "http://fallback:11434");
      expect(lock.url).toBe("http://fallback:11434");
    });

    it("should be null after release", async () => {
      await lock.acquire(async () => "http://primary:11434");
      lock.release();
      expect(lock.url).toBeNull();
    });
  });

  describe("stale timeout", () => {
    it("should force-release after stale timeout", async () => {
      vi.useFakeTimers();

      await lock.acquire(async () => "http://primary:11434", 5000);

      expect(lock.isActive).toBe(true);

      await vi.advanceTimersByTimeAsync(5000);

      expect(lock.isActive).toBe(false);
      expect(lock.url).toBeNull();
    });

    it("should not force-release before timeout", async () => {
      vi.useFakeTimers();

      await lock.acquire(async () => "http://primary:11434", 5000);

      await vi.advanceTimersByTimeAsync(4999);

      expect(lock.isActive).toBe(true);
    });

    it("should clear stale timer on normal release", async () => {
      vi.useFakeTimers();

      await lock.acquire(async () => "http://primary:11434", 5000);
      lock.release();

      // Advancing past timeout should not cause issues
      await vi.advanceTimersByTimeAsync(10000);

      expect(lock.isActive).toBe(false);
    });

    it("should discard pending recovery on force-release", async () => {
      vi.useFakeTimers();

      await lock.acquire(async () => "http://fallback:11434", 5000);
      lock.deferRecovery();

      await vi.advanceTimersByTimeAsync(5000);

      // Lock was force-released — pendingRecovery cleared
      expect(lock.isActive).toBe(false);

      // New cycle — no stale recovery
      await lock.acquire(async () => "http://primary:11434");
      const { recovered } = lock.release();
      expect(recovered).toBe(false);
    });
  });
});
