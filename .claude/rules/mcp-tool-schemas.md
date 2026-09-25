---
paths:
  - "src/mcp/tools/**"
  - "src/mcp/resources/**"
  - "src/core/api/internal/infra/schema-builder.ts"
  - "src/core/domains/explore/post-process.ts"
  - "tests/mcp/tools/**"
---

# MCP Tool Schemas — Contract Invariants (MANDATORY)

The tool schema (`inputSchema` `.describe()`, tool `description`, output
schemas) is the call/response CONTRACT layer
(`.claude/rules/plugin-guidance-layers.md`). An agent trusts it without reading
code, so every sentence in it is a claim the code must keep. The 2026-09-23
compaction wave (`74e63f677`, `23529cbfb`, `f4fe51717`, `9506eb2b6`) found each
invariant below broken in production. Workflow for editing a schema:
`.claude/skills/mcp-schema-authoring/`. Prose style: `caveman-compression.md`.

## Invariants

1. **Expose only what the query path applies.** A param the handler ignores is
   worse than an absent one — the agent trusts a filter that never ran (86wsz:
   eight codegraph filters listed with codegraph off, search ran unfiltered).
   Derive the exposed set from the registry (`SchemaBuilder#filterParamNames`
   from `registry.getAllFilters()`), never hand-list it.
   `tests/mcp/tools/param-applicability.test.ts` pins it per composition.

2. **A param `.describe()` is a ≤ 20-word hint** (`MAX_PARAM_HINT_WORDS`,
   enforced over the real `tools/list`). The hint carries the ONE semantic an
   agent would otherwise get wrong (unit, default, mutual exclusion) — not a
   bare restatement of the name, and not reference prose. Reference prose goes
   to `tea-rags://schema/overview` `## Param reference`
   (`src/mcp/resources/registry.ts`). Offloading EVERYTHING is also wrong: many
   agents never fetch the resource.

3. **Never describe a param, default or value the code does not have.** Stated
   defaults must match the code (search_code's limit hint stated a default the
   handler does not use; the real one is 5); a tool must not promise a param it
   lacks (find_symbol `level`). Interpolate defaults from the constant the
   handler uses instead of typing the number into prose.

4. **Output schemas declare the shape tools actually emit.** Mirror the
   contracts type (`RankingOverlaySchema` ↔ `RankingOverlay`), and test by
   parsing REAL results (Reranker, strategies, groupers) — never hand-built
   fixtures in the imagined shape. `.passthrough()` is only for a bag whose keys
   are runtime-dependent (search `payload`: enrichments, `metaOnly`, `fields`);
   say so in prose and declare no keys inside it. `.passthrough()` on a declared
   shape hides a lie (nb32e: item-level `relativePath`/`content`/`git` that no
   tool returns).

5. **One path, one shape, in every mode.** A payload path holds the same value
   type with and without `metaOnly` / `fields` / a preset — raw values in
   `payload`, labels only in `rankingOverlay.{file,chunk}.<field>` (9506eb2b6).
   A shape change here is `BREAKING CHANGE` (commit-rules.md).

6. **Shared semantics live in ONE string.** A contract several tools share
   (`META_ONLY_CONTRACT`) is one exported constant referenced by every tool —
   never per-tool copies that drift. Plugin rules and skills POINT at the
   schema/overview; they do not restate it.

7. **Measure `tools/list` size on every schema change.**
   `npx tsx scripts/measure-tools-list.ts` (real composition, codegraph ON and
   OFF). Put before → after bytes in the commit body. An increase needs a reason
   in the commit.

## Checklist before commit

- [ ] every new/changed param is applied by the handler in every composition
      that exposes it
- [ ] hints ≤ 20 words, carry the gotcha; long prose in overview
- [ ] defaults/enum values in prose read from code constants
- [ ] output schema parsed against a real result in a test
- [ ] no mode-dependent shape at one payload path
- [ ] `tools/list` bytes before → after in the commit body
- [ ] `.claude-plugin/**` touched → plugin version bumped
      (`plugin-versioning.md`); rule corpus grew → `inject-rules.sh --count` vs
      declared `--parts`
