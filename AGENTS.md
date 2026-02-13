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
