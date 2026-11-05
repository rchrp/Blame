import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const pythonAvailable = spawnSync("python3", ["--version"], { stdio: "ignore", timeout: 3_000 }).status === 0;
const probe = String.raw`
import ast
import json
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

source = Path(sys.argv[1]).read_text()
body = source.split("cat >/usr/local/bin/blame-runtime-agent <<'EOF'\n", 1)[1].split("\nEOF", 1)[0]
functions = [node for node in ast.parse(body).body if isinstance(node, ast.FunctionDef) and node.name in ("run_semantic_workspace", "run_semantic_workspace_once")]
captured = {}

class Process:
    returncode = 0
    def communicate(self, encoded):
        captured.update(json.loads(encoded))
        return "{}", ""

# No serving harness: the relay runs one harness process for the request.
scope = {"json": json, "semantic_processes": {}, "semantic_processes_lock": threading.Lock(),
         "semantic_server_process": lambda: None,
         "target_user": lambda _: None, "clean_env": lambda *_: {}, "demote": lambda _: None,
         "subprocess": SimpleNamespace(PIPE=None, Popen=lambda *args, **kwargs: Process())}
exec(compile(ast.Module(body=functions, type_ignores=[]), "runtime-relay", "exec"), scope)
context = {"agentId": "lead", "toolCallId": "read-1", "metadata": {"modelSupportsImages": True},
           "snapshot": {"messages": [{"id": "summary-1", "metadata": {"kind": "compaction_summary"}}]}}
scope["run_semantic_workspace"]({"operationId": "operation-1", "workspaceRoot": "/workspace",
    "tool": "read_code", "input": {"target": "image.png"}, "toolContext": context})
assert captured.get("toolContext") == context, "The runtime relay dropped the tool context"
assert not scope["semantic_processes"], "The relay retained a completed operation"
`;

for (const platform of ["macos", "windows"]) {
  test(`${platform} runtime relay preserves model capabilities and compaction context`, { skip: !pythonAvailable }, () => {
    const path = resolve(import.meta.dirname, `../packages/desktop/resources/runtime/${platform}/scripts/provision-blame-runtime.sh`);
    const result = spawnSync("python3", ["-c", probe, path], { encoding: "utf8", timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  });
}
