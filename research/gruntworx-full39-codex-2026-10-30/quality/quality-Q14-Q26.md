Offline quality review Q14–Q26

Literal request graded separately from historical gold. No penalty for held context, answer length or absent new tool calls.

| Question | A | B | Request |
|---|---|---|---|
| Q14 | pass | pass | Fail or wait after grant rejection, and which failures reconnect resumes? |
| Q15 | pass | pass | Existing webhook verification, validation, acknowledgement and delivery deduplication. |
| Q16 | partial | partial | Registry constants/public methods and every app/ traversal over all adapters. |
| Q17 | pass | pass | An existing purpose-scoped storage service with separate bucket and credentials to copy. |
| Q18 | pass | pass | Which flags govern tax automations/Instead and where defined? |
| Q19 | pass | pass | AASM transitions of processing and upload state machines. |
| Q20 | pass | pass | Accepted status-update input and exact frontend broadcast frame. |
| Q21 | pass | pass | HTTP status/error mapping, metrics and refusal-to-failure-reason mapping. |
| Q22 | partial | pass | Shared/Instead operation-worker retries, throttle and slug contract and throttle configuration location. |
| Q23 | pass | partial | How existing vendor webhooks reach a cluster and controller. |
| Q24 | pass | pass | Accept explicit instead→Instead / gruntworx→GruntWorx dictionary and downcase instead of camelize. |
| Q25 | pass | pass | Suggest clearer alternatives to step_available?, avoiding feature-flag ambiguity. |
| Q26 | partial | partial | Actual Instead incident/fix cost in TD-99833. |

Q14 — Fail or wait after grant rejection, and which failures reconnect resumes?

A: pass (high). “They fail first ... failure_reason: unauthorized”
Correctly distinguishes failed records from waiting, limits reconnect resumption to unauthorized, and explains unusable-grant deferral.
Historical gold: Substantial; does not specify one ExportAsync per tax preparation.

B: pass (high). “Only failures with reason unauthorized are resumed”
Same required behavior; extra insufficient-scope/401 examples agree with the refusal mapping.
Historical gold: Substantial; per-tax-preparation adapter enqueue detail omitted.

Q15 — Existing webhook verification, validation, acknowledgement and delivery deduplication.

A: pass (high). “no delivery-ID deduplication at the endpoint or enqueue boundary”
Covers HMAC/timestamp/secrets, 401 versus signed-body 200, validation/asynchronous handling, signed body versus query, and absence of delivery-ID inbox deduplication.
Historical gold: Full core coverage.

B: pass (high). “state handling, not through a stored event-ID check”
Covers the requested endpoint lifecycle and distinguishes idempotent state handling from delivery-ID deduplication.
Historical gold: Substantial; does not explicitly explain request.request_parameters and query-string precedence.

Q16 — Registry constants/public methods and every app/ traversal over all adapters.

A: partial (high). “client_for(firm) ... connections_for(firm)”
Method names/constants and three direct Registry.adapters.each users are present, but the client_for parameter is a connection and connections_for takes firm_id, not Firm. Omits Registry.connections_for's transform_values traversal and DisconnectAll's all-provider traversal.
Historical gold: Incomplete app/ inventory. Gold's config/initializers/yabeda.rb is outside the explicit app/ scope and is not a literal-request penalty.

B: partial (medium). “connections_for(firm_id) uses ADAPTERS.transform_values”
Correct constants/signatures and direct traversals, including the registry itself. Still omits app/services/.../connections/disconnect_all.rb, which traverses the all-provider connections map.
Historical gold: Misses DisconnectAll; outside-app Yabeda is not penalized.
Uncertainty: If the request is narrowly interpreted as direct adapter-namespace iteration only, B would pass; this grade uses the requested exhaustive all-provider behavior inventory.

Q17 — An existing purpose-scoped storage service with separate bucket and credentials to copy.

