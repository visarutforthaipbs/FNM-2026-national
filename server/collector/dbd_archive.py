#!/usr/bin/env python3
"""Shared archive helpers for the DBD collector.

The match archive is intentionally append-only so retries remain auditable.
Consumers must therefore use the latest record for each operator instead of
counting physical JSONL lines. Detail archives are written atomically and with
owner-only permissions because committee/partner responses can contain
personal data.
"""

from __future__ import annotations

import gzip
import json
import os
import tempfile
from pathlib import Path
from typing import Any


PII_FIELDS = frozenset({
    "cmtNo",
    "address",
    "phoneNo",
    "zipCode",
    "tumbonCode",
    "ampurCode",
    "pvCode",
})


def operator_key(value: str | None) -> str:
    """Return the stable key used to collapse retry/history records."""
    return (value or "").strip()


def latest_match_records(path: Path) -> tuple[list[dict], int, int]:
    """Read an append-only match archive at its current logical grain.

    Returns ``(latest_records, physical_lines, invalid_lines)``. A later retry
    replaces the earlier logical record for the same stripped operator name,
    while the source file itself remains untouched for forensic replay.
    """
    latest: dict[str, dict] = {}
    physical_lines = 0
    invalid_lines = 0
    if not path.exists():
        return [], 0, 0

    with path.open(encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            physical_lines += 1
            try:
                rec = json.loads(line)
                key = operator_key(rec.get("oname"))
                if not key:
                    raise ValueError("match record has no operator name")
            except (json.JSONDecodeError, TypeError, ValueError):
                invalid_lines += 1
                continue
            latest[key] = rec
    return list(latest.values()), physical_lines, invalid_lines


def redact_sensitive(value: Any) -> Any:
    """Recursively remove personal identifiers from a DBD response."""
    if isinstance(value, dict):
        return {
            key: redact_sensitive(item)
            for key, item in value.items()
            if key not in PII_FIELDS
        }
    if isinstance(value, list):
        return [redact_sensitive(item) for item in value]
    return value


def write_gzip_json_atomic(path: Path, value: Any) -> None:
    """Write gzip JSON atomically with owner-only permissions."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        os.chmod(tmp_path, 0o600)
        with gzip.open(tmp_path, "wt", encoding="utf-8") as fh:
            json.dump(value, fh, ensure_ascii=False)
        os.replace(tmp_path, path)
        os.chmod(path, 0o600)
    finally:
        if tmp_path.exists():
            tmp_path.unlink()
