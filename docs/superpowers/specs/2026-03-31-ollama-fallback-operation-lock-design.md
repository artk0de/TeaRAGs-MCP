# Ollama Fallback: Operation-Locked URL Selection

**Date**: 2026-03-31 **Status**: Draft **Scope**:
`src/core/adapters/embeddings/ollama.ts`, `ollama/operation-lock.ts`

## Problem

The OllamaEmbeddings fallback mechanism switches between primary and fallback
URLs mid-operation, causing:

1. **Background probe switches URL mid-pipeline**: `probePrimary()` fires every
   30s and sets `usingFallback = false` when `GET /` succeeds. The next embed
   call tries primary, fails (primary answers health checks but can't handle
   embed load), wastes 5s on timeout, then switches back to fallback.

2. **Health check doesn't verify embed capability**: `GET /` only checks HTTP
   availability. Primary Ollama may respond to health checks but timeout on
   embed requests (GPU throttling, network latency on large payloads).

3. **Double retry amplification**: WorkerPool retries (3x) × retryWithBackoff
   primary→fallback cycle = 6 attempts per batch, each starting with a pointless
   primary probe.

4. **Fallback fail resets state**: When both URLs fail, `usingFallback` resets
   to `false`, so the next call retries primary first despite it being
   known-dead.

5. **Single embed timeout too low**: `CONNECT_TIMEOUT_MS = 5000` is used for
   single embed calls. After a successful health check, 5s is insufficient for
   cold model loads or large inputs.

Observable effect: peaks-and-valleys indexing pattern. Batches succeed on
fallback, probe switches to primary, next batch wastes 5s+ on primary timeout,
falls back, repeat. Eventually both appear dead and batches are permanently
lost.

## Design

### Core Principle

URL selection happens once per embed call via OperationLock inside
OllamaEmbeddings. While any embed is in flight, the URL stays locked. No
mid-operation switching. Probe-detected recovery is deferred until all in-flight
embeds complete. No external wiring needed — lock lives entirely inside the
Ollama adapter.

### OperationLock

New structure in `adapters/embeddings/ollama/operation-lock.ts`. Pure data
structure with no side effects. Created only when `fallbackBaseUrl` is
configured — no lock, no overhead otherwise.

```typescript
export class OperationLock {
  private count = 0;
  private lockedUrl: string | null = null;
  private _pendingRecovery = false;
  private resolving: Promise<string> | null = null;
  private staleTimer?: ReturnType<typeof setTimeout>;

  /**
   * Acquire the lock. First caller triggers async URL resolution (health
   * check). Concurrent callers wait on the mutex and get the same URL.
   * Rolls back count on resolution failure — error propagates to caller.
   */
  async acquire(
    resolveUrl: () => Promise<string>,
    staleTimeoutMs?: number,
  ): Promise<string> {
    this.count++;
    if (this.count === 1) {
      this.resolving = resolveUrl();
      try {
        this.lockedUrl = await this.resolving;
      } catch (error) {
        this.count--;
        this.resolving = null;
        throw error;
      }
      this.resolving = null;
      if (staleTimeoutMs) {
        this.staleTimer = setTimeout(() => this.forceRelease(), staleTimeoutMs);
        this.staleTimer.unref();
      }
    } else if (this.resolving) {
      try {
        await this.resolving;
      } catch {
        this.count--;
        throw;
      }
    }
    return this.lockedUrl!;
  }

  /**
   * Release the lock. When count reaches 0, returns whether a deferred
   * recovery is pending. Caller is responsible for acting on it.
   */
  release(): { recovered: boolean } {
    if (this.count <= 0) return { recovered: false };
    this.count--;
    if (this.count === 0) {
      this.lockedUrl = null;
      this.clearStaleTimer();
      if (this._pendingRecovery) {
        this._pendingRecovery = false;
        return { recovered: true };
      }
    }
    return { recovered: false };
  }

  get isActive(): boolean {
    return this.count > 0;
  }

  get url(): string | null {
    return this.lockedUrl;
  }

  /** Mark that probe detected primary recovery, to be applied on release. */
  deferRecovery(): void {
    this._pendingRecovery = true;
  }

  /** Force-release all acquisitions (stale timeout safety net). */
  private forceRelease(): void {
    this.count = 0;
    this.lockedUrl = null;
    this._pendingRecovery = false;
    this.clearStaleTimer();
  }

  private clearStaleTimer(): void {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = undefined;
    }
  }
}
```

