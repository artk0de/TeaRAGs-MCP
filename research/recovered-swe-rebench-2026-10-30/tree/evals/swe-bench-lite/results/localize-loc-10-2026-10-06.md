<!-- RECONSTRUCTED FROM TRANSCRIPT (session 3769d71e, 2026-10-06). The original file was produced by
`uv run swe-lite-ab localize --tasks loc-10` at 11:06Z and was lost with the swe-rebench worktree.
Header text re-rendered from localize.render; primary and rank tables copied verbatim from the 11:09Z
`sed` output of the final run. The final run's wall time and the -prod rows of the secondary table were
never printed and are unknown; secondary rows below come from the earlier 10:59Z run (5 configs, 104 s),
whose non-prod configs are unchanged. Trailing notes (truncated queries / unscored), if any, are lost. -->
# Component localization — loc-10

Files ranked for the original issue text (SWE-bench_Pro-locagent `problem_statement`), no LLM. tea-rags configurations search `language: python` chunks, with the preset filter cleared or, for `-prod` configurations, set to `production`; `bm25` ranks git-tracked `.py` files and `bm25-prod` the same minus test and doc files. A gold file outside the top 50 counts as not found (rank –).

Wall time: unknown for the final run (earlier 5-config run: 104 s for 10 tasks).

## Primary gold (gold `.py` files)

| config | n | R@1 | R@5 | R@10 | Hit@5 | MRR |
|---|---:|---:|---:|---:|---:|---:|
| semantic-relevance | 10 | 0.23 | 0.65 | 0.70 | 0.90 | 0.64 |
| hybrid-relevance | 10 | 0.23 | 0.60 | 0.77 | 0.80 | 0.63 |
| hybrid-bugHunt | 10 | 0.00 | 0.17 | 0.42 | 0.40 | 0.21 |
| hybrid-hotspots | 10 | 0.10 | 0.25 | 0.31 | 0.50 | 0.34 |
| semantic-relevance-prod | 10 | 0.23 | 0.70 | 0.77 | 0.90 | 0.71 |
| hybrid-relevance-prod | 10 | 0.28 | 0.70 | 0.79 | 0.90 | 0.73 |
| hybrid-tiebreak-prod | 10 | 0.28 | 0.72 | 0.82 | 1.00 | 0.74 |
| semantic-tiebreak-prod | 10 | 0.28 | 0.70 | 0.82 | 0.90 | 0.76 |
| bm25 | 10 | 0.12 | 0.42 | 0.44 | 0.90 | 0.50 |
| bm25-prod | 10 | 0.17 | 0.44 | 0.57 | 0.90 | 0.58 |

## Secondary gold (every gold file)

| config | n | R@1 | R@5 | R@10 | Hit@5 | MRR |
|---|---:|---:|---:|---:|---:|---:|
| semantic-relevance | 10 | 0.15 | 0.47 | 0.52 | 0.90 | 0.64 |
| hybrid-relevance | 10 | 0.15 | 0.42 | 0.58 | 0.80 | 0.63 |
| hybrid-bugHunt | 10 | 0.00 | 0.11 | 0.31 | 0.40 | 0.21 |
| hybrid-hotspots | 10 | 0.10 | 0.19 | 0.24 | 0.50 | 0.34 |
| bm25 | 10 | 0.08 | 0.29 | 0.32 | 0.90 | 0.50 |
| semantic-relevance-prod | 10 | ? | ? | ? | ? | ? |
| hybrid-relevance-prod | 10 | ? | ? | ? | ? | ? |
| hybrid-tiebreak-prod | 10 | ? | ? | ? | ? | ? |
| semantic-tiebreak-prod | 10 | ? | ? | ? | ? | ? |
| bm25-prod | 10 | ? | ? | ? | ? | ? |

## Rank of the first primary gold file per task

| task | gold .py | semantic-relevance | hybrid-relevance | hybrid-bugHunt | hybrid-hotspots | semantic-relevance-prod | hybrid-relevance-prod | hybrid-tiebreak-prod | semantic-tiebreak-prod | bm25 | bm25-prod |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| instance_ansible__ansible-185d41031660a676c43fbb781cd1335902024bfe-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5 | 2 | 1 | 1 | 7 | 13 | 1 | 1 | 1 | 1 | 5 | 4 |
| instance_ansible__ansible-f327e65d11bb905ed9f15996024f857a95592629-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5 | 2 | 5 | 9 | 7 | 1 | 2 | 3 | 3 | 2 | 2 | 3 |
| instance_ansible__ansible-f8ef34672b961a95ec7282643679492862c688ec-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5 | 6 | 2 | 3 | 17 | 7 | 2 | 3 | 3 | 2 | 1 | 1 |
| instance_internetarchive__openlibrary-53d376b148897466bb86d5accb51912bbbe9a8ed-v08d8e8889ec945ab821fb156c04c7d2e2810debb | 4 | 1 | 1 | 2 | 7 | 1 | 1 | 1 | 1 | 2 | 2 |
| instance_internetarchive__openlibrary-5fb312632097be7e9ac6ab657964af115224d15d-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4 | 2 | 1 | 1 | 4 | 3 | 1 | 1 | 1 | 1 | 1 | 1 |
| instance_internetarchive__openlibrary-f3b26c2c0721f8713353fe4b341230332e30008d-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4 | 2 | 3 | 2 | 9 | 4 | 2 | 1 | 1 | 2 | 1 | 1 |
| instance_qutebrowser__qutebrowser-2dd8966fdcf11972062c540b7a787e4d0de8d372-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d | 4 | 17 | 14 | 47 | 48 | 13 | 6 | 5 | 7 | 4 | 3 |
| instance_qutebrowser__qutebrowser-7f9713b20f623fc40473b7167a082d6db0f0fd40-va0fd88aac89cde702ec1ba84877234da33adce8a | 2 | 1 | 1 | 16 | 11 | 1 | 1 | 1 | 1 | 36 | 28 |
| instance_qutebrowser__qutebrowser-fea33d607fde83cf505b228238cf365936437a63-v9f8e9d96c85c85a605e382f1510bd08563afc566 | 2 | 1 | 1 | 2 | 1 | 1 | 1 | 1 | 1 | 5 | 3 |
| instance_qutebrowser__qutebrowser-ff1c025ad3210506fc76e1f604d8c8c27637d88e-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d | 2 | 3 | 4 | 3 | 3 | 2 | 2 | 2 | 1 | 3 | 1 |
