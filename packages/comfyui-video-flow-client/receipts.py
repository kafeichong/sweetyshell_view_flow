"""Crash-safe local receipts for Video Flow task submissions."""

import hashlib
import json
import os
from pathlib import Path
from typing import Any


class ReceiptStore:
    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser()
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
