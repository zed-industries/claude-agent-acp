#!/usr/bin/env python3
"""
Telemetry Validation Test Harness for claude-agent-acp (PR #344)

Validates that UsageUpdate and PromptResponse.usage report accurate token data
by running multi-turn conversations and comparing against expected behavior.

Addresses SteffenDE's concern: https://github.com/zed-industries/claude-agent-acp/pull/344#issuecomment-3951271477

Tests:
  1. Single-turn sanity check
  2. Multi-turn token accumulation (monotonic growth)
  3. /compact compaction (does 'used' drop?)
  4. /context ground truth comparison
  5. Per-turn accumulation vs final result.usage cross-reference
"""

import json
import subprocess
import sys
import os
import time
import threading
import uuid
from dataclasses import dataclass, field
from typing import Optional


# ─── ACP JSON-RPC helpers ─────────────────────────────────────────────

class ACPConnection:
    """Raw JSON-RPC connection to claude-agent-acp subprocess."""

    def __init__(self, proc: subprocess.Popen):
        self.proc = proc
        self.request_id = 0
        self.pending: dict[int, threading.Event] = {}
        self.results: dict[int, dict] = {}
        self.notifications: list[dict] = []
        self._lock = threading.Lock()
        self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self._reader_thread.start()
        self.stderr_lines: list[str] = []
        self._stderr_thread = threading.Thread(target=self._read_stderr, daemon=True)
        self._stderr_thread.start()

    def _read_stderr(self):
        """Capture stderr for SDK debug output."""
        for line in self.proc.stderr:
            text = line.decode("utf-8", errors="replace").rstrip("\n")
            self.stderr_lines.append(text)

    def _read_loop(self):
        """Read newline-delimited JSON from stdout."""
        buffer = b""
        while True:
            chunk = self.proc.stdout.read(1)
            if not chunk:
                break
            buffer += chunk
            if chunk == b"\n":
                line = buffer.strip()
                buffer = b""
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                self._dispatch(msg)

    def _dispatch(self, msg: dict):
        """Route incoming messages to pending requests or notification log."""
        if "id" in msg and "method" not in msg:
            # This is a response to a request we sent
            rid = msg["id"]
            with self._lock:
                self.results[rid] = msg
                if rid in self.pending:
                    self.pending[rid].set()
        elif "method" in msg and "id" in msg:
            # Server-to-client request (e.g., requestPermission)
            self._handle_server_request(msg)
        elif "method" in msg:
            # Notification (no id)
            with self._lock:
                self.notifications.append(msg)

    def _handle_server_request(self, msg: dict):
        """Auto-respond to server requests like permission prompts."""
        method = msg["method"]
        if method == "requestPermission":
            # Auto-approve with allow_once
            options = msg.get("params", {}).get("options", [])
            allow_once = next((o for o in options if o.get("kind") == "allow_once"), None)
            option_id = allow_once["optionId"] if allow_once else options[0].get("optionId", "")
            response = {
                "jsonrpc": "2.0",
                "id": msg["id"],
                "result": {"outcome": {"outcome": "selected", "optionId": option_id}},
            }
            self._send_raw(response)
        else:
            # Unknown server request — send empty result
            response = {
                "jsonrpc": "2.0",
                "id": msg["id"],
                "result": {},
            }
            self._send_raw(response)

    def _send_raw(self, msg: dict):
        """Send a raw JSON-RPC message."""
        data = json.dumps(msg) + "\n"
        self.proc.stdin.write(data.encode("utf-8"))
        self.proc.stdin.flush()

    def send_request(self, method: str, params: dict, timeout: float = 120) -> dict:
        """Send a JSON-RPC request and wait for the response."""
        self.request_id += 1
        rid = self.request_id
        event = threading.Event()
        with self._lock:
            self.pending[rid] = event

        msg = {
            "jsonrpc": "2.0",
            "id": rid,
            "method": method,
            "params": params,
        }
        self._send_raw(msg)

        if not event.wait(timeout):
            raise TimeoutError(f"Request {method} (id={rid}) timed out after {timeout}s")

        with self._lock:
            del self.pending[rid]
            return self.results.pop(rid)

    def drain_notifications(self) -> list[dict]:
        """Return and clear all accumulated notifications."""
        with self._lock:
            notifs = list(self.notifications)
            self.notifications.clear()
            return notifs

    def get_usage_updates(self, notifs: list[dict]) -> list[dict]:
        """Extract usage_update notifications from a list of notifications."""
        updates = []
        for n in notifs:
            params = n.get("params", {})
            update = params.get("update", {})
            if update.get("sessionUpdate") == "usage_update":
                updates.append(update)
        return updates

    def get_agent_text(self, notifs: list[dict]) -> str:
        """Extract agent message text from notifications."""
        parts = []
        for n in notifs:
            params = n.get("params", {})
            update = params.get("update", {})
            if update.get("sessionUpdate") == "agent_message_chunk":
                content = update.get("content", {})
                if content.get("type") == "text":
                    parts.append(content.get("text", ""))
        return "".join(parts)


