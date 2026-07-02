---
paths:
  - "src/core/domains/language/**"
  - "src/core/domains/ingest/pipeline/chunker/**"
  - "src/core/domains/trajectory/codegraph/**"
  - "src/core/api/internal/**"
  - "src/core/contracts/types/language.ts"
---

# `domains/language` Architecture Rules (MANDATORY)

Learned expensive way in per-language consolidation (spec
`docs/superpowers/specs/2026-05-25-domains-language-consolidation-design.md`).
Apply up front.

## 1. A Factory encapsulates construction

`LanguageFactory.create(lang)` builds `LanguageProvider` itself — native switch
(`new RubyLanguage(mode)`, …) lives in ONE place, inside `create()`. MUST NOT
accept consumer-assembled pre-built registry/`Map` and merely look up — that's a
**container, not a factory**, forces consumer to do factory's job (assemble
providers, import concretes). Legacy languages supplied as deferred builder
thunks (`() => LanguageProvider`) injected by composition layer
(`api/internal/`, only layer allowed to bridge `ingest` + `trajectory` +
`language`); factory invokes thunk lazily, caches result per language.

## 2. worker_threads DI = inject a module PATH, not an instance

Class instance can't cross `postMessage` (structured-clone drops methods +
native handles). So:

- Composition root injects **serializable module-path string** via `workerData`
  / `ChunkerConfig` (e.g. `languageModulePath`).
- Worker does `await import(path)` **in-thread**, constructs factory/providers
  there (mirrors how chunker always built tree-sitter `Parser`s in-thread).
- Dynamic `import(variable)` invisible to `no-restricted-imports`, so worker
  entry stays in **home domain** (`ingest`) with ZERO static cross-domain import
  and **NO guard exemption**.

NEVER relocate a domain's worker entry into `api/` (or anywhere) just to "reach"
concretes — worker meaningless outside home domain. NEVER add guard exemption to
let `ingest`/`trajectory` statically import `domains/language`.

## 3. Language-migration test rule

Relocating per-language code into `domains/language/<lang>/`:

- Adapting a test's **imports and setup** for new location = allowed.
- The **examples** — `describe`/`it` cases, assertions, fixtures (corner cases)
  — MUST be preserved.
- **Validate**: count `it` / `test` / `describe` per language-processing test
  file vs base branch; branch count must be `>=` base, NOTHING dropped. Losing a
  corner case = hard failure.
- Tests of **new entities** (factory, composer, kernel, adapter) may be
  rewritten/deleted freely to match real design.

See also `.claude/rules/test-patterns.md`, `.claude/rules/codegraph-walkers.md`,
`.claude/rules/symbolid-convention.md`, `.claude/rules/domain-boundaries.md`.
