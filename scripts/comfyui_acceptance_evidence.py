#!/usr/bin/env python3
"""Evidence snapshots for the loopback ComfyUI acceptance environment.

Each R6 row must show that Preview moved nothing and that Production moved
exactly one Task / Attempt / reservation / Provider create. That claim is only
provable from a before/after pair, so capture a snapshot, Queue once, capture
again, and diff. This is test infrastructure: like the environment launcher it
only ever talks to loopback and never reads a real Provider credential.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable
from urllib.request import urlopen

from comfyui_acceptance_env import PROJECT_NAME, _docker_compose, _read_state


COUNTER_QUERIES = {
    "tasks": "SELECT count(*) FROM tasks;",
    "attempts": "SELECT count(*) FROM execution_attempts;",
    "reservations": "SELECT count(*) FROM task_budget_reservations;",
    "preflights": "SELECT count(*) FROM preflight_records;",
    "assets": "SELECT count(*) FROM assets;",
}


def _parse_count(stdout: str) -> int:
    for line in reversed(stdout.strip().splitlines()):
        stripped = line.strip()
        if stripped.isdigit():
            return int(stripped)
    raise ValueError(f"COUNT_ROW_NOT_FOUND:{stdout!r}")


def _default_runner(command: list[str], **kwargs) -> str:
    return subprocess.run(command, check=True, capture_output=True, text=True, **kwargs).stdout


def _default_provider_fetch(url: str) -> dict:
    with urlopen(url, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def _default_receipt_lister(root: Path) -> list[str]:
    if not root.is_dir():
        return []
    return sorted(str(path.relative_to(root)) for path in root.rglob("*.json"))


def capture_snapshot(
    runtime_root: Path,
    *,
    runner: Callable[..., str] = _default_runner,
    provider_fetch: Callable[[str], dict] = _default_provider_fetch,
    receipt_lister: Callable[[Path], list[str]] = _default_receipt_lister,
) -> dict:
    """Read the acceptance environment's current evidence counters.

    Deliberately records only ports, counters and receipt names: the actor token
    lives in the same runtime root and must never reach a snapshot file.
    """
    runtime_root = runtime_root.resolve()
    try:
        state = _read_state(runtime_root)
    except RuntimeError as error:
        raise RuntimeError(f"ACCEPTANCE_ENV_NOT_STARTED:{runtime_root}") from error

    ports = state["ports"]
    repo_root = Path(__file__).resolve().parent.parent
    compose, env = _docker_compose(repo_root, int(ports["database"]))

    counters = {}
    for name, query in COUNTER_QUERIES.items():
        stdout = runner(
            compose + [
                "exec", "-T", "postgres", "psql", "-t", "-A",
                "-v", "ON_ERROR_STOP=1", "-U", "video_contract", "-d", "video_flow_contract",
                "-c", query,
            ],
            cwd=repo_root,
            env=env,
        )
        counters[name] = _parse_count(stdout)

    stats = provider_fetch(f"http://127.0.0.1:{ports['provider']}/api/v3/__test__/stats")
    return {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "runtimeRoot": str(runtime_root),
        "ports": dict(ports),
        "counters": counters,
        "provider": {
            "createCount": stats.get("createCount", 0),
            "createCountsByKey": dict(stats.get("createCountsByKey") or {}),
        },
        "receiptFiles": receipt_lister(runtime_root / "receipts"),
    }


def diff_snapshots(before: dict, after: dict) -> dict:
    counters = {
        name: after["counters"].get(name, 0) - before["counters"].get(name, 0)
        for name in COUNTER_QUERIES
    }
    before_keys = before["provider"].get("createCountsByKey", {})
    after_keys = after["provider"].get("createCountsByKey", {})
    key_deltas = {
        key: after_keys.get(key, 0) - before_keys.get(key, 0)
        for key in set(before_keys) | set(after_keys)
    }
    before_receipts = set(before.get("receiptFiles", []))
    after_receipts = set(after.get("receiptFiles", []))
    return {
        "counters": counters,
        "counterIncrements": {name: delta for name, delta in counters.items() if delta},
        "providerCreateCount": after["provider"]["createCount"] - before["provider"]["createCount"],
        "providerCreatesByPrompt": {key: delta for key, delta in key_deltas.items() if delta},
        "newReceiptFiles": sorted(after_receipts - before_receipts),
        "removedReceiptFiles": sorted(before_receipts - after_receipts),
    }


def preview_increment_violations(diff: dict) -> list[str]:
    """Preview must record its report and move nothing executable.

    Preview is *supposed* to append exactly one PreflightRecord — that record is
    the report the user reads and the credential Production later consumes. What
    it must never do is create a Task / Attempt / reservation, register an Asset
    or reach the Provider. Asserting "everything is zero" would be wrong here and
    is exactly the mistake this function exists to prevent.
    """
    violations = [
        f"counter:{name}"
        for name in COUNTER_QUERIES
        if name != "preflights" and diff["counters"].get(name, 0) != 0
    ]
    if diff["providerCreateCount"]:
        violations.append("providerCreateCount")
    preflights = diff["counters"].get("preflights", 0)
    if preflights != 1:
        violations.append(f"preflightRecords:{preflights}")
    return violations


def production_increment_violations(diff: dict) -> list[str]:
    """Production must move exactly one Task, one Attempt, one reservation and one create."""
    violations = [
        f"counter:{name}:{diff['counters'].get(name, 0)}"
        for name in ("tasks", "attempts", "reservations")
        if diff["counters"].get(name, 0) != 1
    ]
    if diff["providerCreateCount"] != 1:
        violations.append(f"providerCreateCount:{diff['providerCreateCount']}")
    return violations


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("snapshot", "diff", "assert-preview", "assert-production"))
    parser.add_argument("paths", nargs="+")
    parser.add_argument("--runtime-root", type=Path, default=Path("/tmp/video-flow-comfy-acceptance"))
    args = parser.parse_args()
    try:
        if args.command == "snapshot":
            snapshot = capture_snapshot(args.runtime_root)
            Path(args.paths[0]).write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"已写入快照 {args.paths[0]}：{json.dumps(snapshot['counters'], ensure_ascii=False)} create={snapshot['provider']['createCount']}")
            return 0
        before, after = (json.loads(Path(path).read_text(encoding="utf-8")) for path in args.paths[:2])
        diff = diff_snapshots(before, after)
        print(json.dumps(diff, ensure_ascii=False, indent=2))
        violations = preview_increment_violations(diff) if args.command == "assert-preview" else (
            production_increment_violations(diff) if args.command == "assert-production" else []
        )
        if violations:
            print(f"FAIL: {violations}", file=sys.stderr)
            return 1
        return 0
    except (RuntimeError, ValueError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
