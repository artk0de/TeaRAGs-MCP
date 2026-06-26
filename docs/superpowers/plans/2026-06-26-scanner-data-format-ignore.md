# Scanner Default-Ignore for Data Formats — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Per the dinopowers chaining rule, when
> execution would invoke `superpowers:executing-plans` /
> `superpowers:test-driven-development`, invoke `dinopowers:executing-plans` /
> `dinopowers:test-driven-development` instead.

**Goal:** Stop indexing json/yaml data files (fixtures, VCR cassettes,
CI/config) in the code RAG by default, while keeping signal-bearing JSON
manifests.

**Architecture:** Append a "data / serialization formats" block to the scanner's
`BUILTIN_IGNORE_PATTERNS` (a flat `string[]` consumed by `FileScanner`): ignore
`*.json`/`*.yaml`/`*.yml`, then re-include JSON manifests via `!` negations. No
scanner logic change — only the data the existing `ignore()` instance consumes.
Validated against the real `ignore` package: negations keep manifests, directory
traversal is not blocked (distinguishes this blacklist-with-exceptions form from
the kgjzq whitelist-`*` bug).

**Tech Stack:** TypeScript, the `ignore` npm package (gitignore semantics,
last-match-wins), vitest.

**Bead:** `tea-rags-mcp-dygln`. **Spec:**
`docs/superpowers/specs/2026-06-26-scanner-data-format-ignore-design.md`.

## Global Constraints

- **Layer:** production change is confined to
  `src/core/domains/ingest/pipeline/ignore-defaults.ts` (a data leaf imported
  only by `scanner.ts`). Do NOT modify `scanner.ts` logic.
- **Out of scope (separate beads, do NOT touch):** `tea-rags-mcp-kgjzq`
  (whitelist-`*` directory-descent bug), `tea-rags-mcp-0wwb6` (quarantine for
  broken supported source).
- **Test rule** (`.claude/rules/test-patterns.md`): ADD new `it()` cases; do NOT
  rewrite the existing passing tests. High-level scanner-behavior tests via the
  real `FileScanner` + `ignore` package.
- **Test config must list `.json`/`.yaml`/`.yml` in `supportedExtensions`**
  (mirrors production `DEFAULT_CODE_EXTENSIONS` in
  `bootstrap/config/defaults.ts:42-44`). Otherwise the extension filter excludes
  them and IGNORE-assertions pass trivially, testing nothing.
- **Allowlist is JSON-only.** YAML is fully ignored (no negations) per design
  decision.
- **Commit convention** (`.claude/rules/commit-rules.md`): `improve(ingest)`
  with a `BREAKING CHANGE:` footer (the default indexing surface shrinks →
  requires user action to opt back in).

## File Structure

