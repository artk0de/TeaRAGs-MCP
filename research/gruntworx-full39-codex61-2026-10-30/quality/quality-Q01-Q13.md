# Independent offline quality review: Sol Q01–Q13

Read the literal questions and all 26 fresh Sol answers individually. Assess each answer against its question and earlier delivered questions/answers; context_added and historical hidden context are not treated as delivered. Consult historical gold only as a separate diagnostic and verify suspected substantive contradictions against current code. No penalty for no tools, a concise answer, or honestly unavailable vendor/history information. Pass is sufficient substantive correctness, partial is a concrete error or material incompleteness, fail would be a predominantly wrong/nonresponsive answer.

| Condition | Pass | Partial | Fail | Verified hard errors |
|---|---:|---:|---:|---:|
| A | 12 | 1 | 0 | 0 |
| B | 11 | 2 | 0 | 1 |

Only confirmed hard error: **BQ10** assigns a same-return-type scope to the in-flight duplicate guard. That guard has no return-type filter.

## Per-question judgments

### Q01

**A: partial** (high). Architecture, registration, capabilities and data model are accurate, but the list explicitly presented as what an adapter namespace must provide omits Documents::ReconcileStatusesAsync, a required dispatch contract. Several shared status/cleanup ports are also summarized rather than inventoried.

> Namespace адаптера должен предоставлять

Evidence: app/workers/tax_preparation/tax_automations/documents/reconcile_sweep_worker.rb:34–40 directly calls adapter::Documents::ReconcileStatusesAsync.call(owner.user, owner, connection, ...). Registry ADAPTERS and FEATURE_FLAGS contain only Instead (app/lib/tax_preparation/tax_automations/registry.rb:6–13).

**B: pass** (high). Covers the shared-port groups, required adapter reconciliation service, static registry, capability structure, common envelope/send state machines and vendor-specific models. Correctly distinguishes reserved GruntWorx enum from a registered adapter.

> Documents::ReconcileStatusesAsync

Evidence: registry.rb:6–13 and reconcile_sweep_worker.rb:34–40 confirm the dispatch and required service; the answer includes the contract A omitted.

Gold diagnostic: Both summarize rather than reproduce every historical port name. No separate penalty for missing isolated aliases or every API detail; A's missing adapter reconciliation entry is material because the question explicitly asks the namespace contract.

### Q02

**A: pass** (high). Identifies the bottom-of-stack Faraday adapter, stateless router, deterministic handles, current VCR/WebMock/test transport distinction and lack of current wiring. Explicitly leaves original activation and original spec setup unverified.

> The current checkout does not establish the original activation switch or historical spec setup.

Evidence: app/lib/tax_preparation/tax_automations/instead/mock/adapter.rb:3–11 says wired into nothing and explains middleware preservation. BaseClient#adapter_spec, base_client.rb:408–416, selects injected :test transport or Faraday.default_adapter.

**B: pass** (high). Same correct current-state distinctions and honest limit on inaccessible historical activation/spec wiring.

> Its historical activation and historical spec usage cannot be reconstructed reliably from the accessible current files.

Evidence: mock/adapter.rb:3–11; BaseClient#adapter_spec at base_client.rb:408–416.

Gold diagnostic: Gold names the removed tax_automations_instead_mocks flag and historical commits. Git/history was denied in the benchmark; absence of those inaccessible historical facts is not scored as failure. Neither answer invents them.

### Q03

**A: pass** (medium-high). Addresses all five requested lesson areas: grouped/app-wide throttling, bounded reconciliation, shared failure reasons, cassette clock control and conservative entity matching. Vendor numbers are explicitly not proposed as GruntWorx defaults.

> Only unauthorized uploads automatically resume after reconnect.

Evidence: ReconcileCandidatesQuery at app/queries/tax_preparation/tax_automations/documents/reconcile_candidates_query.rb:8–26,40–45 confirms 1h/12h/2d windows; spec/support/vcr_fixed_time.rb:3–17 freezes replay at recorded_at. LinkEntityByName#perform, instead/clients/link_entity_by_name.rb:49–63, filters active unlinked entities by firm/type.

