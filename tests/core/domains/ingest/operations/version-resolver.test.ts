import { describe, expect, it } from "vitest";

import {
  computeNewVersion,
  maxVersionedCollection,
  parseCollectionVersion,
} from "../../../../../src/core/domains/ingest/operations/version-resolver.js";

const BASE = "code_abc";

describe("parseCollectionVersion", () => {
  it("returns 0 for undefined", () => {
    expect(parseCollectionVersion(BASE, undefined)).toBe(0);
  });

  it("returns 0 for an unversioned collection (the base name itself)", () => {
    expect(parseCollectionVersion(BASE, BASE)).toBe(0);
  });

  it("parses the _vN suffix", () => {
    expect(parseCollectionVersion(BASE, `${BASE}_v8`)).toBe(8);
  });

  it("returns 0 for a different base name", () => {
    expect(parseCollectionVersion(BASE, "code_other_v3")).toBe(0);
  });
});

describe("maxVersionedCollection", () => {
  it("returns 0 when no versioned collections exist", () => {
    expect(maxVersionedCollection(BASE, [BASE, "code_other_v9"])).toBe(0);
  });

  it("returns the highest version among matching collections", () => {
    expect(maxVersionedCollection(BASE, [`${BASE}_v1`, `${BASE}_v8`, `${BASE}_v3`])).toBe(8);
  });
});

describe("computeNewVersion", () => {
  it("first index (no alias, no versioned collections) → v1", () => {
    expect(
      computeNewVersion({
        collectionName: BASE,
        aliasTargetCollection: undefined,
        allCollections: [],
        isMigration: false,
      }),
    ).toBe(1);
  });

  it("alias at vN → vN+1", () => {
    expect(
      computeNewVersion({
        collectionName: BASE,
        aliasTargetCollection: `${BASE}_v8`,
        allCollections: [`${BASE}_v8`],
        isMigration: false,
      }),
    ).toBe(9);
  });

  it("orphan vM > alias version → vM+1 (never re-collides with leftover)", () => {
    // Alias points at v8 but an orphan v13 lingers from an interrupted run.
    expect(
      computeNewVersion({
        collectionName: BASE,
        aliasTargetCollection: `${BASE}_v8`,
        allCollections: [`${BASE}_v8`, `${BASE}_v13`],
        isMigration: false,
      }),
    ).toBe(14);
  });

  it("orphan present but no alias (lost snapshot) → maxOrphan+1", () => {
    expect(
      computeNewVersion({
        collectionName: BASE,
        aliasTargetCollection: undefined,
        allCollections: [`${BASE}_v1`],
        isMigration: false,
      }),
    ).toBe(2);
  });

  it("migration (real unversioned collection exists, no alias) → v2", () => {
    expect(
      computeNewVersion({
        collectionName: BASE,
        aliasTargetCollection: undefined,
        allCollections: [BASE],
        isMigration: true,
      }),
    ).toBe(2);
  });
});
