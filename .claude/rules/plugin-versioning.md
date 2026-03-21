# Plugin Versioning (MANDATORY)

**Every commit that modifies `plugin/` files MUST bump the version in
`plugin/.claude-plugin/plugin.json`.**

- New skill or rule file → **minor** bump (0.1.0 → 0.2.0)
- Text changes to existing skills/rules → **patch** bump (0.1.0 → 0.1.1)

Check before committing:

```bash
git diff --cached --name-only | grep '^plugin/'
```

If any plugin files are staged, bump version BEFORE `git commit`.
