"""Independent live read-only proxy comparison; no inference/model calls."""
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

BASE = Path(__file__).resolve().parent / "codex61"
CFG_PATH = BASE / "proxy-proof-A.json"
CFG = json.loads(CFG_PATH.read_text())
REPO = "/Users/Shared/nav-ab/repo-master"
PROJECT = "taxdome-worktree-navmaster"


class Wire:
    def __init__(self, name, command, env):
        self.stderr = (BASE / ("independent-" + name + ".stderr")).open("w")
        self.proc = subprocess.Popen(command, cwd=REPO, env=env, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=self.stderr, text=True, bufsize=1)
        self.queue = queue.Queue()
        self.sequence = 0

        def read():
            for line in self.proc.stdout:
                try:
                    self.queue.put(json.loads(line))
                except json.JSONDecodeError:
                    pass
        threading.Thread(target=read, daemon=True).start()
        self.call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                 "clientInfo": {"name": "independent-benchmark-audit", "version": "1"}})
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.proc.stdin.flush()

    def call(self, method, params):
        self.sequence += 1
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.sequence,
                                         "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            result = self.queue.get(timeout=max(1, deadline - time.monotonic()))
            if result.get("id") == self.sequence and "method" not in result:
                return result
        raise TimeoutError(method)

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        self.stderr.close()


def answer(message):
    result = message.get("result", {})
    assert "error" not in message and not result.get("isError"), "Read-only upstream request failed"
    if "structuredContent" in result:
        return result["structuredContent"]
    for block in result.get("content", []):
        if block.get("type") == "text":
            try:
                return json.loads(block["text"])
            except json.JSONDecodeError:
                pass
    return result


def source_rows(message):
    rows = answer(message).get("results", [])
    if isinstance(rows, dict):
        columns = rows["columns"]
        rows = [{"payload": {key.removeprefix("payload."): value for key, value in zip(columns, row)
                             if key.startswith("payload.")}} for row in rows["rows"]]
    keys = ["relativePath", "content", "startLine", "endLine", "kind"]
    return [{key: row.get("payload", {}).get(key) for key in keys} for row in rows]


def main():
    env = {"PATH": "/Users/artk0re/.asdf/installs/nodejs/24.15.0/bin:/opt/homebrew/bin:/usr/bin:/bin",
           "HOME": "/Users/artk0re", "LANG": "en_US.UTF-8", "ASDF_NODEJS_VERSION": "24.15.0",
           **CFG["upstream_env"]}
    proxy = Wire("proxy", [sys.executable, str(BASE.parent / "codex61_mcp_proxy.py")],
                 {**env, "BENCH_MCP_PROXY_CONFIG": str(CFG_PATH)})
    raw = None
    try:
        raw = Wire("raw", CFG["upstream_command"], env)
        args = {"relativePath": "app/lib/tax_preparation/tax_automations/registry.rb",
                "project": PROJECT, "path": REPO}
        source = {name: source_rows(wire.call("tools/call", {"name": "find_symbol", "arguments": args}))
                  for name, wire in [("proxy", proxy), ("raw", raw)]}
        assert source["proxy"] == source["raw"] and source["proxy"], "Source response changed"
        assert sum(len(row.get("content") or "") for row in source["proxy"]) > 100
        resources = {name: wire.call("resources/read", {"uri": "tea-rags://guide/navigation"})
                     for name, wire in [("proxy", proxy), ("raw", raw)]}
        texts = {name: "\n".join(block.get("text", "") for block in result.get("result", {}).get("contents", []))
                 for name, result in resources.items()}
        assert texts["proxy"] == texts["raw"] and len(texts["proxy"]) > 100, "Resource response changed"
        names = [tool["name"] for tool in proxy.call("tools/list", {})["result"]["tools"]]
        assert "find_symbol" in names
        assert not set(names) & {"index_codebase", "clear_index", "delete_collection", "get_collection_info"}
        cross = proxy.call("tools/call", {"name": "find_symbol", "arguments": {"project": "tea-rags", "symbol": "X"}})
        mutation = proxy.call("tools/call", {"name": "index_codebase", "arguments": {}})
        assert "error" in cross and "error" in mutation
        proof = {"source_rows": len(source["proxy"]),
                 "source_content_chars": sum(len(row.get("content") or "") for row in source["proxy"]),
                 "raw_vs_proxy_source_identical": True,
                 "source_body_sha256": hashlib.sha256(json.dumps(source["proxy"], sort_keys=True).encode()).hexdigest(),
                 "guide_chars": len(texts["proxy"]), "raw_vs_proxy_guide_identical": True,
                 "read_tool_count": len(names), "cross_project_rejected": True, "mutator_rejected": True,
                 "no_model_calls": True,
                 "proxy_config_sha256": hashlib.sha256(CFG_PATH.read_bytes()).hexdigest(),
                 "proxy_source_sha256": hashlib.sha256((BASE.parent / "codex61_mcp_proxy.py").read_bytes()).hexdigest()}
        (BASE / "independent-transport-proof.json").write_text(json.dumps(proof, indent=2) + "\n")
        print(json.dumps(proof, indent=2))
    finally:
        proxy.close()
        if raw:
            raw.close()


if __name__ == "__main__":
    main()
