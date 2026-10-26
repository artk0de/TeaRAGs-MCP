---
paths:
  - "plugins/**"
  - ".claude-plugin/**"
  - "harness/**"
  - ".agents/**"
  - ".cursor-plugin/**"
  - "src/mcp/resources/generated/**"
---

# Plugin Sources (MANDATORY)

`plugins/<name>/` is the only place plugin content is written: skills, rules,
references, hook scripts, manifest metadata. Everything below is GENERATED from
it by `npm run gen:plugins` (`scripts/gen-plugins.ts`):

- `.claude-plugin/tea-rags/`, `.claude-plugin/dinopowers/`,
  `.claude-plugin/tea-rags-setup/` — Claude Code packages
- `harness/codex/**`, `.agents/plugins/marketplace.json` — Codex
- `harness/cursor/**`, `.cursor-plugin/marketplace.json` — Cursor
- `src/mcp/resources/generated/agent-context.ts` — server core + guides

`.claude-plugin/marketplace.json` and `.claude-plugin/.benchmarks/` are
hand-kept, not generated. `.gitattributes` (`merge=tea-rags-generated`) is the
authoritative list of generated paths.

## Rules

1. Edit only `plugins/**`. NEVER hand-edit a generated path — the next
   regeneration overwrites it.
2. Try a change locally with `npm run gen:plugins`. Committing the output is
   allowed, not required: the release runs `gen:plugins` and commits the
   packages in the `chore(release)` commit. No PR check compares the committed
   output with a fresh render.
3. Version bumps go in `plugins/<name>/.claude-plugin/plugin.json`
   (`plugin-versioning.md`); generated packages copy it.
4. Merges never conflict in generated paths: the `tea-rags-generated` driver
   keeps ours and `scripts/git/merge-generated.sh` regenerates inside the merge
   commit. The driver is registered by `npm install` (`prepare`); without it a
   merge falls back to a text merge.
5. `npm run build` regenerates `agent-context.ts` (`prebuild`), so a build
   always compiles the current rules.
6. Generator tests (`tests/scripts/gen-harness-*.test.ts`,
   `tests/mcp/resources/agent-context-render.test.ts`) assert render properties
   — determinism, links, hook paths, JSON, budgets, manifests — never committed
   == render.