| File                                                  | Responsibility                                        | Change                                                                           |
| ----------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/core/domains/ingest/pipeline/ignore-defaults.ts` | `BUILTIN_IGNORE_PATTERNS` data array + its header doc | append data-format block + allowlist; extend header comment                      |
| `tests/core/domains/ingest/pipeline/scanner.test.ts`  | `FileScanner` behavior suite                          | add 3 `it()` cases under existing `describe("BUILTIN_IGNORE_PATTERNS baseline")` |
| `docs/CODE_VECTORIZATION.md`                          | user-facing indexing/ignore doc                       | add a short json/yaml default-ignore + override subsection                       |

---

### Task 1: TDD — default-ignore json/yaml with JSON manifest allowlist

**Files:**

- Modify: `src/core/domains/ingest/pipeline/ignore-defaults.ts` (append to
  `BUILTIN_IGNORE_PATTERNS`, before the closing `];`; extend header comment)
- Test: `tests/core/domains/ingest/pipeline/scanner.test.ts` (add 3 `it()` cases
  inside the existing `describe("BUILTIN_IGNORE_PATTERNS baseline")` block,
  after the "accepts user patterns that duplicate the baseline" test at line
  ~213)

**Interfaces:**

- Consumes: `FileScanner`
  (`new FileScanner({ supportedExtensions, ignorePatterns })`,
  `await loadIgnorePatterns(dir)`, `await scanDirectory(dir)`) — already
  imported in the test file.
- Produces: nothing new — `BUILTIN_IGNORE_PATTERNS` keeps its `string[]` shape
  and export name.

- [ ] **Step 1: Write the failing tests**

Insert these three `it()` cases at the end of
`describe("BUILTIN_IGNORE_PATTERNS baseline")` (immediately before its closing
`});` at line ~214). The imports `mkdirSync, mkdtempSync, writeFileSync`,
`tmpdir`, `join` are already present at the top of the file.

```ts
// Data formats (json/yaml) are not code — VCR cassettes / fixtures / config
// blobs pollute a code index (octokit full-index: 714 json -> 2x chunks +
// volume crash). Default-ignore them, but keep signal-bearing JSON manifests.
it("default-ignores json/yaml data while keeping JSON manifests and descending data dirs", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "scanner-dataformat-"));
  // signal-bearing manifests — must be KEPT via allowlist negations
  writeFileSync(join(tmpDir, "package.json"), "{}");
  writeFileSync(join(tmpDir, "tsconfig.json"), "{}");
  writeFileSync(join(tmpDir, "tsconfig.build.json"), "{}");
  writeFileSync(join(tmpDir, "vitest.config.json"), "{}");
  writeFileSync(join(tmpDir, "composer.json"), "{}");
  writeFileSync(join(tmpDir, "deno.json"), "{}");
  // nested manifest — negation must match at any depth
  mkdirSync(join(tmpDir, "packages", "foo"), { recursive: true });
  writeFileSync(join(tmpDir, "packages", "foo", "package.json"), "{}");
  // data / fixtures / config — must be IGNORED
  mkdirSync(join(tmpDir, "spec", "cassettes"), { recursive: true });
  writeFileSync(join(tmpDir, "spec", "cassettes", "x.json"), "{}");
  writeFileSync(join(tmpDir, "fixtures.json"), "{}");
  writeFileSync(join(tmpDir, "config.yml"), "a: 1");
  writeFileSync(join(tmpDir, "settings.yaml"), "a: 1");
  // a source file INSIDE the data dir — proves traversal is NOT blocked
  writeFileSync(
    join(tmpDir, "spec", "cassettes", "helper.ts"),
    "export const h = 1;",
  );
  // a plain source file at root — must survive
  writeFileSync(join(tmpDir, "main.ts"), "export const main = 1;");

  const localScanner = new FileScanner({
    supportedExtensions: [".ts", ".json", ".yaml", ".yml"],
    ignorePatterns: [],
  });
  await localScanner.loadIgnorePatterns(tmpDir);
  const files = await localScanner.scanDirectory(tmpDir);

  // manifests kept
  expect(files.some((f) => f.endsWith("package.json"))).toBe(true);
  expect(files.some((f) => f.endsWith("tsconfig.json"))).toBe(true);
  expect(files.some((f) => f.endsWith("tsconfig.build.json"))).toBe(true);
  expect(files.some((f) => f.endsWith("vitest.config.json"))).toBe(true);
  expect(files.some((f) => f.endsWith("composer.json"))).toBe(true);
  expect(files.some((f) => f.endsWith("deno.json"))).toBe(true);
  expect(files.some((f) => f.includes("packages/foo/package.json"))).toBe(true);
  // source kept (root + inside an all-data dir → traversal not blocked)
  expect(files.some((f) => f.endsWith("main.ts"))).toBe(true);
  expect(files.some((f) => f.endsWith("helper.ts"))).toBe(true);
  // data ignored
  expect(files.some((f) => f.endsWith("x.json"))).toBe(false);
  expect(files.some((f) => f.endsWith("fixtures.json"))).toBe(false);
  expect(files.some((f) => f.endsWith("config.yml"))).toBe(false);
  expect(files.some((f) => f.endsWith("settings.yaml"))).toBe(false);
});

