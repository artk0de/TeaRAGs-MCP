# Late visible-transcript audit (Q21–Q39)

Read-only offline analysis. Audited A is 0.54.0/ced48, not assumed equivalent to newest main. No actors, models, evals, indexing, source edits, gold or grading answers. No private reasoning records read or extracted.

Unique completed native responses: **A51 / B44 / previous A49**. Final responses count; nested tool invocations do not.

| Question | latest A | B | previous A |
|---|---:|---:|---:|
| Q21 | 3 | 3 | 3 |
| Q22 | 3 | 2 | 2 |
| Q23 | 4 | 4 | 5 |
| Q24 | 1 | 2 | 1 |
| Q25 | 1 | 1 | 2 |
| Q26 | 5 | 3 | 3 |
| Q27 | 1 | 1 | 1 |
| Q28 | 1 | 2 | 1 |
| Q29 | 2 | 2 | 1 |
| Q30 | 6 | 5 | 6 |
| Q31 | 1 | 1 | 1 |
| Q32 | 1 | 1 | 1 |
| Q33 | 3 | 2 | 2 |
| Q34 | 3 | 2 | 4 |
| Q35 | 5 | 3 | 4 |
| Q36 | 3 | 3 | 3 |
| Q37 | 3 | 2 | 4 |
| Q38 | 1 | 1 | 1 |
| Q39 | 4 | 4 | 4 |

## 1. Known missing method bodies deferred to a separate evidence response (Q21)

Q01 W8 delivered BaseClient and TokenRefreshable file outlines including all five Q21 W2 exact IDs. Q04 W1 delivered request and with_access_token bodies; Q14 W1 delivered refresh! body. These are locators or specifically named bodies, not a claim that the five W2 bodies were held.

**Missing:** All five Q21 W2 bodies were genuinely missing: upload_to_signed_target, exchange_operation, exchange_code!, revoke_tokens!, refresh_tokens!. Read them, do not omit them.

**Minimal plan:** Join the five missing already-located IDs into Q21 W1 find_symbol batch: 11 requested IDs total, below max20; the delivered payload.content sum for both observed waves is 17061 characters including large class headers, below 24k. Reuse held request/refresh/rate-limit bodies. Then final answer.

**Native responses:** 3 → 2 (hypothesis, not rerun).

Evidence:
- Q21 event 43 / `exec-fb54e898-a76b-496c-a237-d9ecf1205d0d` / W1 `resp_0774613464b3f479016ae6082e67f48191806308dc5e375afc`.
- Q21 event 58 / `exec-01b2af5f-66ef-478a-9b5e-b07e0a40404f` / W2 `resp_0774613464b3f479016ae6083528d481918f1f17645ae932df`.
- Q01 event 356 / `exec-c7bbaa51-973b-4fd9-872b-4d5071bfa4ed` / W8 `resp_0774613464b3f479016ae6054cabfc8191a52ff1512125d279`.

**Short fixture:** Retain two small outlines naming a metrics wrapper and the already-known upload/exchange callers; hold the shared request body. User asks emitted operation tags and error mapping. Full production-equivalent catalog, genuine missing caller bodies available. Actor should join ready relevant missing callers into first body response.

**Nearby control:** A wrapper calls a previously unknown helper whose exact identifier is absent from retained context; preserve the post-body dependent read. Also exercise >20 methods or >24k body budget so genuine batching limits are not penalized.

## 2. Rediscovering already-held validation context with a separate broad reference search (Q34)

Q02 W7 delivered the complete spec/support/tax_automations_helpers.rb (fixture JSON parser, mock registration helpers, contract path, instead_contract and conforms_to_contract? using JSON::Validator with the OpenAPI root). Q26 W4 delivered finalize_doc_upload specs asserting conforms_to_contract?(File,...).

**Missing:** Exact Gemfile gem declaration was not previously shown; keep Q34 W1 Gemfile read.

**Minimal plan:** Read Gemfile in one evidence response and answer from the held helper/spec bodies. If scope verification is desired, perform one full spec/ filename-only search alongside the Gemfile read; the W2 broad search depends on no W1 result and adds no new body. No user request for every reference requires two successive scoped filename inventories.

**Native responses:** 3 → 2 (hypothesis, not rerun).

Evidence:
- Q02 event 368 / `exec-a2f363dc-ea4e-47f4-b8b1-53cd6e8486c6` / W7 `resp_0774613464b3f479016ae605cede488191b451273203fa2c54`.
- Q26 event 115 / `exec-e522585b-ccd2-46ce-9ac2-b84765464223` / W4 `resp_0774613464b3f479016ae608d5470c81918175a6c9fa43a38f`.
- Q34 event 62 / `exec-d90c400d-872d-46e7-b970-0361b9e42877` / W1 `resp_0774613464b3f479016ae609bbfa948191acd5f34c7a4b3085`.
- Q34 event 66 / `exec-3c987484-0afd-44ba-b282-3a5b2efced97` / W1 `resp_0774613464b3f479016ae609bbfa948191acd5f34c7a4b3085`.
- Q34 event 85 / `exec-5db5b00c-ed20-4ce1-bc65-13e93357078b` / W2 `resp_0774613464b3f479016ae609c60d08819184da4c1939a99b9f`.

**Short fixture:** Retain actual helper body and one contract assertion in delivered conversation; leave Gemfile declaration missing. Ask how fixtures/mock responses are checked and the gem. Require one missing gem read, permit concurrent scoped search, prohibit extra response merely locating the already-held helper.

