export type Outcome = "catch" | "pit" | "egg" | "robot";

// ---------------------------------------------------------------------------
// Part 1: djb2 hash
// ---------------------------------------------------------------------------

/** djb2 hash -> hex string */
export function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

// ---------------------------------------------------------------------------
// Part 2: pickUniquePhrase
// ---------------------------------------------------------------------------

/**
 * Pick a random phrase not yet seen (by hash).
 * If all phrases seen -> reset (return from full set).
 */
export function pickUniquePhrase(phrases: string[], seenHashes: string[]): string {
  const seenSet = new Set(seenHashes);
  const unseen = phrases.filter((p) => !seenSet.has(djb2(p)));
  const pool = unseen.length > 0 ? unseen : phrases;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------------------------------------------------------------------------
// Part 3: Shuffle Bag
// ---------------------------------------------------------------------------

/** Create a new shuffle bag with weighted outcomes (50/30/15/5%) */
export function createBag(): Outcome[] {
  const bag: Outcome[] = [
    ...Array<Outcome>(10).fill("catch"),
    ...Array<Outcome>(6).fill("egg"),
    ...Array<Outcome>(3).fill("pit"),
    ...Array<Outcome>(1).fill("robot"),
  ];
  // Fisher-Yates shuffle
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

/** Draw one outcome from the bag. If empty -> create new bag first. */
export function drawFromBag(bag: Outcome[]): {
  outcome: Outcome;
  remaining: Outcome[];
} {
  if (bag.length === 0) bag = createBag();
  const outcome = bag[0];
  return { outcome, remaining: bag.slice(1) };
}

// ---------------------------------------------------------------------------
// Part 4: localStorage I/O Helpers
// ---------------------------------------------------------------------------

const KEY_SEEN = "dinorun_seen";
const KEY_BAG = "dinorun_bag";
const KEY_NEXT = "dinorun_next_at";

type SeenMap = Record<Outcome, string[]>;

const emptySeen = (): SeenMap => ({ catch: [], pit: [], egg: [], robot: [] });

export function loadSeenHashes(storage: Storage = localStorage): SeenMap {
  try {
    const raw = storage.getItem(KEY_SEEN);
    if (!raw) return emptySeen();
    return { ...emptySeen(), ...JSON.parse(raw) };
  } catch {
    return emptySeen();
  }
}

export function saveSeenHash(outcome: Outcome, hash: string, storage: Storage = localStorage): void {
  const seen = loadSeenHashes(storage);
  if (!seen[outcome].includes(hash)) {
    seen[outcome].push(hash);
  }
  storage.setItem(KEY_SEEN, JSON.stringify(seen));
}

export function resetSeenHashes(outcome: Outcome, storage: Storage = localStorage): void {
  const seen = loadSeenHashes(storage);
  seen[outcome] = [];
  storage.setItem(KEY_SEEN, JSON.stringify(seen));
}

export function loadBag(storage: Storage = localStorage): Outcome[] {
  try {
    const raw = storage.getItem(KEY_BAG);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function saveBag(bag: Outcome[], storage: Storage = localStorage): void {
  storage.setItem(KEY_BAG, JSON.stringify(bag));
}

export function loadNextAt(storage: Storage = localStorage): number {
  try {
    const raw = storage.getItem(KEY_NEXT);
    if (!raw) return 0;
    return Number(raw) || 0;
  } catch {
    return 0;
  }
}

export function saveNextAt(ts: number, storage: Storage = localStorage): void {
  storage.setItem(KEY_NEXT, String(ts));
}
