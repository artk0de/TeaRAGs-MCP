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

Turn TeaRAGs failure into well-formed GitHub issue **without creating
duplicates**. Repo: `artk0de/TeaRAGs-MCP`.

## MANDATORY: never duplicate, never auto-file

1. **Check for a known/existing issue BEFORE composing or filing anything.** Not
   optional — most failures already have issue. Skipping = hard error.
2. **Never create an issue without explicit user confirmation.** Default:
   produce pre-filled URL user submits themselves.
3. **Never include source code** — only error/diagnostic context.

## Instructions

### 1. Gather bounded context

Collect only what maintainer needs to triage — no source files:

- **Version**: `tea-rags --version`.
- **Infra**: `tea-rags doctor --json` (embedding model, Qdrant URL/version,
  reachability).
- **Platform**: OS + node version.
- **The failure**:
  - For specific error — code, message, hint (verbatim).
  - For quarantined files — `tea-rags doctor <project> --quarantine --json`.
  - When index involved — `get_index_status` for project.

### 2. Known-issue check (MANDATORY, before anything else)

Search existing issues, surface candidates:

- If `gh` installed:
  ```bash
  gh search issues --repo artk0de/TeaRAGs-MCP "<error code or key symptom>" --state all
  gh search issues --repo artk0de/TeaRAGs-MCP "<broader keyword>" --state all
  ```
- If `gh` NOT installed: print search URL, ask user to skim:
  `https://github.com/artk0de/TeaRAGs-MCP/issues?q=<url-encoded query>`

Show matches as `#<number> — <title> (<state>)`. Then:

- **Match found** → tell user, link it, STOP. Suggest commenting on existing
  issue instead of opening new one. Continue only if user confirms case
  genuinely distinct.
- **No match** → continue to step 3.

### 3. Compose the issue fields

Repo sets `blank_issues_enabled: false` → blank `issues/new?title=&body=` URL
redirects to template chooser, DROPS prefill. Target issue form
`.github/ISSUE_TEMPLATE/bug_report.yml` instead. One value per form field id:

| Field id       | Value                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `title`        | `[bug]: <one-line summary>` (form default prefix kept)                                                                                                       |
| `version`      | `tea-rags --version`                                                                                                                                         |
| `client`       | EXACT dropdown option: `Claude Code`, `Cursor`, `Continue`, `Zed`, `CLI only (tea-rags command, no MCP client)`, `Other (name it in the reproduction steps)` |
| `embedding`    | `<provider> / <model id>`                                                                                                                                    |
| `qdrant`       | `<embedded\|external> <version>` (+ URL when external)                                                                                                       |
| `platform`     | `<os> / Node <ver>`                                                                                                                                          |
| `reproduction` | numbered steps, if known                                                                                                                                     |
| `expected`     | what should have happened                                                                                                                                    |
| `actual`       | error code + message + hint verbatim, or quarantine summary                                                                                                  |
| `index-status` | `get_index_status` / `tea-rags doctor <path> --json` output                                                                                                  |
| `logs`         | `--quarantine --json` / `DEBUG=1` excerpt, redacted                                                                                                          |

Unknown value → omit param; user fills it in form. `checks` checkboxes NOT
prefillable — user ticks them.

### 4. Output (hybrid)

- **Default** — print composed fields + pre-filled issue-form URL user opens and
  submits (every value url-encoded):
  `https://github.com/artk0de/TeaRAGs-MCP/issues/new?template=bug_report.yml&title=<enc>&version=<enc>&client=<enc>&embedding=<enc>&qdrant=<enc>&platform=<enc>&reproduction=<enc>&expected=<enc>&actual=<enc>&index-status=<enc>&logs=<enc>`
  URL past ~8000 chars → drop `logs` then `index-status` from URL, print them
  for user to paste into form.
- **If `gh` installed AND authenticated** (`gh auth status` succeeds) — offer as
  one-step alternative, run ONLY after user confirms. API bypasses form → body
  file carries one `### <form label>` heading per field (`TeaRAGs version`,
  `MCP client`, `Embedding provider and model`, `Qdrant mode and version`,
  `OS and Node version`, `Reproduction steps`, `Expected behavior`,
  `Actual behavior`, `get_index_status output`, `Logs`) — same shape as
  form-filed issue:
  ```bash
  gh issue create --repo artk0de/TeaRAGs-MCP --title "[bug]: <summary>" --body-file <tmp-body.md>
  ```

## Red flags — STOP

- About to compose/file without running known-issue search → go back to step 2.
- About to run `gh issue create` without explicit confirmation → ask first.
- Pasting source code into body → remove it; diagnostics only.
