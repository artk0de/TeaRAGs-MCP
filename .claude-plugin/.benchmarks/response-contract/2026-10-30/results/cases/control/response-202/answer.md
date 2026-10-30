`RetryController#plan` synchronously decides whether a retry is allowed and, if so, returns a delay in milliseconds. It **does not sleep or make network calls**: its body only validates inputs, checks conditions, calculates numbers, and returns an object or throws an exception. See [RetryController.ts:6](src/queue/RetryController.ts:6).

The validation and decision order matters:

1. **Validate `attempt` first.** It must satisfy `Number.isInteger(attempt)` and be non-negative. Negative numbers, fractions, `NaN`, and either infinity throw `RangeError("attempt must be a non-negative integer")`. This happens before checking the status, so an invalid attempt throws even when that status would otherwise prevent a retry. See [RetryController.ts:7](src/queue/RetryController.ts:7).
2. **Check the status.** Only `429` and `503` qualify. Every other status immediately returns `{ retry: false, reason: "status" }`. There is no separate status validation or coercion.
3. **Check the attempt budget.** For either eligible status, attempts `3` and above return `{ retry: false, reason: "budget" }`. Attempts `0`, `1`, and `2` proceed to delay calculation. Because the status check comes first, an ineligible status with attempt `3` still produces reason `"status"`, not `"budget"`. These branches are at [RetryController.ts:10](src/queue/RetryController.ts:10).

For an allowed retry, the method calculates:

```ts
exponential = Math.min(100 * 2 ** attempt, 500);
```

The baseline therefore doubles from **100 ms at attempt 0**, to **200 ms at attempt 1**, to **400 ms at attempt 2**. Although this expression has a 500 ms ceiling, the budget check prevents reaching attempt `3`, where the uncapped exponential would become 800 ms.

The optional `retryAfterMs` is accepted only when it is supplied, finite, and greater than or equal to zero. Zero and non-negative fractional values are accepted; the method does not round them. An omitted value, explicit `undefined`, `NaN`, either infinity, or a negative value is ignored, with the exponential baseline used instead. An invalid hint does **not** throw. See [RetryController.ts:16](src/queue/RetryController.ts:16).

The final calculation applies both bounds:

```ts
delayMs = Math.min(Math.max(exponential, requested), 500);
```

The inner `Math.max` establishes the **attempt-specific lower bound**: an accepted hint cannot shorten the exponential delay. The outer `Math.min` establishes the **500 ms upper bound**: even a much larger accepted hint cannot exceed it. Thus, acceptance of a hint does not guarantee that its exact value appears in the result. The return expression is at [RetryController.ts:20](src/queue/RetryController.ts:20).

Here are all the requested examples. A missing third argument means the hint is omitted.

| Arguments `(status, attempt, retryAfterMs?)` | Result | Explanation |
|---|---|---|
| `(429, 0)` | `{ retry: true, delayMs: 100 }` | Eligible status, first baseline. |
| `(503, 2)` | `{ retry: true, delayMs: 400 }` | Eligible status, third permitted attempt value. |
| `(429, 3)` | `{ retry: false, reason: "budget" }` | Attempt budget exhausted. |
| `(400, 0)` | `{ retry: false, reason: "status" }` | Status is ineligible. |
| `(400, -1)` | Throws `RangeError` | Attempt validation precedes status rejection. |
| `(429, 1, 50)` | `{ retry: true, delayMs: 200 }` | Hint accepted, then raised to the baseline. |
| `(429, 1, 400)` | `{ retry: true, delayMs: 400 }` | Hint lies between both bounds. |
| `(429, 1, 900)` | `{ retry: true, delayMs: 500 }` | Hint accepted, then capped. |
| `(429, 1, NaN)` | `{ retry: true, delayMs: 200 }` | Non-finite hint ignored. |
| `(429, 1, -10)` | `{ retry: true, delayMs: 200 }` | Negative hint ignored. |

There are exactly three returned object shapes: `{ retry: false, reason: "status" }`, `{ retry: false, reason: "budget" }`, and `{ retry: true, delayMs: number }`. Rejected decisions contain no `delayMs`; successful decisions contain no `reason`. Invalid attempts return no object because they throw.

A caller can consume the result like this, assuming `controller` is an existing `RetryController` instance:

```ts
const decision = controller.plan(429, 1, 400);

if (decision.retry) {
  setTimeout(() => {
    void retryRequest();
  }, decision.delayMs);
} else {
  console.log("Retry declined:", decision.reason);
}
```

Here the **caller’s `setTimeout`** schedules the retry, and `retryRequest` performs the application work. `plan` itself does neither.
