Fresh Sol Q14–Q26 offline quality review

Answers: `research/gruntworx-full39-codex61-2026-10-30/{A,B}/answers/Qxx.md`.

Literal requests are graded separately from historical gold coverage. Retained code is valid evidence; no tool-count, answer-length or no-tool penalty is applied. Both sessions had finished before gold was read. No model reruns or product changes were made.

| Question | A | B | Assessment |
|---|---|---|---|
| Q14 | pass | pass | Both correctly say failed/unauthorized first, then unauthorized-only reconnect recovery. |
| Q15 | pass | pass | Both cover signature/body validation, acknowledgements and replay protection versus event-ID deduplication. |
| Q16 | pass | pass | Both give correct registry signatures and all direct/indirect in-app adapter traversal sites. |
| Q17 | pass | pass | Both identify firm_site_backups with independent variables and explicit shared fallbacks. |
| Q18 | pass | pass | Both identify the two flags, config definition and distinct API/provider gates. |
| Q19 | partial | pass | A adds a false only-exit claim; archive exits processed and exceeded too. Both tables are correct. |
| Q20 | pass | pass | Both give the service inputs/authorization/errors and complete frontend broadcast frame. |
| Q21 | pass | pass | Both correctly separate HTTP errors, metric labels and persisted refusal reasons. |
| Q22 | pass | pass | Both cover base retries, nil/effective default group, concrete throttle/slug opt-in and config keys. |
| Q23 | pass | pass | Both cover no_proxy local routing and the exact controller endpoint. |
| Q24 | pass | pass | Both satisfy explicit dictionary/downcase intent. Missing Zeitwerk discussion is not an automatic failure. |
| Q25 | pass | pass | Both offer semantically useful names; conditional recommendations need not match historical preference. |
| Q26 | partial | partial | Both lack the full incident-specific correction; A supplies verified current /v1 mechanism, B generic contract lessons. |

**Totals:** A 11 pass / 2 partial / 0 fail; B 12 pass / 1 partial / 0 fail. These are quality counts for these thirteen questions only.

**Verified hard error:** A Q19 says “`resend` is the only exit from `processed`, `archived` or `exceeded`.” The executable `archive` transition at `app/models/tax_preparation/tax_automations/document.rb:74–76` includes both `processed` and `exceeded`. Its transition table is correct; the extra explanation is wrong. The loose adjacent source comment does not override executable transitions.

**Q26 answerability:** historical gold marks the incident unanswerable from code alone. Neither answer is called fabricated for honestly lacking the ticket/history. A verifies a present URL mechanism, not the whole historical patch; both remain partial on the requested specific incident. The historical scope-ID correction and exact 14-file fix are not established in either response.

**Evidence per question**

**Q14** — When a vendor rejects the firm's grant mid-send and the admin later reconnects, do the affected files wait and resume, or fail? Which failures are resumed?

- **A: pass**. Evidence: “They fail visibly, then can be resumed automatically after reconnect.” Correct failed/unauthorized outcome, firm/provider/nondeleted selection, per-tax-preparation re-export, unauthorized-only recovery and usable-connection guard. Historical gold: Core historical facts covered.
- **B: pass**. Evidence: “Failure reason unauthorized only.” Correctly distinguishes immediate failure from reconnect-triggered eligible retries; excludes other reasons and already-uploaded processing failures. Historical gold: Core historical facts covered.

**Q15** — How does the existing Instead webhook endpoint verify, validate and acknowledge deliveries, and does it deduplicate events?

- **A: pass**. Evidence: “These are state-based replay protections, not event deduplication or exactly-once delivery.” Covers HMAC raw-body verification, timestamp/secret rotation, signed-body-only validation, 401 versus signed-invalid 200, asynchronous routing and lack of event-ID deduplication. Correctly distinguishes stale/status guards from deduplication. Historical gold: Behavior covered; does not name the controller's superclass, which is not required by the literal request.
- **B: pass**. Evidence: “No processed-event ledger or explicit deduplication keyed by event_id exists in this path.” Covers the same verification, validation and acknowledgement contract, including unexpected exceptions and equal-time entity replays. Historical gold: Behavior covered; omitted superclass is a historical-detail omission, not an answer failure.

**Q16** — List the tax-automation provider registry's constants and public methods, and every place in app/ that iterates over all adapters.

