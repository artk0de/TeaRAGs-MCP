# Delivery Contract — Phase 5 DELIVER

Structured output of the review. Skill emits THIS — agent delivers it through
whatever MR-platform mechanism the session exposes. Skill names NO commands.

## Contract shape

```text
comment := { file, line (new side), severity: "major"|"minor",
             body: evidence-citing text, signature }
summary := { verdict, counts by severity, dimensions run/skipped + why,
             observations list }
```

## Comment conventions

- `[minor]` prefix on every style/naming/docs nit — anything that should not
  block the merge. Body starts with the prefix, then the point.
- Signature footer on EVERY comment and on the summary:
  `🤖 tea-rags mr-review agent`.
- Comment language mirrors MR description language; default English.
- One inline comment per finding at its file:line. One summary comment total.
- Body cites evidence: labeled signal value (`bugFixRate 48% concerning`) or
  concrete code reference (symbol, line, sibling pattern). No evidence — no
  comment (Phase 4 already dropped it).

## Delivery

Agent posts through the session's available MR-platform mechanism:

1. Platform MCP server — PREFER when several mechanisms available.
2. Platform CLI.
3. `http-client` MCP with configured token.

None available → print full contract in chat for manual posting, mark review
"delivered locally". NEVER fail the review because posting is impossible.

## Draft-gate (external mode, MANDATORY)

1. Render draft table: `file:line | severity | one-line body` per finding.
2. ONE confirmation for the whole batch — never per-comment, never skipped.
3. Post each comment inline at its file:line + the summary comment.
4. Report per-comment status: posted / failed. Failed → retry once, then surface
   in chat with the unposted body.

## Local mode

No posting. Chat report: findings grouped by severity (major first), then
observations, then dimensions-skipped notes ("not assessed — codegraph off",
"tests dimension: no DSL chunks, file-level fallback"). Same evidence rules.

## Degradation matrix

| Condition                        | Behavior                                                       |
| -------------------------------- | -------------------------------------------------------------- |
| Repo not in tea-rags registry    | Stop; print register + index instructions                      |
| Index stale vs target branch     | Incremental `index_codebase`, then proceed                     |
| Codegraph off                    | Skip blast-radius + cycles; summary: "structural not assessed" |
| No DSL test chunks               | tests dimension falls back to `testFile: "only"` file-level    |
| No delivery mechanism in session | Print delivery contract in chat for manual posting             |
| Empty diff                       | Stop with explicit message                                     |
