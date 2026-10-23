#!/usr/bin/env python3
""" REPL client for the bebots MCP server (bot-to-bot communication).

Lets you act as a bot against the desktop app's remote MCP endpoint (HTTP
JSON-RPC at /mcp), the same way bot homes' opencode.json configures agents.

Usage:
  python3 scripts/mcp_repl.py                     # interactive REPL
  python3 scripts/mcp_repl.py --list-tools        # one-shot: list MCP tools
  python3 scripts/mcp_repl.py --message BOT_ID "hello, are you there?"
  python3 scripts/mcp_repl.py --task BOT_ID "write a haiku about databases"

Identity: pass --bot-id to act as a specific bot (defaults to "me", an
unregistered caller — fine for list_bots, but send_message/create_task calls
made as an unknown bot will fail conversation lookup, so use a real id).

Connection: defaults are read from the app's userData dir
(~/Library/Application Support/@bebots/desktop/api-{port,token}.txt) unless
--url / --token are given.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Optional

APP_DATA = os.path.expanduser("~/Library/Application Support/@bebots/desktop")
PROTOCOL_VERSION = "2025-03-26"


class McpClient:
    def __init__(self, base_url: str, token: str, bot_id: str):
        self.url = base_url.rstrip("/") + "/mcp"
        self.bot_id = bot_id
        self.session_id = None
        self.headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {token}",
            "X-Bebots-Bot-Id": bot_id,
        }
        self.next_id = 1

    def post(self, payload: dict) -> Optional[dict]:
        body = json.dumps(payload).encode()
        headers = dict(self.headers)
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        req = urllib.request.Request(self.url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=600) as res:
                sid = res.headers.get("Mcp-Session-Id")
                if sid:
                    self.session_id = sid
                raw = res.read().decode()
        except urllib.error.HTTPError as e:
            print(f"HTTP {e.code}: {e.read().decode(errors='replace')}")
            sys.exit(1)
        if not raw:
            return None  # notification ack
        # Server may reply as a single JSON doc or an SSE stream with one data line.
        if raw.lstrip().startswith("event:") or raw.lstrip().startswith("data:"):
            for line in raw.splitlines():
                if line.startswith("data:"):
                    return json.loads(line[5:])
        return json.loads(raw)

    def rpc(self, method: str, params: object) -> dict:
        payload = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        if params is not None:
            payload["params"] = params
        self.next_id += 1
        resp = self.post(payload)
        if resp is None:
            raise RuntimeError(f"no response for {method}")
        if "error" in resp:
            raise RuntimeError(f"JSON-RPC error for {method}: {resp['error']}")
        return resp.get("result", {})

    def notify(self, method: str, params: object = None) -> None:
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        self.post(payload)

    def initialize(self) -> dict:
        result = self.rpc("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "bebots-mcp-repl", "version": "1.0.0"},
        })
        self.notify("notifications/initialized")
        return result

    def tools_list(self) -> list:
        return self.rpc("tools/list", {}).get("tools", [])

    def call(self, name: str, arguments: dict) -> str:
        result = self.rpc("tools/call", {"name": name, "arguments": arguments})
        if result.get("isError"):
            return "ERROR: " + "\n".join(c.get("text", "") for c in result.get("content", []))
        return "\n".join(c.get("text", "") for c in result.get("content", []))


def pretty(text: str) -> None:
    print(text)
    try:
        print(json.dumps(json.loads(text), indent=2))
    except (json.JSONDecodeError, TypeError):
        pass


HELP = """
commands:
  init                 re-run MCP initialize handshake
  tools                list server tools
  bots                 list all bots (list_bots)
  send <bot> <content> send a message to a bot (send_message)
  task <bot> <desc>    delegate a task (create_task)
  call <tool> [json]   call any tool with JSON args
  whoami               show the bot id you are acting as
  help                 this message
  quit                 exit
 Anything else is treated as: send <last-flagged-bot> <your text>
