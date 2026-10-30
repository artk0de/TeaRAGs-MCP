The retry scheduler returns:

- Attempt 0: **250 ms**
- Attempt 1: **500 ms**
- Attempt 4: **2,000 ms** (capped)

Formula: `Math.min(250 * 2 ** attempt, 2000)`.
