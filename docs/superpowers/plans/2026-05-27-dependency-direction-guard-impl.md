# Dependency Direction Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the full layer dependency-direction matrix across `src/` with
an eslint guard, after clearing every current cross-layer violation.

**Architecture:** Extend the existing `@typescript-eslint/no-restricted-imports`
pattern in `eslint.config.js` — one deny-list block per layer `files` scope.
`cli`/`mcp` reach `core` only through `api/public`; `api/public` is widened into
the single re-export facade for all consumer-facing symbols. Violations are
fixed FIRST (re-export redirects, type relocations, two import cuts); the guard
is enabled LAST so CI is green at every commit.

**Tech Stack:** TypeScript, ESLint (flat config, `typescript-eslint`), Vitest.

**Spec:**
`docs/superpowers/specs/2026-05-27-dependency-direction-guard-design.md`
**Epic:** `tea-rags-mcp-3u5s` (P0). **Blocker:** `tea-rags-mcp-gww8` (Streaming
File Enrichment) gates Task 7.

---

## File Structure

| File                                                   | Responsibility                                                           | Change                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| `src/core/contracts/types/enrichment.ts`               | `EnrichmentHealthMap` (relocated)                                        | Create                                               |
| `src/core/contracts/types/ingest-config.ts`            | `IngestCodeConfig` etc. (from `core/types.ts`)                           | Create                                               |
| `src/core/types.ts`                                    | (root, layer-ambiguous)                                                  | Delete after relocation                              |
| `src/core/domains/ingest/pipeline/enrichment/types.ts` | enrichment runtime types                                                 | Drop `EnrichmentHealthMap`, re-import from contracts |
| `src/core/api/errors.ts`                               | `InputValidationError` hierarchy + (relocated) `ConfigValueInvalidError` | Modify                                               |
| `src/bootstrap/errors.ts`                              | bootstrap config errors                                                  | Drop `ConfigValueInvalidError`                       |
| `src/core/api/public/index.ts`                         | single public facade for cli/mcp                                         | Widen re-exports                                     |
| `src/mcp/**`                                           | tool surface                                                             | Redirect all core imports → `api/public`             |
| `src/cli/**`                                           | entry layer                                                              | Redirect imports → `api/public` + bootstrap factory  |
| `src/core/domains/explore/**`                          | explore domain                                                           | Cut import of `trajectory`                           |
| `src/core/domains/trajectory/codegraph/provider.ts`    | codegraph provider                                                       | Cut import of ingest walker (Task 7)                 |
| `.claude/rules/domain-boundaries.md`                   | doc                                                                      | Align to matrix                                      |
| `eslint.config.js`                                     | guard                                                                    | Add full matrix (Task 9)                             |

Verification commands used throughout:

- Build: `npm run build` (tsc) — expected: exit 0.
- Tests: `npx vitest run` — expected: all pass, no rewrites.
- Lint: `npm run lint` — expected: 0 errors.

---

## Task 1: Relocate shared consumer-facing types into `contracts/`

`core/types.ts` (root) is layer-ambiguous and `EnrichmentHealthMap` lives in a
domain; both are consumed by `mcp`. Relocate to `contracts/` (pure) so the
internal home is layer-correct; `api/public` re-exports them in Task 3.
`IngestCodeConfig` references `EnrichmentHealthMap`, so the latter moves first.

**Files:**

- Create: `src/core/contracts/types/enrichment.ts`
- Create: `src/core/contracts/types/ingest-config.ts`
- Modify: `src/core/domains/ingest/pipeline/enrichment/types.ts`
- Modify: `src/core/contracts/index.ts` (barrel)
- Delete: `src/core/types.ts`

- [ ] **Step 1: Move `EnrichmentHealthMap` definition verbatim**

Cut the `EnrichmentHealthMap` type (and any types it transitively needs that are
not already in contracts) from
`src/core/domains/ingest/pipeline/enrichment/types.ts` into the new
`src/core/contracts/types/enrichment.ts`. In the original file, replace the
definition with a re-import:

```typescript
import type { EnrichmentHealthMap } from "../../../../contracts/types/enrichment.js";

export type { EnrichmentHealthMap };
```