A: pass (high). “firm_site_backups ... own credential variables with fallback”
Initially discusses the shared-credential tax-software bucket, but explicitly identifies firm_site_backups as the distinct-credential pattern; source confirms both descriptions.
Historical gold: Partial detail coverage: exact backup ENV names/region and MinIO service name not listed.

B: pass (high). “firm_site_backups is the closer template for credentials”
Directly selects the distinct-credential pattern and correctly warns tax-software backups alone shares credentials.
Historical gold: Substantial; some exact bucket/region configuration details omitted.

Q18 — Which flags govern tax automations/Instead and where defined?

A: pass (high). “Two flags ... tax_automations_unified_api ... tax_automations_instead”
Names both flags, definition file, provider registry mapping, and accurate default-disabled settings. No new tool call is needed for already-held config.
Historical gold: Partial ancillary coverage: firm/temp/permanent/removal dates and absence of the old mock flag not enumerated.

B: pass (high). “two firm-scoped feature flags, both defined in ... tax_automations.yml”
Names the flags/file, gating behavior and provider registry mapping correctly.
Historical gold: Substantial; lifecycle/removal-date and no-mock-flag diagnostics omitted.

Q19 — AASM transitions of processing and upload state machines.

A: pass (high). “upload ... waiting, uploaded, failed → uploading”
Supplies both complete event/from/to tables, initial states, uploaded_at and failure-reason clearing behavior.
Historical gold: Full core transition coverage.

B: pass (high). “resend ... processing, processed, error, archived, exceeded ... sent”
Same complete transition inventory and relevant side effects.
Historical gold: Full core transition coverage.

Q20 — Accepted status-update input and exact frontend broadcast frame.

A: pass (high). “UpdateStatus.call(user, actor, tax_automation_document_id, params)”
Provides signature, processing-status/reason vocabulary and system actor, validation/transition behavior, after-commit timing and the correct frame fields/type/event.
Historical gold: Substantial; exact ServiceResult failure symbols not enumerated.

B: pass (high). “It does not accept upload status”
Correctly distinguishes accepted processing update from the upload workflow and supplies the exact broadcast frame/after-commit behavior.
Historical gold: Substantial; constructor user argument and exact failure-result symbols not explicitly listed.

Q21 — HTTP status/error mapping, metrics and refusal-to-failure-reason mapping.

A: pass (high). “a plain vendor ForbiddenError defaults to api_error”
Lists all mapped statuses/fallbacks, all four metrics and the important policy-forbidden versus vendor-403 distinction. Correct scope/quota/unauthorized mappings.
Historical gold: Substantial; RateLimitedError Retry-After parsing is not explicitly covered.

B: pass (high). “RateLimitedError can parse Retry-After as seconds or an HTTP date”
Covers requested maps/metrics/refusals, fallback behavior and rate-limit parsing, without confusing vendor-403 with a policy refusal.
Historical gold: Full core coverage.

Q22 — Shared/Instead operation-worker retries, throttle and slug contract and throttle configuration location.

A: partial (medium). “RETRY_ATTEMPTS = 10 ... retry ladder ... about 4.5 hours”
Correct retry bound, class responsibilities, slug ownership and throttle/config limits. However the requested retry contract omits kill-on-record/policy/invalid-grant, RateLimitedError.retry_after and invalid-grant exhaustion verification, which materially change how the base retries.
Historical gold: Partial retry-policy coverage and no explicit concrete sidekiq_throttle_as opt-in. Effective default throttle bucket is correctly called default even though rate_limit_group returns nil.
Uncertainty: If 'retries' is taken to request only the numeric retry bound, A would pass; this grade treats the base retry policy as requested behavior.

B: pass (high). “kills retries for missing records, policy errors, and invalid grants”
Includes numeric retry limit, special retry/exhaustion rules, adapter throttle arguments/default bucket, concrete slug ownership, opt-in and configuration locations/limits.
Historical gold: Substantial/full core contract; not-step_only is not stated explicitly.

Q23 — How existing vendor webhooks reach a cluster and controller.

