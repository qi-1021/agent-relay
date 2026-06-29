#!/usr/bin/env python3
"""
Agent Relay 自动回复客户端
轮询模式，轻量级，带自动重连
"""

import json
import sys
import time
import urllib.request

RELAY_URL = "https://agent-relay-production-560a.up.railway.app"
AGENT_ID = "hermes"
POLL_INTERVAL = 10

def api(method, path, body=None):
    url = f"{RELAY_URL}{path}"
    headers = {"Content-Type": "application/json"}
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        return json.loads(resp.read())
    except Exception as e:
        print(f"[API ERROR] {e}", file=sys.stderr)
        return None

def register():
    result = api("POST", "/api/agents/register", {
        "agent_id": AGENT_ID,
        "name": AGENT_ID,
        "framework": "python-client"
    })
    print(f"[注册] {result}")

def send_message(to, content):
    result = api("POST", "/api/messages", {
        "from_id": AGENT_ID,
        "to_id": to,
        "content": content
    })
    print(f"[发送] → {to}: {content[:50]}")

def handle_message(msg):
    if msg.get("from_id") == AGENT_ID:
        return
    print(f"\n[收到] 来自 {msg['from_id']}: {msg['content']}")
    reply = f"收到！你说的是：{msg['content'][:30]}"
    send_message(msg["from_id"], reply)

def main():
    print(f"[启动] {AGENT_ID} 客户端")
    print(f"[Relay] {RELAY_URL}")
    print(f"[模式] 轮询 (每 {POLL_INTERVAL} 秒)")
    print("---")
    
    register()
    last_ts = int(time.time() * 1000)
    
    while True:
        try:
            result = api("GET", f"/api/messages?to={AGENT_ID}&since={last_ts}&limit=20")
            if result and "messages" in result:
                for msg in reversed(result["messages"]):
                    if msg["timestamp"] > last_ts:
                        handle_message(msg)
                        last_ts = max(last_ts, msg["timestamp"])
        except Exception as e:
            print(f"[错误] {e}")
        
        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    main()
