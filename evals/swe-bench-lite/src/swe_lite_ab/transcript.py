import json
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Iterable

SEARCH_READ_TOOLS = {"Bash", "Read", "Grep", "Glob"}
TEA_RAGS_PREFIX = "mcp__tea-rags__"
INDEX_TOOL = "mcp__tea-rags__index_codebase"
INDEX_BASH_MARKERS = ("tea-rags index-codebase", "index_codebase")
SEARCH_TOOLS = {"Grep", "Glob"}
SEARCH_BASH = re.compile(r"\b(grep|rg|find|ag|ack)\b|\bls\s+-[A-Za-z]*R")
OPEN_TOOLS = {"Read", "Edit", "Write", "MultiEdit"}


@dataclass
class RunMetrics:
    input_tokens: int = 0
    cache_write_tokens: int = 0
    cache_read_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    turns: int = 0
    duration_ms: int = 0
    duration_api_ms: int = 0
    tool_calls: dict[str, int] = field(default_factory=dict)
    tea_rags_calls: int = 0
    search_read_calls: int = 0
    gold_touched: bool = False
    turns_to_gold: int | None = None
    gold_before_search: bool = False
    is_error: bool = True
    tool_seconds: dict[str, float] = field(default_factory=dict)
    index_in_run_seconds: float = 0.0


def _mentions(text: str, gold: list[str]) -> bool:
    return any(g in text for g in gold)


def _is_index_call(name: str, tool_input: dict) -> bool:
    if name == INDEX_TOOL:
        return True
    return name == "Bash" and any(k in str(tool_input.get("command", "")) for k in INDEX_BASH_MARKERS)


def _is_search_call(name: str, tool_input: dict) -> bool:
    if name.startswith(TEA_RAGS_PREFIX) or name in SEARCH_TOOLS:
        return True
    return name == "Bash" and bool(SEARCH_BASH.search(str(tool_input.get("command", ""))))


def parse(lines: Iterable[str], gold: list[str], usage_source: str,
          arrivals: list[float] | None = None) -> RunMetrics:
    """`arrivals[i]` is the offset (s) at which `lines[i]` arrived; with it, each tool_use is timed
    from its assistant event to the user event carrying its tool_result."""
    m = RunMetrics()
    searched = False
    started: dict[str, tuple[str, bool, float]] = {}
    tool_seconds: Counter[str] = Counter()
    seen: set[str] = set()
    tools: Counter[str] = Counter()
    main_turn = 0
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        event = json.loads(line)
        at = arrivals[i] if arrivals is not None and i < len(arrivals) else None
        kind = event.get("type")
        if kind == "assistant":
            msg = event["message"]
            if msg["id"] not in seen:
                seen.add(msg["id"])
                u = msg.get("usage") or {}
                if usage_source == "sum":
                    m.input_tokens += u.get("input_tokens", 0)
                    m.cache_write_tokens += u.get("cache_creation_input_tokens", 0)
                    m.cache_read_tokens += u.get("cache_read_input_tokens", 0)
                    m.output_tokens += u.get("output_tokens", 0)
                if event.get("parent_tool_use_id") is None:
                    main_turn += 1
            for block in msg.get("content", []):
                if block.get("type") != "tool_use":
                    continue
                tools[block["name"]] += 1
                if at is not None:
                    started[block["id"]] = (block["name"], _is_index_call(block["name"], block.get("input", {})), at)
                if not m.gold_touched and _mentions(json.dumps(block.get("input", {})), gold):
                    m.gold_touched, m.turns_to_gold = True, main_turn
                    # Gold opened straight away: the agent knew where to look without searching.
                    m.gold_before_search = block["name"] in OPEN_TOOLS and not searched
                searched = searched or _is_search_call(block["name"], block.get("input", {}))
        elif kind == "user":
            content = event.get("message", {}).get("content", [])
            for block in content if isinstance(content, list) and at is not None else []:
                if isinstance(block, dict) and block.get("type") == "tool_result" and block.get("tool_use_id") in started:
                    name, is_index, t0 = started.pop(block["tool_use_id"])
                    tool_seconds[name] += at - t0
                    if is_index:
                        m.index_in_run_seconds += at - t0
            if not m.gold_touched and _mentions(json.dumps(event.get("message", {})), gold):
                m.gold_touched, m.turns_to_gold = True, main_turn
        elif kind == "result":
            m.is_error = bool(event.get("is_error"))
            m.turns = event.get("num_turns", main_turn)
            m.cost_usd = event.get("total_cost_usd", 0.0)
            m.duration_ms = event.get("duration_ms", 0)
            m.duration_api_ms = event.get("duration_api_ms", 0)
            if usage_source == "result":
                u = event.get("usage") or {}
                m.input_tokens = u.get("input_tokens", 0)
                m.cache_write_tokens = u.get("cache_creation_input_tokens", 0)
                m.cache_read_tokens = u.get("cache_read_input_tokens", 0)
                m.output_tokens = u.get("output_tokens", 0)
    m.tool_calls = dict(tools)
    m.tool_seconds = {name: round(sec, 3) for name, sec in tool_seconds.items()}
    m.index_in_run_seconds = round(m.index_in_run_seconds, 3)
    m.tea_rags_calls = sum(n for name, n in tools.items() if name.startswith(TEA_RAGS_PREFIX))
    m.search_read_calls = m.tea_rags_calls + sum(n for name, n in tools.items() if name in SEARCH_READ_TOOLS)
    return m
