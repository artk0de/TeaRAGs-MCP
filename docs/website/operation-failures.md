# Ollama Failure Behavior

How tea-rags handles Ollama connectivity failures during indexing and search.

## Single URL (no fallback)

When only `OLLAMA_URL` is configured (no `OLLAMA_FALLBACK_URL`):

- Embed calls go directly to the configured URL
- On failure, `OllamaUnavailableError` is thrown with a hint to start Ollama
- No retry logic beyond rate-limit retries

## Dual URL (primary + fallback)

When both `OLLAMA_URL` and `OLLAMA_FALLBACK_URL` are configured, tea-rags uses
an **operation-locked fallback** strategy.

### How it works

1. **Health probe before embed**: Before each embed operation, a lightweight
   `GET /` check verifies the primary is reachable (cached for 60s).

2. **URL locked per operation**: Once an embed call starts, the chosen URL is
   locked for the entire operation. No mid-operation switching. This prevents
   wasted timeout cycles when a background probe detects primary recovery during
   an active embed batch.

3. **Failure affects next operation**: If an embed fails on the locked URL, the
   error is thrown immediately. The next operation will use the other URL.

4. **Background probe**: When operating on fallback, a background probe pings
   primary every 30s. Recovery is deferred until all in-flight embeds complete.

5. **No state reset on dual failure**: When both URLs are dead, `usingFallback`
   stays `true`. Primary returns only via successful probe.

### Failure scenarios

| Scenario                             | Behavior                                         |
| ------------------------------------ | ------------------------------------------------ |
| Primary health probe fails           | Switch to fallback, start background probe       |
| Primary embed fails (after probe OK) | Error thrown, next call uses fallback            |
| Fallback embed fails                 | Error with both URLs in message                  |
| Both URLs dead                       | Error persists, probe continues checking primary |
| Primary recovers during active embed | Recovery deferred until embed completes          |
| Primary recovers between embeds      | Immediate switch back to primary                 |

### Error messages

All errors include actionable hints:

- **Primary fail**: "Retry the operation -- it will automatically use fallback"
- **Both dead**: "Start Ollama with `open -a Ollama` or `ollama serve`"

### Timeouts

| Operation         | Timeout                            |
| ----------------- | ---------------------------------- |
| Single embed      | 30s (allows cold model load)       |
| Batch embed       | max(30s, 30s + batchSize \* 100ms) |
| Health probe      | 1s                                 |
| Health cache      | 60s TTL                            |
| Stale lock safety | 5 min (auto-releases stuck locks)  |