"""


def main() -> None:
    ap = argparse.ArgumentParser(description="bebots MCP bot client")
    ap.add_argument("--url", help="API base URL, e.g. http://127.0.0.1:63992")
    ap.add_argument("--token", help="API bearer token")
    ap.add_argument("--bot-id", default="me", help="value for X-Bebots-Bot-Id (your caller identity)")
    ap.add_argument("--one-shot", help="tool call as JSON like {\"name\":\"send_message\",\"arguments\":{...}}")
    ap.add_argument("--list-tools", action="store_true")
    ap.add_argument("cmd", nargs="?", help="send | task | bots | tools")
    ap.add_argument("target", nargs="?", help="target bot id")
    ap.add_argument("text", nargs="?", help="message or task description")
    args = ap.parse_args()

    url = args.url or f"http://127.0.0.1:{open(os.path.join(APP_DATA, 'api-port.txt')).read().strip()}"
    token = args.token or open(os.path.join(APP_DATA, "api-token.txt")).read().strip()

    client = McpClient(url, token, args.bot_id)
    init = client.initialize()
    print(f"connected: {init['serverInfo']['name']} v{init['serverInfo']['version']} "
          f"(protocol {init['protocolVersion']}, acting as bot '{args.bot_id}')")

    if args.list_tools:
        for t in client.tools_list():
            print(f"{t['name']}: {t.get('description', '')}")
            print(json.dumps(t.get("inputSchema", {}), indent=2))
        return

    if args.one_shot:
        call = json.loads(args.one_shot)
        pretty(client.call(call["name"], call.get("arguments", {})))
        return

    if args.cmd == "bots":
        pretty(client.call("list_bots", {}))
        return
    if args.cmd == "send" and args.target:
        pretty(client.call("send_message", {"target_bot_id": args.target, "content": args.text or ""}))
        return
    if args.cmd == "task" and args.target:
        pretty(client.call("create_task", {"assignee": args.target, "description": args.text or ""}))
        return
    if args.cmd == "tools":
        for t in client.tools_list():
            print(f"{t['name']}: {t.get('description', '')}")
        return
    if args.cmd:
        ap.error(f"unknown command {args.cmd!r} for one-shot use")

    # Interactive REPL
    last_bot = None
    print(HELP)
    while True:
        try:
            line = input(f"[{args.bot_id}]> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not line:
            continue
        parts = line.split(maxsplit=1)
        cmd = parts[0]
        try:
            if cmd in ("q", "quit", "exit"):
                return
            elif cmd == "help":
                print(HELP)
            elif cmd == "whoami":
                print(args.bot_id, "  session:", client.session_id)
            elif cmd == "init":
                print(json.dumps(client.initialize(), indent=2)[:2000])
            elif cmd == "tools":
                for t in client.tools_list():
                    print(f"{t['name']}: {t.get('description', '')}")
            elif cmd == "bots":
                pretty(client.call("list_bots", {}))
            elif cmd in ("send", "msg") and len(parts) >= 2:
                target, rest = parts[1].split(maxsplit=1) if " " in parts[1] else (parts[1], "")
                last_bot = target
                pretty(client.call("send_message", {"target_bot_id": target, "content": rest}))
            elif cmd == "task" and len(parts) >= 2:
                target, rest = parts[1].split(maxsplit=1) if " " in parts[1] else (parts[1], "")
                last_bot = target
                pretty(client.call("create_task", {"assignee": target, "description": rest}))
            elif cmd == "call":
                try:
                    call = json.loads(parts[1] if len(parts) > 1 else "{}")
                    pretty(client.call(call["name"], call.get("arguments", {})))
                except json.JSONDecodeError as e:
                    print("bad JSON args:", e)
            else:
                # bare text = reply to last-flagged bot
                if not last_bot:
                    print("unknown command. use 'send <bot> <text>'")
                else:
                    pretty(client.call("send_message", {"target_bot_id": last_bot, "content": line}))
        except RuntimeError as e:
            print(f"error: {e}")


if __name__ == "__main__":
    main()
