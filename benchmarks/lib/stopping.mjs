/**
 * Stopping Decision Logic
 *
 * Determines when to stop testing based on performance degradation,
 * error rates, and other criteria.
 */

import { CRITERIA } from "./config.mjs";

export class StoppingDecision {
  constructor() {
    this.results = [];
    this.bestRate = 0;
    this.consecutiveDegradations = 0;
    this.errors = 0;
    this.totalTests = 0;
  }

  addResult(result) {
    this.results.push(result);
    this.totalTests++;

    if (result.error) {
      this.errors++;
      return this.checkStop("error");
    }

    if (result.rate > this.bestRate) {
      this.bestRate = result.rate;
      this.consecutiveDegradations = 0;
    } else {
      const degradation = (this.bestRate - result.rate) / this.bestRate;
      if (degradation >= CRITERIA.DEGRADATION_THRESHOLD) {
        this.consecutiveDegradations++;
      } else {
        this.consecutiveDegradations = 0;
      }
    }

    return this.checkStop();
  }

  checkStop(reason = null) {
    // Error rate too high
    if (this.errors / this.totalTests > CRITERIA.ERROR_RATE_THRESHOLD && this.totalTests >= 3) {
      return { stop: true, reason: `Error rate exceeded ${CRITERIA.ERROR_RATE_THRESHOLD * 100}%` };
    }

    // Consecutive degradations
    if (this.consecutiveDegradations >= CRITERIA.CONSECUTIVE_DEGRADATIONS) {
      return { stop: true, reason: `${CRITERIA.CONSECUTIVE_DEGRADATIONS} consecutive degradations` };
    }

    // Single large degradation
    if (this.results.length >= 2) {
      const last = this.results[this.results.length - 1];
      const degradation = (this.bestRate - last.rate) / this.bestRate;
      if (degradation >= CRITERIA.DEGRADATION_THRESHOLD) {
        return { stop: true, reason: `Performance dropped ${Math.round(degradation * 100)}% from best` };
      }
    }

    // No improvement (requires at least 3 tests to avoid premature stopping)
    if (this.results.length >= 3) {
      const prev = this.results[this.results.length - 2];
      const curr = this.results[this.results.length - 1];
      const improvement = (curr.rate - prev.rate) / prev.rate;
      if (improvement < CRITERIA.NO_IMPROVEMENT_THRESHOLD && curr.rate <= this.bestRate) {
        return { stop: true, reason: `No significant improvement (<${CRITERIA.NO_IMPROVEMENT_THRESHOLD * 100}%)` };
      }
    }

    return { stop: false };
  }

  getBest() {
    return this.results.reduce((best, r) =>
      (!r.error && r.rate > (best?.rate || 0)) ? r : best, null);
  }
}
