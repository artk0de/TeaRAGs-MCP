# Q27–Q39 independent offline grading

Literal questions and current checked-in code control the grades. Gold is a navigation aid; hidden context_added was not delivered. No penalty for answering without tools, and no historical requirements were imposed unless asked. All schema findings consider later migrations. CRM Public API is the internal Crm::Api contract. GWX proposals were not treated as established vendor contracts.

| Arm | Pass | Partial | Fail | Score |
|---|---:|---:|---:|---:|
| A | 13 | 0 | 0 | 13/13 |
| B | 12 | 1 | 0 | 12.5/13 |

The only material omission is B Q39: the main document and checklist serializers exposing prefixed send-status fields are missing. No false current-code claim was identified in the other answers.

Current-code corrections to old gold: Q34 uses a two-argument helper bound to instead_contract; Q37 includes a ninth metric, entity_matches_total. Q31 lacks its preceding naming proposal in the literal delivered question, so hidden historical specifics were not required.

## Q27

A: **pass**. Correctly distinguishes existing shared lifecycle services from adapter entry points and identifies DisconnectAll as shared, with its OAuth-shaped assumptions.

B: **pass**. Correctly distinguishes existing shared lifecycle services from adapter entry points and identifies DisconnectAll as shared, with its OAuth-shaped assumptions.

Evidence:
- `/Users/Shared/nav-ab/repo-master/app/services/tax_preparation/tax_automations/connections/disconnect_all.rb` — perform, lines 28–47: Registry.connections_for, disconnect, RevokeAsync, marker reset
- `/Users/Shared/nav-ab/repo-master/app/services/tax_preparation/tax_automations/documents/resume_sends.rb` — resend!, lines 58–63: adapter::ExportAsync
- `/Users/Shared/nav-ab/repo-master/app/services/tax_preparation/tax_automations/firms/destroy_cleanup.rb` — destroy_provider_records!, lines 53–61: every adapter::DestroyForFirm
- `/Users/Shared/nav-ab/repo-master/app/services/tax_preparation/tax_automations/tax_preparations/batch_destroy.rb` — drop_provider_records!, lines 48–59: adapter::DestroyForTaxPreparations

Hard errors: None identified.

## Q28

A: **pass**. Correctly explains the persistent firm/account binding, transient connection attribute, first/same/different/missing-account cases, rollback and best-effort grant revocation, and explicit-disconnect/provider-switch reset.

B: **pass**. Correctly explains the persistent firm/account binding, transient connection attribute, first/same/different/missing-account cases, rollback and best-effort grant revocation, and explicit-disconnect/provider-switch reset.

Evidence:
- `/Users/Shared/nav-ab/repo-master/app/services/tax_preparation/tax_automations/connections/create.rb` — bind_account!, lines 119–128; choose_provider!, lines 105–117; perform, lines 42–73; withdraw_stray_grant, lines 130–136
- `/Users/Shared/nav-ab/repo-master/app/lib/tax_preparation/tax_automations/instead/client.rb` — grant_identity, lines 195–199: firm_uuid is external_tenant_uuid
- `/Users/Shared/nav-ab/repo-master/app/models/concerns/tax_preparation/tax_automations/has_oauth_connection.rb` — virtual string attribute external_tenant_uuid, lines 41–43
- `/Users/Shared/nav-ab/repo-master/db/migrate/20260731110427_add_external_uuids_to_tax_automations.rb` — persistent external_tenant_uuid has PostgreSQL uuid type
- `/Users/Shared/nav-ab/repo-master/db/migrate/20261019194834_add_external_tenant_uuid_index_to_tax_preparation_tax_automations_firm_settings.rb` — nonunique partial external_tenant_uuid index

Uncertainty / grading boundary:
- The account-A/account-B values are conceptual examples, not valid UUID literals. A omits the UUID storage-type limitation; this was not treated as a core behavioral error for the literal open-ended marker question.

Hard errors: None identified.

## Q29

A: **pass**. Correct authorization action (:read), usable-connection lookup, workflow arguments and perform_async_operation call, with after-commit scheduling and async result.

B: **pass**. Correct authorization action (:read), usable-connection lookup, workflow arguments and perform_async_operation call, with after-commit scheduling and async result.

Evidence:
- `/Users/Shared/nav-ab/repo-master/app/services/tax_preparation/tax_automations/instead/export_async.rb` — perform, lines 28–38, contains the full requested behavior
- `/Users/Shared/nav-ab/repo-master/app/policies/tax_preparation/tax_automations/connection_policy.rb` — can_read?, lines 6–20, confirms A’s additional permission details

