import { beforeEach, describe, expect, it } from "vitest";

import {
  createBag,
  djb2,
  drawFromBag,
  loadBag,
  loadNextAt,
  loadSeenHashes,
  pickUniquePhrase,
  resetSeenHashes,
  saveBag,
  saveNextAt,
  saveSeenHash,
  type Outcome,
} from "../../website/src/components/dinoRunStorage";

// ---------------------------------------------------------------------------
// Mock localStorage
// ---------------------------------------------------------------------------
function createMockStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (_i: number) => null,
  } as Storage;
}

// ===========================================================================
// Part 1: djb2 hash
// ===========================================================================
describe("djb2", () => {
  it("returns a string hash", () => {
    const result = djb2("hello");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("is deterministic (same input -> same output)", () => {
    expect(djb2("test")).toBe(djb2("test"));
    expect(djb2("")).toBe(djb2(""));
    expect(djb2("a longer string")).toBe(djb2("a longer string"));
  });

  it("produces different hashes for different inputs", () => {
    const h1 = djb2("hello");
    const h2 = djb2("world");
    const h3 = djb2("hello!");
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h2).not.toBe(h3);
  });
});

// ===========================================================================
// Part 2: pickUniquePhrase
// ===========================================================================
describe("pickUniquePhrase", () => {
  const phrases = ["alpha", "bravo", "charlie"];

  it("returns a phrase from the array when no hashes seen", () => {
    const result = pickUniquePhrase(phrases, []);
    expect(phrases).toContain(result);
  });

  it("avoids already-seen hashes", () => {
    // Mark 2 of 3 as seen; must return the third
    const seenHashes = [djb2("alpha"), djb2("bravo")];
    // Run multiple times to ensure it consistently picks "charlie"
    for (let i = 0; i < 20; i++) {
      const result = pickUniquePhrase(phrases, seenHashes);
      expect(result).toBe("charlie");
    }
  });

  it("resets when ALL phrases seen (returns any phrase from full set)", () => {
    const allSeen = phrases.map(djb2);
    const result = pickUniquePhrase(phrases, allSeen);
    expect(phrases).toContain(result);
  });
});

// ===========================================================================
// Part 3: Shuffle Bag
// ===========================================================================
describe("createBag", () => {
  it("returns 20 items with correct distribution", () => {
    const bag = createBag();
    expect(bag).toHaveLength(20);

    const counts: Record<Outcome, number> = {
      catch: 0,
      egg: 0,
      pit: 0,
      robot: 0,
    };
    for (const item of bag) {
      counts[item]++;
    }
    expect(counts.catch).toBe(10);
    expect(counts.egg).toBe(6);
    expect(counts.pit).toBe(3);
    expect(counts.robot).toBe(1);
  });
});

describe("drawFromBag", () => {
  it("returns an outcome and remaining bag (19 items)", () => {
    const bag = createBag();
    const { outcome, remaining } = drawFromBag(bag);
    expect(typeof outcome).toBe("string");
    expect(["catch", "egg", "pit", "robot"]).toContain(outcome);
    expect(remaining).toHaveLength(19);
  });

  it("on empty bag creates new bag then draws (returns 19 remaining)", () => {
    const { outcome, remaining } = drawFromBag([]);
    expect(["catch", "egg", "pit", "robot"]).toContain(outcome);
    expect(remaining).toHaveLength(19);
  });
});

// ===========================================================================
// Part 4: localStorage I/O Helpers
// ===========================================================================
describe("localStorage I/O helpers", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createMockStorage();
  });

  // --- SeenHashes ---
  describe("loadSeenHashes", () => {
    it("returns empty object on fresh storage", () => {
      const result = loadSeenHashes(storage);
      expect(result).toEqual({ catch: [], pit: [], egg: [], robot: [] });
    });
  });

  describe("saveSeenHash / loadSeenHashes", () => {
    it("persists and retrieves a hash", () => {
      saveSeenHash("catch", "abc123", storage);
      const seen = loadSeenHashes(storage);
      expect(seen.catch).toContain("abc123");
    });

    it("does not duplicate existing hash", () => {
      saveSeenHash("egg", "hash1", storage);
      saveSeenHash("egg", "hash1", storage);
      const seen = loadSeenHashes(storage);
      expect(seen.egg).toEqual(["hash1"]);
    });
  });

  describe("resetSeenHashes", () => {
    it("clears only the specified outcome", () => {
      saveSeenHash("catch", "h1", storage);
      saveSeenHash("pit", "h2", storage);
      resetSeenHashes("catch", storage);
      const seen = loadSeenHashes(storage);
      expect(seen.catch).toEqual([]);
      expect(seen.pit).toEqual(["h2"]);
    });
  });

  // --- Bag ---
  describe("loadBag", () => {
    it("returns empty array on fresh storage", () => {
      expect(loadBag(storage)).toEqual([]);
    });
  });

  describe("saveBag / loadBag", () => {
    it("round-trips", () => {
      const bag: Outcome[] = ["catch", "egg", "pit", "robot"];
      saveBag(bag, storage);
      expect(loadBag(storage)).toEqual(bag);
    });
  });

  // --- NextAt ---
  describe("loadNextAt", () => {
    it("returns 0 on fresh storage", () => {
      expect(loadNextAt(storage)).toBe(0);
    });
  });

  describe("saveNextAt / loadNextAt", () => {
    it("round-trips", () => {
      const ts = Date.now();
      saveNextAt(ts, storage);
      expect(loadNextAt(storage)).toBe(ts);
    });
  });
});
