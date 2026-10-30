# Saved-trace routing audit

Two scoped changes are supported: make independent dispatch explicit inside code-mode wrappers, and distinguish configuration/framework wiring from a request for static caller edges. The first is a confirmed workflow defect and belongs in the existing 0.53.9 await/parallel work. The second is a narrow routing clarification, with a runtime test needed before claiming a performance gain. No fresh MCP, corpus or model call was made.

**Q12's four tools versus the historical one are not four wasted calls.** Historical Q01 returned the complete generic merge and batch-destroy files (4413 and 2381 characters). New Q01 returned their outlines (1476 and 874 characters), plus only the two provider-dispatch helper bodies. New Q12 correctly fetched the unread generic merge perform/helpers and batch-destroy perform body. It did not refetch the two retained provider helpers. The graph found the CRM consumer entry point, and the subsequently fetched consumer bodies were also new. That is defensible evidence for “when CRM merges two contacts,” rather than a confirmed graph misuse. There was no compaction before Q12.

One local Q12 inefficiency is definite: wrapper `ctc_01ea513854152a31016ae4c83022588191bcd68fe7f9b540c1` awaits `get_callers(MergeForContact#perform)` and then an already-addressed BatchDestroy/vendor body batch. The second request does not use the first result. They can dispatch together. The later consumer-body request truly depends on the graph-discovered IDs.

The other batching observations are unambiguous:

- Q34's first wrapper serially awaits three independent operations: spec filename discovery, Gemfile search and Gemfile.lock search. Its next wrapper also serializes two independent spec queries. The final client-spec body read at lines 690–717 is legitimate dependent work; Q02 retained only lines 1–200.
- Q36 discovers seven migration paths, then runs a single `for` loop with an awaited bounded read for each file. One wrapper does not make this a batch. All seven operations are deliberately serialized.
- Q30's four-file schema/migration `Promise.allSettled` wrapper is a positive control. It really dispatches the independent reads together. Near-zero native durations or scheduler behavior do not invalidate that workflow. Filename/line discovery and genuinely newly discovered constraints may remain separate stages.

The proposed dispatch wording is: form all currently independent promises, then await one `Promise.all`/`Promise.allSettled` in one wrapper. Apply this to independent searches and graph/body combinations as well as per-file reads. Sequential awaits and `for await` read loops are not batches. Preserve real dependencies; never guess a path or symbol merely to batch it earlier.

Q02 asks how a mock is enabled, used by specs and still wired. `get_callers(Mock::Adapter#call)` cannot establish those facts by itself when Faraday or another framework dispatches the adapter. The config/factory/spec references are the primary evidence. A static `noEdges` result does not mean “unwired.” The trace supports clarifying that distinction; it does not prove what internally caused the model to request the graph. Preserve graph use for explicit callers/impact questions and genuinely missing event-entry edges, including the defensible Q12 case.

The Q02 proxy rejection is separate: a legitimate noEdges banner was rejected as unclassified text. That response-contract defect must be fixed in the proxy independently, rather than concealed with a plugin rule that discourages all graph calls.

An exact path/symbol/body-hash scan found no confirmed repeated complete native method/file bodies in selected Q02/Q12/Q30/Q34/Q36. Outlines were excluded from that test. This does not prove absence of every overlapping shell read or differently formatted body. Equal search output is also not automatically redundant when a later query expands coverage.

The companion JSON contains precise call/wrapper IDs, two proposed rules, and six case designs: retained framework wiring, real static impact, CRM event entry with missing bodies, seven known migrations, dependent config-selected discovery, and independent spec/manifest searches. Grader criteria are separated from actor inputs. Raw fixtures must be materialized before any runtime evaluation; no model test was run for this audit.
