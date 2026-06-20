---
name: report-issue
description:
  Help the user file a high-quality GitHub issue for a TeaRAGs bug — gather
  environment + diagnostic context, CHECK FOR EXISTING/KNOWN ISSUES FIRST, then
  produce a pre-filled issue URL (or `gh issue create` when available). Triggers
  on "report a bug", "file an issue", "open a GitHub issue about this error /
  the quarantine", "зарепорти баг в tea-rags", "это похоже на баг tea-rags". NOT
  for user-fixable config / setup errors (those hints are already actionable).
argument-hint: "[error code, symptom, or 'quarantine']"
---

# Report a TeaRAGs Issue

Turns a TeaRAGs failure into a well-formed GitHub issue **without creating
duplicates**. The repository is `artk0de/TeaRAGs-MCP`.

## MANDATORY: never duplicate, never auto-file

1. **Check for a known/existing issue BEFORE composing or filing anything.**
   This step is not optional — most failures already have an issue. Skipping it
   is a hard error.
2. **Never create an issue without explicit user confirmation.** Default to
   producing a pre-filled URL the user submits themselves.
3. **Never include source code** — only error/diagnostic context.

## Instructions

### 1. Gather bounded context

Collect only what a maintainer needs to triage — no source files:

- **Version**: `tea-rags --version`.
- **Infra**: `tea-rags doctor --json` (embedding model, Qdrant URL/version,
  reachability).
- **Platform**: OS + node version.
- **The failure**:
  - For a specific error — its code, message, and hint (verbatim).
  - For quarantined files — `tea-rags doctor <project> --quarantine --json`.
  - When an index is involved — `get_index_status` for the project.

### 2. Known-issue check (MANDATORY, before anything else)

Search existing issues and surface candidates:

- If `gh` is installed:
  ```bash
  gh search issues --repo artk0de/TeaRAGs-MCP "<error code or key symptom>" --state all
  gh search issues --repo artk0de/TeaRAGs-MCP "<broader keyword>" --state all
  ```
- If `gh` is NOT installed: print the search URL and ask the user to skim it:
  `https://github.com/artk0de/TeaRAGs-MCP/issues?q=<url-encoded query>`

Show any matches as `#<number> — <title> (<state>)`. Then:

- **Match found** → tell the user, link it, and STOP. Suggest commenting on the
  existing issue instead of opening a new one. Only continue if the user
  confirms their case is genuinely distinct.
- **No match** → continue to step 3.

### 3. Compose the issue body

Fill this template (markdown):

```markdown
## Summary

<one-line description>

## Environment

- tea-rags: <version>
- embedding: <model> · qdrant: <version> · platform: <os> / node <ver>

## What happened

<error code + message, or quarantine summary>

## Reproduction

<steps, if known>

## Logs / diagnostics

<the doctor --json / --quarantine --json / error hint block>
```

### 4. Output (hybrid)

- **Default** — print the composed body and a pre-filled issue URL the user can
  open and submit:
  `https://github.com/artk0de/TeaRAGs-MCP/issues/new?title=<url-encoded>&body=<url-encoded>`
- **If `gh` is installed AND authenticated** (`gh auth status` succeeds) — offer
  it as a one-step alternative, and run it ONLY after the user confirms:
  ```bash
  gh issue create --repo artk0de/TeaRAGs-MCP --title "<title>" --body-file <tmp-body.md>
  ```

## Red flags — STOP

- About to compose/file without running the known-issue search → go back to
  step 2.
- About to run `gh issue create` without explicit confirmation → ask first.
- Pasting source code into the body → remove it; diagnostics only.
