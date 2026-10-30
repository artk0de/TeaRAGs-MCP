`RetryScheduler#shouldRetry` returns:

- `429` → `true`
- `503` → `true`
- `400` → `false`

It checks `status === 429 || status === 503`.
