#!/usr/bin/env python3
"""按 taskId 拉一份只读任务报表。

给排障的人一条命令：拿到 taskId 就能看到 Task/Attempt/Asset/预算/最后错误与
事件关联键，以及每一类证据能不能读。

两点刻意为之：
- 只读。排障动作改变现场，等于把要查的东西毁掉；要修复请走显式的受控接口。
- 默认脱敏。报表里可能出现签名 URL 与完整 Prompt，终端、工单、聊天记录都会
  留存输出，所以默认只打印摘要，需要原文时显式加 --raw。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlsplit, urlunsplit

REDACTED = "[redacted]"
SENSITIVE_WORDS = frozenset(
    {
        "token",
        "authorization",
        "auth",
        "prompt",
        "password",
        "passwd",
        "secret",
        "credential",
        "credentials",
        "signature",
        "apikey",
    }
)


def _key_words(key: str) -> list[str]:
    words: list[str] = []
    current = ""
    for char in key:
        if char.isalnum():
            if current and current[-1].islower() and char.isupper():
                words.append(current)
                current = char
            else:
                current += char
        else:
            if current:
                words.append(current)
            current = ""
    if current:
        words.append(current)
    return [word.lower() for word in words]


def is_sensitive_key(key: str) -> bool:
    return any(word in SENSITIVE_WORDS for word in _key_words(key))


_URL_PATTERN = re.compile(r"https?://[^\s\"']+")


def _strip_one_url(match: re.Match[str]) -> str:
    raw = match.group(0)
    try:
        parts = urlsplit(raw)
    except ValueError:
        return REDACTED
    if not parts.netloc:
        return raw
    netloc = parts.netloc.rsplit("@", 1)[-1]
    return urlunsplit((parts.scheme, netloc, parts.path, "", ""))


def strip_url_secrets(value: str) -> str:
    """URL 无论独立出现还是嵌在错误消息里，都要去掉 query 与 userinfo。"""
    if "://" not in value:
        return value
    return _URL_PATTERN.sub(_strip_one_url, value)


def sanitize(value: Any) -> Any:
    """递归脱敏：敏感键整字段替换，URL 去 query。"""
    if isinstance(value, dict):
        return {
            key: REDACTED if is_sensitive_key(str(key)) else sanitize(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, str):
        return strip_url_secrets(value)
    return value


def read_admin_token() -> str:
    """管理凭证只从文件读取：不进程内明文、不进 shell 历史。"""
    path = Path(os.getenv("VIDEO_FLOW_ADMIN_TOKEN_FILE", "~/.video-flow/admin-token")).expanduser()
    if not path.is_file():
        raise SystemExit(
            f"admin token file not found: {path} "
            "(set VIDEO_FLOW_ADMIN_TOKEN_FILE or create the file with mode 600)"
        )
    return path.read_text(encoding="utf-8").strip()


def summarize(report: Dict[str, Any]) -> Dict[str, Any]:
    """默认输出：只给排障需要的线索，不含完整 Prompt 与签名地址。"""
    task = report.get("task") or {}
    attempts = report.get("attempts") or []
    assets = report.get("assets") or []
    budget = report.get("budget") or {}
    evidence = report.get("evidence") or {}

    return {
        "task": {
            "id": task.get("id"),
            "status": task.get("status"),
            "taskStatus": task.get("taskStatus"),
            "deliveryStatus": task.get("deliveryStatus"),
            "errorMsg": task.get("errorMsg"),
        },
        "attempts": [
            {
                "attemptId": attempt.get("attemptId"),
                "providerTaskId": attempt.get("providerTaskId"),
                "status": attempt.get("status"),
                "costStatus": attempt.get("costStatus"),
                "failureCode": attempt.get("failureCode"),
                "failureMessage": attempt.get("failureMessage"),
            }
            for attempt in attempts
        ],
        "assets": [
            {"assetId": asset.get("assetId"), "objectKey": asset.get("objectKey")}
            for asset in assets
        ],
        "budget": {
            "state": budget.get("state"),
            "reservedCny": budget.get("reservedCny"),
            "settledCny": budget.get("settledCny"),
            "reviewOperator": budget.get("reviewOperator"),
            "operatorIsDeclaredClaim": budget.get("operatorIsDeclaredClaim"),
        },
        "lastError": report.get("lastError"),
        "correlation": report.get("correlation"),
        "evidence": evidence,
    }


def fetch_report(base_url: str, task_id: str, token: str, *, timeout: float = 20.0) -> Dict[str, Any]:
    import httpx

    response = httpx.get(
        f"{base_url.rstrip('/')}/api/v1/admin/tasks/{task_id}/report",
        headers={"X-Admin-Token": token},
        timeout=timeout,
    )
    response.raise_for_status()
    return response.json()


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Video Flow 只读任务报表")
    parser.add_argument("--task-id", required=True, help="要查询的 taskId")
    parser.add_argument(
        "--base-url",
        default=os.getenv("VIDEO_FLOW_BACKEND_URL", "http://localhost:3100"),
        help="Backend 地址",
    )
    parser.add_argument(
        "--raw",
        action="store_true",
        help="打印完整响应（仍脱敏）；默认只打印摘要",
    )
    args = parser.parse_args(argv)

    token = read_admin_token()
    try:
        report = fetch_report(args.base_url, args.task_id, token)
    except Exception as error:  # 网络与 4xx/5xx 都要给出可读原因
        print(f"failed to fetch report for {args.task_id}: {error}", file=sys.stderr)
        return 1

    payload = report if args.raw else summarize(report)
    print(json.dumps(sanitize(payload), ensure_ascii=False, indent=2, sort_keys=True))

    evidence = (report.get("evidence") or {}).get("sources") or []
    missing = [source for source in evidence if not source.get("available")]
    if missing:
        # 明确提示证据缺口，避免把"读不到"误读成"没发生"。
        details = ", ".join(
            f"{source.get('source')}({source.get('reason')})" for source in missing
        )
        print(f"证据不完整: {details}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