- [ ] **Step 2: Move `core/types.ts` content into contracts**

Move the body of `src/core/types.ts` (`IngestCodeConfig` and siblings) into
`src/core/contracts/types/ingest-config.ts`, changing its `EnrichmentHealthMap`
import to `from "./enrichment.js"`. Delete `src/core/types.ts`.

- [ ] **Step 3: Update internal importers**

Find every importer of the old paths and repoint them to contracts:

Run: `git grep -l 'core/types\|enrichment/types.*EnrichmentHealthMap' src/` For
each hit, change the import source to `core/contracts/types/ingest-config.js` /
`.../enrichment.js`. Add both types to `src/core/contracts/index.ts` barrel.

- [ ] **Step 4: Verify build + tests**

Run: `npm run build && npx vitest run` Expected: exit 0; no test changes
(relocation only, per test-patterns.md).

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts src/core/domains/ingest/pipeline/enrichment/types.ts
git rm src/core/types.ts
git commit -m "refactor(contracts): relocate EnrichmentHealthMap + IngestCodeConfig into contracts"
```

---

## Task 2: Relocate `ConfigValueInvalidError` out of `bootstrap`

`mcp` imports `ConfigValueInvalidError` from `bootstrap/errors.js` — an upward
edge. Move the class into the api error layer (`api/errors.ts`, which already
extends `TeaRagsError`) so consumers reach it via `api/public` (Task 3).

**Files:**

- Modify: `src/core/api/errors.ts` (add the class)
- Modify: `src/bootstrap/errors.ts` (remove it; re-import if bootstrap still
  uses it)

- [ ] **Step 1: Move the class verbatim**

Cut the `ConfigValueInvalidError` class from `src/bootstrap/errors.ts` into
`src/core/api/errors.ts`, preserving its body and base class. If `bootstrap`
still throws it, add
`import { ConfigValueInvalidError } from "../core/api/errors.js";` in bootstrap
(bootstrap → core/api is allowed).

- [ ] **Step 2: Update importers**

Run: `git grep -l 'ConfigValueInvalidError' src/` Repoint every import to
`core/api/errors.js` (or `api/public` once Task 3 lands).

- [ ] **Step 3: Verify + commit**

Run: `npm run build && npx vitest run` → exit 0.

```bash
git add src/core/api/errors.ts src/bootstrap/errors.ts
git commit -m "refactor(api): move ConfigValueInvalidError from bootstrap into api errors"
```

---

## Task 3: Widen `api/public` into the single consumer facade

`api/public/index.ts` must re-export everything `cli`/`mcp` consume so they
never reach below it. `api/public` is part of `api/`, which may import domains,
contracts, adapters, infra — so all re-exports are legal here.

**Files:**

- Modify: `src/core/api/public/index.ts`

- [ ] **Step 1: Add runtime + type re-exports**

Append to `src/core/api/public/index.ts`:

```typescript
// ── Error classes (runtime) — consumers throw/catch typed errors ──
export {
  InputValidationError,
  CollectionNotProvidedError,
  MissingArgumentError,
  InvalidParameterError,
  ProjectNotRegisteredError,
  ProjectNameNotUniqueError,
  ProjectNameInvalidError,
  PathDoesNotExistError,
  ProjectPathMissingError,
  ConfigValueInvalidError,
} from "../errors.js";
export { TeaRagsError, UnknownError } from "../../infra/errors.js";

// ── Registry + collection-name (runtime) ──
export { CollectionRegistry } from "../../infra/registry/index.js";
export { resolveCollectionName } from "../../infra/collection-name.js";
export { PROJECT_NAME_RE } from "../../infra/registry/index.js";

// ── Relocated shared types ──
export type { EnrichmentHealthMap } from "../../contracts/types/enrichment.js";
export type { IngestCodeConfig } from "../../contracts/types/ingest-config.js";
export type {
  CollectionEntry,
  ProjectInfo,
} from "../../infra/registry/index.js";

// ── Adapter-owned type consumed by cli (interface stays in adapters) ──
export type { EmbeddingProvider } from "../../adapters/embeddings/base.js";

