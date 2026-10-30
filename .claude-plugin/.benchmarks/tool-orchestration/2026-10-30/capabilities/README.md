# No-turn wait-tool capability proof

**PASS:** changing only `features.sleep_tool = true` to `false` removes `clock.sleep` from the actual local model-visible tool catalog. It adds no tool and changes none of the retained tool definitions. This was measured with the supported local `codex debug prompt-input` command, which exports `additional_tools` without starting an actor turn. Both isolated profiles also pass `app-server --strict-config --print-startup-config`.

The candidate catalog retains `functions.exec`, `functions.wait`, `functions.request_user_input`, `functions.request_user_input_async` and `collaboration.wait_agent`. The unchanged native exec description still declares `exec_command` and `write_stdin`. Native wait is explicitly for a real yielded exec cell; it is not a general timer. The question-tool description permits Default or Plan mode in this probe because both profiles explicitly enable `features.default_mode_request_user_input = true`.

A separate future-benchmark variant sets `multi_agent = false` while retaining the sleep/question settings. Strict validation and the same wait/write-stdin/question exposure still pass. Its debug catalog continues to list collaboration tools, so this proof does not claim that the multi-agent flag removes those tools from the catalog or establishes their runtime availability.

All work is isolated under `.tmp/codex_wait_probe`. No actor/model request, tool execution by a model, new agent, running-A39 mutation or global configuration change was made. The global config SHA-256 remained identical. This is a catalog/configuration proof; it does not establish that a model will choose the correct wait operation or handle an asynchronous answer correctly.

Official OpenAI documentation describes the app-server lifecycle and configuration inspection, including the distinction between thread setup and starting a turn. The local binary is the authority for the tested `sleep_tool` feature and prompt-input command; the fetched configuration reference did not explicitly list that feature. Sources: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Artifacts:

- `capability-proof.json`: exact tool-name difference, preservation checks and limitations.
- `control/` and `candidate/`: isolated config, strict-startup output, actual prompt-input export, feature list and command records.
- `future-benchmark/`: no-turn validation and catalog with multi-agent disabled.
- `probe.py` and `analyze.py`: local no-turn runner and offline comparison.
- `runtime-evals-plan.json`: four planned native cases covering independent reads, a real pending exec cell, a real command session and asynchronous clarification. They use controller-observed lifecycle events and real returned IDs; no fixed delays, timers or polling loops. They must wait for A39 EOF and explicit root authorization. No runtime case has been launched.
