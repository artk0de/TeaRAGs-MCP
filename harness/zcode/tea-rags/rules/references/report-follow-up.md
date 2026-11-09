# Report follow-up — after a risk / architecture report

Owner: the `→` offer line ending a `risk-assessment` or
`architecture-diagnostics` report. The report only OFFERS; read this file in the
turn the user answers.

## Branch A — "here and now"

1. One case per turn, report order (#1 first) unless the user names a case.
2. Run that case's `Next steps` row: its Call, with the row's symbol /
   `pathPattern`. A case with several rows → rows in table order.
3. End the turn with the case result + one line:
   `→ Next: #<n+1> <symbol/component> — continue, skip, or file the rest as tasks?`
4. Code change inside a case → that skill's own gates (TDD, review) apply; a
   report row is not an approved design.

## Branch B — "file tasks"

1. One task per case (Critical/High rows, or report findings); Medium only on
   request.
2. Draft each task — title `<Risk Type / finding>: <symbol or component>`; body
   = the case card verbatim (Problem / What's wrong / evidence numbers, commit
   links) + `Next steps` Action and Call + `File:Line`.
3. Pick the tracker, first match:
   - `.beads/` in repo →
     `bd create --title="<title>" --type=task --description="<body>"`
   - a tracker tool in your tool list (Jira, Linear, GitHub issues) → that tool
   - `gh` available + GitHub remote →
     `gh issue create --title "<title>" --body "<body>"`
   - none → print the drafts as Markdown, say no tracker found.
4. Creating a task publishes it — show the drafts + target tracker and get an
   explicit yes BEFORE the first create. Print
   `tasks: <n> drafted → <tracker>; awaiting confirmation`.
5. After creating: list created ids/links, one per case.

Never start a case or create a task before the user picks a branch.
