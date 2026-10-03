import json
from collections import Counter
from dataclasses import dataclass, field
from typing import Iterable

SEARCH_READ_TOOLS = {"Bash", "Read", "Grep", "Glob"}
TEA_RAGS_PREFIX = "mcp__tea-rags__"


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
    is_error: bool = True


def _mentions(text: str, gold: list[str]) -> bool:
    return any(g in text for g in gold)


def parse(lines: Iterable[str], gold: list[str], usage_source: str) -> RunMetrics:
    m = RunMetrics()
    seen: set[str] = set()
    tools: Counter[str] = Counter()
    main_turn = 0
    for line in lines:
        if not line.strip():
            continue
        event = json.loads(line)
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
                if not m.gold_touched and _mentions(json.dumps(block.get("input", {})), gold):
                    m.gold_touched, m.turns_to_gold = True, main_turn
        elif kind == "user" and not m.gold_touched:
            if _mentions(json.dumps(event.get("message", {})), gold):
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
    m.tea_rags_calls = sum(n for name, n in tools.items() if name.startswith(TEA_RAGS_PREFIX))
    m.search_read_calls = m.tea_rags_calls + sum(n for name, n in tools.items() if name in SEARCH_READ_TOOLS)
    return m