Key properties:

- **Mutex via Promise**: first `acquire()` creates a resolving Promise.
  Concurrent callers `await` the same Promise. Health check runs once.
- **Rollback on failure**: if `resolveUrl()` throws, count is decremented and
  error propagates. No broken state.
- **Stale timeout**: equals `core.requestTimeoutMs` (300s default). If
  `endOperation()` is never called (process crash edge case), lock
  auto-releases. Timer is `.unref()`'d — does not keep the process alive.

### OllamaEmbeddings Changes

#### New state

```
+ lock: OperationLock | null   // created only when fallbackBaseUrl is set
  usingFallback: boolean       // kept (persistent across operations)
  primaryAlive: boolean        // kept (health cache)
  primaryAliveAt: number       // kept (health cache timestamp)
  probeTimer: setInterval      // kept (background probe)
```

In constructor:

```typescript
this.lock = fallbackBaseUrl ? new OperationLock() : null;
```

No lock without fallback — zero overhead for single-URL deployments.

#### Lock integration in `embed()` / `embedBatch()`

Lock acquire/release happens inside the embed methods themselves. No external
wiring, no changes to EmbeddingProvider interface, App, or middleware.

```typescript
async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
  const url = this.lock
    ? await this.lock.acquire(
        () => this.resolveUrl(),
        this.staleTimeoutMs,
      )
    : this.resolveActiveUrl();
  try {
    // ... embed on url
  } finally {
    if (this.lock) {
      try {
        const { recovered } = this.lock.release();
        if (recovered) this.applyRecovery();
      } catch {
        // never throw from finally — would mask caller's error
      }
    }
  }
}
```

`resolveUrl()` is async — performs health check, returns chosen URL:

```
if usingFallback → return fallbackUrl
else → checkPrimaryHealth()
  → OK → return primaryUrl
  → FAIL → usingFallback=true, startPrimaryProbe(), return fallbackUrl
```

Between embed calls (count=0), probe may switch URL. This is correct — it's a
natural boundary between operations.

#### `retryWithBackoff()` — simplified

During active lock (`lock.isActive`):

```
url = lock.url
→ withRateLimitRetry(fn(url))
→ on non-rate-limit failure:
   - DO NOT switch to fallback mid-operation
   - Set usingFallback = true (for NEXT acquire, not this one)
   - Invalidate health cache: primaryAlive = false
   - throw OllamaUnavailableError with agent-actionable hint
```

Without lock (no fallback URL configured):

```
→ embed on primaryUrl
→ on fail → throw OllamaUnavailableError
```

Key change: **no same-call fallback**. URL is chosen once per acquire, used for
the duration of the lock. Failure affects the next acquire's URL selection.

Health cache invalidation on embed fail: if primary was selected from cache but
embed times out, `primaryAlive = false` immediately. Does not wait for cache TTL
(60s) to expire. Next acquire will re-probe.

#### `probePrimary()` — deferred switching

```
GET primary/ → OK:
  if lock?.isActive:
    lock.deferRecovery()        // apply when last embed releases
  else:
    usingFallback = false
    primaryAlive = true
    primaryAliveAt = now
    stopPrimaryProbe()
    emit "to-primary"

GET primary/ → FAIL:
  // nothing — probe continues
```

#### Fallback fail — no state reset

Remove all 3 points where `usingFallback` is reset to `false` on dual failure:

- Line 221 (quick path fallback fail)
- Line 245 (health probe path fallback fail)
- Line 283-284 (primary path fallback fail)

When both URLs are dead, `usingFallback` stays `true`. Next acquire starts with
fallback. Primary returns only via probe.

### Timeout Changes

| Constant                    | Old   | New                                         | Rationale                                                    |
| --------------------------- | ----- | ------------------------------------------- | ------------------------------------------------------------ |
| `CONNECT_TIMEOUT_MS`        | 5000  | renamed → `SINGLE_EMBED_TIMEOUT_MS` = 30000 | 5s too low for cold model load after successful health check |
| `BATCH_BASE_TIMEOUT_MS`     | 30000 | 30000 (unchanged)                           | Already adequate                                             |
| `BATCH_PER_ITEM_TIMEOUT_MS` | 100   | 100 (unchanged)                             | Already adequate                                             |
| `HEALTH_PROBE_TIMEOUT_MS`   | 1000  | 1000 (unchanged)                            | Health check should be fast                                  |
| `HEALTH_TTL_MS`             | 60000 | 60000 (unchanged)                           | Cache duration adequate                                      |