// Escape hatch: a project that genuinely wants its yaml/json indexed (or
// wants a manifest dropped) overrides via .contextignore — later add wins.
it("lets .contextignore re-include yaml and drop a manifest", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "scanner-dataoverride-"));
  writeFileSync(join(tmpDir, "openapi.yaml"), "a: 1");
  writeFileSync(join(tmpDir, "package.json"), "{}");
  writeFileSync(join(tmpDir, "main.ts"), "export const main = 1;");
  // user re-includes openapi.yaml AND drops the package.json manifest
  writeFileSync(
    join(tmpDir, ".contextignore"),
    "!openapi.yaml\npackage.json\n",
  );

  const localScanner = new FileScanner({
    supportedExtensions: [".ts", ".json", ".yaml"],
    ignorePatterns: [],
  });
  await localScanner.loadIgnorePatterns(tmpDir);
  const files = await localScanner.scanDirectory(tmpDir);

  expect(files.some((f) => f.endsWith("main.ts"))).toBe(true);
  expect(files.some((f) => f.endsWith("openapi.yaml"))).toBe(true); // re-included
  expect(files.some((f) => f.endsWith("package.json"))).toBe(false); // dropped
});

// YAML has NO manifest allowlist — every yaml/yml is ignored by default.
it("ignores yaml manifests too (no yaml allowlist)", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "scanner-yaml-"));
  writeFileSync(join(tmpDir, "docker-compose.yml"), "a: 1");
  writeFileSync(join(tmpDir, "config.yaml"), "a: 1");
  writeFileSync(join(tmpDir, "main.ts"), "export const main = 1;");

  const localScanner = new FileScanner({
    supportedExtensions: [".ts", ".yaml", ".yml"],
    ignorePatterns: [],
  });
  await localScanner.loadIgnorePatterns(tmpDir);
  const files = await localScanner.scanDirectory(tmpDir);

  expect(files.some((f) => f.endsWith("main.ts"))).toBe(true);
  expect(files.some((f) => f.endsWith("docker-compose.yml"))).toBe(false);
  expect(files.some((f) => f.endsWith("config.yaml"))).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they FAIL**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/scanner.test.ts -t "default-ignores json/yaml"`
Expected: FAIL — `package.json`/`tsconfig.json` etc. ARE found, and
`x.json`/`config.yml` ARE found (no data-format patterns exist yet), so the
`toBe(false)`/`toBe(true)` assertions break. (The yaml-only and override tests
also fail for the same reason.)

- [ ] **Step 3: Append the data-format block to `BUILTIN_IGNORE_PATTERNS`**

In `src/core/domains/ingest/pipeline/ignore-defaults.ts`, insert the block
immediately after the `"*.chunk.js",` line and before the closing `];`:

```ts
  // Data / serialization formats (not code — fixtures, VCR cassettes, CI/config).
  // A code RAG should not embed recorded HTTP responses or config blobs. Keep
  // signal-bearing JSON manifests via negation; YAML is fully ignored.
  "*.json",
  "*.yaml",
  "*.yml",
  "!package.json",
  "!tsconfig.json",
  "!tsconfig.*.json",
  "!*.config.json",
  "!composer.json",
  "!deno.json",
```

- [ ] **Step 4: Extend the file header comment**

In the same file, update the opening doc comment so the category is documented.
Replace the sentence:

```ts
 * Covers framework build artefacts, language caches, IDE
 * configs, and minified bundles that are universally undesirable for
 * semantic search/indexing.
```

with:

```ts
 * Covers framework build artefacts, language caches, IDE
 * configs, minified bundles, and data/serialization formats (json/yaml —
 * fixtures, cassettes, config) that are universally undesirable for
 * semantic search/indexing. Signal-bearing JSON manifests (package.json,
 * tsconfig.json, *.config.json, …) are re-included via negation; YAML is
 * fully ignored. Users override either way via .contextignore.
