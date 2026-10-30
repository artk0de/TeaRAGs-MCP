`RetryController#plan` synchronously decides whether a request should be retried and, if so, returns a delay in milliseconds. It retries only statuses **429 and 503**, with eligible attempt values **0, 1, and 2**. It does not sleep, schedule a timer, or make network calls; the caller must act on its result.

### Validation and decision order

The method evaluates its inputs in this exact order ([lines 6–15][validation]):

1. **Validate `attempt`.** It must satisfy `Number.isInteger(attempt)` and be non-negative. Negative numbers, fractions, `NaN`, and infinities cause a `RangeError` with the message `"attempt must be a non-negative integer"`. This check happens before checking the status, so an invalid attempt throws even for a status that would otherwise be rejected.
2. **Check `status`.** Any value other than numeric `429` or `503` returns `{ retry: false, reason: "status" }`. There is no separate status-validation exception.
3. **Check the retry budget.** For either eligible status, `attempt >= 3` returns `{ retry: false, reason: "budget" }`. Consequently, attempt `3` and every larger valid integer are rejected.
4. **Calculate a delay.** Only eligible statuses with attempts `0`, `1`, or `2` reach this step.

The ordering determines the reason returned. For example, `(400, 3)` returns the `"status"` reason, because status rejection occurs before budget rejection. `(400, -1)` throws before either decision can be returned.

### Delay calculation and `retryAfterMs`

The exponential baseline is ([lines 16–20][delay]):

```ts
const exponential = Math.min(100 * 2 ** attempt, 500);
```

For the three eligible attempts, this produces **100, 200, and 400 ms**, respectively. Although the calculation includes a 500 ms ceiling, the budget check prevents attempt `3` from reaching it.

An optional `retryAfterMs` is accepted when it is defined, finite according to `Number.isFinite`, and greater than or equal to zero. Zero and positive fractions are accepted; it does not have to be an integer. Omitted values, explicit `undefined`, `NaN`, either infinity, and negative values are ignored, causing the exponential baseline to be used instead. There is no numeric-string coercion.

The final calculation is:

```ts
Math.min(Math.max(exponential, requested), 500)
```

This imposes **both bounds**: the exponential baseline is the minimum delay, and **500 ms** is the maximum delay. An accepted suggestion below the baseline therefore cannot shorten the wait. A suggestion above 500 is accepted as an input but capped in the returned result. These checks and calculations are skipped entirely when validation throws or an earlier branch returns.

### Worked examples

Here, each tuple means `(status, attempt, retryAfterMs?)`.

| Input | Evaluation | Result |
|---|---|---|
| `(429, 0)` | Baseline `100`; suggestion omitted | `{ retry: true, delayMs: 100 }` |
| `(503, 2)` | Baseline `400`; suggestion omitted | `{ retry: true, delayMs: 400 }` |
| `(429, 3)` | Eligible status, exhausted budget | `{ retry: false, reason: "budget" }` |
| `(400, 0)` | Valid attempt, ineligible status | `{ retry: false, reason: "status" }` |
| `(400, -1)` | Attempt validation fails first | Throws `RangeError("attempt must be a non-negative integer")` |
| `(429, 1, 50)` | Baseline `200`; accepted `50` is below the floor | `{ retry: true, delayMs: 200 }` |
| `(429, 1, 400)` | Accepted `400` lies between the bounds | `{ retry: true, delayMs: 400 }` |
| `(429, 1, 900)` | Accepted `900` exceeds the ceiling | `{ retry: true, delayMs: 500 }` |
| `(429, 1, NaN)` | Suggestion ignored; baseline `200` | `{ retry: true, delayMs: 200 }` |
| `(429, 1, -10)` | Negative suggestion ignored; baseline `200` | `{ retry: true, delayMs: 200 }` |

### Returned shapes and caller usage

The implementation returns exactly three object shapes: `{ retry: false, reason: "status" }`, `{ retry: false, reason: "budget" }`, or `{ retry: true, delayMs: number }`. Rejections contain no `delayMs`; approvals contain no `reason`. Invalid attempts throw instead of returning an object ([method implementation][validation]).

For example, with `RetryController` available in scope:

```ts
function scheduleRetry(
  controller: RetryController,
  retryRequest: () => void,
): void {
  const decision = controller.plan(503, 2);

  if (decision.retry) {
    setTimeout(retryRequest, decision.delayMs); // 400 ms
  } else {
    console.log(`Retry declined: ${decision.reason}`);
  }
}
```

The timer belongs to this caller. `plan` itself only validates inputs, performs arithmetic, and returns its decision.

[validation]: /Users/artk0re/Dev/Tools/tea-rags-mcp/.tmp/plugin-routing-evals/response-contract-runs/20261030-184546-954844000/candidate/cases/response-202/workspace/src/queue/RetryController.ts:6
[delay]: /Users/artk0re/Dev/Tools/tea-rags-mcp/.tmp/plugin-routing-evals/response-contract-runs/20261030-184546-954844000/candidate/cases/response-202/workspace/src/queue/RetryController.ts:16