A: pass (high). “/webhooks/instead ... :no_proxy”
Explains main-cluster proxy modes and the Instead no-proxy decision, then gives POST path and exact controller#create. Targeted middleware source confirms the routing policy.
Historical gold: Full core coverage.

B: partial (high). “app host for the relevant TaxDome cluster”
Correct endpoint/controller and host constraints, but does not identify the cluster-routing middleware or the existing Instead :no_proxy policy. Host selection alone does not explain the requested cluster routing.
Historical gold: Controller route covered; WEBHOOKS_MAP/no_proxy omitted.
Uncertainty: The app-host statement alone is not proven false; the defect is missing the decisive routing mechanism, not a categorical claim that every host reference is wrong.

Q24 — Accept explicit instead→Instead / gruntworx→GruntWorx dictionary and downcase instead of camelize.

A: pass (high). “camelize не нужен; регистр класса задаёт словарь”
Agrees with the exact user decision and supplies an explicit namespace dictionary with lowercase normalization. No unsupported factual claim identified; relevant registry/client code was held from previous questions.
Historical gold: Only explicit mapping/downcase covered; existing BaseClient#vendor underscore and Zeitwerk/global-inflection concerns omitted. These are not explicit requirements of this question and do not turn the answer into a failure.

B: pass (high). “Ключ нормализуем через downcase.to_sym, значение берём из словаря”
Directly implements the two-entry naming dictionary and explains why camelize loses the internal W. No new tool invocation is necessary.
Historical gold: Same ancillary omissions: metric tag implementation and loader inflection are not discussed. No Zeitwerk penalty is applied to this literal request.

Q25 — Suggest clearer alternatives to step_available?, avoiding feature-flag ambiguity.

A: pass (high). “operation_available? ... action_supported?”
Offers several meaningful alternatives and distinguishes operation, capability and whole-provider availability; explicitly notes enabled/feature-flag ambiguity. Naming brainstorm does not require choosing the exact historical winner.
Historical gold: Does not report historical namespace counts or recommend the historical name supports?. These diagnostics are not mandatory outcomes of the user's open naming question.

B: pass (high). “operation_supported? ... operation_available?”
Offers alternatives, separates static support from runtime availability and explains feature-flag/capability overlap.
Historical gold: Does not reproduce historical counts or exact supports? choice; not an automatic correctness failure.

Q26 — Actual Instead incident/fix cost in TD-99833.

A: partial (high). “I can’t reliably say what the drift cost or what the fix changed”
Truthfully abstains after scoped retrieval errors and does not invent the OAuth-scope/base-URL fix. Requested historical incident facts remain unanswered. Specifically, TD-99833 semantic_search returned normalized BENCH_READ_ERROR and get_index_status was rejected by the benchmark proxy (request 162, Unclassified text tool result blocked). This is an operator/transport limitation in the observed run, not evidence of a model reasoning failure or shipped-plugin capability gap.
Historical gold: Not covered. Gold itself marks this unanswerable from code and requires git/ticket evidence outside the actor's permitted source corpus.

B: partial (high). “I can’t verify TD-99833’s exact incident or cost”
Truthfully states history/Jira limits and distinguishes general mock-drift risk from the unverified incident. It does not supply the requested incident-specific facts, but does not hallucinate them.
Historical gold: Not covered; same source-only answerability limit applies, independently of tool type/speed.

Summary: A 10 pass / 3 partial / 0 fail; B 10 pass / 3 partial / 0 fail.
Q24 is pass/pass on literal intent. Q26 is an honest unresolved historical question in both. Q16 B and Q22 A have explicitly noted interpretation uncertainty; no answer-length or no-tool-use scoring was used.

Targeted source checks: app/lib/tax_preparation/tax_automations/registry.rb; app/services/tax_preparation/tax_automations/connections/disconnect_all.rb:31; app/workers/tax_preparation/tax_automations/operation_worker.rb; app/workers/tax_preparation/tax_automations/instead/operation_worker.rb; lib/middleware/clusters/webhooks.rb:34; config/storage.yml:30; config/settings/features/tax_automations.yml