// ── Payload signal descriptor (consumed by mcp schema code) ──
export type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";
```

> The exact export list is reconciled against the real violation set in Tasks 4
> and 5 — add any symbol those tasks find missing, remove any not actually
> consumed. The `ProjectRegistryOps` facade is added in Step 2.

- [ ] **Step 2: Expose a `ProjectRegistryOps` accessor for cli**

`cli` uses `ProjectRegistryOps` (currently from `api/internal`). Expose it
through the public surface without leaking `api/internal`: re-export the class
from `api/public` (the class itself is fine to expose; only the `internal/`
_path_ is forbidden to consumers):

```typescript
export { ProjectRegistryOps } from "../internal/ops/project-registry-ops.js";
```

- [ ] **Step 3: Verify build**

Run: `npm run build` Expected: exit 0 (re-exports resolve; no circular-import
error introduced).

- [ ] **Step 4: Commit**

```bash
git add src/core/api/public/index.ts
git commit -m "feat(api): widen api/public into the single consumer facade"
```

---

## Task 4: Redirect all `mcp/**` imports to `api/public`

After Task 3, every core symbol `mcp` needs is on `api/public`. Repoint imports;
`mcp` must end up importing ONLY from `core/api/public`.

**Files:**

- Modify: `src/mcp/**/*.ts` (per the violation inventory)

- [ ] **Step 1: Repoint the barrel + errors imports**

Replace import sources in `src/mcp/`:

- `../../core/api/index.js` → `../../core/api/public/index.js`
- `../../core/api/errors.js` → `../../core/api/public/index.js`
- `../../core/infra/errors.js` (TeaRagsError, UnknownError) →
  `../../core/api/public/index.js`
- `../../core/infra/registry/index.js` (PROJECT_NAME_RE) →
  `../../core/api/public/index.js`
- `../../core/contracts/types/trajectory.js` (PayloadSignalDescriptor) →
  `../../core/api/public/index.js`
- `../../core/domains/ingest/.../enrichment/types.js` (EnrichmentHealthMap) →
  `../../core/api/public/index.js`
- `../../bootstrap/errors.js` (ConfigValueInvalidError) →
  `../../core/api/public/index.js`

(adjust `../` depth per file location)

- [ ] **Step 2: Verify zero non-public core imports remain**

Run:

```bash
git grep -hn 'from "[^"]*\(core/\|bootstrap/\)' src/mcp/ | grep -vE 'core/api/public'
```

Expected: NO output. (Any line = a still-forbidden import to fix.)

- [ ] **Step 3: Verify build + tests**

Run: `npm run build && npx vitest run` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/mcp
git commit -m "refactor(mcp): import core only via api/public"
```

---

## Task 5: Redirect all `cli/**` imports

`cli` may import `bootstrap` and `api/public` only. Runtime registry/collection
helpers → `api/public`. `QdrantManager` construction → obtain from the bootstrap
factory instead of constructing in cli.

**Files:**

- Modify: `src/cli/**/*.ts`

- [ ] **Step 1: Repoint api/infra imports to api/public**

Replace in `src/cli/`:

- `../../core/infra/registry/...` (CollectionRegistry, PROJECT_NAME_RE,
  CollectionEntry) → `../../core/api/public/index.js`
- `../../core/infra/collection-name.js` (resolveCollectionName) →
  `../../core/api/public/index.js`
- `../../core/api/errors.js` → `../../core/api/public/index.js`
- `../../core/api/internal/ops/project-registry-ops.js` (ProjectRegistryOps) →
  `../../core/api/public/index.js`
- `../../core/adapters/embeddings/base.js` (EmbeddingProvider type) →
  `../../core/api/public/index.js`

- [ ] **Step 2: Move `QdrantManager` construction to the bootstrap factory**

`cli` imports `QdrantManager` from `core/adapters/qdrant/client.js` and
constructs it. Add a factory accessor in `src/bootstrap/factory.ts` that returns
a ready `QdrantManager` (bootstrap → adapters is allowed), and have the cli
command consume that instead of importing the adapter directly. Remove the
`core/adapters/qdrant/client.js` import from cli.

