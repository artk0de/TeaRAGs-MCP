---
paths:
  - "src/core/domains/language/**"
  - "src/core/domains/ingest/pipeline/chunker/**"
  - "src/core/domains/trajectory/codegraph/**"
  - "src/core/api/internal/**"
  - "src/core/contracts/types/language.ts"
---

# `domains/language` Architecture Rules (MANDATORY)

Hard-won during the per-language consolidation (spec
`docs/superpowers/specs/2026-05-25-domains-language-consolidation-design.md`).
Apply up front — these were learned the expensive way.

## 1. A Factory encapsulates construction

`LanguageFactory.create(lang)` builds the `LanguageProvider` itself — the native
switch (`new RubyLanguage(mode)`, …) lives in ONE place, inside `create()`. It
MUST NOT accept a consumer-assembled, pre-built registry/`Map` of providers and
merely look one up — that is a **container, not a factory**, and it forces the
consumer to do the factory's job (assemble providers, import concretes). Legacy
languages are supplied as deferred builder thunks (`() => LanguageProvider`)
injected by the composition layer (`api/internal/`, the only layer allowed to
bridge `ingest` + `trajectory` + `language`); the factory invokes the thunk
lazily and caches the result per language.

## 2. worker_threads DI = inject a module PATH, not an instance

A class instance cannot cross `postMessage` (structured-clone drops methods and
native handles). So:

- The composition root injects a **serializable module-path string** via
  `workerData` / `ChunkerConfig` (e.g. `languageModulePath`).
- The worker does `await import(path)` **in-thread** and constructs the factory
  / providers there (mirrors how the chunker always built tree-sitter `Parser`s
  in-thread).
- A dynamic `import(variable)` is invisible to `no-restricted-imports`, so the
  worker entry stays in its **home domain** (`ingest`) with ZERO static
  cross-domain import and **NO guard exemption**.

NEVER relocate a domain's worker entry into `api/` (or anywhere) just to "reach"
concretes — the worker is meaningless outside its home domain. NEVER add a guard
exemption to let `ingest`/`trajectory` statically import `domains/language`.

## 3. Language-migration test rule

When relocating per-language code into `domains/language/<lang>/`:

- Adapting a test's **imports and setup** for the new location is allowed.
- The **examples** — `describe`/`it` cases, their assertions, and fixtures (the
  corner cases) — MUST be preserved.
- **Validate**: count `it` / `test` / `describe` per language-processing test
  file vs the base branch; the branch count must be `>=` base, with NOTHING
  dropped. Losing a corner case is a hard failure.
- Tests of **new entities** (factory, composer, kernel, adapter) may be
  rewritten/deleted freely to match the real design.

See also `.claude/rules/test-patterns.md`,
`.claude/rules/codegraph-walkers.md`, `.claude/rules/symbolid-convention.md`,
`.claude/rules/domain-boundaries.md`.
