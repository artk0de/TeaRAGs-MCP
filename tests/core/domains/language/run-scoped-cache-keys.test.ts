/**
 * No resolver cache under `domains/language/**` may key on a long-lived object's
 * identity (bd tea-rags-mcp-39xca.6).
 *
 * Twice in one week the defect was the same shape. `LanguageFactory.create`
 * caches the provider, so a memo held by a resolver lives as long as the
 * factory; `GraphDbClientPool` keeps one `GlobalSymbolTable` per collection for
 * the pool's lifetime. A memo keyed by that table served run N's answers to run
 * N+1 (bd 11qqk, re-export declarers; bd z99hp, ancestor linearizers). Keying on
 * a run-global CHANNEL's identity instead (`WeakMap<object, …>`) moved the
 * problem rather than removing it: those objects are mutated in place by
 * `absorb` and `seal`.
 *
 * The run's identity is now explicit — `CallContext.runScope` — and caches go
 * through `RunScopedMemo` (`kernel/run-scoped-memo.ts`). This scan forbids the
 * two identity-keyed declarations that bypass it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const LANGUAGE_ROOT = "src/core/domains/language";

/** A Map / WeakMap / Set / WeakSet whose KEY type is the symbol table or a bare `object`. */
const IDENTITY_KEYED_CACHE = /\b(?:WeakMap|Map|WeakSet|Set)<\s*(?:GlobalSymbolTable|object)\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("domains/language caches are keyed by run scope, not by object identity", () => {
  it("recognises the forbidden shapes (the scan cannot pass on a broken pattern)", () => {
    expect(IDENTITY_KEYED_CACHE.test("new WeakMap<GlobalSymbolTable, Memo>()")).toBe(true);
    expect(IDENTITY_KEYED_CACHE.test("new WeakMap<object, Memo>()")).toBe(true);
    expect(IDENTITY_KEYED_CACHE.test("new Map< GlobalSymbolTable, Memo>()")).toBe(true);
    expect(IDENTITY_KEYED_CACHE.test("new WeakMap<ResolveRunScope, WeakMap<K, V>>()")).toBe(false);
    expect(IDENTITY_KEYED_CACHE.test("new WeakMap<objectLike, V>()")).toBe(false);
  });

  it("finds no GlobalSymbolTable- or object-keyed cache under domains/language", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(LANGUAGE_ROOT)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (IDENTITY_KEYED_CACHE.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
