# Ollama Health Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix cold-start timeout by adding a pre-flight health probe before
embed calls, separating "is server alive?" from "can it embed?".

**Architecture:** `OllamaEmbeddings.checkPrimaryHealth()` does `GET /api/tags`
(1s timeout) with cached result (60s TTL). `retryWithBackoff()` consults it
before choosing primary vs fallback. Remove `CONNECT_TIMEOUT_WITH_FALLBACK_MS`.

**Tech Stack:** Node.js fetch, vitest

**Spec:** `docs/superpowers/specs/2026-03-26-ollama-health-probe-design.md`

---

### Task 1: Write failing tests for `checkPrimaryHealth()`

**Files:**

- Modify: `tests/core/adapters/embeddings/ollama.test.ts`

- [ ] **Step 1: Add health probe test block**

Add a new `describe("health probe")` block at the end of the `OllamaEmbeddings`
describe, before the closing `});`. All tests create an instance with
`fallbackBaseUrl` to activate probe logic.

```typescript
describe("health probe", () => {
  let probeEmbeddings: OllamaEmbeddings;

  beforeEach(() => {
    probeEmbeddings = new OllamaEmbeddings(
      "nomic-embed-text",
      undefined,
      undefined,
      "http://primary:11434",
      true,
      999,
      "http://fallback:11434",
    );
  });

  it("should probe primary before embed when fallback is configured", async () => {
    const mockEmbedding = Array(768).fill(0.5);

    // Probe GET /api/tags succeeds, then embed succeeds
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: mockEmbedding }),
      });

    await probeEmbeddings.embed("test");

    // First call = probe, second = embed
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe("http://primary:11434/api/tags");
    expect(mockFetch.mock.calls[0][1]).toEqual(
      expect.objectContaining({ method: "GET" }),
    );
    expect(mockFetch.mock.calls[1][0]).toContain("http://primary:11434");
  });

  it("should skip primary and use fallback when probe fails", async () => {
    const mockEmbedding = Array(768).fill(0.5);

    // Probe fails, fallback embed succeeds
    mockFetch
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: mockEmbedding }),
      });

    const result = await probeEmbeddings.embed("test");
    expect(result.embedding).toEqual(mockEmbedding);

    // First call = probe (failed), second = fallback embed
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe("http://primary:11434/api/tags");
    expect(mockFetch.mock.calls[1][0]).toContain("http://fallback:11434");
  });

  it("should cache probe result and skip probe on subsequent calls", async () => {
    const mockEmbedding = Array(768).fill(0.5);

    // First call: probe + embed
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: mockEmbedding }),
      });

    await probeEmbeddings.embed("first");

    // Second call: cache hit, no probe — just embed
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: mockEmbedding }),
    });

    await probeEmbeddings.embed("second");

    // 3 calls total: probe + embed + embed (no second probe)
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[2][0]).toContain(
      "http://primary:11434/api/embed",
    );
  });

  it("should re-probe after TTL expires", async () => {
    vi.useFakeTimers();

    const mockEmbedding = Array(768).fill(0.5);

    // First call: probe + embed
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: mockEmbedding }),
      });

    await probeEmbeddings.embed("first");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Advance past TTL (60s)
    await vi.advanceTimersByTimeAsync(61_000);

    // Second call: should re-probe
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: mockEmbedding }),
      });

    await probeEmbeddings.embed("after ttl");

    // 4 calls: probe + embed + probe + embed
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockFetch.mock.calls[2][0]).toBe("http://primary:11434/api/tags");

    vi.useRealTimers();
  });

  it("should not probe when no fallback is configured", async () => {
    const noFallback = new OllamaEmbeddings(
      "nomic-embed-text",
      undefined,
      undefined,
      "http://primary:11434",
      true,
    );

    const mockEmbedding = Array(768).fill(0.5);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: mockEmbedding }),
    });

    await noFallback.embed("test");

    // Only 1 call — embed, no probe
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain("/api/embeddings");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/adapters/embeddings/ollama.test.ts`

Expected: new tests fail — `checkPrimaryHealth` does not exist yet,
`retryWithBackoff` doesn't call probe.

- [ ] **Step 3: Commit failing tests**

```bash
git add tests/core/adapters/embeddings/ollama.test.ts
git commit -m "test(embedding): add failing tests for Ollama health probe"
```

---

### Task 2: Implement `checkPrimaryHealth()` and wire into `retryWithBackoff()`

**Files:**

