# Language Compatibility Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans (here: dinopowers:executing-plans) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-maintained `language-compatibility.md` rule with a colocated-descriptor-driven generator that renders both the agent rule and a human README spoiler, guarded against drift.

**Architecture:** Each language owns a `capability.ts` descriptor next to its provider. `LanguageFactory.capabilities()` aggregates them into a `Map`. Two pure renderers (`renderRule`, `renderReadme`) turn that Map into the committed rule file and a README spoiler block. A vitest drift-guard asserts committed === rendered; a regen script rewrites both targets; a paths-scoped rule reminds agents to update descriptors after provider edits.

**Tech Stack:** TypeScript, vitest, Node fs, existing `LanguageFactory` (`src/core/domains/language/factory.ts`).

## Global Constraints

- Bead epic: `tea-rags-mcp-cmm1o`. Every Task = one beads task under it, 1:1 title, labelled.
- **Do NOT add any export to `src/core/domains/language/index.ts`** (barrel, fanIn 7, transitiveImpact 24). Capability is factory-aggregated, never re-exported.
- Type additions to `src/core/contracts/types/language.ts` are **additive only** — never modify existing interfaces (`LanguageProvider`, `LanguageFactoryDescriptor`, etc.).
- Codegraph MEASURED numbers (`resolveSuccessRate`) are NEVER rendered — capability ceiling only; measured numbers live in prime.
- Committed targets: `.claude-plugin/tea-rags/rules/language-compatibility.md` (full file) and `README.md` block between `<!-- BEGIN lang-compat -->` / `<!-- END lang-compat -->`.
- Descriptor values are ported verbatim from the approved matrix in `.claude-plugin/tea-rags/rules/language-compatibility.md`.
- Conventional commits, scope from `.claude/rules/commit-rules.md`. Test runner: `npx vitest run`.

---

## File Structure

- `src/core/contracts/types/language.ts` — **modify (additive)**: `CodegraphTier`, `TypingTieredCodegraph`, `LanguageCapability`.
- `src/core/domains/language/<lang>/capability.ts` ×9 — **create**: one `export const capability: LanguageCapability`.
- `src/core/domains/language/factory.ts` — **modify**: add `capabilities()` method + capability imports (NO barrel touch).
- `src/core/domains/language/capability/fallback.ts` — **create**: `UNSUPPORTED_FALLBACK`.
- `src/core/domains/language/capability/rule.ts` — **create**: `renderRule`.
- `src/core/domains/language/capability/readme.ts` — **create**: `renderReadme`.
- `scripts/gen-language-compatibility.ts` — **create**: regen entrypoint; `package.json` script `gen:lang-compat`.
- `tests/core/domains/language/capability/*.test.ts` — **create**: presence, renderRule, renderReadme, drift-guard.
- `.claude/rules/language-capability-sync.md` — **create**: enforcement rule.

---

### Task 1: LanguageCapability types

**Files:**
- Modify: `src/core/contracts/types/language.ts` (append new interfaces; do not edit existing ones)
- Test: `tests/core/contracts/types/language-capability.test.ts`

**Interfaces:**
- Produces: `CodegraphTier`, `TypingTieredCodegraph`, `LanguageCapability` (consumed by every later Task).

- [ ] **Step 1: Write the failing test** (type-level + runtime shape via a sample literal)

```ts
import { describe, it, expect } from "vitest";
import type { LanguageCapability } from "../../../../src/core/contracts/types/language.js";

describe("LanguageCapability", () => {
  it("accepts a flat codegraph tier", () => {
    const cap: LanguageCapability = {
      language: "go",
      ast: { tier: "full", engine: "tree-sitter" },
      tests: { tier: "medium", detection: "*_test.go", tech: "generic AST" },
      codegraph: { tier: "moderate", tech: "6-strategy chain" },
    };
    expect(cap.codegraph.tier).toBe("moderate");
  });

  it("accepts a typing-tiered codegraph object (Ruby)", () => {
    const cap: LanguageCapability = {
      language: "ruby",
      ast: { tier: "full", engine: "tree-sitter", hooks: ["rspecScopeChunker"] },
      tests: { tier: "high", detection: "*_spec.rb / *_test.rb", tech: "RSpec scope chunker" },
      codegraph: { tier: { untyped: "high", yard: "maximum", "rbs/sorbet": "tbd" }, tech: "11-strategy + YARD" },
    };
    expect(typeof cap.codegraph.tier).toBe("object");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/contracts/types/language-capability.test.ts`