Hard errors: None identified.

## Q30

A: **pass**. Correct current schema answer: firms have no equivalent UUID column found; contacts.uid and clients.uid are PostgreSQL UUIDs. Correctly separates TD identity from the vendor-account marker.

B: **pass**. Correct current schema answer: firms have no equivalent UUID column found; contacts.uid and clients.uid are PostgreSQL UUIDs. Correctly separates TD identity from the vendor-account marker.

Evidence:
- `/Users/Shared/nav-ab/repo-master/db/migrate/20241228010533_init_schema.rb` — firms definition begins at line 1567
- `/Users/Shared/nav-ab/repo-master/db/migrate/20260511100000_add_uid_to_contacts_and_clients.rb` — adds uid as uuid to contacts and clients
- `/Users/Shared/nav-ab/repo-master/db/migrate/20260511105000_set_default_uid_for_contacts_and_clients.rb` — gen_random_uuid defaults
- `/Users/Shared/nav-ab/repo-master/db/migrate/20260511120000_add_check_constraint_on_uid_for_contacts_and_clients.rb` — uid IS NOT NULL constraints
- `/Users/Shared/nav-ab/repo-master/db/migrate/20260511120001_validate_check_constraint_and_add_index_on_uid_for_contacts_and_clients.rb` — validates constraints and adds unique indexes
- `/Users/Shared/nav-ab/repo-master/db/data/20260511110000_backfill_uid_on_contacts.rb` — backfill file found in complete db/ filename search
- `/Users/Shared/nav-ab/repo-master/db/data/20260511110001_backfill_uid_on_clients.rb` — backfill file found in complete db/ filename search

Uncertainty / grading boundary:
- Firm UUID absence is a checked-in-code finding, not an assertion about an inspected live database. Initial table plus later UID/UUID migration filename searches were considered.

Hard errors: None identified.

## Q31

A: **pass**. Provides consistent Instead-to-GruntWorx namespaces/service roles and preserves the meaning of external IDs. GWX names are presented as proposed conventions, not facts about an unseen future vendor contract.

B: **pass**. Provides consistent Instead-to-GruntWorx namespaces/service roles and preserves the meaning of external IDs. GWX names are presented as proposed conventions, not facts about an unseen future vendor contract.

Evidence:
- `/Users/Shared/nav-ab/repo-master/app/services/tax_preparation/tax_automations/instead/export_async.rb` — Instead::ExportAsync exists
- `/Users/Shared/nav-ab/repo-master/app/workers/tax_preparation/tax_automations/instead/operation_worker.rb` — Instead::OperationWorker exists
- `/Users/Shared/nav-ab/repo-master/app/lib/tax_preparation/tax_automations/instead/mock/adapter.rb` — Instead::Mock::Adapter exists, currently disconnected
- `/Users/Shared/nav-ab/repo-master/app/lib/tax_preparation/tax_automations/instead/mock/router.rb` — Instead::Mock::Router exists, currently disconnected
- `/Users/Shared/nav-ab/repo-master/app/models/tax_preparation/tax_automations/instead/entity.rb` — Entity is the vendor taxpayer model; no answer claims the proposed API Client is this model

Uncertainty / grading boundary:
- The literal follow-up contains no preceding proposed naming list. No hidden context_added or historical gold requirements were imposed; consistency is judged from the response itself and existing role names.

Hard errors: None identified.

## Q32

A: **pass**. Correctly treats adapter::Documents::ReconcileStatusesAsync as the adapter implementation of an existing shared contract rather than a new shared mechanism.

B: **pass**. Correctly treats adapter::Documents::ReconcileStatusesAsync as the adapter implementation of an existing shared contract rather than a new shared mechanism.

Evidence:
- `/Users/Shared/nav-ab/repo-master/app/workers/tax_preparation/tax_automations/documents/reconcile_sweep_worker.rb` — reconcile, lines 34–42: resolves connection and invokes adapter service as Owner with connection and IDs

Hard errors: None identified.

## Q33

A: **pass**. Correct hierarchy for send steps, byte transfer and webhook processing; correct unthrottled transfer/webhook queues and retry-exhaustion file failure mapping.

B: **pass**. Correct hierarchy for send steps, byte transfer and webhook processing; correct unthrottled transfer/webhook queues and retry-exhaustion file failure mapping.

