# Agent-Assisted GitHub Issue Reporting

Epic: `tea-rags-mcp-jola7`.

## Goal

When TeaRAGs hits a genuine bug (an unexpected internal error, a file the
chunker could not parse), let the user's agent help file a high-quality GitHub
issue — with the right environment context and **without creating duplicates**.
Two pieces: a plugin skill that orchestrates the report, and a surgical nudge in
the hints of the two bug-class errors that points at it.

## Part A — `tea-rags:report-issue` plugin skill

Lives at `.claude-plugin/tea-rags/skills/report-issue/SKILL.md`, following the
existing tea-rags skill conventions. Triggers on "report a bug", "file an issue
about the quarantine / this error", "зарепорти баг в tea-rags".

### Flow (hybrid output)

1. **Gather bounded context** — never source code:
   - `tea-rags --version` (or the `version` field of `package.json`).
   - Embedding model + Qdrant version + infra reachability via
     `tea-rags doctor --json`.
   - OS / platform (`process.platform`, node version).
   - The trigger context: either a specific error (code + message + hint) or,
     for quarantine reports, `tea-rags doctor <project> --quarantine --json`.
   - `get_index_status` when an index is involved.

2. **Known-issue check (MANDATORY — runs BEFORE composing a new report).** The
   skill MUST search existing issues first and never push a duplicate:
   - If `gh` is available:
     `gh search issues --repo artk0de/TeaRAGs-MCP "<error code or key symptom>" --state all`
     (and a second search on a broader keyword).
   - If `gh` is absent: emit the GitHub issue-search URL
     (`https://github.com/artk0de/TeaRAGs-MCP/issues?q=<query>`) and ask the
     user to confirm none match.
   - Surface any candidate matches (number + title + state). Proceed to file
     ONLY when there is no clear duplicate, or the user explicitly confirms the
     issue is distinct. A match → link it instead of opening a new one.

3. **Compose** a markdown body from a fixed template: Summary · Environment
   (version, model, qdrant, OS) · What happened (error/quarantine context) ·
   Reproduction · Logs/JSON block.

4. **Hybrid output:**
   - Default — print the composed body and a pre-filled
     `https://github.com/artk0de/TeaRAGs-MCP/issues/new?title=...&body=...` URL
     (URL-encoded). The user clicks and stays in control.
   - When `gh` is available AND authenticated — offer
     `gh issue create --repo artk0de/TeaRAGs-MCP --title ... --body-file ...` as
     a one-step alternative. NEVER auto-create without explicit confirmation.

### Constraints

- No source code in the report; only error/diagnostic context.
- Never auto-file without confirmation; never skip the known-issue check.
- No direct GitHub REST calls — `gh` CLI or a browser URL only.

## Part B — Error-hint nudge (surgical)

Add one line to the `hint` of exactly two bug-class errors — the ones a user
cannot fix themselves:

| Error            | File                                | Why it is a bug, not user error              |
| ---------------- | ----------------------------------- | -------------------------------------------- |
| `UnknownError`   | `src/core/infra/errors.ts`          | catch-all for unexpected internal failures   |
| `FileParseError` | `src/core/domains/ingest/errors.ts` | the chunker/tree-sitter threw on valid input |

Nudge text (appended to the existing hint): _"If this looks like a TeaRAGs bug,
your agent can file a GitHub issue for you — run the `tea-rags:report-issue`
skill."_

User-fixable errors (config, `INGEST_NOT_INDEXED`, `INFRA_QDRANT_UNAVAILABLE`,
`INGEST_CHUNK_OVERSIZED` → lower `INGEST_CHUNK_SIZE`) are NOT touched — their
hints are already actionable and a report nudge would be noise.

`infra/errors.ts` and `ingest/errors.ts` are deep-silo files — commits carry a
`Why:` line per `.claude/rules/silo-pairing.md`.

## Out of scope

- A nudge on every error class (noise + churn across deep-silo files).
- Auto-creating issues without confirmation.
- Telemetry / automatic crash reporting.
- A GitHub App / REST integration.

## Testing

- **Hint edits** — extend `tests/core/infra/errors.test.ts` and
  `tests/core/domains/ingest/errors.test.ts`: assert the two errors' `hint`
  contains the `tea-rags:report-issue` pointer; existing hint content preserved.
- **Skill** — no unit harness for skills; validate the SKILL.md against the
  existing tea-rags skill format (frontmatter `name`/`description`, trigger
  phrasing, the known-issue-check step present). Optional eval later.

## File touch list

| File                                                                          | Change                                        |
| ----------------------------------------------------------------------------- | --------------------------------------------- |
| `.claude-plugin/tea-rags/skills/report-issue/SKILL.md`                        | NEW skill.                                    |
| `src/core/infra/errors.ts`                                                    | `UnknownError` hint nudge (Why: line).        |
| `src/core/domains/ingest/errors.ts`                                           | `FileParseError` hint nudge (Why: line).      |
| `tests/core/infra/errors.test.ts`, `tests/core/domains/ingest/errors.test.ts` | hint assertions.                              |
| `.claude-plugin/tea-rags/` plugin manifest                                    | register the skill if the registry is manual. |
