from __future__ import annotations

import gzip
import json
import stat
import tempfile
import unittest
from pathlib import Path

from dbd_archive import (
    latest_match_records,
    redact_sensitive,
    write_gzip_json_atomic,
)
try:
    from dbd_resolve import failure_outcome
except ModuleNotFoundError:  # local stdlib-only test environments
    failure_outcome = None


class DBDArchiveTests(unittest.TestCase):
    def test_latest_match_records_collapses_retries_and_whitespace(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "matches.jsonl"
            path.write_text(
                "\n".join([
                    json.dumps({"oname": "Acme ", "outcome": "error"}),
                    "not-json",
                    json.dumps({"oname": "Acme", "outcome": "exact"}),
                    json.dumps({"oname": "Beta", "outcome": "no_match"}),
                ]) + "\n",
                encoding="utf-8",
            )
            records, lines, invalid = latest_match_records(path)
            by_name = {record["oname"].strip(): record for record in records}
            self.assertEqual(lines, 4)
            self.assertEqual(invalid, 1)
            self.assertEqual(len(records), 2)
            self.assertEqual(by_name["Acme"]["outcome"], "exact")

    def test_redaction_is_recursive(self):
        value = {
            "contents": [{"fullName": "Public Name", "cmtNo": "secret", "nested": {"phoneNo": "x"}}],
            "address": "secret",
        }
        self.assertEqual(
            redact_sensitive(value),
            {"contents": [{"fullName": "Public Name", "nested": {}}]},
        )

    def test_atomic_gzip_json_is_owner_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "archive" / "value.json.gz"
            write_gzip_json_atomic(path, {"ok": True})
            with gzip.open(path, "rt", encoding="utf-8") as fh:
                self.assertEqual(json.load(fh), {"ok": True})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)

    @unittest.skipIf(failure_outcome is None, "collector HTTP dependencies are not installed")
    def test_source_rejections_are_terminal_but_not_no_match(self):
        self.assertEqual(failure_outcome("400 Client Error"), "invalid_name")
        self.assertEqual(failure_outcome("403 Client Error"), "source_blocked")
        self.assertEqual(failure_outcome("502 Server Error"), "error")


if __name__ == "__main__":
    unittest.main()
