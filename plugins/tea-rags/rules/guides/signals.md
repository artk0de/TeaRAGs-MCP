# Custom Weight Signals

Every signal takes a number (weight). For `{custom: {...}}` rerank mode.

Keys = the list below, nothing else. A key outside it fails the call with
`INPUT_UNKNOWN_RERANK_SIGNAL`, and the error's hint lists every valid key:
replace the unknown key with the listed key of the same intent, keep the other
weights, re-call once — authors / how many people → `ownership` or
`knowledgeSilo`. Never drop `rerank` to get past the error.

<!-- data:signal-keys -->
