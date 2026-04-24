/**
 * Tests for AdaptiveBatchSizer
 *
 * Coverage:
 * - Initial state
 * - Multiplicative halving on QdrantOptimizationInProgressError (yellow)
 * - Floor enforcement (min)
 * - Non-yellow errors ignored
 * - Recovery doubling after consecutive successes
 * - Cap at initial
 * - Failure resets success counter
 */

import { describe, expect, it } from "vitest";

import { QdrantOptimizationInProgressError } from "../../../../../src/core/adapters/qdrant/errors.js";
import { AdaptiveBatchSizer } from "../../../../../src/core/domains/ingest/pipeline/adaptive-batch-sizer.js";

function yellow(): QdrantOptimizationInProgressError {
  return new QdrantOptimizationInProgressError("col");
}

describe("AdaptiveBatchSizer", () => {
  describe("Default state", () => {
    it("returns initial size from current()", () => {
      const sizer = new AdaptiveBatchSizer({
        initial: 512,
        min: 32,
        recoveryThreshold: 5,
      });
      expect(sizer.current()).toBe(512);
    });
  });

  describe("Halve on yellow error", () => {
    it("halves current size on each onFailure(yellow) call", () => {
      const sizer = new AdaptiveBatchSizer({
        initial: 512,
        min: 32,
        recoveryThreshold: 5,
      });

      sizer.onFailure(yellow());
      expect(sizer.current()).toBe(256);

      sizer.onFailure(yellow());
      expect(sizer.current()).toBe(128);

      sizer.onFailure(yellow());
      expect(sizer.current()).toBe(64);

      sizer.onFailure(yellow());
      expect(sizer.current()).toBe(32);
    });

    it("floors at min when halved below the floor", () => {
      const sizer = new AdaptiveBatchSizer({
        initial: 512,
        min: 32,
        recoveryThreshold: 5,
      });

      for (let i = 0; i < 4; i++) sizer.onFailure(yellow());
      expect(sizer.current()).toBe(32);

      // continue pushing; should stay at min, not below
      for (let i = 0; i < 5; i++) sizer.onFailure(yellow());
      expect(sizer.current()).toBe(32);
    });

    it("applies Math.max(min, Math.floor(size/2)) with non-power-of-two initial", () => {
      const sizer = new AdaptiveBatchSizer({
        initial: 300,
        min: 50,
        recoveryThreshold: 3,
      });

      sizer.onFailure(yellow());
      expect(sizer.current()).toBe(150);

      sizer.onFailure(yellow());
      expect(sizer.current()).toBe(75);

      // Math.floor(75/2)=37, Math.max(50, 37)=50 — floor kicks in
      sizer.onFailure(yellow());
      expect(sizer.current()).toBe(50);
    });
  });

  describe("Ignore non-yellow errors", () => {
    it("does not adjust size on generic Error", () => {
      const sizer = new AdaptiveBatchSizer({
        initial: 512,
        min: 32,
        recoveryThreshold: 5,
      });

      sizer.onFailure(new Error("random"));
      expect(sizer.current()).toBe(512);
    });

    it("does not adjust size on null/undefined/string/object", () => {
      const sizer = new AdaptiveBatchSizer({
        initial: 512,
        min: 32,
        recoveryThreshold: 5,
      });

      sizer.onFailure(null);
      sizer.onFailure(undefined);
      sizer.onFailure("string");
      sizer.onFailure({});
      expect(sizer.current()).toBe(512);
    });
  });

  describe("Recovery doubles on threshold", () => {
    it("doubles back to initial after recoveryThreshold consecutive successes", () => {
      const sizer = new AdaptiveBatchSizer({
        initial: 512,
        min: 32,
        recoveryThreshold: 5,
      });

      sizer.onFailure(yellow());
      expect(sizer.current()).toBe(256);

      // 4 successes — below threshold, still 256
      for (let i = 0; i < 4; i++) sizer.onSuccess();
      expect(sizer.current()).toBe(256);

      // 5th success triggers doubling
      sizer.onSuccess();
      expect(sizer.current()).toBe(512);
    });

    it("resets consecutiveSuccesses counter after doubling", () => {
      const sizer = new AdaptiveBatchSizer({
        initial: 512,
        min: 32,
        recoveryThreshold: 5,
      });

      sizer.onFailure(yellow()); // 256
      sizer.onFailure(yellow()); // 128

      // 5 successes -> 256 and counter resets
      for (let i = 0; i < 5; i++) sizer.onSuccess();
      expect(sizer.current()).toBe(256);

      // 4 more successes — below threshold again
      for (let i = 0; i < 4; i++) sizer.onSuccess();
      expect(sizer.current()).toBe(256);

      // 5th -> 512
      sizer.onSuccess();
      expect(sizer.current()).toBe(512);
    });
  });

  describe("Recovery caps at initial", () => {
    it("does not exceed initial when already at initial", () => {
      const sizer = new AdaptiveBatchSizer({
        initial: 512,
        min: 32,
        recoveryThreshold: 5,
      });

      for (let i = 0; i < 20; i++) sizer.onSuccess();
      expect(sizer.current()).toBe(512);
    });

    it("caps at initial with small-difference configuration", () => {
      const sizer = new AdaptiveBatchSizer({
        initial: 100,
        min: 32,
        recoveryThreshold: 2,
      });

      sizer.onFailure(yellow());
      expect(sizer.current()).toBe(50);

      sizer.onSuccess();
      sizer.onSuccess();
      // Math.min(100, 50*2)=100
      expect(sizer.current()).toBe(100);

      // Another success cycle — should do nothing since size === initial
      sizer.onSuccess();
      sizer.onSuccess();
      expect(sizer.current()).toBe(100);
    });
  });

  describe("Failure resets success counter", () => {
    it("clears consecutiveSuccesses on yellow failure", () => {
      const sizer = new AdaptiveBatchSizer({
        initial: 512,
        min: 32,
        recoveryThreshold: 5,
      });

      sizer.onFailure(yellow()); // 256

      // 3 successes (below threshold)
      sizer.onSuccess();
      sizer.onSuccess();
      sizer.onSuccess();

      sizer.onFailure(yellow()); // 128, counter reset
      expect(sizer.current()).toBe(128);

      // 4 successes after reset — still below threshold
      for (let i = 0; i < 4; i++) sizer.onSuccess();
      expect(sizer.current()).toBe(128);

      // 5th success after reset -> 256
      sizer.onSuccess();
      expect(sizer.current()).toBe(256);
    });
  });
});