**B: pass** (medium-high). Covers the same requested operational lessons with concrete retry, lost-event, credential-scrubbing and ambiguity safeguards; keeps vendor semantics conditional for GruntWorx.

> Ambiguous matches never auto-link.

Evidence: ReconcileCandidatesQuery:8–26,40–45; vcr_fixed_time.rb:3–17; Instead::Clients::LinkEntityByName#perform:49–63.

Gold diagnostic: Neither explicitly explains failure_reason integer alignment with Juno. That historical detail is not required to satisfy the five lesson topics. This review spot-checks the substantive claims rather than independently re-auditing every incidental limit/header/scrubbing detail.

### Q04

**A: pass** (high). Separates mandatory OAuth-shaped contracts from optional upload helpers, and identifies account binding, duplicate-send semantics, capability granularity and document-oriented state assumptions. Correctly treats actual GruntWorx incompatibility as unconfirmed.

> This is an optional helper: an adapter’s ExportAsync can own a different upload workflow.

Evidence: BaseClient#upload_to_signed_target, app/lib/tax_preparation/tax_automations/base_client.rb:243–274, always calls upload_connection.post with multipart fields. ValidateDocuments#already_sent_document_ids contains the explicit Instead entity/path/archive rationale. Connections::Create#bind_account! at connections/create.rb:119–128 implements binding.

**B: pass** (high). Gives concrete OAuth, upload, duplicate, account, reconnect and capability assumptions. The extra warning about resumption against a mutable envelope is grounded in the shared implementation.

> resumption groups them by envelope and passes its current values

Evidence: Documents::ResumeSends#perform at documents/resume_sends.rb:33–48 groups records by tax_preparation; #resend! at58–63 passes that envelope to adapter::ExportAsync. BaseClient#upload_to_signed_target:243–274 confirms POST-only helper.

Gold diagnostic: Both omit the closed frontend provider union and an explicit lack-of-result-import-port discussion. Their substantial backend portability analysis still answers the literal open question; these omissions are recorded as coverage diagnostics, not hard errors.

### Q05

**A: pass** (high). Correctly distinguishes storage blacklist from preview allowlist: XLSM storage allowed, preview not enabled; PDF/XLS allowed and previewable.

> An .xlsm file is allowed for storage, but is not currently marked previewable.

Evidence: config/settings.yml:1093 onward has extensions_black_list_regexp without xlsm and previewable_extensions_regexp containing xls/xlsx but not xlsm. TaxPreparation::Document#previewable?, app/models/tax_preparation/document.rb:843–845, checks the preview regex and positive size.

**B: pass** (high). Same correct distinction and XLSM outcome; adding an extension alone is not claimed to prove renderer compatibility.

> Storage uses an extension blocklist, rather than an allowlist.

Evidence: config/settings.yml:1093 onward; TaxPreparation::Document#previewable? at document.rb:843–845.

Gold diagnostic: Historical gold's assertion that no general document extension blocklist exists is stale and contradicted by current settings. Both answers correctly follow current code.

### Q06

**A: pass** (medium). Provides a broad TD↔GWX planning table, distinguishes known TD concepts from unknown GWX identifiers/statuses, includes shared states/failure vocabulary and the only user-supplied vendor result formats. It does not pretend unavailable GWX contracts are known.

> точные имена полей, операций и статусов GWX не подставляю предположениями

Evidence: The literal question requests a full mapping without narrowing it to statuses. Earlier delivered Q01–Q05 establish TD ports/model and PDF/XLS/XLSM, but not the GWX API. Current Registry and reconcile/merge/binding code support the TD-side concepts; settings/Document#previewable? support the result-format rows.

**B: partial** (medium-low). Correctly requests missing GWX documentation and avoids fabrication, but supplies only a three-row result-format table. It could have tabulated known TD entities/fields/statuses/errors with the GWX side explicitly unknown, as the requested mapping deliverable; most of those TD concepts were already in its previous answers.

> Известны только форматы результатов