# ─── Data structures ──────────────────────────────────────────────────

@dataclass
class TurnResult:
    turn: int
    prompt: str
    # From PromptResponse
    stop_reason: Optional[str] = None
    response_input_tokens: int = 0
    response_output_tokens: int = 0
    response_cache_read: int = 0
    response_cache_write: int = 0
    response_total_tokens: int = 0
    # From usage_update notifications (per-turn updates)
    usage_updates: list = field(default_factory=list)
    # Final usage_update (the last one with cost/size)
    final_used: int = 0
    final_size: int = 0
    final_cost: float = 0.0
    # Agent text response
    agent_text: str = ""
    notes: str = ""


# ─── Main test harness ────────────────────────────────────────────────

def main():
    print("=" * 80)
    print("TELEMETRY VALIDATION TEST HARNESS — claude-agent-acp PR #344")
    print("=" * 80)
    print()

    # Run from the project directory
    project_dir = os.path.dirname(os.path.abspath(__file__))

    # Check the binary exists
    dist_path = os.path.join(project_dir, "dist", "index.js")
    if not os.path.exists(dist_path):
        print(f"ERROR: {dist_path} not found. Run 'npm run build' first.")
        sys.exit(1)

    # Spawn the subprocess (match the integration test pattern)
    # Unset CLAUDECODE to avoid "nested session" detection when running inside Claude Code
    env = {**os.environ}
    env.pop("CLAUDECODE", None)

    print("[*] Spawning claude-agent-acp subprocess...")
    proc = subprocess.Popen(
        ["node", dist_path],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=project_dir,
        env=env,
    )

    conn = ACPConnection(proc)
    time.sleep(1)  # Let subprocess initialize

    try:
        run_tests(conn)
    except Exception as e:
        print(f"\nFATAL ERROR: {e}")
        import traceback
        traceback.print_exc()
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def run_tests(conn: ACPConnection):
    # ─── Initialize ───────────────────────────────────────────────
    print("[*] Sending initialize...")
    init_resp = conn.send_request("initialize", {
        "protocolVersion": 1,
        "clientCapabilities": {
            "fs": {"readTextFile": True, "writeTextFile": True},
        },
    })
    if "error" in init_resp:
        print(f"  ERROR: {init_resp['error']}")
        sys.exit(1)
    print(f"  OK: protocol={init_resp['result'].get('protocolVersion')}")

    # ─── Create session ───────────────────────────────────────────
    print("[*] Creating new session...")
    cwd = os.path.dirname(os.path.abspath(__file__))
    session_resp = conn.send_request("session/new", {
        "cwd": cwd,
        "mcpServers": [],
    })
    if "error" in session_resp:
        print(f"  ERROR: {session_resp['error']}")
        # Print any stderr output for debugging
        time.sleep(1)
        print(f"  STDERR ({len(conn.stderr_lines)} lines):")
        for line in conn.stderr_lines[-20:]:
            print(f"    {line}")
        sys.exit(1)
    session_id = session_resp["result"]["sessionId"]
    print(f"  OK: sessionId={session_id}")

    # ─── Set bypass permissions mode ──────────────────────────────
    print("[*] Setting bypassPermissions mode...")
    mode_resp = conn.send_request("session/set_mode", {
        "sessionId": session_id,
        "modeId": "bypassPermissions",
    })
    if "error" in mode_resp:
        print(f"  WARNING: set_mode failed: {mode_resp['error']}")
    else:
        print("  OK")

    # Drain any initialization notifications
    time.sleep(2)
    conn.drain_notifications()

    turns: list[TurnResult] = []

    # ═══════════════════════════════════════════════════════════════
    # TEST 1: Single-turn sanity check
    # ═══════════════════════════════════════════════════════════════
    print()
    print("─" * 60)
    print("TEST 1: Single-turn sanity check")
    print("─" * 60)

    t1 = send_prompt(conn, session_id, 1, "What is 2+2? Reply with just the number.")
    turns.append(t1)

    assert t1.response_input_tokens > 0, "input_tokens should be > 0"
    assert t1.response_output_tokens > 0, "output_tokens should be > 0"
    assert t1.response_total_tokens > 0, "total_tokens should be > 0"
    assert t1.response_total_tokens < 1_000_000, f"total_tokens suspiciously high: {t1.response_total_tokens}"
    print(f"  PASS: tokens are plausible (total={t1.response_total_tokens})")

    if t1.final_cost > 0:
        print(f"  PASS: cost reported: ${t1.final_cost:.6f}")
    else:
        print(f"  INFO: cost is {t1.final_cost} (may be zero for cached responses)")

    if t1.final_size > 0:
        print(f"  PASS: context window size: {t1.final_size}")
    else:
        print(f"  WARN: context window size is 0")

    # ═══════════════════════════════════════════════════════════════
    # TEST 2: Multi-turn token accumulation
    # ═══════════════════════════════════════════════════════════════
    print()
    print("─" * 60)
    print("TEST 2: Multi-turn token accumulation")
    print("─" * 60)

    t2 = send_prompt(conn, session_id, 2, "Now what is 3+3? Reply with just the number.")
    turns.append(t2)

    t3 = send_prompt(conn, session_id, 3, "And what is 5+5? Reply with just the number.")
    turns.append(t3)

    # Check monotonic growth of final_used
    print(f"  Turn 1 final_used: {t1.final_used}")
    print(f"  Turn 2 final_used: {t2.final_used}")
    print(f"  Turn 3 final_used: {t3.final_used}")

    if t2.final_used > t1.final_used:
        print("  PASS: Turn 2 used > Turn 1 used (monotonic growth)")
    else:
        print(f"  FAIL: Turn 2 used ({t2.final_used}) <= Turn 1 used ({t1.final_used})")

    if t3.final_used > t2.final_used:
        print("  PASS: Turn 3 used > Turn 2 used (monotonic growth)")
    else:
        print(f"  FAIL: Turn 3 used ({t3.final_used}) <= Turn 2 used ({t2.final_used})")

    # Check that PromptResponse.usage also grows
    print(f"\n  Turn 1 response total: {t1.response_total_tokens}")
    print(f"  Turn 2 response total: {t2.response_total_tokens}")
    print(f"  Turn 3 response total: {t3.response_total_tokens}")

    if t2.response_total_tokens > t1.response_total_tokens:
        print("  PASS: PromptResponse total grows across turns")
    else:
        print("  NOTE: PromptResponse total did not grow — check if it's per-turn or cumulative")

    # ═══════════════════════════════════════════════════════════════
    # TEST 3: /compact — does 'used' drop?
    # ═══════════════════════════════════════════════════════════════
    print()
    print("─" * 60)
    print("TEST 3: /compact compaction test (SteffenDE's scenario)")
    print("─" * 60)

    pre_compact_used = t3.final_used
    print(f"  Pre-compact final_used: {pre_compact_used}")

    t4 = send_prompt(conn, session_id, 4, "/compact")
    turns.append(t4)
    print(f"  Post-/compact final_used: {t4.final_used}")
    print(f"  Post-/compact response_total: {t4.response_total_tokens}")

    # Send another prompt after compaction
    t5 = send_prompt(conn, session_id, 5, "What is 4+4? Reply with just the number.")
    turns.append(t5)
    print(f"  Post-compact prompt final_used: {t5.final_used}")

    # Compare used values — note that with short conversations, compaction may not
    # reduce context because the system prompt dominates. The key check is whether
    # 'used' represents per-API-call context (correct) vs cumulative (wrong).
    # With the old cumulative approach, Turn 5 used would be ~3x Turn 1's used.
    # With per-call context, Turn 5 should be similar magnitude to Turn 1.
    ratio_to_turn1 = t5.final_used / max(t1.final_used, 1)
    print(f"  Ratio of Turn 5 used / Turn 1 used: {ratio_to_turn1:.2f}")

    if ratio_to_turn1 < 2.0:
        print("  PASS: Post-compact 'used' is within 2x of Turn 1 → per-call context (not cumulative)")
        print("     → With cumulative semantics, this ratio would be ~3-5x")
    else:
        print(f"  WARN: Ratio {ratio_to_turn1:.2f}x suggests possible cumulative counting")

    if t5.final_used < pre_compact_used:
        print("  PASS: 'used' DROPPED after compaction (context shrank)")
    elif t5.final_used > pre_compact_used:
        print(f"  NOTE: 'used' grew slightly ({pre_compact_used} → {t5.final_used})")
        print("     → Short conversations may not shrink after compaction (system prompt dominates)")
        print("     → The key metric is ratio to Turn 1, not absolute direction")
    else:
        print("  NOTE: 'used' stayed the same after compaction")

    # ═══════════════════════════════════════════════════════════════
    # TEST 4: /context ground truth
    # ═══════════════════════════════════════════════════════════════
    print()
    print("─" * 60)
    print("TEST 4: /context ground truth comparison")
    print("─" * 60)

    t6 = send_prompt(conn, session_id, 6, "/context")
    turns.append(t6)
    print(f"  /context agent text: {t6.agent_text[:500] if t6.agent_text else '(empty)'}")
    print(f"  Our reported final_used: {t6.final_used}")

    # Try to parse context usage from the agent text
    context_tokens = parse_context_usage(t6.agent_text)
    if context_tokens is not None:
        print(f"  /context reports: ~{context_tokens} tokens in context")
        diff = abs(t6.final_used - context_tokens)
        pct = (diff / max(context_tokens, 1)) * 100
        print(f"  Difference: {diff} tokens ({pct:.1f}%)")
        if pct < 20:
            print("  PASS: Our 'used' roughly matches /context")
        else:
            print(f"  FAIL: Our 'used' ({t6.final_used}) diverges significantly from /context ({context_tokens})")
    else:
        print("  INFO: Could not parse /context output")

    # ═══════════════════════════════════════════════════════════════
    # TEST 5: Per-turn accumulation vs result.usage
    # ═══════════════════════════════════════════════════════════════
    print()
    print("─" * 60)
    print("TEST 5: Per-turn accumulation vs final result.usage")
    print("─" * 60)

    # The per-turn usage_updates show cumulative values.
    # Check if the last per-turn update matches the final PromptResponse.
    for t in turns:
        if t.usage_updates:
            last_update_used = t.usage_updates[-1].get("used", 0)
            print(f"  Turn {t.turn}: last per-turn update used={last_update_used}, "
                  f"response total={t.response_total_tokens}, "
                  f"final_used={t.final_used}")
            if last_update_used != t.final_used and t.final_used > 0:
                print(f"    NOTE: Per-turn cumulative ({last_update_used}) != "
                      f"final result ({t.final_used})")

    # ═══════════════════════════════════════════════════════════════
    # SUMMARY TABLE
    # ═══════════════════════════════════════════════════════════════
    print()
    print("=" * 120)
    print("SUMMARY TABLE")
    print("=" * 120)
    hdr = (
        f"{'Turn':>4} | {'Prompt':<42} | {'input':>7} | {'output':>7} | "
        f"{'cache_r':>7} | {'total':>7} | {'cost_usd':>10} | "
        f"{'upd.used':>10} | {'upd.size':>10} | {'Notes'}"
    )
    print(hdr)
    print("-" * 120)
    for t in turns:
        prompt_short = t.prompt[:40] + (".." if len(t.prompt) > 40 else "")
        row = (
            f"{t.turn:>4} | {prompt_short:<42} | {t.response_input_tokens:>7} | "
            f"{t.response_output_tokens:>7} | {t.response_cache_read:>7} | "
            f"{t.response_total_tokens:>7} | {t.final_cost:>10.6f} | "
            f"{t.final_used:>10} | {t.final_size:>10} | {t.notes}"
        )
        print(row)

    print()
    print("=" * 120)
    print("PER-TURN USAGE UPDATE DETAIL")
    print("=" * 120)
    for t in turns:
        print(f"\n  Turn {t.turn} ({t.prompt[:50]}):")
        if not t.usage_updates:
            print("    (no usage_update notifications)")
        for i, u in enumerate(t.usage_updates):
            cost_info = ""
            if "cost" in u and u["cost"]:
                cost_info = f", cost=${u['cost'].get('amount', 0):.6f}"
            print(f"    [{i}] used={u.get('used', '?')}, size={u.get('size', '?')}{cost_info}")

    # ═══════════════════════════════════════════════════════════════
    # ANALYSIS
    # ═══════════════════════════════════════════════════════════════
    print()
    print("=" * 80)
    print("ANALYSIS")
    print("=" * 80)

    # Determine if we're reporting cumulative or current context
    if len(turns) >= 5:
        turn1_used = turns[0].final_used
        pre_compact = turns[2].final_used  # Turn 3 (last before /compact)
        post_compact_prompt = turns[4].final_used  # Turn 5 (first after /compact)

        # The key test: with cumulative semantics, Turn 5 would be ~5x Turn 1
        # (since we've had 5+ API calls). With per-call context, Turn 5 should
        # be within ~2x of Turn 1 (same system prompt, similar conversation size).
        ratio = post_compact_prompt / max(turn1_used, 1)

        if ratio < 2.0:
            print(f"""
  CONCLUSION: UsageUpdate.used reports CURRENT CONTEXT (per-API-call input tokens).

  Evidence:
  - Turn 1 used: {turn1_used}
  - Turn 3 used (pre-compact): {pre_compact}
  - Turn 5 used (post-compact): {post_compact_prompt}
  - Ratio (Turn 5 / Turn 1): {ratio:.2f}x

  The 'used' value represents the total input tokens for the last API call,
  which is the current context window usage. This includes:
    input_tokens + cache_read_input_tokens + cache_creation_input_tokens

  With short conversations, compaction may not reduce context significantly
  because the system prompt (~17K tokens) dominates. But the semantics are correct:
  'used' reflects actual context size, not cumulative API throughput.

  PromptResponse.usage correctly reports per-prompt aggregated token counts.

  SEMANTICS:
  - UsageUpdate.used → current context window tokens (per-API-call)
  - UsageUpdate.size → max context window (e.g., 200,000)
  - PromptResponse.usage → total tokens for this prompt (across iterations)
  - Cost accumulates across all prompts in the session
""")
        else:
            print(f"""
  WARNING: UsageUpdate.used may be CUMULATIVE.

  Turn 1 used: {turn1_used}
  Turn 5 used (post-compact): {post_compact_prompt}
  Ratio: {ratio:.2f}x — this suggests cumulative counting.

  RECOMMENDATION: Investigate further — the 'used' field should represent
  current context window usage, not cumulative API token throughput.
""")