- [ ] **Step 3: Verify zero forbidden imports remain**

Run:

```bash
git grep -hn 'from "[^"]*core/' src/cli/ | grep -vE 'core/api/public'
```

Expected: NO output.

- [ ] **Step 4: Verify build + tests**

Run: `npm run build && npx vitest run` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/cli src/bootstrap/factory.ts
git commit -m "refactor(cli): import core only via api/public + bootstrap factory"
```

---

## Task 6: Cut `explore → trajectory` import

`domains/explore` has one import of `domains/trajectory` — domains must not
import each other; explore receives trajectory data via DI (constructor params).

**Files:**

- Modify: the single explore file importing trajectory (find in Step 1)

- [ ] **Step 1: Locate the import**

Run: `git grep -n 'domains/trajectory' src/core/domains/explore/` Expected: one
hit.

- [ ] **Step 2: Replace with a contracts type or DI param**

If the import is a TYPE, move/point it to `contracts/` (explore → contracts is
allowed). If it is a RUNTIME value, inject it through the explore module's
constructor at the composition root (`api/internal/composition.ts`) instead of
importing it.

- [ ] **Step 3: Verify**

Run: `git grep -n 'domains/trajectory' src/core/domains/explore/` → no output.
Run: `npm run build && npx vitest run` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/core/domains/explore src/core/api/internal/composition.ts
git commit -m "refactor(explore): receive trajectory data via DI, drop direct import"
```

---

## Task 7: Cut `trajectory → ingest` (codegraph provider → ingest walker)

> **BLOCKED by `tea-rags-mcp-gww8` (Streaming File Enrichment).** The
> `codegraph/provider.ts → ingest/.../*-walker.js` import is entangled with the
> streaming-enrichment refactor; do not start this task until gww8 lands the
> walker boundary. This is the precondition flagged on `tea-rags-mcp-qbod`.

**Files:**

- Modify: `src/core/domains/trajectory/codegraph/provider.ts`

- [ ] **Step 1: Locate the import**

Run:
`git grep -n 'ingest/.*walker\|domains/ingest' src/core/domains/trajectory/`
Expected: the codegraph/provider hit.

- [ ] **Step 2: Break the dependency**

Move the shared walker contract/type into `contracts/` (trajectory → contracts
allowed), or have ingest inject the walker capability into the codegraph
provider via DI through the enrichment registry. The post-gww8 streaming
boundary determines which; follow the gww8 outcome.

- [ ] **Step 3: Verify**

