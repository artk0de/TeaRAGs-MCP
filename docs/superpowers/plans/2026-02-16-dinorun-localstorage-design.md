# DinoRun localStorage + Shuffle Bag + Chicken Trigger — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Add localStorage persistence for phrase dedup, shuffle bag for
outcomes, persistent timer, and chicken trigger button to the DinoRun Easter
egg.

**Architecture:** Extract pure logic (hash, shuffle bag, localStorage I/O) into
`dinoRunStorage.ts`. Modify `DinoRun.tsx` to use the new module and replace
auto-activation with a chicken button. All localStorage keys prefixed with
`dinorun_`.

**Tech Stack:** React 19, TypeScript, Docusaurus 3, vitest (for pure logic
tests)

---

## Task 1: Create `dinoRunStorage.ts` — Pure Logic Module

**Files:**

- Create: `website/src/components/dinoRunStorage.ts`
- Test: `tests/website/dinoRunStorage.test.ts`

### Step 1: Write failing tests for djb2 hash

```typescript
// tests/website/dinoRunStorage.test.ts
import { describe, expect, it } from "vitest";

import { djb2 } from "../../website/src/components/dinoRunStorage";

describe("djb2", () => {
  it("returns a string hash", () => {
    const h = djb2("hello");
    expect(typeof h).toBe("string");
    expect(h.length).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    expect(djb2("test phrase")).toBe(djb2("test phrase"));
  });

  it("produces different hashes for different inputs", () => {
    expect(djb2("phrase A")).not.toBe(djb2("phrase B"));
  });
});
```

### Step 2: Run tests — expect FAIL (module not found)

Run: `npx vitest run tests/website/dinoRunStorage.test.ts` Expected: FAIL —
cannot resolve module

### Step 3: Implement djb2

```typescript
// website/src/components/dinoRunStorage.ts
export type Outcome = "catch" | "pit" | "egg" | "robot";

/** djb2 hash → hex string */
export function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}
```

### Step 4: Run tests — expect PASS

Run: `npx vitest run tests/website/dinoRunStorage.test.ts` Expected: PASS

### Step 5: Commit

```bash
git add website/src/components/dinoRunStorage.ts tests/website/dinoRunStorage.test.ts
git commit -m "feat(website): add djb2 hash for phrase deduplication"
```

---

## Task 2: Phrase Deduplication Logic

**Files:**

- Modify: `website/src/components/dinoRunStorage.ts`
- Modify: `tests/website/dinoRunStorage.test.ts`

### Step 1: Write failing tests for phrase picking with dedup

```typescript
import {
  djb2,
  pickUniquePhrase,
} from "../../website/src/components/dinoRunStorage";

describe("pickUniquePhrase", () => {
  const phrases = ["alpha", "beta", "gamma"];

  it("returns a phrase from the array", () => {
    const result = pickUniquePhrase(phrases, []);
    expect(phrases).toContain(result);
  });

  it("avoids already-seen hashes", () => {
    const seenHashes = [djb2("alpha"), djb2("beta")];
    // Only "gamma" is left
    const result = pickUniquePhrase(phrases, seenHashes);
    expect(result).toBe("gamma");
  });

  it("resets when all phrases seen — returns a phrase and signals reset", () => {
    const allSeen = phrases.map(djb2);
    const result = pickUniquePhrase(phrases, allSeen);
    expect(phrases).toContain(result);
  });
});
```

### Step 2: Run tests — expect FAIL

Run: `npx vitest run tests/website/dinoRunStorage.test.ts` Expected: FAIL —
pickUniquePhrase not exported

### Step 3: Implement pickUniquePhrase

Add to `dinoRunStorage.ts`:

```typescript
/**
 * Pick a random phrase not yet seen (by hash).
 * If all phrases seen → reset (return from full set).
 * Returns { phrase, hash, didReset }.
 */
export function pickUniquePhrase(
  phrases: string[],
  seenHashes: string[],
): string {
  const seenSet = new Set(seenHashes);
  const unseen = phrases.filter((p) => !seenSet.has(djb2(p)));
  const pool = unseen.length > 0 ? unseen : phrases;
  return pool[Math.floor(Math.random() * pool.length)];
}
```

### Step 4: Run tests — expect PASS

