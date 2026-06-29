# Language Compatibility Generator — Design

Bead: `tea-rags-mcp-cmm1o`. Downstream consumer: `tea-rags-mcp-xip6g` (prime
per-index highlight — separate bead).

## Problem

`.claude-plugin/tea-rags/rules/language-compatibility.md` is hand-maintained.
Per-language AST / tests / codegraph capability tiers drift from the code the
moment a chunker hook or resolver changes. We want ONE source of truth that
renders to both the agent-facing rule injection and a human-facing README
section, guarded against drift.

## Decisions (locked in brainstorming 2026-06-29)

1. **Descriptor placement** — colocated `src/core/domains/language/<lang>/capability.ts`
   (drift-resistant: edit the chunker/resolver → the capability sits in the same
   directory, visible in review). `LanguageFactory` aggregates them into a Map,
   parallel to `.supported()`. Lightweight: imports descriptors only, does NOT
   construct the runtime walker/resolver/chunker.
2. **Sync** — committed file (inject-rules `cat`s it) + pure-function generator
   + vitest drift-guard test (render === committed → CI red on drift) + regen
   script.
3. **Enforcement** — project rule `.claude/rules/language-capability-sync.md`,
   `paths: ["src/core/domains/language/**"]`, surfaces in agent context on any
   provider edit: "review `<lang>/capability.ts` tier → run regen".

## Architecture / data flow

```
src/core/domains/language/<lang>/capability.ts        colocated descriptor
   ↓  LanguageFactory.capabilities(): Map<lang, LanguageCapability>   (lightweight)
   ├─→ renderRule(map)   → .claude-plugin/tea-rags/rules/language-compatibility.md   (committed; inject-rules cat's)
   ├─→ renderReadme(map) → README "## Languages Compatibilities" <details> spoiler, between <!-- BEGIN/END lang-compat --> markers (committed)
   └─→ prime (xip6g)     → per-index highlight, filtered by polyglot set            (separate bead)
   ↑  drift-guard vitest: renderRule===rule.md AND renderReadme===README spoiler block
   ↑  enforcement rule: edit domains/language ⇒ update capability.ts + regen
```

## Components

1. **`LanguageCapability` type** — in `contracts/types/language.ts` beside
   `LanguageProvider`:

   ```ts
   type CodegraphTier = "maximum" | "high" | "moderate" | "minimal" | "none";
   interface TypingTieredCodegraph {        // Ruby: capability depends on annotation tier
     untyped: CodegraphTier;
     yard: CodegraphTier;
     "rbs/sorbet": CodegraphTier | "tbd";
   }
   interface LanguageCapability {
     language: string;
     ast:   { tier: "full" | "partial" | "none"; engine: string; hooks?: string[] };
     tests: { tier: "high" | "medium" | "low" | "na"; detection: string; tech: string };
     codegraph: { tier: CodegraphTier | TypingTieredCodegraph; tech: string };
     notes?: string;   // README prose extras
   }
   ```

2. **9 colocated `<lang>/capability.ts`** — each exports
   `const capability: LanguageCapability`. The fallback group (sql/jsonc/json —
   no provider) is a static `UNSUPPORTED_FALLBACK` constant in the generator,
   documenting absence (not a provider language).

3. **`LanguageFactory.capabilities(): Map<string, LanguageCapability>`** —
   aggregates descriptors via the same switch style as `.create()` / `.supported()`,
   importing only `capability.ts` (no runtime construction).

4. **Renderers** (`src/core/domains/language/capability/{rule,readme}.ts`, pure):
   - `renderRule(map)` → agent matrix + scales (current `language-compatibility.md`
     format).
   - `renderReadme(map)` → `## Languages Compatibilities` section with a
     `<details><summary>` spoiler containing the human table (technologies, levels,
     prose).
   - Codegraph MEASURED numbers (`resolveSuccessRate`) are NOT rendered — static
     capability ceiling only; measured numbers stay in prime.

5. **Regen script** — `scripts/gen-language-compatibility.ts` + `npm run gen:lang-compat`;
   writes both committed targets (rule file fully; README block between markers).

6. **Drift-guard test** (vitest) — `renderRule(capabilities()) === read(rule.md)`
   and `renderReadme(capabilities()) === README spoiler block`; mismatch → fail.

7. **Enforcement rule** — `.claude/rules/language-capability-sync.md`,
   `paths: ["src/core/domains/language/**"]`.

## Migration

The just-hand-written `language-compatibility.md` becomes the generator's OUTPUT:
port its content into descriptors + `renderRule` so `renderRule(capabilities())`
produces an equivalent file (validates the generator against the already-approved
matrix). The README spoiler is new content from `renderReadme`.

## Testing (TDD)

- presence: every `LanguageFactory.supported()` language has a `capability.ts`.
- `renderRule` / `renderReadme`: unit tests over a fixture Map.
- drift-guard: committed rule file + README block === rendered.
- regen script: idempotent (running twice is a no-op).

## Plugin / housekeeping

- `language-compatibility.md` already minor-bumped tea-rags plugin to 0.29.0;
  generator-driven content keeps the same path (inject-rules unchanged).
- README `<details>` is inline HTML (markdownlint MD033) — scope a local
  `<!-- markdownlint-disable MD033 -->` to the block, decided at impl.

## Out of scope (separate bead xip6g)

prime per-index highlight in `src/cli/prime/format.ts` — consumes the same
`LanguageFactory.capabilities()` Map, filtered to the index's polyglot set.