Run: `git grep -n 'domains/ingest' src/core/domains/trajectory/` → no output.
Run: `npm run build && npx vitest run` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/core/domains/trajectory/codegraph
git commit -m "refactor(trajectory): break codegraph→ingest walker import (post-streaming)"
```

---

## Task 8: Align `domain-boundaries.md` to the matrix

**Files:**

- Modify: `.claude/rules/domain-boundaries.md`

- [ ] **Step 1: Fix the core table**

- `core/domains/explore/` "Imports from" cell: `contracts/`, **`adapters/`**,
  `infra/` (add adapters — explore legitimately uses Qdrant types).
- `core/contracts/` "Imports from" cell: **nothing** (pure; was `infra/`).

- [ ] **Step 2: Add outer-layer rows**

Add to the dependency table:

```
| `cli/`        | `bootstrap/`, `core/api/public/`            | (process entry)      |
| `mcp/`        | `core/api/public/`                          | tool surface         |
| `bootstrap/`  | `mcp/`, `core/api/`, contracts/adapters/infra | composition root   |
| `index.ts`    | `bootstrap/`                                | process bootstrap    |
```

- [ ] **Step 3: Add the consumer-surface rule**

Add a paragraph: `cli`/`mcp` reach `core` ONLY through `core/api/public` (not
`api/internal`, not `contracts`/`adapters`/`infra` directly); `api/public` is
the curated re-export facade; forbidden edges apply to `import type` too.

- [ ] **Step 4: Commit**

```bash
git add .claude/rules/domain-boundaries.md
git commit -m "docs(architecture): align domain-boundaries.md with full layer matrix"
```

---

## Task 9: Enable the full dependency guard (`tea-rags-mcp-qbod`)

All violations cleared → add the per-layer deny-list blocks. This is the **core
task of the epic** and runs LAST.

**Files:**

- Modify: `eslint.config.js` (replace the two language blocks with the full set)
- Test: `tests/eslint-guard.fixture.test.ts` (negative fixture)

- [ ] **Step 1: Replace the two language blocks with the full matrix**

In `eslint.config.js`, replace the "Leaf-domain guard" + "Reverse guard" blocks
with the block set below (the language directionality is folded into the domain
blocks). Each block: a `files` scope + forbidden `group` globs + a `message`.

```javascript
// ── Dependency direction guard — full layer matrix ──
// Spec: docs/superpowers/specs/2026-05-27-dependency-direction-guard-design.md
// Allowed targets per layer (everything else is an error, incl. `import type`):
//   cli       → bootstrap, core/api/public
//   mcp       → core/api/public
//   bootstrap → mcp, core/api/*, core/{contracts,adapters,infra}
//   index.ts  → bootstrap
//   api       → core/{domains,contracts,adapters,infra}
//   domains/* → core/{contracts,adapters,infra}  (never each other)
//   contracts → (nothing)   adapters → infra   infra → (nothing)
{
  files: ["src/cli/**/*.ts"],
  rules: {
    "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{
      group: [
        "**/core/domains/**", "**/core/contracts/**", "**/core/adapters/**",
        "**/core/infra/**", "**/core/api/internal/**",
        "**/core/api/errors", "**/core/api/errors.js",
        "**/core/api/index", "**/core/api/index.js", "**/mcp/**",
      ],
      message: "cli may import only bootstrap/ and core/api/public. See domain-boundaries.md.",
    }]}],
  },
},
{
  files: ["src/mcp/**/*.ts"],
  rules: {
    "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{
      group: [
        "**/core/domains/**", "**/core/contracts/**", "**/core/adapters/**",
        "**/core/infra/**", "**/core/api/internal/**",
        "**/core/api/errors", "**/core/api/errors.js",
        "**/core/api/index", "**/core/api/index.js",
        "**/bootstrap/**", "**/cli/**",
      ],
      message: "mcp may import only core/api/public. See domain-boundaries.md.",
    }]}],
  },
},
{
  files: ["src/bootstrap/**/*.ts"],
  rules: {
    "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{
      group: ["**/cli/**"],
      message: "bootstrap is the composition root; it must not import the cli command layer.",
    }]}],
  },
},
{
  files: ["src/index.ts"],
  rules: {
    "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{
      group: ["**/core/**", "**/mcp/**", "**/cli/**"],
      message: "src/index.ts may import only bootstrap/.",
    }]}],
  },
},
{
  files: ["src/core/api/**/*.ts"],
  rules: {
    "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{
      group: ["**/mcp/**", "**/cli/**", "**/bootstrap/**"],
      message: "api/ is the core composition root; it must not import outer layers.",
    }]}],
  },
},
{
  files: ["src/core/domains/explore/**/*.ts"],
  rules: {
    "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{
      group: [
        "**/domains/trajectory/**", "**/domains/ingest/**", "**/domains/language/**",
        "**/core/api/**", "**/bootstrap/**", "**/mcp/**", "**/cli/**",
      ],
      message: "explore may import only core/{contracts,adapters,infra}; domains are mutually isolated.",
    }]}],
  },
},
{
  files: ["src/core/domains/trajectory/**/*.ts"],
  rules: {
    "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{
      group: [
        "**/domains/explore/**", "**/domains/ingest/**", "**/domains/language/**",
        "**/language/index.js",
        "**/core/api/**", "**/bootstrap/**", "**/mcp/**", "**/cli/**",
      ],
      message: "trajectory may import only core/{contracts,adapters,infra}; reach language via injected LanguageFactory.",
    }]}],
  },
},
{
  files: ["src/core/domains/ingest/**/*.ts"],
  rules: {
    "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{
      group: [
        "**/domains/explore/**", "**/domains/trajectory/**", "**/domains/language/**",
        "**/language/index.js",
        "**/core/api/**", "**/bootstrap/**", "**/mcp/**", "**/cli/**",
      ],
      message: "ingest may import only core/{contracts,adapters,infra}; reach language via injected LanguageFactory.",
    }]}],
  },
},
{
  files: ["src/core/domains/language/**/*.ts"],
  rules: {
    "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{
      group: ["**/ingest/**", "**/trajectory/**", "**/explore/**", "**/core/api/**", "**/bootstrap/**"],
      message: "domains/language is a leaf domain — import only contracts/, infra/, tree-sitter.",
    }]}],
  },
},
{
  files: ["src/core/contracts/**/*.ts"],
  rules: {
    "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{
      group: [
        "**/core/infra/**", "**/core/adapters/**", "**/core/domains/**",
        "**/core/api/**", "**/bootstrap/**", "**/mcp/**", "**/cli/**",
      ],
      message: "contracts is pure — no imports from any core/ layer.",
    }]}],
  },
},
{
  files: ["src/core/adapters/**/*.ts"],
  rules: {
    "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{
      group: [
        "**/core/contracts/**", "**/core/domains/**", "**/core/api/**",
        "**/bootstrap/**", "**/mcp/**", "**/cli/**",
      ],
      message: "adapters may import only core/infra.",
    }]}],
  },
},
{
  files: ["src/core/infra/**/*.ts"],
  rules: {
    "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{
      group: [
        "**/core/contracts/**", "**/core/adapters/**", "**/core/domains/**",
        "**/core/api/**", "**/bootstrap/**", "**/mcp/**", "**/cli/**",
      ],
      message: "infra is the lowest layer — no imports from any core/ layer.",
    }]}],
  },
},
```

- [ ] **Step 2: Run lint to verify the tree is green**

Run: `npm run lint` Expected: 0 errors. (Any error = an un-fixed violation from
Tasks 1–7; fix it, do not weaken the guard — see
`.claude/rules/linter-config.md`.)

- [ ] **Step 3: Write a negative fixture test**

Create `tests/eslint-guard.fixture.test.ts` that lints an in-memory snippet with
a deliberately-wrong import (e.g. an `mcp` file importing
`../../core/adapters/qdrant/client.js`) via the ESLint Node API and asserts the
`no-restricted-imports` error fires. Mirrors how the language guard is trusted.

```typescript
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

