/**
 * Industry floors under percentile thresholds — spec
 * docs/superpowers/specs/2026-08-02-module-mass-signals-design.md.
 *
 * A percentile answers "large for this project"; a floor answers "large, full
 * stop". `applySignalFloors` raises each percentile whose label declares one,
 * so a clean codebase stops reporting a 35-line class as a megaclass while a
 * legacy monolith keeps its own, higher, project-relative thresholds.
 */

import { describe, expect, it } from "vitest";

import { applySignalFloors } from "../../../../src/core/domains/explore/signal-floors.js";

const LABELS = { p50: "small", p75: "large", p95: "god-module" };

describe("applySignalFloors", () => {
  it("raises a percentile that sits below its label's floor", () => {
    const raised = applySignalFloors({ 50: 12, 75: 26, 95: 35 }, LABELS, { large: 300, "god-module": 600 });

    expect(raised[75]).toBe(300);
    expect(raised[95]).toBe(600);
  });

  it("keeps a percentile that already exceeds its floor — the project stays the authority", () => {
    const raised = applySignalFloors({ 50: 200, 75: 800, 95: 2400 }, LABELS, { large: 300, "god-module": 600 });

    expect(raised[75]).toBe(800);
    expect(raised[95]).toBe(2400);
  });

  it("leaves percentiles whose label declares no floor untouched", () => {
    const raised = applySignalFloors({ 50: 12, 75: 26, 95: 35 }, LABELS, { "god-module": 600 });

    expect(raised[50]).toBe(12);
    expect(raised[75]).toBe(26);
  });

  it("preserves monotonicity — thresholds never cross after raising", () => {
    const raised = applySignalFloors({ 50: 12, 75: 26, 95: 35 }, LABELS, { large: 300, "god-module": 600 });

    expect(raised[50]).toBeLessThanOrEqual(raised[75]);
    expect(raised[75]).toBeLessThanOrEqual(raised[95]);
  });

  it("returns the percentiles unchanged when the language declares no floors", () => {
    const percentiles = { 50: 12, 75: 26, 95: 35 };

    expect(applySignalFloors(percentiles, LABELS, undefined)).toEqual(percentiles);
    expect(applySignalFloors(percentiles, LABELS, {})).toEqual(percentiles);
  });

  it("ignores a floor naming a label this signal does not declare", () => {
    const raised = applySignalFloors({ 50: 12, 75: 26, 95: 35 }, LABELS, { megaclass: 900 });

    expect(raised).toEqual({ 50: 12, 75: 26, 95: 35 });
  });

  it("skips a label whose percentile was never computed", () => {
    const raised = applySignalFloors({ 50: 12 }, LABELS, { large: 300, "god-module": 600 });

    expect(raised).toEqual({ 50: 12 });
  });

  it("does not mutate the percentiles it was given", () => {
    const percentiles = { 50: 12, 75: 26, 95: 35 };
    applySignalFloors(percentiles, LABELS, { large: 300 });

    expect(percentiles[75]).toBe(26);
  });
});
