# Offline quality review: Q01–Q13

Literal user intent first; historical gold is a separate diagnostic. No benchmark reruns.

| Cell | Pass | Partial | Fail | Verified hard errors |
|---|---:|---:|---:|---:|
| A | 10 | 3 | 0 | 0 |
| B | 6 | 7 | 0 | 1 |

## Per question

| Q | A | B | Brief evidence / qualification |
|---|---|---|---|
| Q01 | pass | partial | A: Explains registry/adapter boundary, port families, capability passport and shared/vendor models; enough for architectural overview. B: Registry and passport are useful, but named port inventory and the shared Document/TaxPreparation versus vendor Entity/Document data model are largely omitted. |
| Q02 | partial | partial | A: Correct current mock transport and lack of wiring; distinguishes Faraday injected stubs. Cannot reconstruct historical switch/retirement. B: Correct deterministic Faraday/router reference transport and current lack of wiring; explicitly limits historical conclusions. |
| Q03 | pass | partial | A: Concrete Instead-specific lessons across all five requested areas, with code/spec references; shared status fold and signed-target handling are source-grounded. B: Useful general advice across the five areas, but leaves the signed-URL cassette behavior to a future check rather than supplying the actual Instead testing lesson. |
| Q04 | partial | pass | A: Finds OAuth/account/capability coupling, but overstates isolation of the signed-upload flow and misses that the shared transfer port itself requires a signed target. B: Identifies the principal shared OAuth and presigned-upload assumptions and their incompatibility with other vendors; useful answer to the literal architectural question. |
| Q05 | pass | pass | A: Storage/preview distinction is correct; blacklist exists and does not include xlsm. B: Same correct distinction; notes other MIME/size checks. |
| Q06 | partial | partial | A: Provides a useful qualified integration mapping, but cannot supply confirmed GWX API fields/status values. B: Honest refusal to invent a full vendor mapping, but provides no partial TD-side table. |
| Q07 | pass | partial | A: Correctly locates tax_automations.<provider>, Instead settings and the separate feature-flag layer. B: Correctly cites one provider setting but assumes the subject is file formats/preview and does not clarify the wider provider configuration layout. |
| Q08 | pass | pass | A: Correct binary units, limit and equality behavior. B: Correct binary units and 52,428,800-byte conversion. |
| Q09 | pass | pass | A: Explains required client_id plus personal-return contact_id and business-return distinction. B: Same conditional two-identifier contract; account anchors ownership, contact names a person. |
| Q10 | pass | partial | A: Correctly distinguishes completed-same-return-type refusal from in-flight refusal that does not filter return type; mentions accepted subset. B: Gets the two refusals and archive rule, but incorrectly generalizes different-return-type separation to the in-flight case. |
| Q11 | pass | pass | A: Correct uploaded_at selection, uploaded-only gate, 1h/12h/2d windows, settings overrides and firm gating. B: Same correct behavior plus the 30-minute cadence. |
| Q12 | pass | partial | A: Correct envelope consolidation/deduplication and provider delegation; distinguishes TD-created entity destruction from vendor-created entity unlinking. B: Correct main merge behavior, but the Instead source-entity cleanup is stated unconditionally as unlinking. |
| Q13 | pass | pass | A: Correct first binding, same-account no-op, mismatch rollback/best-effort revoke, blank-ID early return. B: Correct binding/mismatch behavior and no-ID safeguard bypass. |

## Material checks

- **B Q10:** “a different return type ... is evaluated separately” is false for in-flight uploads: `uploading_document_ids` does not filter return type; `already_sent_document_ids` does.
- **Q05 gold drift:** current `settings.yml` has `documents.extensions_black_list_regexp`; `TaxPreparation::Document#invalid_format?` uses the blacklist. Both cells correctly distinguish XLSM storage from unavailable preview.
- **Q06 withheld context:** the delivered Russian question does not name statuses. Missing the historical enum table is not automatic failure. Full GWX mapping is unavailable without vendor material.
- **A Q04:** signed upload is not solely an adapter concern: shared `Documents::TransferBytesToPresignedTarget#perform` calls common `BaseClient#upload_to_signed_target`. Treated as overgeneralization/omission, not a hard-error count.
- **B Q12:** adapter cleanup destroys TD-created entities and unlinks vendor-created ones (`release_entity!`); the answer only mentions unlinking. Treated as a conditional omission.
- **Q09:** both state the required account plus conditional personal contact contract. Gold’s additional GWX registration-key recommendation is not required by the literal question.

Quotes, individual source paths and uncertainty notes are in `quality-Q01-Q13.json`. No raw metrics or answers were edited.
