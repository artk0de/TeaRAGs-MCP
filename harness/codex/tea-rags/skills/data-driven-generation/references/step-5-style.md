# Step 5: STYLE — data-driven-generation

Loaded by `SKILL.md` Step 5.

Session-context reuse (Prerequisites): the container, template and symbol bodies
fetched in Steps 0–4 are the style source — read them from the conversation; a
file is re-fetched only when edited since. Same for naming: types, anchors and
signatures already in context feed `get_naming_lexicon` without new lookups.

Source per mode: CREATE → blame-owner table below. EXTEND → match the container
file itself. MODIFY → match the symbol itself; blame table = review routing
only.

Use `blameDominantAuthor` from explore pre-gen output (live-line owner — person
whose code you'd match/extend). Style copy mirrors CURRENT code, not historical
commit activity, so use blame-based.

| file.blameDominantAuthorPct.label | Behavior                                              |
| --------------------------------- | ----------------------------------------------------- |
| "deep-silo"                       | Match exactly. Flag the live-line owner for review.   |
| "silo"                            | Match dominant patterns closely. Owner should review. |
| "concentrated"                    | Follow dominant patterns, minor flexibility.          |
| "shared"                          | Project conventions. Opportunity to unify.            |

If `recentDominantAuthor` differs from `blameDominantAuthor` (long-time owner
left, new contributor took over): defer to `blameDominantAuthor` for style
(their code is what's there now), but flag `recentDominantAuthor` as secondary
reviewer for fastest turnaround.

### Naming (lexicon)

Names are the project's ontology. A value the project already names gets the
project's name; a new term only for a genuinely new concept. Learn the
CONVENTION — how a name relates to its value's type and to the call it is bound
from — not one name to copy.

Canonical failure (taxdome, Ruby): the project writes
`tax_automation_document = find_tax_automation_document!(id)`, and a second
binding of that model in one scope gets a qualifier
(`tax_automation_document_ignored`). The agent wrote
`row = find_vendor_envelope(id)` returning a `TaxAutomationDocument`: `row`
carries no type (the Ruby resolver types receivers from names, so the graph
loses edges), `vendor_envelope` is a term the project never uses.

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
  when known. Type unknown but bound from a call →
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

| Shape            | Name to build (casing as the returned names show)                         |
| ---------------- | ------------------------------------------------------------------------- |
| `EXACT`          | the type itself: `tax_automation_document`, plural for a collection       |
| `QUALIFIED`      | EXACT + qualifier, for a second binding of the type in one scope          |
| `TAIL`           | trailing word(s) of the type: `document`                                  |
| `VERB_TYPE`      | `return`: verb + type — `find_tax_automation_document!`                   |
| `CALLEE_DERIVED` | the callee without verb prefix and `!`/`?`: `x = find_x!(id)`             |
| `FREE`           | project names by ROLE — pick from `kinds.<kind>` names; never force EXACT |

- `byType[].kinds.<kind>[].name` = the vocabulary; a dominant name is reused
  verbatim. `confidence` low or `evidence` mostly `name-inferred` = weak
  evidence, prefer the template's code.
- `byCallee` = how the project names values bound from that call (untyped path).
- `concept.terms` = the project's words for the concept. A holder that already
  IS what you are about to write → back to Step 4 and gate that holder (a missed
  reuse, not a naming issue) — never rename and write a sibling.
- `names[]`: `CONFORMS` → keep (it means consistent with the project's
  vocabulary, not a verdict on behaviour; an `alternatives` word on it is the
  project's term for the same concept → prefer it). `MISFIT` → take `suggestion`
  (`holder` shows where the project uses it; a type MISFIT names the missing
  `role`; `role.evidence: "directory"` = location only — rename only when the
  type belongs to `role.examples`' family, else keep the name, reconsider the
  location). `NEW_TERM` → adopt a `topTerms` term or an `alternatives` word if
  it denotes the same concept; otherwise the concept is new — keep the term,
  justify it in Step 6. `NO_CONVENTION` (value) → no demand, not free: take
  `prefer.exact` (type spelled) or a name like `prefer.analogous` (family's);
  justify only a name unlike both. `COLLISION` → the short name is already a
  type elsewhere (`existing`); pick a distinct name.
- `driftWarning` or empty `byType` → no history for the type; take names from
  the template's code and say so.

**Codegraph off** → tool absent; concept part only: `semantic_search` with
`query` = the concept description, `language`, `pathPattern` = L2 (widen to the
project under 5 hits), `filter: { presets: "production" }`,
`rerank: { custom: { similarity: 0.7, imports: 0.3 } }` (import-proxy for the
graph weights), `limit: 30`, `metaOnly: true`. Split holders' symbolIds and
paths into words; recurring terms = the vocabulary. Value names: follow how the
template's code names the same types.

Output: the vocabulary for Step 6.