Run: `npx vitest run tests/website/dinoRunStorage.test.ts`

### Step 5: Commit

```bash
git add website/src/components/dinoRunStorage.ts tests/website/dinoRunStorage.test.ts
git commit -m "feat(website): add phrase deduplication with hash tracking"
```

---

## Task 3: Shuffle Bag for Outcomes

**Files:**

- Modify: `website/src/components/dinoRunStorage.ts`
- Modify: `tests/website/dinoRunStorage.test.ts`

### Step 1: Write failing tests for shuffle bag

```typescript
import {
  createBag,
  drawFromBag,
} from "../../website/src/components/dinoRunStorage";

describe("shuffle bag", () => {
  it("createBag returns 20 items with correct distribution", () => {
    const bag = createBag();
    expect(bag).toHaveLength(20);
    expect(bag.filter((o) => o === "catch")).toHaveLength(10);
    expect(bag.filter((o) => o === "egg")).toHaveLength(6);
    expect(bag.filter((o) => o === "pit")).toHaveLength(3);
    expect(bag.filter((o) => o === "robot")).toHaveLength(1);
  });

  it("drawFromBag returns an outcome and the remaining bag", () => {
    const bag = createBag();
    const { outcome, remaining } = drawFromBag(bag);
    expect(["catch", "pit", "egg", "robot"]).toContain(outcome);
    expect(remaining).toHaveLength(19);
  });

  it("drawFromBag on empty bag creates new bag then draws", () => {
    const { outcome, remaining } = drawFromBag([]);
    expect(["catch", "pit", "egg", "robot"]).toContain(outcome);
    expect(remaining).toHaveLength(19);
  });
});
```

### Step 2: Run tests — expect FAIL

### Step 3: Implement shuffle bag

Add to `dinoRunStorage.ts`:

```typescript
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

/** Draw one outcome from the bag. If empty → create new bag first. */
export function drawFromBag(bag: Outcome[]): {
  outcome: Outcome;
  remaining: Outcome[];
} {
  if (bag.length === 0) bag = createBag();
  const outcome = bag[0];
  return { outcome, remaining: bag.slice(1) };
}
```

### Step 4: Run tests — expect PASS

### Step 5: Commit

```bash
git add website/src/components/dinoRunStorage.ts tests/website/dinoRunStorage.test.ts
git commit -m "feat(website): add shuffle bag for weighted outcome variety"
```

---

## Task 4: localStorage I/O Helpers

**Files:**

- Modify: `website/src/components/dinoRunStorage.ts`
- Modify: `tests/website/dinoRunStorage.test.ts`

### Step 1: Write failing tests for localStorage read/write

Note: vitest with `environment: "node"` doesn't have `localStorage`. Mock it.

```typescript
import {
  loadBag,
  loadNextAt,
  loadSeenHashes,
  saveBag,
  saveNextAt,
  saveSeenHash,
} from "../../website/src/components/dinoRunStorage";

// Mock localStorage
const mockStorage = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (k: string) => mockStorage.get(k) ?? null,
  setItem: (k: string, v: string) => mockStorage.set(k, v),
  removeItem: (k: string) => mockStorage.delete(k),
} as Storage;

describe("localStorage helpers", () => {
  beforeEach(() => mockStorage.clear());

  it("loadSeenHashes returns empty object on fresh storage", () => {
    expect(loadSeenHashes(fakeLocalStorage)).toEqual({
      catch: [],
      pit: [],
      egg: [],
      robot: [],
    });
  });

  it("saveSeenHash persists and loadSeenHashes retrieves", () => {
    saveSeenHash("catch", "abc123", fakeLocalStorage);
    const loaded = loadSeenHashes(fakeLocalStorage);
    expect(loaded.catch).toContain("abc123");
  });

  it("loadBag returns empty array on fresh storage", () => {
    expect(loadBag(fakeLocalStorage)).toEqual([]);
  });

  it("saveBag/loadBag round-trips", () => {
    saveBag(["catch", "pit", "egg"], fakeLocalStorage);
    expect(loadBag(fakeLocalStorage)).toEqual(["catch", "pit", "egg"]);
  });

  it("loadNextAt returns 0 on fresh storage", () => {
    expect(loadNextAt(fakeLocalStorage)).toBe(0);
  });

  it("saveNextAt/loadNextAt round-trips", () => {
    saveNextAt(1708012345000, fakeLocalStorage);
    expect(loadNextAt(fakeLocalStorage)).toBe(1708012345000);
  });
});
```