Evidence: Its own Q01 lists the shared envelope/send model and state machines; Q03 lists the shared failure vocabulary. Those are known TD-side mapping facts even though exact GWX correspondences are unavailable.

Gold diagnostic: Gold treats this as a status-enum request, but the delivered literal question says only full TD↔GWX mapping. Hidden context_added is not imposed. A's broader table is accepted. B's partial is a deliverable-completeness judgment, not a penalty for refusing unknown GWX facts; a more permissive rubric could accept its clarification as a pass.

### Q07

**A: pass** (medium-high). Accepts the user's configuration clarification, explicitly labels the GWX mock toggle as a future requirement and does not claim it already exists.

> для GWX фиксируем это как требование, а не как уже существующую настройку

Evidence: config/settings.yml:1788 onward contains tax_automations with provider-scoped instead settings; BaseClient#adapter_spec:408–416 does not consult a mock switch.

**B: pass** (medium-high). Shows a provider-scoped config example and explicitly calls mock_enabled a proposed key. Preserves the distinction between user clarification and current-code evidence.

> Это предлагаемый ключ, не существующая настройка.

Evidence: config/settings.yml:1788 onward; BaseClient#adapter_spec:408–416.

Gold diagnostic: This short follow-up is interpreted in the delivered conversation's mock/config planning context. Neither answer is penalized for not reproducing every existing provider setting.

### Q08

**A: pass** (high). Correct binary units and exact-limit acceptance: 50 means 52,428,800 bytes, not decimal 50,000,000.

> Binary MiB, despite the field being named max_file_size_mb.

Evidence: ValidateDocuments#unsupported_file, app/services/tax_preparation/tax_automations/export/validate_documents.rb:112–119, uses terms.max_file_size_mb.megabytes and rejects only document.file_size > limit.

**B: pass** (high). Same correct unit conversion and inclusive boundary.

> A file exactly that size is accepted.

Evidence: ValidateDocuments#unsupported_file at validate_documents.rb:112–119.

Gold diagnostic: Both cover the substantive gold fact. Some answer line citations are approximate; the verified method is112–119, not B's142. This does not change behavioral correctness.

### Q09

**A: pass** (high). Correctly separates mandatory account identity/document scope from the personal-return contact, and states the envelope key excludes mutable return_type.

> Both, with different roles

Evidence: TaxPreparations::FindOrCreate#find_tax_preparation at tax_preparations/find_or_create.rb:113–115 keys firm/client/contact/year; #fetch_contact_id! at84–95 verifies contact membership through the account.

**B: pass** (high). Same correct personal/business distinction and envelope identity; does not flatten all taxpayers to the account alone.

> Both, with the TaxDome account (client_id) always required.

Evidence: FindOrCreate#find_tax_preparation:113–115; #fetch_contact_id!:84–95; ExportAsync send parameters cited in the answer.

Gold diagnostic: The literal question asks current shared entry-point identity. Neither answer must additionally prescribe a GWX registration key from unavailable GWX semantics.

### Q10

**A: pass** (high). Correctly distinguishes same-return-type uploaded duplicates from in-flight duplicates across return types, plus archive/failed-upload exceptions and partial acceptance.

> waiting or uploading, regardless of return type

Evidence: ValidateDocuments#already_sent_document_ids adds where(return_type: params[:payload][:return_type]); #uploading_document_ids only filters waiting/uploading and merges tax_automation_documents_for_payload, without that return_type filter. Both bodies were independently retrieved through scoped find_symbol.

**B: partial** (high). Correct refusal names, states, archive/failed cases and no-vendor early return, but incorrectly gives both duplicate checks a same-return-type scope. A waiting/uploading send under another return type still blocks the new send.

> Shared validation checks prior send records for the same firm, account, contact, tax year, provider and return type.

Evidence: app/services/tax_preparation/tax_automations/export/validate_documents.rb, ValidateDocuments#uploading_document_ids: Document.where(upload_status: %i[waiting uploading]).merge(tax_automation_documents_for_payload).pluck(:document_id).to_set. In contrast #already_sent_document_ids explicitly adds where(return_type: params[:payload][:return_type]).

