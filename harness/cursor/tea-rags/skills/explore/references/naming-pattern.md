# Naming pattern (codegraph row 5)

Opened from explore codegraph row 5 ("what does the project call X", "is this
name right", a type `<T>` to name).

`get_naming_lexicon(concept+language | types | names)`. Checked first: the
question quotes a candidate name (`<name>` — "is `<name>` a good name", even
with "or what do we call it") → `names:[{name: "<name>", kind, type?: "<T>"}]` —
its verdict + alternatives answer both halves; never `concept`. No candidate
name, a type `<T>` named ("how is a variable / value of `<T>` named", "как
называть переменную с `<T>`") → copied: `get_naming_lexicon(types:["<T>"])` —
never `concept:"<T>"`. `concept` only for "what do we call X" (X = idea, not a
type). Names in a diff → SKILL.md row 5 (`review_changes`). Answer = dominant
shape + top names/terms with holders; reading + codegraph-off fallback:
`../../data-driven-generation/SKILL.md` Step 5 "Naming (lexicon)".