**Nearby control:** Hold only helper outline or JSON::Validator name without helper body, and a newly discovered component helper. The body read must remain necessary; never infer whole-root $ref handling from the symbol alone.

## 3. Guessed nonexistent absence-search scope creates its own recovery response (Q35)

After W1, find and list_by_account bodies are held. W2 reveals contact_data body and file outline. The existing app/services/crm/api path is certain from the delivered file locator; the file outline newly supplies list_by_ids/list_active/list_synced/list_synced_with_client/find_by_account_user IDs.

**Missing:** contact_data requires a genuine W1-to-W2 dependency. The W3 additional method bodies follow the new W2 outline. A complete successful uid/uuid absence check is also needed for the broad no-public-exposure claim.

**Minimal plan:** Preserve W1, W2 helper/outline, W3 newly-discovered methods. Run the valid existing-scope app/services/crm/api uid/uuid absence search alongside W2 or W3. Do not add guessed app/contracts/crm, whose error2 forced the clean W4 retry. Then final answer. This saves one response, without pretending error2 proves absence.

**Native responses:** 5 → 4 (hypothesis, not rerun).

Evidence:
- Q35 event 44 / `exec-a37cc426-ef4f-44a1-9d39-5e6fa7801625` / W1 `resp_0774613464b3f479016ae609db455c81918b1a57c1611180c1`.
- Q35 event 59 / `exec-1a7a8730-c0e1-4299-b5b5-557c4a53da57` / W2 `resp_0774613464b3f479016ae609e0fa588191b70a0d7da7bb61af`.
- Q35 event 75 / `exec-eafbc7cf-9e0a-4678-91f9-7d296d499360` / W3 `resp_0774613464b3f479016ae609e4df7c81918c0a98fc54f16e47`.
- Q35 event 88 / `exec-872eecb2-69e1-4f0a-8f70-6ad035105d74` / W3 `resp_0774613464b3f479016ae609e4df7c81918c0a98fc54f16e47`.
- Q35 event 107 / `exec-5e41c3c7-be80-4f74-b7ce-7f9283747ca6` / W4 `resp_0774613464b3f479016ae609ecc3808191bbee2ca575d4ed9d`.

**Short fixture:** Use a known services API file and existing nested contracts path under it; sibling app/contracts/crm does not exist. User asks identifier exposure. Actor should scope absence to known root, retain needed helper read, and not manufacture a failed search wave.

**Nearby control:** A user explicitly asks a second possibly absent contract directory; preserve existence/absence verification and recovery after any actual error. A final empty result exit1 must be distinguished from error2.

## Secondary Q26 candidate

W1 metadata search locates finalization and OAuth contract spec IDs; W2 broadens metadata but reads no bodies. W3 finally reads relative_path plus another production search. W4 reads token_response/perform and specs. BaseClient/TokenRefreshable outlines from Q01 already contained relative_path/token_response/perform locators. Those missing bodies and W1-discovered specs can join an unavoidable discovery/body wave. Historical task scope may justify broadened searches, so no claim all discovery can be eliminated or that present bodies prove original before/after history.

## Controls and limitations

- No exact repeated delivered method/file body content found among normalized A late rows versus prior A rows; this does not claim semantic duplicate absence across shell formatting. Main remaining waste here is scheduling and reference rediscovery, not indiscriminate full-body reopening.
- Q29 adapter ExportAsync body was genuinely missing; Q01 had only its locator. Preserve its Q29 read.
- Q33 transfer/finalize worker bodies and exact locators were absent from all earlier delivered A results. Directory inventory supplies real new locators; preserve inventory→body dependency. StartUploadWorker/ExportOperationWorker/Webhook worker bases were held from Q03/Q15.
- Q39 large document serializer first returns an outline, not six method bodies; preserve the subsequent methods read. Small serializer bodies are delivered in W2. Config discovery is genuine.
- Q30 schema.rb is absent/error; migrations filename inventory, fresh UID migrations, schema ranges, and firm UUID absence need evidence. No all-in-one counterfactual asserted.
- Q36 migration filenames are newly discovered W1 and read together W2; genuine dependency.
- Q37 A metrics.rb was only a locator earlier, so full helper body is genuinely missing. B had already read complete metrics.rb at Q21, an accidental relevance/coverage confound; B faster Q37 is not proof A should skip helper.
- Q22 config line search and bounded read are a real locator→body dependency as executed. Direct bounded reading could reduce steps but not established as top avoidable issue from held A evidence.
- No repeated skill/schema metadata rediscovery visible in A Q21-Q39; exact searches appear primarily config/absence scopes.
- Native response counts count unique rawResponse/completed IDs, not nested tool invocations. Final response is included.
- Single existing run each; no causal performance or statistical claim.
- Only actual delivered body rows or successful shell outputs treated as held bodies; outlines and headers treated as locators.
- Top3 valid alternatives save at least one native response each in isolation (3 response opportunities total); no behavior reruns performed, so improvements remain hypotheses.
- No current-source implementation diagnosis: newest main differs from audited A plugin.

Artifacts: `late-audit.json` contains structured verdicts and plans; `selected-safe-visible-extracts.json` contains selected complete visible tool calls/results and prompts. `A-safe-visible.json`/`B-safe-visible.json` retain tool/final-only records for raw verification; `A-delivered-rows.json` normalizes delivered MCP rows.
