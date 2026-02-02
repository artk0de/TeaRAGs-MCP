/**
 * Smart Stepping Algorithm
 *
 * Binary search-like approach:
 * 1. Start from initial value, double each step (32 → 64 → 128 → ...)
 * 2. If a doubled value is WORSE, try ONE midpoint and STOP
 * 3. Return the best value found
 *
 * Example:
 * - 32 (rate=100) → 64 (rate=80, worse!)
 * - Try midpoint: 48 → rate=110 (better!) → return 48
 * OR
 * - 32 (rate=100) → 64 (rate=80, worse!)
 * - Try midpoint: 48 → rate=90 (still worse than 32) → return 32
 */

import { CRITERIA } from "./config.mjs";

/**
 * Smart stepping search for optimal batch size
 *
 * @param {Object} options
 * @param {number} options.start - Starting value (default: 32)
 * @param {number} options.max - Maximum value to test (default: 8192)
 * @param {Function} options.testFn - Async function that tests a value, returns {rate, error, ...}
 * @param {Function} options.onResult - Callback for each result (value, result, isMidpoint)
 * @returns {Promise<{bestValue: number, bestRate: number, results: Array}>}
 */
export async function smartSteppingSearch({
  start = 32,
  max = 8192,
  testFn,
  onResult,
  onStop,  // Callback when stopping: (reason) => void
}) {
  const results = [];
  let bestValue = start;
  let bestRate = 0;
  let stopReason = null;

  let current = start;
  let prevValue = null;
  let prevRate = 0;

  while (current <= max) {
    const result = await testFn(current);
    results.push({ value: current, ...result, isMidpoint: false });

    if (onResult) {
      onResult(current, result, false);
    }

    if (result.error) {
      // Error - try midpoint if we have a previous good value
      if (prevValue !== null) {
        const midpoint = Math.round((prevValue + current) / 2);
        if (midpoint !== prevValue && midpoint !== current) {
          const midResult = await testFn(midpoint);
          results.push({ value: midpoint, ...midResult, isMidpoint: true });
          if (onResult) {
            onResult(midpoint, midResult, true);
          }
          if (!midResult.error && midResult.rate > bestRate) {
            bestRate = midResult.rate;
            bestValue = midpoint;
          }
        }
      }
      break;
    }

    // Update best if this is better
    if (result.rate > bestRate) {
      bestRate = result.rate;
      bestValue = current;
    }

    // Check if current is WORSE than previous
    if (prevValue !== null && result.rate < prevRate) {
      // Performance dropped - try ONE midpoint between prev and current, then STOP
      const midpoint = Math.round((prevValue + current) / 2);
      if (midpoint !== prevValue && midpoint !== current) {
        const midResult = await testFn(midpoint);
        results.push({ value: midpoint, ...midResult, isMidpoint: true });

        if (onResult) {
          onResult(midpoint, midResult, true);
        }

        if (!midResult.error && midResult.rate > bestRate) {
          bestRate = midResult.rate;
          bestValue = midpoint;
        }
      }
      // STOP - don't continue
      stopReason = `Performance dropped at ${current} (${result.rate} vs ${prevRate}), tried midpoint ${midpoint}`;
      if (onStop) onStop(stopReason);
      break;
    }

    // Check for plateau (3 values with <15% variance)
    if (results.length >= 3) {
      const last3 = results.slice(-3).filter(r => !r.error && !r.isMidpoint);
      if (last3.length >= 3) {
        const rates = last3.map(r => r.rate);
        const maxRate = Math.max(...rates);
        const minRate = Math.min(...rates);
        const variance = (maxRate - minRate) / maxRate;

        if (variance < CRITERIA.NO_IMPROVEMENT_THRESHOLD) {
          stopReason = `Plateau detected (${(variance * 100).toFixed(0)}% variance < ${(CRITERIA.NO_IMPROVEMENT_THRESHOLD * 100).toFixed(0)}% threshold)`;
          if (onStop) onStop(stopReason);
          break;
        }
      }
    }

    // Save for next iteration
    prevValue = current;
    prevRate = result.rate;

    // Double for next iteration
    current *= 2;
  }

  // If we reached max without stopping
  if (!stopReason && current > max) {
    stopReason = `Reached maximum value (${max})`;
    if (onStop) onStop(stopReason);
  }

  return { bestValue, bestRate, results, stopReason };
}

/**
 * Linear stepping with fixed values (for parameters where doubling doesn't make sense)
 */
export async function linearSteppingSearch({ values, testFn, onResult }) {
  const results = [];
  let bestValue = values[0];
  let bestRate = 0;
  let consecutiveDegradations = 0;

  for (const value of values) {
    const result = await testFn(value);
    results.push({ value, ...result });

    if (onResult) {
      onResult(value, result);
    }

    if (result.error) {
      continue;
    }

    if (result.rate > bestRate) {
      bestRate = result.rate;
      bestValue = value;
      consecutiveDegradations = 0;
    } else {
      const degradation = (bestRate - result.rate) / bestRate;
      if (degradation >= CRITERIA.DEGRADATION_THRESHOLD) {
        consecutiveDegradations++;
        if (consecutiveDegradations >= CRITERIA.CONSECUTIVE_DEGRADATIONS) {
          break;
        }
      }
    }

    // Check for plateau
    if (results.length >= 3) {
      const recentResults = results.slice(-3).filter(r => !r.error);
      if (recentResults.length >= 3) {
        const prev = recentResults[recentResults.length - 2];
        const curr = recentResults[recentResults.length - 1];
        const improvement = (curr.rate - prev.rate) / prev.rate;
        if (improvement < CRITERIA.NO_IMPROVEMENT_THRESHOLD && curr.rate <= bestRate) {
          break;
        }
      }
    }
  }

  return { bestValue, bestRate, results };
}
