# Eval cases — tea-rags addressing (project vs path)

For EACH case give the EXACT addressing params of your next tea-rags call(s):
which of `project` / `path` / `collection` you pass and their values (other
params briefly). Then one line of reasoning. Execute nothing.

Fixture: repository `acme`, registered alias `acme`, registry path `/work/acme`
(the main checkout). Linked worktrees live under
`/work/acme/.claude/worktrees/<name>`. Prime digest shows `## Project` →
`name: acme`.

---

C1 [main session, cwd /work/acme, main checkout switched to branch feat/x with
uncommitted edits] Show the body of `Billing::Invoice#total`.

C2 [main session, cwd /work/acme/.claude/worktrees/feat-y] Find all usages of
`PriceCalculator`.

C3 [subagent: task-agent, cwd /work/acme/.claude/worktrees/feat-y; parent told
you the task, nothing about tea-rags addressing beyond any injected block] Get
the callers of `Pricing#apply`.

C4 [main session, cwd /work/acme, you just edited 3 files with Edit] The next
step searches a different area — refresh the index first. Exact `index_codebase`
params?

C5 [main session, cwd /work/acme/.claude/worktrees/feat-y, edited 2 files] Do
you call `index_codebase`? If yes, exact params.

C6 [main session, cwd /work/acme/.claude/worktrees/feat-y] Your previous call
was `find_symbol(symbol: "Order", path: "/work/acme/.claude/worktrees/feat-y")`
and its answer carried
`"workingTree":{"tree":"/work/acme/.claude/worktrees/feat-y", "project":"acme",…}`.
Next call: semantic_search for "order cancellation flow".

C7 [main session, cwd /work/acme/.claude/worktrees/feat-y] Your previous call
`hybrid_search(project: "acme", query: …)` answered with
`"workingTree":{"tree":"/work/acme",…}`. What now?

C8 [main session, cwd /work/acme] Review the uncommitted diff before commit with
`review_changes`.

C9 [main session, cwd /work/newrepo — NOT registered; prime shows no project]
Index it for the first time.

C10 [script / CLI context, no working directory concept] Query acme's index for
"retry policy".

C11 [subagent: explore, cwd /work/acme] How does checkout flow reach payment
capture? First call addressing?

C12 [main session, cwd /work/acme, you only hold the collection name
`code_1a2b3c` from list_collections, project unknown] Search it.