Evidence:
- `/Users/Shared/nav-ab/repo-master/app/workers/tax_preparation/tax_automations/operation_worker.rb` — RETRY_ATTEMPTS=10; sidekiq_retries_exhausted, lines 27–35 chains parent first
- `/Users/Shared/nav-ab/repo-master/app/workers/tax_preparation/tax_automations/instead/export_operation_worker.rb` — step_only!, inherited base, full exhaustion callback lines 3–25
- `/Users/Shared/nav-ab/repo-master/app/workers/tax_preparation/tax_automations/instead/clients/create_entity_worker.rb` — ExportOperationWorker inheritance, entities throttle group, all send IDs
- `/Users/Shared/nav-ab/repo-master/app/workers/tax_preparation/tax_automations/instead/documents/transfer_bytes_worker.rb` — ExportOperationWorker, high unthrottled queue
- `/Users/Shared/nav-ab/repo-master/app/workers/tax_preparation/tax_automations/instead/webhooks/process_event_worker.rb` — Instead::OperationWorker, high unthrottled queue
- `/Users/Shared/nav-ab/repo-master/app/services/tax_preparation/tax_automations/documents/fail_upload.rb` — perform lines 26–40 broadcasts after commit; fail_send! lines 42–49 guards transitions

Hard errors: None identified.

## Q34

A: **pass**. Correct gem (json-schema 6.2.0), JSON::Validator component-root validation and fixture mappings. Correctly limits the claim to explicit payload examples rather than automatic validation of every mock HTTP exchange.

B: **pass**. Correct gem (json-schema 6.2.0), JSON::Validator component-root validation and fixture mappings. Correctly limits the claim to explicit payload examples rather than automatic validation of every mock HTTP exchange.

Evidence:
- `/Users/Shared/nav-ab/repo-master/spec/support/tax_automations_helpers.rb` — instead_contract lines 85–87; conforms_to_contract?(schema_name,payload) lines 89–93
- `/Users/Shared/nav-ab/repo-master/spec/unit/tax_preparation/lib/tax_automations/instead/client_spec.rb` — fixture conformance examples near lines 696–713: Entity, File, SignedUpload and TokenResponse
- `/Users/Shared/nav-ab/repo-master/Gemfile.lock` — json-schema (6.2.0), line 652

Uncertainty / grading boundary:
- Gold claims a contract-path argument, but the current helper demonstrably has only schema_name and payload. Current code controls this grade.

Hard errors: None identified.

## Q35

A: **pass**. Correct internal CRM Public API calls: Contact.find and list_by_ids expose first/last names; list_by_account returns combined name. contacts.uid is not exposed by these mappings/contracts, so API extension is required.

B: **pass**. Correct internal CRM Public API calls: Contact.find and list_by_ids expose first/last names; list_by_account returns combined name. contacts.uid is not exposed by these mappings/contracts, so API extension is required.

Evidence:
- `/Users/Shared/nav-ab/repo-master/app/services/crm/api/contact.rb` — find lines 87–111; list_by_ids lines 141–168; list_by_account lines 170–184; contact_data lines 387–406
- `/Users/Shared/nav-ab/repo-master/app/services/crm/api/contracts/contact/find/result.rb` — Data contract has name fields but no uid/uuid
- `/Users/Shared/nav-ab/repo-master/app/services/tax_preparation/tax_automations/instead/clients/create_entity.rb` — fetch_contact!, lines 106–114 calls internal Crm::Api::Contact.find

Hard errors: None identified.

## Q36

A: **pass**. Correct current indexes and FKs, including later migrations: unique firm-only connection index replaces creator-composite uniqueness; refresh-expiry partial index; both firm/external and global document UUID unique partial indexes; document/entity FKs and cascading shared-send FK.

B: **pass**. Correct current indexes and FKs, including later migrations: unique firm-only connection index replaces creator-composite uniqueness; refresh-expiry partial index; both firm/external and global document UUID unique partial indexes; document/entity FKs and cascading shared-send FK.

Evidence:
- `/Users/Shared/nav-ab/repo-master/db/migrate/20260728173319_create_tax_preparation_tax_automations_instead_connections.rb` — creation: soft firm ref and original actor composite index
- `/Users/Shared/nav-ab/repo-master/db/migrate/20260731125304_rename_actor_to_creator_on_instead_connections.rb` — actor-to-creator columns and composite index rename
- `/Users/Shared/nav-ab/repo-master/db/migrate/20260806132558_make_instead_connections_unique_per_firm.rb` — adds unique firm index and removes creator composite
- `/Users/Shared/nav-ab/repo-master/db/migrate/20260922130328_add_refresh_expires_at_index_to_tax_preparation_tax_automations_instead_connections.rb` — refresh_expires_at WHERE status = 1
- `/Users/Shared/nav-ab/repo-master/db/migrate/20260731110423_create_tax_preparation_tax_automations_instead_documents.rb` — document creation indexes and FKs
- `/Users/Shared/nav-ab/repo-master/db/migrate/20260915170006_add_external_uuid_index_to_tax_preparation_tax_automations_instead_documents.rb` — later global unique partial external_uuid index

