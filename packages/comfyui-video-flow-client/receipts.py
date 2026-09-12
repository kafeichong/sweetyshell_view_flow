"""Crash-safe local receipts for Video Flow task submissions."""

import hashlib
import json
import os
from pathlib import Path
from typing import Any


def credential_namespace(backend_url: str, token: str) -> str:
    """按后端地址与凭证派生不可逆命名空间。

    换账号或换后端后，旧回执里的 taskId 属于另一个身份，绝不能拿来当成本次
    执行的结果。这里只存摘要，原始的 token 永远不落盘。
    """
    material = f"{(backend_url or '').rstrip('/')}\0{token or ''}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:16]


class ReceiptStore:
    def __init__(self, root: str | Path, namespace: str | None = None):
        self.root = Path(root).expanduser()
        # 命名空间是派生摘要，只做目录名，不参与任何可逆解析。
        if namespace:
            self.root = self.root / namespace
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)

    @staticmethod
    def _filename(intent_key: str) -> str:
        if not intent_key or "/" in intent_key or "\\" in intent_key or intent_key in {".", ".."}:
            raise ValueError("invalid receipt intent key")
        return hashlib.sha256(intent_key.encode("utf-8")).hexdigest() + ".json"

    def _path(self, intent_key: str) -> Path:
        return self.root / self._filename(intent_key)

    def save(self, intent_key: str, payload: dict[str, Any]) -> None:
        destination = self._path(intent_key)
        temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
        try:
            with temporary.open("w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            temporary.chmod(0o600)
            temporary.replace(destination)
            destination.chmod(0o600)
        finally:
            if temporary.exists():
                temporary.unlink()

    def load(self, intent_key: str) -> dict[str, Any] | None:
        path = self._path(intent_key)
        if not path.exists():
            return None
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
        if not isinstance(value, dict):
            raise ValueError("receipt payload must be an object")
        return value
