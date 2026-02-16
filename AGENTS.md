# Agent Rules

## Linter Configuration (MANDATORY)

**Agents MUST NOT modify ESLint, Prettier, or any linter configuration files without explicit user approval.**

This includes:
- `eslint.config.js` — ESLint rules and overrides
- `.prettierrc` — Prettier formatting rules
- `.prettierignore` — Prettier ignore patterns
- `commitlint.config.js` — Commit message rules

### What is prohibited:
- Changing rule severity (error → warn → off)
- Adding eslint-disable comments to bypass rules
- Adding new ignore patterns to skip files
- Modifying rule options or thresholds

### What to do instead:
- **Fix the code** to satisfy the linter rule
- If a rule produces false positives, **report it to the user** with evidence
- If a rule is too strict for a specific case, **ask the user** before adding an exception

### Rationale:
Linter rules are calibrated based on project bug history analysis. Weakening them silently reintroduces the exact bug patterns they were designed to prevent.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
