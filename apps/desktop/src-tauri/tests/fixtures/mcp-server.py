"""Harmless stdio MCP fixture for the opt-in installed-Claude integration test."""

import json
import pathlib
import sys


for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request.get("method")
    if method == "initialize":
        result = {
            "protocolVersion": request["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "writer-fixture", "version": "1"},
        }
    elif method == "tools/list":
        result = {"tools": [{
            "name": "record",
            "description": "Record a harmless integration-test marker for note a or b.",
            "inputSchema": {
                "type": "object",
                "properties": {"note": {"type": "string", "enum": ["a", "b"]}},
                "required": ["note"],
                "additionalProperties": False,
            },
        }]}
    elif method == "tools/call":
        note = request["params"]["arguments"]["note"]
        assert request["params"]["name"] == "record" and note in ("a", "b")
        pathlib.Path(sys.argv[1], f"mcp-{note}.txt").write_text("EXECUTED")
        result = {"content": [{"type": "text", "text": "Marker recorded."}]}
    elif method == "ping":
        result = {}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Unknown method"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