### Step 2: Run tests — expect FAIL

### Step 3: Implement localStorage helpers

Add to `dinoRunStorage.ts`:

```typescript
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

export function saveSeenHash(
  outcome: Outcome,
  hash: string,
  storage: Storage = localStorage,
): void {
  const seen = loadSeenHashes(storage);
  if (!seen[outcome].includes(hash)) {
    seen[outcome].push(hash);
  }
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
```

### Step 4: Run tests — expect PASS

### Step 5: Commit

```bash
git add website/src/components/dinoRunStorage.ts tests/website/dinoRunStorage.test.ts
git commit -m "feat(website): add localStorage helpers for dinorun persistence"
```

---

## Task 5: Integrate Storage into DinoRun.tsx

**Files:**

- Modify: `website/src/components/DinoRun.tsx`

This task modifies the React component to use the new storage module. No new
tests — visual testing via `?dinorun=` param.

### Step 1: Update imports and replace functions

At the top of `DinoRun.tsx`, replace:

```typescript
// OLD
import {
  catchPhrases,
  eggPhrases,
  pitPhrases,
  robotPhrases,
} from "./dinoRunPhrases";
// ADD
import {
  djb2,
  drawFromBag,
  loadBag,
  loadNextAt,
  loadSeenHashes,
  Outcome,
  pickUniquePhrase,
  saveBag,
  saveNextAt,
  saveSeenHash,
} from "./dinoRunStorage";
```

Remove `type Outcome` (now imported), `pickRandom`, `pickOutcome`, `randomDelay`
functions.

Keep the `getPhrase` function but refactor to use `pickUniquePhrase`:

```typescript
function getPhrase(outcome: Outcome): { phrase: string; hash: string } {
  const phrases = {
    catch: catchPhrases,
    pit: pitPhrases,
    egg: eggPhrases,
    robot: robotPhrases,
  }[outcome];
  const seen = loadSeenHashes();
  const phrase = pickUniquePhrase(phrases, seen[outcome]);
  const hash = djb2(phrase);
  return { phrase, hash };
}
```

### Step 2: Replace outcome picking in `startRun`

In `startRun` callback, replace:

```typescript
// OLD
const outcome = forcedOutcome ?? pickOutcome();
const phrase = getPhrase(outcome);
```

With:

```typescript
// Animation is non-cancellable — ignore all triggers while running
if (runningRef.current) return;
runningRef.current = true;

// Hide chicken button if it's showing (logo click while chicken visible)
setChickenReady(false);

let outcome: Outcome;
if (forcedOutcome) {
  outcome = forcedOutcome;
} else {
  const bag = loadBag();
  const draw = drawFromBag(bag);
  outcome = draw.outcome;
  saveBag(draw.remaining);
}
const { phrase, hash } = getPhrase(outcome);
saveSeenHash(outcome, hash);
```

**Important:** The `manual` flag (logo click / `dinorun-trigger` event) must:

1. **Guard: if animation is already running (`state !== null`), ignore the click
   entirely — return early**
2. Hide the chicken button if visible (`setChickenReady(false)`)
3. Draw from the shuffle bag (not bypass it) — bag tracks overall variety
4. After animation dismiss → `scheduleNext()` → new timer saved to localStorage

**Non-cancellable animation rule:** Once an animation starts, it runs to
completion. No click (logo, chicken, or otherwise) can cancel or restart it.

**Implementation detail:** `startRun` lives in `useCallback` — `state` would be
stale there. Use a `runningRef = useRef(false)` instead:

- Set `runningRef.current = true` at start of animation
- Set `runningRef.current = false` in `dismiss()`
- Guard: `if (runningRef.current) return;` at top of `startRun`
- **Remove** the old cancel logic (`cancelAnimationFrame`,
  `clearTimeout(dismissRef)`, `setState(null)`) from `startRun`

### Step 3: Replace timer scheduling with localStorage persistence

Replace `randomDelay()` usage in `scheduleNext`:

