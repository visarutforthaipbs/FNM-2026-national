#!/usr/bin/env python3
"""Remove personal identifiers from existing DBD detail archives.

Dry-run is the default. ``--apply`` rewrites only committee/partner files that
contain forbidden keys, then restricts the entire DBD archive to its owner.
No unredacted backup is created: retaining one would preserve the exposure this
repair is intended to remove.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
from pathlib import Path

from dbd_archive import PII_FIELDS, redact_sensitive, write_gzip_json_atomic


def count_sensitive(value) -> int:
    if isinstance(value, dict):
        return sum(key in PII_FIELDS for key in value) + sum(
            count_sensitive(item) for item in value.values()
        )
    if isinstance(value, list):
        return sum(count_sensitive(item) for item in value)
    return 0


def secure_permissions(root: Path) -> None:
    for path in root.rglob("*"):
        os.chmod(path, 0o700 if path.is_dir() else 0o600)
    os.chmod(root, 0o700)


def main() -> int:
    ap = argparse.ArgumentParser(description="Redact PII from archived DBD people responses.")
    ap.add_argument("--archive", type=Path, default=Path.home() / "dbd-archive")
    ap.add_argument("--apply", action="store_true", help="rewrite affected archives in place")
    args = ap.parse_args()

    root = args.archive.expanduser().resolve()
    if root in (Path("/"), Path.home().resolve()) or not (root / "detail").is_dir():
        print(f"refusing unsafe or invalid archive root: {root}", file=sys.stderr)
        return 2

    scanned = changed = fields = errors = 0
    for kind in ("committees", "partners"):
        for path in (root / "detail").glob(f"*/*.{kind}.json.gz"):
            scanned += 1
            try:
                with gzip.open(path, "rt", encoding="utf-8") as fh:
                    obj = json.load(fh)
                found = count_sensitive(obj.get("response"))
                if not found:
                    continue
                changed += 1
                fields += found
                if args.apply:
                    obj["response"] = redact_sensitive(obj.get("response"))
                    write_gzip_json_atomic(path, obj)
            except Exception as exc:
                errors += 1
                print(f"ERROR {path}: {exc}", file=sys.stderr)

    if args.apply and not errors:
        secure_permissions(root)
    mode = "redacted" if args.apply else "would redact"
    print(
        f"scanned={scanned:,} files; {mode}={changed:,} files / "
        f"{fields:,} sensitive fields; errors={errors:,}"
    )
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
