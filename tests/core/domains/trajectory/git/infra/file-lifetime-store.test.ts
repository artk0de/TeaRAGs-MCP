/**
 * bd tea-rags-mcp-61gt2 — GitFileLifetimeStore: persistent whole-history
 * lifetime stamps keyed by repo identity + the HEAD tip they were folded
 * through. Pins the GitBlameStore discipline: save→load roundtrip, corrupt
 * JSON → null, identity mismatch → null, oversized → skip save, cold → null.
 * No git needed — synthetic stamps against an explicit tmp baseDir.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitFileLifetimeStore } from "../../../../../../src/core/domains/trajectory/git/infra/file-lifetime-store.js";

const STAMP_A = { lastModifiedAt: 500, firstCreatedAt: 100, lastCommitHash: "s3" };
const STAMP_B = { lastModifiedAt: 200, firstCreatedAt: 200, lastCommitHash: "s2" };

describe("GitFileLifetimeStore (bd tea-rags-mcp-61gt2)", () => {
  let baseDir: string;
  const repoRoot = "/repos/alpha";

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "file-lifetime-store-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function fixtureStamps(): Map<string, typeof STAMP_A> {
    return new Map([
      ["src/a.ts", { ...STAMP_A }],
      ["src/b.ts", { ...STAMP_B }],
    ]);
  }

  it("save → load roundtrip deep-equals the input (tip carried through)", () => {
    const store = new GitFileLifetimeStore(baseDir);
    const stamps = fixtureStamps();
    store.save(repoRoot, "tip-sha", stamps);

    const loaded = store.load(repoRoot);
    expect(loaded).not.toBeNull();
    expect(loaded?.tip).toBe("tip-sha");
    expect(loaded?.stamps.size).toBe(2);
    expect(loaded?.stamps.get("src/a.ts")).toEqual(STAMP_A);
    expect(loaded?.stamps.get("src/b.ts")).toEqual(STAMP_B);
  });

  it("load of corrupt JSON returns null (silent rebuild)", () => {
    const store = new GitFileLifetimeStore(baseDir);
    store.save(repoRoot, "tip-sha", fixtureStamps());
    writeFileSync(locateLifetimeJson(baseDir), "{ not json at all");

    expect(store.load(repoRoot)).toBeNull();
  });

  it("load with a mismatched persisted repoRoot returns null (hash-collision guard)", () => {
    const store = new GitFileLifetimeStore(baseDir);
    store.save(repoRoot, "tip-sha", fixtureStamps());
    const path = locateLifetimeJson(baseDir);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { repoRoot: string };
    parsed.repoRoot = "/repos/omega";
    writeFileSync(path, JSON.stringify(parsed));

    expect(store.load(repoRoot)).toBeNull();
  });

  type LooseSnapshot = { version: number; repoRoot: string; tip: unknown; stamps: Record<string, unknown> };
  const withStampA = (p: LooseSnapshot, patch: Record<string, unknown>): LooseSnapshot => ({
    ...p,
    stamps: { ...p.stamps, "src/a.ts": { ...(p.stamps["src/a.ts"] as object), ...patch } },
  });
  it.each<[string, (p: LooseSnapshot) => unknown]>([
    ["a non-string tip", (p) => ({ ...p, tip: 42 })],
    ["a non-object stamps table", (p) => ({ ...p, stamps: "nope" })],
    ["a stamp with a non-number lastModifiedAt", (p) => withStampA(p, { lastModifiedAt: "soon" })],
    ["a stamp missing lastCommitHash", (p) => withStampA(p, { lastCommitHash: undefined })],
  ])("load rejects %s → null (silent rebuild)", (_label, mutate) => {
    const store = new GitFileLifetimeStore(baseDir);
    store.save(repoRoot, "tip-sha", fixtureStamps());
    const path = locateLifetimeJson(baseDir);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LooseSnapshot;
    writeFileSync(path, JSON.stringify(mutate(parsed)));

    expect(store.load(repoRoot)).toBeNull();
  });

  it("oversized payload skips the save (tiny maxBytes → nothing persisted)", () => {
    const store = new GitFileLifetimeStore(baseDir, 8);
    store.save(repoRoot, "tip-sha", fixtureStamps());

    expect(store.load(repoRoot)).toBeNull();
  });

  it("cold load (nothing ever saved) returns null", () => {
    const store = new GitFileLifetimeStore(baseDir);
    expect(store.load(repoRoot)).toBeNull();
  });
});

/** The store writes ONE lifetime.json under <baseDir>/<hash16>/ — find it. */
function locateLifetimeJson(baseDir: string): string {
  const [hashDir] = readdirSync(baseDir);
  return join(baseDir, hashDir, "lifetime.json");
}