- Modify: `src/core/adapters/embeddings/ollama.ts`

- [ ] **Step 1: Add constants and state**

Replace `CONNECT_TIMEOUT_WITH_FALLBACK_MS` with health probe constants:

```typescript
// REMOVE this line:
// const CONNECT_TIMEOUT_WITH_FALLBACK_MS = 1000;

// ADD these:
/** Timeout for lightweight health probe (GET /api/tags) */
const HEALTH_PROBE_TIMEOUT_MS = 1000;
/** How long to cache a successful health probe result */
const HEALTH_TTL_MS = 60_000;
```

Add state fields to the class after `private probeTimer`:

```typescript
private primaryAlive = false;
private primaryAliveAt = 0;
```

- [ ] **Step 2: Add `checkPrimaryHealth()` method**

Add after `stopPrimaryProbe()`:

```typescript
/**
 * Lightweight pre-flight check: GET /api/tags with short timeout.
 * Cached for HEALTH_TTL_MS to avoid overhead on warm calls.
 * Only called when fallback is configured — separates "server alive?"
 * (fast, ~15ms) from "embed works?" (slow on cold model, ~2s).
 */
private async checkPrimaryHealth(): Promise<boolean> {
  if (this.primaryAlive && Date.now() - this.primaryAliveAt < HEALTH_TTL_MS) {
    return true;
  }
  try {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/tags`,
      { method: "GET" },
      HEALTH_PROBE_TIMEOUT_MS,
    );
    if (response.ok) {
      this.primaryAlive = true;
      this.primaryAliveAt = Date.now();
      return true;
    }
    this.primaryAlive = false;
    return false;
  } catch {
    this.primaryAlive = false;
    return false;
  }
}
```

- [ ] **Step 3: Modify `retryWithBackoff()` to use health probe**

Replace the section between the quick-path block (line 175) and the
`withRateLimitRetry` call (line 177). The new logic probes primary health before
deciding whether to attempt primary or skip to fallback:

```typescript
private async retryWithBackoff<T>(fn: () => Promise<T>, fallbackFn?: () => Promise<T>): Promise<T> {
  // Quick path: if primary is down and fallback available, skip primary entirely
  if (fallbackFn && this.fallbackBaseUrl && this.usingFallback) {
    try {
      return await fallbackFn();
    } catch (fallbackError) {
      if (fallbackError instanceof OllamaModelMissingError) throw fallbackError;
      this.usingFallback = false;
      this.stopPrimaryProbe();
      throw OllamaUnavailableError.withFallback(this.baseUrl, this.fallbackBaseUrl);
    }
  }

  // Health probe: if fallback exists, check primary is alive before attempting embed
  if (fallbackFn && this.fallbackBaseUrl) {
    const healthy = await this.checkPrimaryHealth();
    if (!healthy) {
      // Primary unreachable — skip directly to fallback
      this.usingFallback = true;
      this.startPrimaryProbe();
      if (isDebug()) {
        console.error(
          `[Ollama] Primary ${this.baseUrl} health probe failed, using fallback ${this.fallbackBaseUrl}`,
        );
      }
      try {
        return await fallbackFn();
      } catch (fallbackError) {
        if (fallbackError instanceof OllamaModelMissingError) throw fallbackError;
        this.usingFallback = false;
        this.stopPrimaryProbe();
        throw OllamaUnavailableError.withFallback(this.baseUrl, this.fallbackBaseUrl);
      }
    }
  }

  try {
    return await withRateLimitRetry(fn, {
      maxAttempts: this.retryAttempts,
      baseDelayMs: this.retryDelayMs,
      isRetryable: (error) => this.isRateLimit(error),
    });
  } catch (primaryError) {
    if (primaryError instanceof OllamaModelMissingError) {
      throw primaryError;
    }

    // Invalidate health cache — primary failed despite probe
    this.primaryAlive = false;

    if (!fallbackFn || !this.fallbackBaseUrl) {
      throw new OllamaUnavailableError(this.baseUrl, primaryError instanceof Error ? primaryError : undefined);
    }

    this.usingFallback = true;
    this.startPrimaryProbe();

    if (isDebug()) {
      console.error(
        `[Ollama] Primary ${this.baseUrl} failed, switching to fallback ${this.fallbackBaseUrl}. Probing primary every ${PRIMARY_PROBE_INTERVAL_MS / 1000}s.`,
      );
    }

    try {
      return await fallbackFn();
    } catch (fallbackError) {
      if (fallbackError instanceof OllamaModelMissingError) throw fallbackError;
      this.usingFallback = false;
      this.stopPrimaryProbe();
      throw OllamaUnavailableError.withFallback(
        this.baseUrl,
        this.fallbackBaseUrl,
        primaryError instanceof Error ? primaryError : undefined,
      );
    }
  }
}
```

- [ ] **Step 4: Simplify `connectTimeoutForUrl()`**

Replace:

```typescript
private connectTimeoutForUrl(url: string): number {
  if (!this.fallbackBaseUrl) return CONNECT_TIMEOUT_MS;
  return url === this.baseUrl ? CONNECT_TIMEOUT_WITH_FALLBACK_MS : CONNECT_TIMEOUT_MS;
}
```

With:

```typescript
/* v8 ignore next 3 -- timeout constant, exercised via integration tests */
private connectTimeoutForUrl(_url: string): number {
  return CONNECT_TIMEOUT_MS;
}
```

- [ ] **Step 5: Update `probePrimary()` to use `HEALTH_PROBE_TIMEOUT_MS`**

In `probePrimary()`, replace `CONNECT_TIMEOUT_WITH_FALLBACK_MS` with
`HEALTH_PROBE_TIMEOUT_MS`:

```typescript
const response = await fetchWithTimeout(
  `${this.baseUrl}/api/tags`,
  { method: "GET" },
  HEALTH_PROBE_TIMEOUT_MS,
);
```

Also update health cache on successful probe recovery:

```typescript
if (response.ok) {
  this.usingFallback = false;
  this.primaryAlive = true;
  this.primaryAliveAt = Date.now();
  this.stopPrimaryProbe();
  if (isDebug()) {
    console.error(
      `[Ollama] Primary ${this.baseUrl} recovered, switching back from fallback`,
    );
  }
}
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run tests/core/adapters/embeddings/ollama.test.ts`

Expected: all tests pass (old + new).

- [ ] **Step 7: Commit**

```bash
git add src/core/adapters/embeddings/ollama.ts
git commit -m "fix(embedding): add health probe before embed to fix cold-start timeout"
```

---

### Task 3: Update existing fallback tests for probe behavior

**Files:**

- Modify: `tests/core/adapters/embeddings/ollama.test.ts`

Some existing fallback tests create `OllamaEmbeddings` with `fallbackBaseUrl`.
These now trigger the health probe before embed. Tests that mock only embed
calls need an additional mock for the probe.

- [ ] **Step 1: Update fallback tests to account for probe**

In `describe("fallback URL")`, tests that create instances with
`fallbackBaseUrl` and use `legacyApi=true` need a probe mock prepended.

For each test that expects primary to fail:

- **"should fall back to fallbackBaseUrl when primary fails"** — add probe
  success mock before the primary fail mock. Now flow is: probe OK → primary
  embed fails → fallback embed OK.

```typescript
it("should fall back to fallbackBaseUrl when primary fails", async () => {
  // ... existing setup ...

  // Probe succeeds, primary embed fails, fallback succeeds
  mockFetch
    .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // probe
    .mockRejectedValueOnce(new Error("connection refused")) // primary embed
    .mockResolvedValueOnce({
      // fallback embed
      ok: true,
      json: async () => ({ embedding: mockEmbedding }),
    });

  const result = await fallbackEmbeddings.embed("test");
  expect(result.embedding).toEqual(mockEmbedding);

  expect(mockFetch).toHaveBeenCalledTimes(3);
  const fallbackCall = mockFetch.mock.calls[2];
  expect(fallbackCall[0]).toContain("http://fallback:11434");
});
```

For tests where both primary and fallback fail — same pattern: probe OK →
primary fail → fallback fail.

For the **"should use fallback on second call after primary fails"** test —
first call has probe + primary fail + fallback OK. Second call goes through
`usingFallback` quick path (no probe). Mock count adjusts to 4 total.

For the **probe recovery test** ("should switch back to primary when probe
succeeds") — first call now needs the health probe mock before the primary
failure. Total mocks increase by 1.

Apply the same pattern to all tests in `describe("fallback URL")` that use
`fallbackBaseUrl`. Each needs a probe mock as the first fetch call.

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/core/adapters/embeddings/ollama.test.ts`

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add tests/core/adapters/embeddings/ollama.test.ts
git commit -m "test(embedding): update fallback tests for health probe behavior"
```

---

### Task 4: Full test suite + type check

**Files:** none (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`

Expected: all tests pass.

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: clean build.
