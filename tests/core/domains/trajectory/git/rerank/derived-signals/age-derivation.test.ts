import { describe, expect, it } from "vitest";

import {
  AGE_DERIVATION,
  ageDaysFromStamp,
  invertPercentile,
  invertPercentileKey,
  stampThresholdFromDays,
  stampToTimestampKey,
} from "../../../../../../../src/core/domains/trajectory/git/age-derivation.js";
import { AgeSignal } from "../../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/age.js";
import { RecencySignal } from "../../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/recency.js";

/** Fixed query clock — unix SECONDS, matching the git.{file,chunk}.lastModifiedAt unit. */
const NOW = 1_800_000_000;
const DAY = 86_400;

const payload = (git?: Record<string, unknown>) => ({ git }) as Record<string, unknown>;

describe("ageDaysFromStamp", () => {
  it("derives whole days from lastModifiedAt at the injected now, flooring like the enrichment stamp", () => {
    expect(ageDaysFromStamp(NOW - 3 * DAY, NOW)).toBe(3);
    expect(ageDaysFromStamp(NOW - (30 * DAY + 3600), NOW)).toBe(30);
    expect(ageDaysFromStamp(NOW + 60, NOW)).toBe(0);
  });

  it("no stamp — absent key or the chunk 0 sentinel — is undefined, not ancient", () => {
    expect(ageDaysFromStamp(undefined, NOW)).toBeUndefined();
    expect(ageDaysFromStamp(0, NOW)).toBeUndefined();
  });
});

describe("percentile inversion — age pN ⇔ lastModifiedAt p(100−N)", () => {
  it("mirrors percentiles; the median is symmetric", () => {
    expect(invertPercentile(75)).toBe(25);
    expect(invertPercentile(50)).toBe(50);
    expect(invertPercentile(25)).toBe(75);
    expect(invertPercentile(95)).toBe(5);
  });

  it("inverts FilterPercentile keys", () => {
    expect(invertPercentileKey("p75")).toBe("p25");
    expect(invertPercentileKey("p50")).toBe("p50");
    expect(invertPercentileKey("p25")).toBe("p75");
    expect(invertPercentileKey("p95")).toBe("p5");
  });
});

describe("stampToTimestampKey", () => {
  it("maps level-qualified ageDays keys to lastModifiedAt", () => {
    expect(stampToTimestampKey("git.file.ageDays")).toBe("git.file.lastModifiedAt");
    expect(stampToTimestampKey("git.chunk.ageDays")).toBe("git.chunk.lastModifiedAt");
  });

  it("leaves non-stamp signals alone; bare ageDays has no level to translate", () => {
    expect(stampToTimestampKey("git.file.commitCount")).toBeUndefined();
    expect(stampToTimestampKey("ageDays")).toBeUndefined();
  });
});

describe("stampThresholdFromDays", () => {
  it("converts a fallback of N days into the now-relative stamp threshold", () => {
    expect(stampThresholdFromDays(60, NOW)).toBe(NOW - 60 * DAY);
  });
});

