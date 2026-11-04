# Codex efficiency follow-up, 2026-11-04

Shippable change: 0.55.7 fixes the Codex one-file hook counting a direct Python
write destination as an extra Markdown read. The accepted Explore policy remains
the shipped 0.55.6 H2 body. Neither H4 nor H5 is installed.

All model cases use gpt-6.1-sol/medium, n=1, independent fresh histories and a
sealed plugin snapshot. Backend/corpus remain immutable. Expected answers stay
controller-only, separate from cases. No B or Claude run. Provider prefix
caching is observed in metrics, not disabled or confused with saved answers.

## Retrieval policy experiments

| Whole Q01/Q03 policy             | Steps |     Input |   Fresh |  Cached | Output | Seconds | Quality                               |
| -------------------------------- | ----: | --------: | ------: | ------: | -----: | ------: | ------------------------------------- |
| Shipped H2, 0.55.6               |    22 |   841,245 | 122,141 | 719,104 |  7,873 |  211.39 | Complete                              |
| H4 helper-continuation reference |    20 |   735,011 | 108,835 | 626,176 |  7,848 |  204.16 | Partial: durable entity reuse missing |
| H5 file-level discovery          |    26 | 1,025,598 | 118,590 | 907,008 |  9,033 |  244.39 | Complete                              |

H4's intended same-executor graph continuation was not exercised. G01 read the
reference but still used six steps, matching the baseline. W01 used 18 steps.
Lower usage with missing material coverage is not an optimization acceptance.

H5 actually used file-level searches and observed-domain scoping. W01 improved
from H2's 20 to 12 steps (118.70 to 75.41 seconds), but Q01/Q03 regressed as a
pair. Do not pool per-case winners and describe an untested composite policy. No
dollar claim: pair deltas are -3,551 fresh, +187,904 cached and +1,160 output
tokens. H5's smaller fresh input alone is insufficient to claim lower cost.

Offline probes identify two retrieval issues: a common-English vendor name can
retrieve the wrong domain, and top-k chunks may repeat a file. Scoped file-level
queries improve file diversity, but currently remove representative chunk
locators. Source-confirmed seam: VectorSearchStrategy#executeExplore uses Qdrant
queryGroups and FileLevelGrouper.group retains a representative payload;
BaseExploreStrategy#shapeFileLevel then deliberately removes chunk-specific
fields. Explicit symbol/line fields also return fieldsWarning. Future work needs
a backward-compatible distinct-file search retaining symbol/line locators, with
source tests and a newly sealed backend; do not blindly rewrite this contract.

## Accepted hook correction

The prior code_md heuristic counted all quoted .md paths whenever a read marker
occurred. The fix preserves that conservative scan, subtracting only proved
direct Path.write_text/write_bytes destinations and open literals in w/a/x modes
without '+'. Other occurrences of the same pathname remain; variable bindings,
nested reads, unsupported syntax and unrecognized forms are not removed.

Unit reproduction failed for the correct reason (exit 2 instead of 0), then all
63 relevant generator tests passed. Controls cover genuine multiple reads,
read/write mode w+, and a path also read through a variable. No full suite run.

Native H03: old plugin falsely denies; updated installed-path actor reaches the
process and prints CLASSIFIER_ACCEPTED. Native H04: both plugins deny the two
read expressions, no process starts. Both cases use two model responses under
both policies: no step reduction is claimed. This closes a false-denial path.

The original H01 candidate reached the sandbox but could not create a temporary
heredoc file; end-to-end copying remains OPEN_ENVIRONMENT in that run. H02 had a
fixture path error because CODEX_HOME was absent inside the exec shell. These
failed attempts are retained and are not relabeled PASS. Corrected H03/H04 are
explicit no-I/O static-classification probes through real native PreToolUse.

Raw journals remain private under
/Users/Shared/nav-ab/graph-continuations-0557-evals. Public evidence contains
actions, final answers, source locators/hashes and numeric usage, with no
private reasoning. Per-policy verdicts, fingerprints, source snapshots, failed
attempts and reproduction helpers accompany this report. The broader goal of
consistently beating standard tools remains open.