describe("dependency direction guard", () => {
  it("flags mcp importing core/adapters directly", async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(
      'import { QdrantManager } from "../../core/adapters/qdrant/client.js";\n',
      { filePath: "src/mcp/tools/fixture.ts" },
    );
    const ids = result.messages.map((m) => m.ruleId);
    expect(ids).toContain("@typescript-eslint/no-restricted-imports");
  });
});
```

- [ ] **Step 4: Run the fixture test**

Run: `npx vitest run tests/eslint-guard.fixture.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.js tests/eslint-guard.fixture.test.ts
git commit -m "feat(config): enforce full dependency-direction matrix in eslint guard"
```

---

## Self-Review notes

- **Spec coverage:** matrix → Task 9; strict-no-type-escape → Task 9 (deny-list
  applies to all imports); fix-dispatch → Tasks 1–5; explore→trajectory → Task
  6; trajectory→ingest → Task 7 (blocked); doc updates → Task 8. All spec
  sections mapped.
- **Ordering invariant:** guard (Task 9) only after Tasks 1–8 are green; Task 7
  is gated on gww8 — if gww8 is not yet done, Tasks 1–6, 8 still land and Task 9
  enables all blocks EXCEPT the `ingest`/`trajectory` mutual-isolation pair,
  which is added in a follow-up commit once Task 7 lands. (Split Task 9 if gww8
  lags: 9a = all blocks except ingest↔trajectory; 9b = the remaining pair.)
- **Type-relocation constraint:** only domain/root types move to `contracts`;
  adapter/infra-owned types (`EmbeddingProvider`, `CollectionEntry`,
  `PROJECT_NAME_RE`) stay put and are re-exported via `api/public` — `adapters`
  and `infra` may not import `contracts`. </content>
