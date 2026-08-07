<!--
PR title uses the same conventional format as the commits:
  type(scope): subject      e.g. improve(rerank): dampen churn on small samples
Scope is mandatory and decides the version bump — see CONTRIBUTING.md.
-->

## What changed

<!-- One line. If it takes three, the PR is probably two PRs. -->

## Why

<!--
Motivation, and the issue this closes: "Closes #123".
What was wrong or missing before, from a user's point of view.
-->

## How

<!--
The approach, and the alternatives you rejected. Call out anything a reviewer
would otherwise have to reverse-engineer: a new abstraction, a changed contract,
a payload field that needs a reindex to populate.
-->

## Testing

<!--
Commands you actually ran, with their result, plus the coverage delta if this
touches src/. Example:

  npm test -- --run          9130 passed
  npm run type-check         clean
  npm run test:coverage      statements 96.41% (+0.08)

Live validation (indexing, enrichment, MCP tools) — say what you indexed and
what you measured.
-->

## Checklist

- [ ] Commits are conventional with a **scope**: `type(scope): subject`, header
      ≤ 100 chars, subject lowercase and without a trailing period
- [ ] Scope comes from the tables in
      [CONTRIBUTING.md](https://github.com/artk0de/TeaRAGs-MCP/blob/main/CONTRIBUTING.md#scopes)
      — it is what decides the release bump
- [ ] `BREAKING CHANGE:` footer (or `type(scope)!: subject`) if this changes env
      var names, defaults or semantics, config format or location, CLI flags,
      the package name, or data directory paths
- [ ] Tests added or updated for the behavior this changes
- [ ] `npm test -- --run`, `npm run type-check`, and `npm run build` pass
      locally
- [ ] Coverage still clears the CI gate — lines 97, functions 97, branches 87,
      statements 96.2 (`npm run test:coverage`)
- [ ] Docs under `website/docs/` updated if behavior, configuration, or an MCP
      tool changed
- [ ] `plugin.json` version bumped if anything under `.claude-plugin/` changed
      (the pre-commit hook enforces this)
- [ ] `CHANGELOG.md` left alone — release notes are generated from commit
      subjects, so write subjects that read like release notes
