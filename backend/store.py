"""
简单的本地数据存储（JSON 文件）。
真实产品里换成数据库（PostgreSQL）+ 对象存储；这里为跑通闭环用文件即可。
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any

_LOCK = threading.Lock()
_BASE = os.path.join(os.path.dirname(__file__), "data")
os.makedirs(_BASE, exist_ok=True)


def _path(name: str) -> str:
    return os.path.join(_BASE, f"{name}.json")


def load(name: str, default: Any) -> Any:
    p = _path(name)
    if not os.path.exists(p):
        return default
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def save(name: str, data: Any) -> None:
    with _LOCK:
        with open(_path(name), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
