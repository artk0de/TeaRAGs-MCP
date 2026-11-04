# One-file classification and bounded-output hypothesis

Observed false denial: a Python command reads source.md and writes result.md
through a variable, with parent.mkdir. It prints no Markdown content, but the
shipped hook counts both paths. Existing direct-Path write handling is correct;
the missing case is a single-assignment binding used only by known writers.

Fix only proven write destinations, preserving unknown-consumer, reassignment,
read/write-mode and real-read guards. Existing AST parser only, no code execution.
The one-input-per-command default, combined executor budget and truncation
handling remain unchanged. Two independent reads should share one model wave.

Separate unshipped experiment: allow exactly one direct `head -c N a.md b.md`
when both literal paths and data/header bytes prove total output <=8192 bytes.
Do not use file size or line count as a token proxy. A single large file is not
automatically cheap; bounded excerpts can limit output even from large files.
Reject globs, substitutions, nested commands, pipelines and over-cap requests.

Baseline: H05,S01. Updated shipped hook: H05,H06,H07,S01,S02. Prototype: S01,S02.
Model gpt-6.1-sol/medium, n=1 each, A only. Preserve every attempt. Compare the
successful parallel H07 wave count with successful prototype S01, and record
actual output size. Static acceptance and denial cases do not prove speed.

Unit baseline 63/63. Added nine cases: three fail for the expected erroneous
exit 2; six controls already pass. After fix all 72/72 pass. These unit tests
do not replace the native behavioral gate above.