Batch formula unchanged:
`max(SINGLE_EMBED_TIMEOUT_MS, 30s + batchSize * 100ms)`.

For batch sizes >= 1, the formula already produces >= 30s, so the rename has no
effect on batch calls. For single embed (`embed()`), the timeout increases from
5s to 30s.

### Error Messages

All errors include agent-actionable hints with retry instructions.

**Embed fail on primary (inside lock):**

```
Ollama embed failed at http://192.168.1.71:11434.
Hint: Retry the operation — it will automatically use fallback http://localhost:11434.
```

**Embed fail on fallback (inside lock):**

```
Ollama embed failed at http://localhost:11434.
Primary http://192.168.1.71:11434 was unreachable at operation start.
Hint: Start Ollama with `open -a Ollama` or `ollama serve`, then retry the operation.
```

**Both dead (resolveUrl cannot select either):**

```
Ollama is not reachable at http://192.168.1.71:11434 (primary)
or http://localhost:11434 (fallback).
Hint: Start Ollama with `open -a Ollama` or `ollama serve`, then retry the operation.
```

### Test Plan

**Update existing tests** in `describe("fallback URL")`:

| Existing test                                                    | Change                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| "fall back to fallbackBaseUrl when health probe fails"           | Remove same-call fallback expectation. Embed fails, next call uses fallback. |
| "throw with both URLs when probe fails and fallback also fails"  | Keep, verify `usingFallback` stays `true`.                                   |
| "use fallback on second call after probe fails (failover cache)" | Adapt to lock: first embed locks fallback, second gets same.                 |
| "switch back to primary when background probe succeeds"          | Add variant: probe during active embed → deferred.                           |
| "keep using fallback when probe fails"                           | No change needed.                                                            |
| "reset failover when both fail during cached state"              | Remove `usingFallback` reset expectation.                                    |

**New tests:**

| Test                                                        | Validates                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| `acquire resolves URL once, parallel callers wait on mutex` | Mutex: health check fires once, others wait.                |
| `acquire rollback on resolveUrl failure`                    | Count rolls back, error propagates.                         |
| `parallel acquire — second gets same locked URL`            | Refcount, shared URL.                                       |
| `release at count=0 applies deferred recovery`              | `deferRecovery()` → release → recovered=true.               |
| `probe during active lock defers recovery`                  | probe OK + lock active → pendingRecovery.                   |
| `embed fail invalidates health cache`                       | primaryAlive=false after fail, cache doesn't protect.       |
| `embed fail sets usingFallback for next acquire`            | Next acquire resolves to fallback.                          |
| `no lock created without fallbackBaseUrl`                   | lock=null, zero overhead.                                   |
| `stale timeout forces release`                              | Timeout → forceRelease → count=0.                           |
| `error hints contain retry instruction`                     | Verify hint text for all 3 error cases.                     |
| `OperationLock unit tests`                                  | acquire/release/deferRecovery/count/mutex/stale edge cases. |

### Files Changed

| File                                                           | Change                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `src/core/adapters/embeddings/ollama/operation-lock.ts`        | New: OperationLock with refcount, mutex, stale timeout                                 |
| `src/core/adapters/embeddings/ollama.ts`                       | Integrate OperationLock, simplify retryWithBackoff, rename timeout, update error hints |
| `tests/core/adapters/embeddings/ollama/operation-lock.test.ts` | New: OperationLock unit tests                                                          |
| `tests/core/adapters/embeddings/ollama.test.ts`                | Update 6 existing + 10 new tests                                                       |
| `docs/website/operation-failures.md`                           | New: article on Ollama failure behavior                                                |

### Not Changed

- `EmbeddingProvider` interface — no changes (lock is internal to Ollama
  adapter)
- `App` — no changes
- MCP middleware — no changes
- `factory.ts` — `onFallbackSwitch` wiring stays as-is
- `WorkerPool` — no changes (retries the same locked URL)
- `EnrichmentCoordinator` — no changes
- `retry.ts` — no changes (rate limit retry is orthogonal)