- **A: pass**. Evidence: “client_for(connection) ... connections_for(firm_id)” Lists all three constants and twelve public module methods with correct signatures. Includes three direct Registry.adapters loops, Registry.connections_for's transform_values and indirect DisconnectAll traversal. Historical gold: Covers in-app sites; config/initializers/yabeda.rb in historical gold is outside the requested app/ scope.
- **B: pass**. Evidence: “Indirectly through connections_for, then iterates its result to disconnect and enqueue revocation” Correct complete registry surface and in-app direct/indirect traversal list; no previous-run signature or DisconnectAll omission carried into this grade. Historical gold: Covers literal app/ scope; excluded config initializer is not penalized.

**Q17** — Is there an existing purpose-scoped storage service (separate bucket and credentials) in config/storage.yml that a dedicated vendor-facing bucket could copy?

- **A: pass**. Evidence: “separation requires populating those dedicated variables” Identifies firm_site_backups, all three purpose-specific environment variables, shared region and credential/bucket fallbacks. Distinguishes bucket-only tax-software backup example. Historical gold: Required example covered; the question does not require an inventory of every storage service.
- **B: pass**. Evidence: “those settings fall back to the main S3 credentials and bucket” Gives the correct reusable purpose-scoped example and isolation caveat. Suggesting omission of fallbacks for strict isolation is explicitly design advice, not a source claim. Historical gold: Required example covered; no exhaustive service list required.

**Q18** — Which feature flags govern tax automations and the Instead provider, and where are they defined?

- **A: pass**. Evidence: “Both are defined in config/settings/features/tax_automations.yml” Names both flags and their API/provider effects, defaults, firm scope and temporary/permanent distinction. Correct registry mapping and disconnect exception. Historical gold: Main facts covered; exact removal date is omitted without affecting the asked identification.
- **B: pass**. Evidence: “tax_automations_unified_api ... tax_automations_instead” Correct two flags, definition path, gates, scope/lifecycle and registry mapping. Separates proposed mock configuration from feature flags. Historical gold: Main facts covered; does not enumerate the temporary flag's exact removal date.

**Q19** — What are the AASM transitions of the send record's processing and upload state machines?

- **A: partial**. Evidence: “resend is the only exit from processed, archived or exceeded” Both transition tables and clearing/timestamp side effects are correct, but this added prose incorrectly excludes archive from processed and exceeded. That contradiction matters in an answer about allowed transitions. Historical gold: Historical tables covered; executable code reveals the extra prose error even though the adjacent source comment also loosely says 'only way out'.
- **B: pass**. Evidence: “archive | sent, processing, processed, error, exceeded | archived” Correct complete tables, initial states, failure-reason clearing, uploaded_at and no-op helper. Does not repeat A's erroneous only-exit statement. Historical gold: Core historical facts covered.

**Q20** — What does the shared status-update service accept, and what frame does the status broadcast send to the frontend?

- **A: pass**. Evidence: “processing_status: required String/Symbol ... failure_reason ... only for error” Correct call arguments, authorization, processing-only update, failure codes, after-commit broadcast and exact frame fields/type/event. Distinguishes send ID from original document ID. Historical gold: Core historical facts covered.
- **B: pass**. Evidence: “type: tax_automation_document; event: status_changed” Correct service contract and complete frontend frame, including both state axes and nullable reason. Historical gold: Core historical facts covered.

**Q21** — How does the shared vendor HTTP client map HTTP statuses to errors, which metrics does it emit, and how are refusals turned into failure reasons?

- **A: pass**. Evidence: “Vendor HTTP 403 therefore maps to api_error, not local-policy forbidden.” Correct explicit HTTP map/fallbacks, vendor hook, four metric families/tags, diagnostic versus document reasons and terminal refusal mapping. Separates transient retry handling from persisted refusal reasons. Historical gold: Core historical facts covered. No invented explicit 409/413 mapping.
- **B: pass**. Evidence: “The HTTP client itself does not persist document failure reasons.” Correct classification/metrics/refusal layers, all required statuses and metrics, Retry-After parsing and local-policy versus vendor 403 distinction. Historical gold: Core historical facts covered.

**Q22** — What do the shared and the Instead operation-worker base classes define (retries, throttle, slug), and where is the Instead throttle configured?