```

- [ ] **Step 5: Run the tests to verify they PASS**

Run: `npx vitest run tests/core/domains/ingest/pipeline/scanner.test.ts`
Expected: PASS — all three new cases green, and the existing
`BUILTIN_IGNORE_PATTERNS baseline` tests still green (no regression).

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/pipeline/ignore-defaults.ts tests/core/domains/ingest/pipeline/scanner.test.ts
git commit -m "$(cat <<'EOF'
improve(ingest): default-ignore json/yaml data formats with JSON manifest allowlist

A code RAG should not index serialization/data files. On octokit's full clone
714 JSON cassettes doubled the index (1510 -> 3078 chunks) and destabilized the
run. Add *.json/*.yaml/*.yml to BUILTIN_IGNORE_PATTERNS, re-including JSON
manifests (package.json, tsconfig.json, *.config.json, composer.json, deno.json)
via negation. YAML is fully ignored. Binaries were already filtered.

BREAKING CHANGE: the default indexing surface shrinks — json/yaml are no longer
indexed by default. Projects that want them indexed must re-include via
.contextignore (e.g. `!**/*.yml`, `!openapi.yaml`). Takes effect on next reindex.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Document the default-ignore + override in CODE_VECTORIZATION.md

**Files:**

- Modify: `docs/CODE_VECTORIZATION.md` (add a subsection near the existing
  `.contextignore` / ignore-pattern content)

**Interfaces:**

- Consumes: nothing. Produces: nothing. Docs-only.

- [ ] **Step 1: Add the subsection**

Find the section in `docs/CODE_VECTORIZATION.md` that discusses ignore patterns
/ `.contextignore`. Add the following subsection there:

````markdown
### Data formats (json / yaml) are ignored by default

tea-rags indexes **code**, not data. `*.json`, `*.yaml`, and `*.yml` are ignored
by the built-in baseline so fixtures, VCR cassettes, and config blobs do not
pollute search results or inflate the index. Signal-bearing **JSON manifests**
are kept automatically: `package.json`, `tsconfig.json`, `tsconfig.*.json`,
`*.config.json`, `composer.json`, `deno.json`.

To change this for a project, use `.contextignore` (later rules win):

```gitignore
# re-include yaml you DO want indexed
!openapi.yaml
!**/*.yml

# drop a manifest you DON'T want indexed
package.json
```
````

Changes take effect on the next (re)index.

````

- [ ] **Step 2: Lint the markdown**

Run: `npx markdownlint-cli2 docs/CODE_VECTORIZATION.md` (or the project's configured markdown lint). Fix any reported issues.
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add docs/CODE_VECTORIZATION.md
git commit -m "docs: document json/yaml default-ignore and .contextignore override"
````

---

### Task 3: Live validation (USER-GATED — do NOT auto-run)

**Purpose:** Confirm the fix on a real corpus: the octokit full clone should now
index ~159 ruby files / ~1510 chunks (down from 893 files / 3078 chunks) with
json/yaml dropped, and complete cleanly.

**This task mutates a shared index and depends on ollama embeddings — it is
user-gated per `.claude/CLAUDE.md`. Run ONLY on explicit "reindex"/"validate"
instruction. Never chain it off the build.**

- [ ] **Step 1: Build + link the worktree (only if exactly one active worktree;
      else ask)**

```bash
cd .claude/worktrees/<branch>
npm run build && npm link
# reconnect MCP servers
```

- [ ] **Step 2: Reindex the octokit full clone (the no-.contextignore copy) and
      compare**

```bash
node build/cli/index.js index-codebase \
  --path /Users/artk0re/.claude/jobs/0c77cad0/tmp/octokit-full --force --json
```

Expected: `filesCount` ~159 (json/yaml dropped), `chunksCount` ~1510 (≈ the
.rb-only baseline, not 3078), exit 0. No json/yaml chunks in the resulting
index.

- [ ] **Step 3: Record the before/after in the bead and close it**

```bash
bd close tea-rags-mcp-dygln --reason="<files/chunks before→after, exit 0 clean>"
```

---

## Self-Review

**Spec coverage:**

- Default-ignore json/yaml + JSON allowlist → Task 1 Step 3. ✓
- YAML no allowlist → Task 1 Step 1 (yaml-only test) + Step 3 (no yaml
  negations). ✓
- Directory-traversal-not-blocked guard (kgjzq distinction) → Task 1 Step 1
  (`helper.ts` inside `spec/cassettes`). ✓
- User override both directions → Task 1 Step 1 (override test). ✓
- BREAKING + reindex-to-take-effect note → Task 1 Step 6 footer + Task 2 +
  Task 3. ✓
- Decoupled from kgjzq/0wwb6 → Global Constraints (out of scope). ✓

**Placeholder scan:** none — every code/test/command step has concrete content.

**Type consistency:** `FileScanner`
constructor/`loadIgnorePatterns`/`scanDirectory` signatures match the existing
test file usage; `BUILTIN_IGNORE_PATTERNS` keeps its `string[]` export. ✓