```typescript
const scheduleNext = useCallback(() => {
  if (timerRef.current) clearTimeout(timerRef.current);
  const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
  const nextAt = Date.now() + delay;
  saveNextAt(nextAt);
  timerRef.current = setTimeout(() => setChickenReady(true), delay);
}, []);
```

On mount, check persisted timer:

```typescript
const savedNextAt = loadNextAt();
const now = Date.now();
if (savedNextAt > 0 && savedNextAt <= now) {
  setChickenReady(true);
} else if (savedNextAt > now) {
  timerRef.current = setTimeout(() => setChickenReady(true), savedNextAt - now);
} else {
  scheduleNext();
}
```

### Step 4: Commit

```bash
git add website/src/components/DinoRun.tsx
git commit -m "feat(website): integrate localStorage persistence into DinoRun"
```

---

## Task 6: Chicken Trigger Button

**Files:**

- Modify: `website/src/components/DinoRun.tsx`

### Step 1: Add `chickenReady` state and chicken button

Add state:

```typescript
const [chickenReady, setChickenReady] = useState(false);
```

Add `ChickenButton` component (inside `DinoRun.tsx`):

```typescript
function ChickenButton({ onClick }: { onClick: () => void }) {
  return createPortal(
    <button
      onClick={onClick}
      aria-label="Start dinosaur animation"
      style={{
        position: "fixed",
        bottom: "16px",
        left: "16px",
        zIndex: 99990,
        background: "none",
        border: "none",
        fontSize: "32px",
        cursor: "pointer",
        padding: "4px",
        lineHeight: 1,
        animation: "drun-chickenAppear 0.6s ease-out",
        filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.3))",
        transition: "transform 0.2s ease",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.2)")}
      onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
    >
      🐔
    </button>,
    document.body,
  );
}
```

Add keyframe to the `<style>` block:

```css
@keyframes drun-chickenAppear {
  0% {
    opacity: 0;
    transform: translateY(20px) scale(0.5);
  }
  60% {
    opacity: 1;
    transform: translateY(-4px) scale(1.05);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
```

### Step 2: Wire chicken button into DinoRun component

In `DinoRun` render:

```typescript
if (!state && chickenReady && typeof document !== "undefined") {
  return <ChickenButton onClick={() => {
    setChickenReady(false);
    startRun(undefined, false);
  }} />;
}
```

### Step 3: Update `useEffect` — remove auto-spawn, keep logo trigger

Remove the `scheduleNext()` call for non-main pages. Replace with timer logic
from Task 5, Step 3.

The `dinorun-trigger` event (logo click) still calls `startRun(undefined, true)`
directly — bypasses chicken.

### Step 4: After animation dismiss, schedule next chicken

In `dismiss` callback:

```typescript
const dismiss = useCallback(() => {
  setState(null);
  scheduleNext(); // writes new dinorun_next_at and sets timer for chicken
}, [scheduleNext]);
```

### Step 5: Commit

```bash
git add website/src/components/DinoRun.tsx
git commit -m "feat(website): replace auto-activation with chicken trigger button"
```

---

## Task 7: Visual Testing & Cleanup

**Files:**

- Modify: `website/src/components/DinoRun.tsx` (cleanup dead code)

### Step 1: Run all vitest tests

Run: `npx vitest run tests/website/dinoRunStorage.test.ts` Expected: all PASS

### Step 2: Run TypeScript check

Run: `cd website && npx tsc --noEmit` Expected: no errors

### Step 3: Run prettier

Run:
`npx prettier --write website/src/components/DinoRun.tsx website/src/components/dinoRunStorage.ts`

### Step 4: Manual visual test

Run: `cd website && npm start`

Test checklist:

- [ ] Open a doc page — chicken appears after timer
- [ ] Click chicken — animation plays, chicken disappears
- [ ] Refresh page — timer persists (chicken doesn't reset)
- [ ] Click logo on main page — animation plays directly (no chicken)
- [ ] `?dinorun=catch` in dev mode — forces catch outcome
- [ ] Run multiple animations — phrases don't repeat until category exhausted
- [ ] Check localStorage in DevTools — keys `dinorun_seen`, `dinorun_bag`,
      `dinorun_next_at` present

### Step 5: Commit

```bash
git add website/src/components/DinoRun.tsx website/src/components/dinoRunStorage.ts
git commit -m "chore(website): cleanup and format dinorun changes"
```