Hard errors: None identified.

## Q37

A: **pass**. Correctly enumerates all nine current application metrics and tags, including entity_matches_total absent from the older gold list; gauge collection and stale-sent semantics are supported by current code.

B: **pass**. Correctly enumerates all nine current application metrics and tags, including entity_matches_total absent from the older gold list; gauge collection and stale-sent semantics are supported by current code.

Evidence:
- `/Users/Shared/nav-ab/repo-master/config/initializers/yabeda.rb` — tax_automations group begins at line 33; nine metric declarations and Sidekiq-only Registry adapter collector
- `/Users/Shared/nav-ab/repo-master/app/lib/tax_preparation/tax_automations/metrics.rb` — count_installations lines 36–42; cached_count lines 44–54 uses replica and 60s cache
- `/Users/Shared/nav-ab/repo-master/app/workers/tax_preparation/tax_automations/documents/reconcile_sweep_worker.rb` — count_stale_sends lines 10–18 checks sent candidates and reconcilable connections
- `/Users/Shared/nav-ab/repo-master/app/queries/tax_preparation/tax_automations/documents/reconcile_candidates_query.rb` — list_sent_tax_automation_documents lines 22–27: uploaded/sent and age threshold

Uncertainty / grading boundary:
- Gold enumerates eight metrics; current code defines nine including entity_matches_total. No penalty for matching current code.

Hard errors: None identified.

## Q38

A: **pass**. Satisfies the requested proposed 50 RPM per-firm throttle in addition to an app budget, with firm-keyed accounting and local-before-global ordering. Does not invent a concrete GWX provider-wide limit.

B: **pass**. Satisfies the requested proposed 50 RPM per-firm throttle in addition to an app budget, with firm-keyed accounting and local-before-global ordering. Does not invent a concrete GWX provider-wide limit.

Evidence:
- `/Users/Shared/nav-ab/repo-master/config/initializers/sidekiq.rb` — Instead threshold array near lines 100–136: local/group limit first, app second; comment explains short-circuit accounting

Uncertainty / grading boundary:
- This is a design acknowledgement, not implementation verification. A per-firm RPM cap bounds consumption but does not guarantee scheduling fairness; both answers give an appropriate fairness caveat.

Hard errors: None identified.

## Q39

A: **pass**. Correct inflection/feature-flag locations and send-record base/index serializers. A also identifies both prefixed frontend document/checklist serializers, so the requested serializer coverage is sufficient.

B: **partial**. Correct inflection/feature-flag locations and send-record base/index serializers. However B omits both Base::DocumentSerializer and DocumentChecklist::ItemSerializer::StrictDocumentSerializer, which directly expose the frontend tax_automation_status/upload_status/failure fields. A prefill serializer and WebSocket note do not replace those requested serializers.

Evidence:
- `/Users/Shared/nav-ab/repo-master/config/initializers/zeitwerk.rb` — Rails.autoloaders inflector mappings begin at line 3
- `/Users/Shared/nav-ab/repo-master/config/settings/features/tax_automations.yml` — tax_automations_instead: enabled false, firm kind, temp false, TD-100346
- `/Users/Shared/nav-ab/repo-master/app/serializers/tax_preparation/base/tax_automations/document_serializer.rb` — status maps processing_status; upload_status, failure_reason/message, provider and sent_at
- `/Users/Shared/nav-ab/repo-master/app/serializers/tax_preparation/api/v1/firm/tax_automations/documents/index_serializer.rb` — wraps base send serializer under tax_automation_documents
- `/Users/Shared/nav-ab/repo-master/app/serializers/tax_preparation/base/document_serializer.rb` — tax_automation_status lines 311–313; failure_reason lines 323–325, plus related prefixed fields
- `/Users/Shared/nav-ab/repo-master/app/serializers/tax_preparation/base/document_checklist/item_serializer.rb` — StrictDocumentSerializer exposes prefixed status/upload/failure/provider fields with read_status policy

Hard errors: B has the material serializer omissions described above.