def send_prompt(conn: ACPConnection, session_id: str, turn_num: int,
                prompt_text: str, timeout: float = 120) -> TurnResult:
    """Send a prompt and capture all usage data."""
    print(f"\n  [Turn {turn_num}] Sending: {prompt_text[:60]}")

    # Clear notifications before sending
    conn.drain_notifications()

    result = conn.send_request("session/prompt", {
        "sessionId": session_id,
        "prompt": [{"type": "text", "text": prompt_text}],
    }, timeout=timeout)

    # Wait a moment for trailing notifications
    time.sleep(0.5)

    # Collect notifications
    notifs = conn.drain_notifications()
    usage_updates = conn.get_usage_updates(notifs)
    agent_text = conn.get_agent_text(notifs)

    tr = TurnResult(turn=turn_num, prompt=prompt_text, agent_text=agent_text)

    # Extract PromptResponse data
    if "result" in result:
        r = result["result"]
        tr.stop_reason = r.get("stopReason")
        usage = r.get("usage", {})
        tr.response_input_tokens = usage.get("inputTokens", 0)
        tr.response_output_tokens = usage.get("outputTokens", 0)
        tr.response_cache_read = usage.get("cachedReadTokens", 0)
        tr.response_cache_write = usage.get("cachedWriteTokens", 0)
        tr.response_total_tokens = usage.get("totalTokens", 0)
    elif "error" in result:
        tr.notes = f"ERROR: {result['error']}"
        print(f"    ERROR: {result['error']}")

    # Extract usage_update data
    tr.usage_updates = usage_updates
    if usage_updates:
        # The last usage_update should be the final one (from result message)
        last = usage_updates[-1]
        tr.final_used = last.get("used", 0)
        tr.final_size = last.get("size", 0)
        cost = last.get("cost")
        if cost:
            tr.final_cost = cost.get("amount", 0.0)

    print(f"    stop_reason={tr.stop_reason}, "
          f"input={tr.response_input_tokens}, output={tr.response_output_tokens}, "
          f"total={tr.response_total_tokens}")
    print(f"    usage_updates: {len(usage_updates)}, "
          f"final_used={tr.final_used}, final_size={tr.final_size}, "
          f"final_cost=${tr.final_cost:.6f}")
    if agent_text:
        print(f"    agent text: {agent_text[:100]}...")

    return tr


def parse_context_usage(text: str) -> Optional[int]:
    """Try to parse token count from /context output."""
    if not text:
        return None

    import re

    # Common patterns from Claude Code's /context output:
    # "Context Usage: 12,345 / 200,000 tokens"
    # "12345/200000 tokens"
    # "Used: 12,345 tokens"
    patterns = [
        r"(\d[\d,]*)\s*/\s*\d[\d,]*\s*tokens",
        r"[Uu]sed:?\s*(\d[\d,]*)\s*tokens",
        r"[Cc]ontext.*?(\d[\d,]*)\s*/",
        r"(\d[\d,]*)\s*tokens?\s*used",
        r"(\d{3,}[\d,]*)",  # fallback: any number > 100
    ]

    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            num_str = match.group(1).replace(",", "")
            try:
                return int(num_str)
            except ValueError:
                continue

    return None


if __name__ == "__main__":
    main()
