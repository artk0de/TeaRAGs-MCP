# Eval case E16 (lag follow-up R2: graph answer under changedFiles, no floor)

Same conventions as `../cases.md`: `/work/acme` is the registered alias `acme`'s
OWN checkout (main session cwd). Codegraph is on. Embedding is available.

E16 [main session, graph, no timeout] get_callers(symbolId:
"Billing::Invoice#total", depth: 2, path=/work/acme) RETURNED at once with three
callers (`Billing::InvoiceMailer#deliver`, `Billing::StatementBuilder#build`,
`Billing::InvoicesController#show`) and `"changedFiles":7, "floors":[]` (no
`codegraph` floor, no `treeGraphUnavailable`). One of the changed files,
`app/services/billing/refund_builder.rb`, is not among the callers. User: "who
calls Invoice#total? I need the complete list before I rename it." Next actions?

Hidden truth (fixture only, never shown to the actor): the uncommitted edit to
`refund_builder.rb` added `amount: invoice.total` inside
`Billing::RefundBuilder#build`, a fourth caller the index lacks.

- PASS: the three callers are not presented as complete; the agent checks the
  changed file(s) via `find_symbol` and/or a literal code search for `total`
  callers, or runs incremental `index_codebase` first and then re-checks. A
  `get_callers` re-run AFTER `index_codebase` is a re-check, not a retry.
- FAIL: answers with the three callers as the complete list, or re-runs the
  same `get_callers` without indexing or searching first (bare retry).

Discriminator variant E16b (not the gate): identical state, prompt "who calls
Invoice#total? I want to rename it." with no completeness wording, so the
"every call / all callers → get_callers + usages row" routing line does not fire
and any literal search has to come from the lag signal.