- **A: pass**. Evidence: “rate_limit_group returns nil, normalized to default” Correct retry count/kill/429/exhaustion behavior, inheritance, lack of base slugs, concrete throttle opt-in, metadata, initializer and both per-group-per-connection/app keys. nil raw default versus effective default is correctly distinguished. Historical gold: Core historical facts covered; inherited platform behavior is described rather than conflated with a base slug.
- **B: pass**. Evidence: “The Instead base does not automatically enable the throttle.” Correct two base contracts, callback chaining, no step_only!, concrete worker slugs/opt-in, initializer/settings and threshold keys. Historical gold: Core historical facts covered.

**Q23** — How are vendor webhooks routed to a cluster and to a controller for the existing provider?

- **A: pass**. Evidence: “'/webhooks/instead' => :no_proxy” Correct receiving-cluster/no-forwarding mechanism, exact POST route/controller and module-only namespace scoping. Separates local firm resolution from cross-cluster routing. Historical gold: Both required routing layers covered.
- **B: pass**. Evidence: “The vendor must therefore call the correct cluster's endpoint.” Correct no_proxy behavior and exact local controller route. No earlier-run omission of cluster middleware is present. Historical gold: Both required routing layers covered.

**Q24** — Хочется именно GruntWorx, просто сделаем явный словарь: instead => Instead, gruntworx => GruntWorx. Значит не camelize нужен, а downcase, этого хватит

- **A: pass**. Evidence: “Прямое соответствие задаём в Registry::ADAPTERS, без camelize.” Directly accepts the explicit provider mapping and downcase key conversion, and correctly identifies underscore's grunt_worx result in BaseClient#vendor. This is an agreement/narrow naming request, not an explicit autoload audit. Historical gold: Covers registry and vendor-key points. Does not mention Zeitwerk; that hidden extra subcriterion is not required by the literal request. No zero-tool penalty.
- **B: pass**. Evidence: “Ключ → отображаемое имя ... Имя → ключ: name.downcase.” Supplies the requested explicit dictionary and correct directional conversion; notes camelize loses the capital W. Illustrative new mapping is not represented as existing code. Historical gold: Covers literal dictionary/downcase intent. Does not tie it to current registry/vendor or discuss Zeitwerk; these are separate historical diagnostic omissions, not an automatic literal failure. No zero-tool penalty.

**Q25** — step_available? — не нравится слово step; operation/feature (путаница с флагами) / какие варианты есть?

- **A: pass**. Evidence: “полезно различать поддержку и текущую доступность” Provides meaningful alternatives, recommends supports? for static provider support, distinguishes runtime availability, and addresses feature/operation collisions. Does not need a repository-wide word census. Historical gold: Matches historical supports? preference; counts are optional diagnostic background.
- **B: pass**. Evidence: “Если проверяет только заявленную поддержку — supports?.” Offers appropriate alternatives with a conditional recommendation: operation_available? for current multi-condition availability, supports? for static support. The open naming question does not require selecting the historical favorite unconditionally. Historical gold: Includes supports? and semantic distinction. Different primary recommendation is not a factual error or literal-task failure.

**Q26** — What did it cost the Instead integration when its mock transport had drifted from the real vendor contract (the fix in TD-99833)?

- **A: partial**. Evidence: “I cannot quantify engineering hours or attribute every current detail above exclusively to TD-99833” Gives a useful cross-layer rework account and a concrete /v1-relative-path correction, verified in current code. Explicitly limits historical attribution. Does not establish the incident's OAuth scope-ID correction or historical 14-file patch, and surrounding current-contract examples must not be mistaken for a verified task diff. Historical gold: Partial: /v1 issue and cross-layer correction covered; scope IDs and exact patch extent not established. Historical gold marks this unanswerable from code alone.
- **B: partial**. Evidence: “I cannot attribute an exact change list or effort estimate to TD-99833” Honestly bounds missing Jira/history and explains mock-induced false confidence and rework. Most supporting bullets describe today's contract rather than the specific historical fix; neither scope-ID correction nor /v1 correction is identified. Historical gold: Partial incident coverage. No invented hours, file count or unsupported exact patch. Honest answerability limits are not hallucination.

**Verification limits:** Other primary contracts were cross-checked against source bodies retained from the previous offline corpus review and the post-EOF gold. This is a focused answer audit, not a new exhaustive source search. The historical TD-99833 patch/ticket was not independently retrieved.

Fresh focused source reads confirmed the full AASM transition definitions and `BaseClient#relative_path`. Other previously read primary contracts were retained. No exhaustive independent history retrieval was performed.
