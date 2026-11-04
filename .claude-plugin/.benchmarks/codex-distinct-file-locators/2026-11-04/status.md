# Distinct-file locators and compact-output experiment

H7 adds optional `distinctFiles` to semantic/hybrid chunk searches, preserving
symbol and line locators. The default remains unchanged. All five behavioral
cases pass. Relevant code tests: 292/292; generator tests: 63/63; build passes.

| Q01 + Q03 | H2 historical shipped variant | H7 distinct locators | H8 compact answer |
| --- | ---: | ---: | ---: |
| Model responses | 22 | 21 | 26 |
| Input tokens | 841245 | 745256 | 1062487 |
| Fresh input | 122141 | 110632 | 114775 |
| Cached input | 719104 | 634624 | 947712 |
| Output tokens | 7873 | 8430 | 8938 |
| Wall seconds | 211.391 | 226.341 | 239.043 |

H8 is rejected and its exact policy is retained under `policies/compact-output.md`.
Shorter final text did not reduce total output or model steps. All three billed
token categories grew relative to H7, so it costs more for positive token rates.
No unverified current dollar prices are asserted. Q01/Q03 original factual
coverage passes, but formatting is partial and U01 omits the exception class
named in its predeclared rubric. See h8-verdicts.json; do not call all H8 gates
closed. W01 remains factually correct but regresses from 14/85.27s to 15/93.55s.

The next concrete investigation is retrieval specificity, not another output
constraint. H8 Q03's unscoped searches for "Instead integration" return Stripe,
frontend and activity-feed code for rate limiting, failure vocabulary and entity
matching. These are successful nonempty tool responses, not transport errors.
They trigger broad filename/occurrence inventories. A domain-grounded query or
scope learned from a relevant anchor is a hypothesis to test, not a shipped fix.
Q01 also spends a response only on the pagination guide and takes class outlines
before reading methods; examine delivered versus deferred bodies before calling
these unnecessary rereads. No source-body hash alone establishes wasted work.

H7 is not a general speed win and remains uninstalled/unmerged. The wider goal
of beating ordinary tools in speed and cost while preserving quality stays open.
These are n=1 independent actors with observed provider prefix caching; historical
H2 changes backend and policy, while H7/H8 use the exact same immutable backend.