describe("AgeSignal#extract reads lastModifiedAt with an injected now", () => {
  const age = new AgeSignal();
  const bounds = { "file.lastModifiedAt": 365, "chunk.lastModifiedAt": 365 };

  it("fresh stamp scores low, stale stamp saturates high", () => {
    const ctx = { bounds, now: NOW };
    expect(age.extract(payload({ file: { lastModifiedAt: NOW - DAY } }), ctx)).toBeCloseTo(1 / 365, 4);
    expect(age.extract(payload({ file: { lastModifiedAt: NOW - 400 * DAY } }), ctx)).toBe(1);
  });

  it("missing lastModifiedAt behaves like the legacy missing ageDays — age 0", () => {
    expect(age.extract(payload({ file: { commitCount: 10 } }), { bounds, now: NOW })).toBe(0);
  });

  it("normalizes by the lastModifiedAt-keyed bounds", () => {
    // stamp 200 days old, bound 1000 → 0.2
    const ctx = { bounds: { "file.lastModifiedAt": 1000, "chunk.lastModifiedAt": 1000 }, now: NOW };
    expect(age.extract(payload({ file: { lastModifiedAt: NOW - 200 * DAY } }), ctx)).toBeCloseTo(0.2, 4);
  });

  it("falls back to defaultBound when ctx has no bounds", () => {
    // 182 days (floored from 182.5) / 365 ≈ 0.5
    expect(age.extract(payload({ file: { lastModifiedAt: NOW - 182.5 * DAY } }), { now: NOW })).toBeCloseTo(0.5, 2);
  });

  it("blends chunk + file ages with payload alpha, per-source normalized (L3 parity)", () => {
    // file: 200d / commitCount 20; chunk: 50d / commitCount 10 → alpha 0.5
    // blended = 0.5·(50/365) + 0.5·(200/365) = 0.3425
    const p = payload({
      file: { lastModifiedAt: NOW - 200 * DAY, commitCount: 20 },
      chunk: { lastModifiedAt: NOW - 50 * DAY, commitCount: 10 },
    });
    expect(age.extract(p, { now: NOW })).toBeCloseTo(0.3425, 4);
  });

  it("stays in 0-1 with no ctx at all (default clock)", () => {
    const val = age.extract(payload({ file: { lastModifiedAt: Math.floor(Date.now() / 1000) - 10 * DAY } }));
    expect(val).toBeGreaterThan(0);
    expect(val).toBeLessThanOrEqual(1);
  });
});

describe("RecencySignal#extract mirrors age with an injected now", () => {
  const recency = new RecencySignal();

  it("fresh stamp scores high, stale scores low", () => {
    expect(recency.extract(payload({ file: { lastModifiedAt: NOW - DAY } }), { now: NOW })).toBeCloseTo(1 - 1 / 365, 4);
    expect(recency.extract(payload({ file: { lastModifiedAt: NOW - 400 * DAY } }), { now: NOW })).toBe(0);
  });

  it("missing lastModifiedAt stays 1 − 0 = 1 (legacy missing-ageDays parity)", () => {
    expect(recency.extract(payload(), { now: NOW })).toBe(1);
  });
});

describe("AGE_DERIVATION capability", () => {
  it("declares the stamp and timestamp fields", () => {
    expect(AGE_DERIVATION.stampField).toBe("ageDays");
    expect(AGE_DERIVATION.timestampField).toBe("lastModifiedAt");
  });

  it("computes the overlay value per level", () => {
    const p = payload({
      file: { lastModifiedAt: NOW - 42 * DAY },
      chunk: { lastModifiedAt: NOW - 2 * DAY },
    });
    expect(AGE_DERIVATION.ageDaysFrom(p, "file", NOW)).toBe(42);
    expect(AGE_DERIVATION.ageDaysFrom(p, "chunk", NOW)).toBe(2);
    expect(AGE_DERIVATION.ageDaysFrom(payload(), "file", NOW)).toBeUndefined();
  });

  it("collection floor: now − stamp percentile, in days", () => {
    expect(AGE_DERIVATION.ageFloorDaysFromStamp(NOW - 10 * DAY, NOW)).toBeCloseTo(10, 6);
    expect(AGE_DERIVATION.ageFloorDaysFromStamp(NOW - 10.5 * DAY, NOW)).toBeCloseTo(10.5, 6);
  });

  it("label bands invert stamp percentiles into whole-day age thresholds", () => {
    const stamps = { 5: NOW - 200.2 * DAY, 25: NOW - 90 * DAY, 50: NOW - 30 * DAY };
    const bands = AGE_DERIVATION.labelThresholdsFromStamps(stamps, NOW);
    expect(bands[95]).toBe(200); // age legacy band ⇔ stamp p5
    expect(bands[75]).toBe(90); // age old band ⇔ stamp p25
    expect(bands[50]).toBe(30); // age typical band ⇔ stamp p50 (median symmetric)
    expect(bands[25]).toBeUndefined(); // stamp p75 not computed → band never fires
  });

  it("is carried by both age and recency descriptors with lastModifiedAt sources", () => {
    for (const d of [new AgeSignal(), new RecencySignal()]) {
      expect(d.ageDerivation).toBe(AGE_DERIVATION);
      expect(d.sources).toEqual(["file.lastModifiedAt", "chunk.lastModifiedAt"]);
    }
  });
});
