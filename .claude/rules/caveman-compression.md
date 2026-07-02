---
paths:
  - ".claude-plugin/**/SKILL.md"
  - ".claude-plugin/**/rules/**/*.md"
  - "src/mcp/tools/**"
  - "src/mcp/resources/**"
  - "src/cli/prime/**"
---

# Caveman Compression (MANDATORY)

Every agent-facing PROSE surface ships caveman-compressed. The project runs on
caveman ([JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman)) —
few token do trick. A description or body that reads as full unhurried prose is
a defect.

## Scope — compress ALWAYS

| Surface                             | Where                                       | Level   |
| ----------------------------------- | ------------------------------------------- | ------- |
| Skill description (frontmatter)     | `.claude-plugin/**/SKILL.md`                | `full`  |
| Skill body                          | `.claude-plugin/**/SKILL.md`                | `ultra` |
| Search-cascade rules                | `.claude-plugin/tea-rags/rules/**/*.md`     | `ultra` |
| MCP tool description                | `src/mcp/tools/**` (+ generated Zod schema) | `full`  |
| MCP resource description + doc body | `src/mcp/resources/**`                      | `ultra` |
| prime digest prose                  | `src/cli/prime/**`                          | `full`  |

Transform: strip articles, filler, hedging, pleasantries. KEEP the positive
trigger core, quoted trigger phrases, and every `NOT for X` / `use Y` boundary.

## Exception — output formats (NEVER compress)

Format and structure **contracts** are out of scope. Preserve byte-exact:

- JSON Schema / Zod structure: field names, types, `enum`, `required`, defaults
- MCP tool RESPONSE shapes, output templates, example payloads
- DTO shapes, param names, flag names
- code fences, tables, paths, URLs, identifiers, symbolIds

caveman compresses the DESCRIPTION prose of a field — never the field itself.

## Why (evidence)

Validated on 55 trigger units (25 skills + 23 MCP tools + 7 resources):
compression at `full` never regressed routing — false-positives ≈ nil because a
skill's/tool's disambiguation clauses are redundant to its positive semantic
core (an out-of-scope prompt fails to match the positive core regardless of the
`NOT for X` clause). Only aggressive `ultra` on broad-scope skill DESCRIPTIONS
risks false-NEGATIVES (target stops firing — e.g. `data-driven-generation`), so
descriptions cap at `full`; bodies, cascade rules, and resource docs are
post-selection (zero trigger risk) and go `ultra`.

## Enforcement

New skill / tool / resource / cascade rule → author it compressed, or run
caveman before commit. Uncompressed prose on any surface above fails review.
Never compress the output-format contracts listed in the Exception.
