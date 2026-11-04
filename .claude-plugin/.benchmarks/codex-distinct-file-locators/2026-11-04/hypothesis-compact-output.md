# H8: compact factual output contract

H7 preserved all original factual points and exercised distinct-file locators.
Q01/Q03 together: 22 -> 21 model responses; input 841245 -> 745256, fresh
122141 -> 110632, cached 719104 -> 634624. Output increased 7873 -> 8430;
wall time increased 211.391 -> 226.341 seconds. W01 separately improved
20 -> 14 responses and 118.70 -> 85.27 seconds. Do not pool case winners.

Observed Q01 final output grew from H2's 1790 to H7's 2189 tokens and final
stream time from 31.143 to 42.600 seconds. This accounts for 11.457 seconds
of its 16.840-second slowdown. H7's observed reasoningOutputTokens are 370,
versus H2's 452; longer final output, not a demonstrated increase in thinking,
is the concrete target. Reasoning tokens are numeric usage telemetry only,
already included in outputTokens; never add them again or export private text.

Change the Codex Explore answer contract for multi-topic factual answers:
one compact fact/contract table per requested topic, grouped source citations,
no intro, repeated prose or conclusion. Preserve call signatures and material
bounds/caveats. Explicit user formatting overrides this default. No token cap.
Compress redundant schema-routing prose to keep the existing 4800-character cap.

Test Q01/Q03/W01 plus U01 (explicit two-bullet user format, no tables), n=1
each with gpt-6.1-sol/medium; A only. Same frozen corpus and unchanged backend
logic. If formatting production sources changes emitted build bytes, require
canonical JS parity with H7 and identical actual tool schemas before running.
Capture the distinct source/runtime/plugin fingerprints. No B/Claude.

Keep original factual grading unchanged. Add output-form assertions separately;
old H7 outputs remain a retained failing baseline for the proposed format,
not retroactively failed factual answers. U01 checks actual local EIN gate and
lookup scope plus user-format priority. Failed attempts remain retained.

Accept the new default only if material coverage and the user-format control
pass and the complete Q01/Q03 policy improves over H7 in output/time without
trading away input efficiency. Record all metrics and observed reasoning usage;
do not claim that thinking was reduced unless that counter supports it. n=1
cannot establish a general performance guarantee.
