# Ollama Health Probe Design

## Problem

`CONNECT_TIMEOUT_WITH_FALLBACK_MS = 1000ms` is used as both connect and request
timeout for embed calls when a fallback URL is configured. Ollama cold model
load takes ~2000ms, exceeding this timeout. Result: primary always fails on
first embed after restart/idle, fallback (localhost) also fails if not running,
producing `INFRA_OLLAMA_UNAVAILABLE`.

## Root Cause

`fetchWithTimeout` wraps the entire HTTP request (connect + model load +
inference) in a single `AbortController` timeout. With fallback present, timeout
is 1000ms — insufficient for cold model load (~2000ms), though warm calls are
~68ms.

## Solution

Add a lightweight health probe (`GET /api/tags`, 1s timeout) before embed calls.
Probe result is cached with 60s TTL. This separates "is server reachable?"
(fast) from "can it embed?" (slow with cold model).

## Design

### New State

```typescript
private primaryAlive = false;
private primaryAliveAt = 0;
```

Constants:

```typescript
const HEALTH_PROBE_TIMEOUT_MS = 1000;
const HEALTH_TTL_MS = 60_000;
```

### `checkPrimaryHealth(): Promise<boolean>`

- If `primaryAlive && (Date.now() - primaryAliveAt < HEALTH_TTL_MS)` -> return
  `true` (cache hit)
- Otherwise: `GET ${baseUrl}/api/tags` with `HEALTH_PROBE_TIMEOUT_MS`
- On success: set `primaryAlive = true`, `primaryAliveAt = Date.now()`, return
  `true`
- On failure: set `primaryAlive = false`, return `false`

### Changes to `retryWithBackoff`

Before attempting primary embed:

1. If fallback is configured -> call `checkPrimaryHealth()`
2. If healthy -> embed primary with full `CONNECT_TIMEOUT_MS` (5000ms)
3. If unhealthy -> skip primary, go directly to fallback

If no fallback configured -> no probe, embed with `CONNECT_TIMEOUT_MS` as
before.

### Remove `CONNECT_TIMEOUT_WITH_FALLBACK_MS`

No longer needed. The probe handles fast failover. All embed calls use
`CONNECT_TIMEOUT_MS` (5000ms).

`connectTimeoutForUrl()` simplifies to always return `CONNECT_TIMEOUT_MS`.

### Existing `probePrimary()` Timer

Kept as-is. It runs every 30s when `usingFallback=true` and recovers primary
after extended downtime. The new health probe is a pre-flight check before
embed, not a replacement.

### Scenario Matrix

| Scenario                   | Probe  | Embed          | Total           | Notes                          |
| -------------------------- | ------ | -------------- | --------------- | ------------------------------ |
| Warm model, cache hit      | skip   | 68ms           | 68ms            | Zero overhead                  |
| Cold model, cache miss     | 15ms   | ~2000ms        | ~2015ms         | Works (was failing)            |
| Server dead (ECONNREFUSED) | 50ms   | skip primary   | 50ms + fallback | Faster than current 1s timeout |
| Server hanging             | 1000ms | skip primary   | 1s + fallback   | Same as current                |
| Probe OK, embed fails      | 15ms   | 5000ms timeout | 5s + fallback   | Edge case, acceptable          |

### Files Changed

- `src/core/adapters/embeddings/ollama.ts` (only file)

### Testing

- Unit test: probe success -> embed uses primary with full timeout
- Unit test: probe failure -> embed skips primary, uses fallback
- Unit test: probe cache hit -> no HTTP call, embed proceeds
- Unit test: probe cache TTL expired -> re-probes
- Unit test: no fallback configured -> no probe, direct embed