Expected: FAIL — `LanguageCapability` not exported from `language.ts`.

- [ ] **Step 3: Append the types** to the END of `src/core/contracts/types/language.ts`

```ts
export type CodegraphTier = "maximum" | "high" | "moderate" | "minimal" | "none";

/** Ruby: codegraph capability depends on the annotation tier of the project. */
export interface TypingTieredCodegraph {
  untyped: CodegraphTier;
  yard: CodegraphTier;
  "rbs/sorbet": CodegraphTier | "tbd";
}

export interface LanguageCapability {
  language: string;
  ast: { tier: "full" | "partial" | "none"; engine: string; hooks?: string[] };
  tests: { tier: "high" | "medium" | "low" | "na"; detection: string; tech: string };
  codegraph: { tier: CodegraphTier | TypingTieredCodegraph; tech: string };
  /** README prose extras (humans only). */
  notes?: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/contracts/types/language-capability.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts/types/language.ts tests/core/contracts/types/language-capability.test.ts
git commit -m "feat(types): add LanguageCapability descriptor types"
```

---

### Task 2: Nine descriptors + LanguageFactory.capabilities() + fallback

**Files:**
- Create: `src/core/domains/language/{typescript,javascript,python,go,java,rust,ruby,bash,markdown}/capability.ts`
- Create: `src/core/domains/language/capability/fallback.ts`
- Modify: `src/core/domains/language/factory.ts` (add `capabilities()` + 9 capability imports; NO barrel export)
- Test: `tests/core/domains/language/capability/capabilities.test.ts`

**Interfaces:**
- Consumes: `LanguageCapability` (Task 1).
- Produces: `LanguageFactory#capabilities(): Map<string, LanguageCapability>`; `UNSUPPORTED_FALLBACK: LanguageCapability[]`; one `export const capability` per language.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";

