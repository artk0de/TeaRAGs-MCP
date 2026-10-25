# Step 5: STYLE — data-driven-generation

Loaded by `SKILL.md` Step 5.

Session-context reuse (Prerequisites): the container, template and symbol bodies
fetched in Steps 0–4 are the style source — read them from the conversation; a
file is re-fetched only when edited since. Same for naming: types, anchors and
signatures already in context feed `get_naming_lexicon` without new lookups.

Style source per mode, the ownership table and the `STYLE` line: `SKILL.md` Step
5 (single definition).

Owner = `blameDominantAuthor` from explore pre-gen output (live-line owner —
person whose code you'd match/extend). Style copy mirrors CURRENT code, not
historical commit activity, so blame-based wins when both labels are present.

If `recentDominantAuthor` differs from `blameDominantAuthor` (long-time owner
left, new contributor took over): defer to `blameDominantAuthor` for style
(their code is what's there now), but flag `recentDominantAuthor` as secondary
reviewer for fastest turnaround.

### Naming (lexicon)

Names are the project's ontology. A value the project already names gets the
project's name; a new term only for a genuinely new concept. Learn the
CONVENTION — how a name relates to its value's type and to the call it is bound
from — not one name to copy.

Canonical failure (Ruby): the project writes
`ledger_entry = find_ledger_entry!(id)`, and a second binding of that model in
one scope gets a qualifier (`ledger_entry_reversed`). The agent wrote
`rec = load_record(id)` returning a `LedgerEntry`: `rec` carries no type (the
Ruby resolver types receivers from names, so the graph loses edges), `record` is
a term the project never uses.

**Codegraph on** (graph tools registered) → ONE `get_naming_lexicon` call here,
before GENERATE — the vocabulary sits in context while writing, so misfits are
prevented, not detected:

| Mode            | `types`                          | `anchors`           | `concept`             | `names`            |
| --------------- | -------------------------------- | ------------------- | --------------------- | ------------------ |
| CREATE          | value types of template+manifest | template + manifest | yes — the new symbol  | the new symbol(s)  |
| EXTEND          | + container field types          | + container         | only for a new method | the new method     |
| MODIFY / hotfix | symbol signature + its locals    | the symbol          | no                    | new locals/methods |

- `language` = target language (required with `concept`); `pathPattern` = target
  area (the tool widens it under 5 rows and reports `scope`).
- Evidence = ONE language namespace per call (languages sharing a
  `typeNamespace`, e.g. TS + JS); other languages' rows never count. So always
  pass `language` with `names[]`; polyglot drafts → one call per language.
  `changes`/`files` split by file language themselves.
- `concept` = a DESCRIPTION of what the new symbol denotes ("pulls signed
  envelopes from the e-signature vendor into tax documents") — never the draft
  name: a draft pulls in its own lexical neighbours.
- `names[]` = drafts with `kind` (`local`/`param`/`field`/`return`) and `type`
  when known. Every draft — the user's included: a draft method/finder goes in
  as `return`, the local it binds as `local`, each entry carrying its own `type`
  (the same type also in `types[]`). Type unknown but bound from a call →
  `callee: { member, receiver? }`. A new class, module, interface, enum or
  constant →
  `{ name, kind: "type", path: <its file>, symbolKind: <class|module|interface|enum|type_alias|constant>, extends?: <planned ancestor> }`:
  the ancestor's family and the directory set the expected role suffix;
  `symbolKind` keeps interface/type_alias/enum out of a class directory's role,
  class out of a shape directory's.
- A `return` draft with no known `type` is judged too — never invent a type to
  force a verdict. A verb the project uses → CONFORMS; a rare one → NEW_TERM
  (`topTerms`); never a MISFIT toward another verb of the same noun (`find_user`
  and `build_user` are different operations — pick the verb for what the method
  does). Verbless → CONFORMS if declared elsewhere, else NO_CONVENTION.

Reading the answer — the dominant shape per kind IS the convention:

| Shape            | Name to build (casing as the returned names show)                          |
| ---------------- | -------------------------------------------------------------------------- |
| `EXACT`          | the type itself: `ledger_entry`, plural for a collection                   |
| `QUALIFIED`      | EXACT + qualifier, for a second binding of the type in one scope           |
| `TAIL`           | trailing word(s) of the type: `document`; `GraphDbClient` param → `client` |
| `VERB_TYPE`      | `return`: verb + type — `find_ledger_entry!`                               |
| `CALLEE_DERIVED` | the callee without verb prefix and `!`/`?`: `x = find_x!(id)`              |
| `FREE`           | project names by ROLE — the top `kinds.<kind>` name; never force EXACT     |

- `byType[].kinds.<kind>[].name` = the vocabulary; the dominant name (highest
  `n`) is reused verbatim — `[client n=40, graphDb n=12]` → `client`, never the
  runner-up because it spells more of the type. `confidence` low or `evidence`
  mostly `name-inferred` = weak evidence, prefer the template's code.
- `byCallee` = how the project names values bound from that call (untyped path).
- `concept.terms` = the project's words for the concept. A holder that already
  IS what you are about to write → back to Step 4 and gate that holder (a missed
  reuse, not a naming issue) — the `BACK-EDGE` line of `SKILL.md` Step 5; never
  rename and write a sibling.
- `names[]`: `CONFORMS` → keep (it means consistent with the project's
  vocabulary, not a verdict on behaviour; an `alternatives` word on it is the
  project's term for the same concept → prefer it). `MISFIT` → take `suggestion`
  (`holder` shows where the project uses it; a type MISFIT names the missing
  `role`; `role.evidence: "directory"` = location only — rename only when the
  type belongs to `role.examples`' family, else keep the name, reconsider the
  location). `NEW_TERM` → adopt a `topTerms` term or an `alternatives` word if
  it denotes the same concept; otherwise the concept is new — keep the term and
  output the line `NEW_TERM <term> — <why no project term denotes this>`.
  `NO_CONVENTION` (value) → no demand, not free: take `prefer.exact` (type
  spelled) or a name like `prefer.analogous` (family's); justify only a name
  unlike both. `COLLISION` → the short name is already a type elsewhere
  (`existing`); pick a distinct name.
- `driftWarning` or empty `byType` → no history for the type; take names from
  the template's code and say so.

**Codegraph off** → tool absent; concept part only: `semantic_search` with
`query` = the concept description, `language`, `pathPattern` = L2 (widen to the
project under 5 hits), `filter: { presets: "production" }`,
`rerank: { custom: { similarity: 0.7, imports: 0.3 } }` (import-proxy for the
graph weights), `limit: 30`, `metaOnly: true`. Split holders' symbolIds and
paths into words; recurring terms = the vocabulary. Value names: follow how the
template's code names the same types.

Output for Step 6: the concrete final name per draft —
`<draft> → <name> (<shape>, <kind>)`, e.g. `rec → ledger_entry (EXACT, local)`,
`load_record → find_ledger_entry! (VERB_TYPE, return)`. A plan that says
"project vocabulary" without spelling the name = not done.