Gold diagnostic: This is a concrete current-code contradiction, not a gold-coverage omission. It affects a real cross-return-type concurrent-send case.

### Q11

**A: pass** (high). Correct uploaded-only intermediate states, uploaded_at clock, inclusive 1h/12h/2d thresholds, provider overrides, firm grouping and eligibility gates; accurately says older sends remain unchanged.

> All ages use uploaded_at, not creation time or the last status change.

Evidence: ReconcileCandidatesQuery at app/queries/tax_preparation/tax_automations/documents/reconcile_candidates_query.rb:8–45 contains all windows and connected/owner/feature gates; reconcile_sweep_worker.rb:21–40 groups by firm and dispatches the adapter.

**B: pass** (high). Same correct candidate-selection mechanics and thresholds.

> Both groups are restricted to uploads no older than 2 days.

Evidence: reconcile_candidates_query.rb:8–45; reconcile_sweep_worker.rb:21–40.

Gold diagnostic: Both cover the requested thresholds, selection and override facts.

### Q12

**A: pass** (high). Correctly explains envelope reassignment/merge, duplicate tuple, retained send states, current-provider hook and local Instead entity handling. Includes the source_taxdome destroy versus vendor-origin unlink distinction.

> The redundant local entity is deleted if TaxDome created it, or unlinked if it originated at Instead.

Evidence: TaxPreparations::MergeForContact at tax_preparations/merge_for_contact.rb:32–52,70–98 moves nonduplicates then invokes provider merge before batch destroy. Instead::MergeForContact at instead/merge_for_contact.rb:42–55 repoints local rows and destroys only source_taxdome? entities; otherwise clears client_id/contact_id.

**B: pass** (high). Same correct local merge and conditional entity deletion/unlinking; explicitly notes the current-provider limitation and absence of a remote merge API call.

> deletes the redundant TaxDome-created entity row or unlinks a vendor-origin entity row

Evidence: tax_preparations/merge_for_contact.rb:32–52,70–98; instead/merge_for_contact.rb:42–55.

Gold diagnostic: Both cover the gold's shared lifecycle and add correctly verified adapter detail.

### Q13

**A: pass** (high). Correct initial/same/different/blank tenant cases, transaction rollback and stray-grant revocation. Correctly says blank tenant disables identity protection and explicitly covers disconnect clearing.

> Any | No identifier | Skip the binding check; accept connection and preserve any existing binding.

Evidence: Connections::Create#bind_account!, app/services/tax_preparation/tax_automations/connections/create.rb:119–128, returns on blank/same, stores first tenant, otherwise raises AccountMismatchError with connection.dup. #perform at42–73 places binding in transaction and invokes withdraw_stray_grant on mismatch.

**B: pass** (high). Correct binding table, rollback, best-effort revocation and provider-switch reset. Directly answers the no-account-identifier case.

> Skip the check; allow connection and leave any existing binding unchanged.

Evidence: Connections::Create#bind_account!:119–128 and #perform:42–73.

Gold diagnostic: B omits explicit disconnect clearing, which is ancillary to the asked reconnect protection/blank identifier behavior; no separate penalty.

## Limits

- Offline human-style team judgment, not an additional benchmark/model run. No production edits, reindex, commits, or raw-output/metrics changes.
- No GWX API specification or historical context_added was delivered to these chats; unavailable vendor mappings and blocked git history are not fabricated or required.
- Q06B partial is lower-confidence and sensitive to whether an appropriate clarification counts as satisfying an underspecified full-table request. If accepted as pass, B totals become12pass/1partial/0fail; its one verified hard error remains unchanged.
- Targeted current-code checks validate suspected material contradictions and central behaviors. This is not an exhaustive independent audit of every incidental detail in long architecture/lesson answers.
- Citation line precision is not scored as a separate hard behavioral error. Some answers cite nearby rather than exact current method lines.
- Historical gold coverage is diagnostic only. Current source overrides stale gold, especially Q05; no status-only interpretation is imposed on the broad literal Q06.