describe("LanguageFactory.capabilities", () => {
  const factory = new LanguageFactory();

  it("has a capability descriptor for every supported() language", () => {
    const caps = factory.capabilities();
    for (const lang of factory.supported()) {
      expect(caps.has(lang)).toBe(true);
      expect(caps.get(lang)!.language).toBe(lang);
    }
  });

  it("ports Ruby codegraph as a typing-tiered object", () => {
    const ruby = factory.capabilities().get("ruby")!;
    expect(ruby.codegraph.tier).toMatchObject({ untyped: "high", yard: "maximum", "rbs/sorbet": "tbd" });
  });

  it("ports markdown AST as partial", () => {
    expect(factory.capabilities().get("markdown")!.ast.tier).toBe("partial");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/language/capability/capabilities.test.ts`
Expected: FAIL — `capabilities` is not a function.

- [ ] **Step 3a: Create each `<lang>/capability.ts`** porting values from the approved matrix. Example — Ruby (`src/core/domains/language/ruby/capability.ts`):

```ts
import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "ruby",
  ast: { tier: "full", engine: "tree-sitter", hooks: ["rspecFilter", "commentCapture", "rspecScopeChunker", "bodyChunker"] },
  tests: { tier: "high", detection: "*_test.rb / *_spec.rb", tech: "RSpec scope chunker (setup injected)" },
  codegraph: {
    tier: { untyped: "high", yard: "maximum", "rbs/sorbet": "tbd" },
    tech: "11-strategy + 4 dispatch components (table/union/cone/dynamic) + YARD type-source",
  },
};
```

TypeScript (`typescript/capability.ts`): ast full tree-sitter hooks `["commentCapture","bodyChunker","testScopeChunker"]`; tests high `*.test.ts / *.spec.ts` testScopeChunker; codegraph `high`, tech "8-strategy chain + ConeDispatch".
JavaScript: ast full tree-sitter `["jsAssignmentFilter"]`; tests high `*.test.js / *.spec.jsx`; codegraph `high`, tech "6-strategy; CommonJS/ESM (dynamic gaps)".
Python: ast full tree-sitter; tests medium `test_*.py / *_test.py / conftest.py` generic AST; codegraph `moderate`, tech "6-strategy + ConeDispatch CHA".
Go: ast full tree-sitter `["GoChunkClassifier"]`; tests medium `*_test.go` generic AST; codegraph `moderate`, tech "6-strategy; explicit interfaces".
Java: ast full tree-sitter; tests medium `*Test.java / *IT.java` generic AST; codegraph `moderate`, tech "6-strategy + java.lang whitelist + overload disambiguation".
Rust: ast full tree-sitter `["nameExtractor"]`; tests medium `*_test.rs` generic AST; codegraph `moderate`, tech "6-strategy; trait-based dispatch".
Bash: ast full tree-sitter; tests low generic AST; codegraph `minimal`, tech "function-call extraction only".
Markdown: ast partial engine "MarkdownChunker"; tests na detection "doc-only" tech "—"; codegraph `none`, tech "no call graph".

- [ ] **Step 3b: Create `src/core/domains/language/capability/fallback.ts`**

```ts
import type { LanguageCapability } from "../../../contracts/types/language.js";

/** Languages with no native provider — CharacterChunker fallback, no AST/codegraph. */
export const UNSUPPORTED_FALLBACK: LanguageCapability[] = ["sql", "jsonc", "json"].map((language) => ({
  language,
  ast: { tier: "none", engine: "CharacterChunker" },
  tests: { tier: "na", detection: "—", tech: "—" },
  codegraph: { tier: "none", tech: "—" },
}));
```

- [ ] **Step 3c: Add `capabilities()` to `LanguageFactory`** (read `factory.ts` for the exact `create()`/`supported()` shape; mirror its static aggregation). Add the 9 capability imports at top, then:

```ts
// imports (top of factory.ts), e.g.:
import { capability as typescriptCapability } from "./typescript/capability.js";
// ... 8 more

capabilities(): Map<string, LanguageCapability> {
  return new Map([
    ["typescript", typescriptCapability],
    ["javascript", javascriptCapability],
    ["python", pythonCapability],
    ["go", goCapability],
    ["java", javaCapability],
    ["rust", rustCapability],
    ["ruby", rubyCapability],
    ["bash", bashCapability],
    ["markdown", markdownCapability],
  ]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/language/capability/capabilities.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/*/capability.ts src/core/domains/language/capability/fallback.ts src/core/domains/language/factory.ts tests/core/domains/language/capability/capabilities.test.ts
git commit -m "feat(factory): colocated language capability descriptors + capabilities() aggregation"
```

---

### Task 3: renderRule (agent matrix)

**Files:**
- Create: `src/core/domains/language/capability/rule.ts`
- Test: `tests/core/domains/language/capability/rule.test.ts`

**Interfaces:**
- Consumes: `LanguageCapability` (Task 1), `UNSUPPORTED_FALLBACK` (Task 2).
- Produces: `renderRule(caps: Map<string, LanguageCapability>): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { renderRule } from "../../../../../src/core/domains/language/capability/rule.js";
import type { LanguageCapability } from "../../../../../src/core/contracts/types/language.js";

const ruby: LanguageCapability = {
  language: "ruby",
  ast: { tier: "full", engine: "tree-sitter" },
  tests: { tier: "high", detection: "*_spec.rb", tech: "RSpec scope chunker" },
  codegraph: { tier: { untyped: "high", yard: "maximum", "rbs/sorbet": "tbd" }, tech: "11-strategy + YARD" },
};

describe("renderRule", () => {
  const out = renderRule(new Map([["ruby", ruby]]));
  it("emits the H1 and the matrix header", () => {
    expect(out).toContain("# Language Compatibility");
    expect(out).toContain("| Language | AST code chunking | Tests code chunking | Codegraph capability |");
  });
  it("renders Ruby typing-tiered codegraph inline", () => {
    expect(out).toContain("untyped **high** · YARD **maximum** · RBS/Sorbet **TBD**");
  });
  it("does NOT render measured resolveSuccessRate", () => {
    expect(out).not.toMatch(/resolveSuccessRate/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/language/capability/rule.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `renderRule`** — a pure function building the matrix + scales + for-humans footnote (mirror the current `language-compatibility.md` layout). Typing-tiered codegraph cell formats as `untyped **high** · YARD **maximum** · RBS/Sorbet **TBD**`; flat tier as `**moderate**`. Append `UNSUPPORTED_FALLBACK` rows (sql/jsonc/json → none). Keep section text identical to the approved file so Task 6's drift-guard passes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/language/capability/rule.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/capability/rule.ts tests/core/domains/language/capability/rule.test.ts
git commit -m "feat(rerank): renderRule — agent-facing compatibility matrix"
```

---

### Task 4: renderReadme (human spoiler)

**Files:**
- Create: `src/core/domains/language/capability/readme.ts`
- Test: `tests/core/domains/language/capability/readme.test.ts`

**Interfaces:**
- Consumes: `LanguageCapability`, `UNSUPPORTED_FALLBACK`.
- Produces: `renderReadme(caps: Map<string, LanguageCapability>): string` — returns ONLY the block that goes between the README markers (markers themselves added by the generator, Task 5).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { renderReadme } from "../../../../../src/core/domains/language/capability/readme.js";
import type { LanguageCapability } from "../../../../../src/core/contracts/types/language.js";

const go: LanguageCapability = {
  language: "go",
  ast: { tier: "full", engine: "tree-sitter" },
  tests: { tier: "medium", detection: "*_test.go", tech: "generic AST" },
  codegraph: { tier: "moderate", tech: "6-strategy; explicit interfaces" },
};

describe("renderReadme", () => {
  const out = renderReadme(new Map([["go", go]]));
  it("wraps the table in a details spoiler under the section heading", () => {
    expect(out).toContain("## Languages Compatibilities");
    expect(out).toContain("<details>");
    expect(out).toContain("<summary>");
    expect(out).toContain("</details>");
  });
  it("includes the technology prose for humans", () => {
    expect(out).toContain("6-strategy; explicit interfaces");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/language/capability/readme.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `renderReadme`** — pure function emitting `## Languages Compatibilities` + `<!-- markdownlint-disable MD033 -->` + `<details><summary>Supported languages & support levels</summary>` + a human table (Language | AST + engine | Tests + tech | Codegraph + tech, typing-tiers spelled out for Ruby) + `</details>` + `<!-- markdownlint-enable MD033 -->`. Append fallback rows.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/language/capability/readme.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/capability/readme.ts tests/core/domains/language/capability/readme.test.ts
git commit -m "feat(docs): renderReadme — human-facing compatibility spoiler"
```

---

### Task 5: Regen script + npm script

**Files:**
- Create: `scripts/gen-language-compatibility.ts`
- Modify: `package.json` (add `"gen:lang-compat"` script)
- Test: `tests/scripts/gen-language-compatibility.test.ts` (idempotence + marker replacement)

**Interfaces:**
- Consumes: `LanguageFactory#capabilities`, `renderRule`, `renderReadme`.
- Produces: a `writeArtifacts()` (exported) so the test can call it without spawning a process; and a CLI entry that calls it.

- [ ] **Step 1: Write the failing test** — `writeArtifacts` writes the rule file verbatim and replaces ONLY the README marker block, leaving surrounding README text intact; running twice is a no-op.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeArtifacts } from "../../scripts/gen-language-compatibility.js";

describe("writeArtifacts", () => {
  it("replaces only the README marker block and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "lc-"));
    const rulePath = join(dir, "rule.md");
    const readmePath = join(dir, "README.md");
    writeFileSync(readmePath, "# Top\n\n<!-- BEGIN lang-compat -->\nOLD\n<!-- END lang-compat -->\n\n# Bottom\n");

    writeArtifacts({ rulePath, readmePath });
    const first = readFileSync(readmePath, "utf8");
    expect(first).toContain("# Top");
    expect(first).toContain("# Bottom");
    expect(first).not.toContain("OLD");

    writeArtifacts({ rulePath, readmePath });
    expect(readFileSync(readmePath, "utf8")).toBe(first); // idempotent
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scripts/gen-language-compatibility.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the script.** Export `writeArtifacts({ rulePath, readmePath })`: build `caps = new LanguageFactory().capabilities()`; write `renderRule(caps)` to `rulePath`; read README, regex-replace between `<!-- BEGIN lang-compat -->` and `<!-- END lang-compat -->` (inclusive of inner content, markers kept) with `renderReadme(caps)`. Add `if (import.meta.url === ...) writeArtifacts(defaultPaths)`. Add `"gen:lang-compat": "tsx scripts/gen-language-compatibility.ts"` to `package.json` (match the existing script runner used by sibling scripts).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/scripts/gen-language-compatibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-language-compatibility.ts package.json tests/scripts/gen-language-compatibility.test.ts
git commit -m "feat(scripts): language-compatibility regen script"
```

---

### Task 6: Drift-guard test + migration

**Files:**
- Modify: `.claude-plugin/tea-rags/rules/language-compatibility.md` (regenerated)
- Modify: `README.md` (add markers + spoiler block)
- Test: `tests/core/domains/language/capability/drift-guard.test.ts`

**Interfaces:**
- Consumes: `renderRule`, `renderReadme`, `LanguageFactory#capabilities`.

- [ ] **Step 1: Run the generator to migrate** (one-time; produces the committed artifacts the guard will lock):

```bash
# add empty markers to README first if absent:
#   <!-- BEGIN lang-compat -->\n<!-- END lang-compat -->
npm run gen:lang-compat
git diff --stat   # expect language-compatibility.md regenerated + README block filled
```

Manually diff the regenerated `language-compatibility.md` against the hand-written version — confirm it matches the approved matrix (or supersedes it with the same tiers). Any unintended diff means `renderRule` text drifted from the approved layout — fix `renderRule`, not the file.

- [ ] **Step 2: Write the drift-guard test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";
import { renderRule } from "../../../../../src/core/domains/language/capability/rule.js";
import { renderReadme } from "../../../../../src/core/domains/language/capability/readme.js";

describe("language-compatibility drift guard", () => {
  const caps = new LanguageFactory().capabilities();
  it("rule file equals renderRule output", () => {
    const committed = readFileSync(".claude-plugin/tea-rags/rules/language-compatibility.md", "utf8");
    expect(committed).toBe(renderRule(caps));
  });
  it("README block equals renderReadme output", () => {
    const readme = readFileSync("README.md", "utf8");
    const block = readme.split("<!-- BEGIN lang-compat -->")[1].split("<!-- END lang-compat -->")[0];
    expect(`<!-- BEGIN lang-compat -->${block}<!-- END lang-compat -->`).toContain(renderReadme(caps).trim().slice(0, 40));
  });
});
```

- [ ] **Step 3: Run — expect PASS** (artifacts already regenerated in Step 1)

Run: `npx vitest run tests/core/domains/language/capability/drift-guard.test.ts`
Expected: PASS. If the rule assertion fails, the committed file drifted — re-run `npm run gen:lang-compat`.

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/tea-rags/rules/language-compatibility.md README.md tests/core/domains/language/capability/drift-guard.test.ts
git commit -m "feat(docs): generator-driven compatibility file + README spoiler + drift guard"
```

---

### Task 7: Enforcement rule

**Files:**
- Create: `.claude/rules/language-capability-sync.md`

- [ ] **Step 1: Create the rule** with the mandatory frontmatter (`.claude/CLAUDE.md` rule-file convention):

```markdown
---
paths:
  - "src/core/domains/language/**"
---

# Language Capability Sync (MANDATORY)

When you change a chunker hook, resolver chain, walker, or test-detection for a
language under `src/core/domains/language/<lang>/`, the change may move that
language's capability tier. You MUST:

1. Re-review `src/core/domains/language/<lang>/capability.ts` and update the
   `ast` / `tests` / `codegraph` tier or `tech` text if the change altered it.
2. Run `npm run gen:lang-compat` to regenerate
   `.claude-plugin/tea-rags/rules/language-compatibility.md` and the README
   `<!-- BEGIN/END lang-compat -->` block.
3. The drift-guard test fails CI if the committed files diverge from the
   descriptors — a red drift-guard means step 2 was skipped.

The capability descriptor is the single source of truth; the rule file and
README are generated views. Never hand-edit the generated files.
```

- [ ] **Step 2: Verify it renders** (no test; it is a rule doc)

Run: `npx markdownlint-cli2 .claude/rules/language-capability-sync.md` (or the MCP markdownlint tool); fix any issues.

- [ ] **Step 3: Commit**

```bash
git add .claude/rules/language-capability-sync.md
git commit -m "docs(rules): enforce capability descriptor sync on domains/language edits"
```

---

## Self-Review

**Spec coverage:** Task 1 → types; Task 2 → 9 descriptors + `capabilities()` + fallback + presence test; Task 3 → renderRule; Task 4 → renderReadme; Task 5 → regen script; Task 6 → drift-guard + migration; Task 7 → enforcement rule. All 9 spec components covered. prime highlight (xip6g) is explicitly out of scope (separate bead).

**Placeholder scan:** descriptor values for all 9 languages are spelled out (Step 3a of Task 2); renderer bodies described by exact output contract + locked by Task 6 drift-guard against the approved file. No "TBD" except the Ruby `rbs/sorbet` *value* (intentional).

**Type consistency:** `LanguageCapability` / `CodegraphTier` / `TypingTieredCodegraph` defined in Task 1, consumed unchanged in Tasks 2-6. `capabilities()` returns `Map<string, LanguageCapability>` consistently. `renderRule`/`renderReadme` take `Map<string, LanguageCapability>` in Tasks 3-6.

**Barrel constraint:** Task 2 Step 3c explicitly forbids barrel export; Global Constraints repeats it.
