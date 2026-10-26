---
name: report-issue
description: >-
  Help the user file a high-quality GitHub issue for a TeaRAGs bug — gather
  environment + diagnostic context, CHECK FOR EXISTING/KNOWN ISSUES FIRST, then
  produce a pre-filled issue URL (or `gh issue create` when available). Triggers
  on "report a bug", "file an issue", "open a GitHub issue about this error /
  the quarantine", "зарепорти баг в tea-rags", "это похоже на баг tea-rags". NOT
  for user-fixable config / setup errors (those hints are already actionable).
codex-description: >-
  File a GitHub issue for a TeaRAGs bug — gather env + diagnostics, check
  existing issues first, produce a pre-filled issue URL or gh issue create.
  Triggers "report a bug", "file an issue", "open a GitHub issue about this
  error", "зарепорти баг в tea-rags", "это похоже на баг tea-rags". NOT for
  user-fixable config / setup errors.
argument-hint: "[error code, symptom, or 'quarantine']"
---

# Report a TeaRAGs Issue

Turn TeaRAGs failure into well-formed GitHub issue **without creating
duplicates**. Repo: `artk0de/TeaRAGs-MCP`.

## MANDATORY: never duplicate, never auto-file

1. **Known-issue check BEFORE composing / filing anything** (step 2). Skipping =
   hard error — go back.
2. **Never create issue w/o explicit user confirmation.** Default: pre-filled
   URL user submits.
3. **Never include source code** — diagnostics only; found in body → remove.

## Instructions

### 1. Gather bounded context

Triage needs only — no source files:

- **Version**: `tea-rags --version`.
- **Infra**: `tea-rags doctor --json` (embedding model, Qdrant URL/version,
  reachability).
- **Platform**: OS + node version.
- **The failure**:
  - specific error → code, message, hint (verbatim)
  - quarantined files → `tea-rags doctor <project> --quarantine --json`
  - index involved → `get_index_status` for project

### 2. Known-issue check (MANDATORY, before anything else)

- `gh` installed:
  ```bash
  gh search issues --repo artk0de/TeaRAGs-MCP "<error code or key symptom>" --state all
  gh search issues --repo artk0de/TeaRAGs-MCP "<broader keyword>" --state all
  ```
- no `gh` → print search URL, user skims:
  `https://github.com/artk0de/TeaRAGs-MCP/issues?q=<url-encoded query>`

Show matches as `#<number> — <title> (<state>)`. Then:

- **Match** → link it, STOP, suggest commenting there. Continue only if user
  confirms case genuinely distinct.
- **No match** → step 3.

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

- **Default** — print fields + pre-filled issue-form URL (every value
  url-encoded):
  `https://github.com/artk0de/TeaRAGs-MCP/issues/new?template=bug_report.yml&title=<enc>&version=<enc>&client=<enc>&embedding=<enc>&qdrant=<enc>&platform=<enc>&reproduction=<enc>&expected=<enc>&actual=<enc>&index-status=<enc>&logs=<enc>`
  URL past ~8000 chars → drop `logs` then `index-status` from URL, print them
  for user to paste into form.
- **`gh` installed AND authenticated** (`gh auth status` ok) — offer one-step
  alternative, run ONLY after user confirms. API bypasses form → body file
  carries one `### <form label>` heading per field (`TeaRAGs version`,
  `MCP client`, `Embedding provider and model`, `Qdrant mode and version`,
  `OS and Node version`, `Reproduction steps`, `Expected behavior`,
  `Actual behavior`, `get_index_status output`, `Logs`) — same shape as
  form-filed issue:
  ```bash
  gh issue create --repo artk0de/TeaRAGs-MCP --title "[bug]: <summary>" --body-file <tmp-body.md>
  ```
