"""
Telling an Imperva block apart from a DBD auth rejection.

Both arrive as 403. They need opposite responses: an auth rejection is cured by
a new token, while a WAF block is made worse by asking for one, because
/api/refresh is the endpoint Imperva guards most closely. Conflating them is how
a block came to be treated as ordinary token expiry and answered with more
refreshes — which is what kept us blocked on 2026-08-12.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from dbd_client import APIError, DBDClient, WAFBlocked


class ClassifyResponseTests(unittest.TestCase):
    def test_html_403_is_a_waf_block(self):
        with self.assertRaises(WAFBlocked):
            DBDClient.classify_response(403, "text/html; charset=UTF-8", "/api/refresh")

    def test_json_403_is_an_auth_error(self):
        with self.assertRaises(APIError):
            DBDClient.classify_response(403, "application/json", "/api/v1/x")

    def test_problem_json_is_also_an_auth_error(self):
        with self.assertRaises(APIError):
            DBDClient.classify_response(401, "application/problem+json", "/api/v1/x")

    def test_missing_content_type_is_treated_as_a_block(self):
        # Imperva's block page has been seen without a usable content-type.
        # Guessing "auth error" there would send us back at /api/refresh.
        with self.assertRaises(WAFBlocked):
            DBDClient.classify_response(403, "", "/api/refresh")

    def test_200_passes(self):
        self.assertIsNone(DBDClient.classify_response(200, "application/json", "/api/v1/x"))

    def test_other_statuses_are_left_to_the_caller(self):
        # 429 and 5xx keep flowing to raise_for_status, so the rate limiter's
        # existing "429 means slow down" handling is untouched.
        for status in (429, 500, 502):
            self.assertIsNone(DBDClient.classify_response(status, "text/html", "/api/v1/x"))

    def test_messages_stay_matchable_by_existing_callers(self):
        """Callers test `"403" in str(exc)`; both branches must keep saying so."""
        for content_type in ("text/html", "application/json"):
            with self.subTest(content_type=content_type):
                try:
                    DBDClient.classify_response(403, content_type, "/api/refresh")
                except Exception as exc:
                    self.assertIn("403", str(exc))
                else:
                    self.fail("expected a raise")


class CookieLoadingTests(unittest.TestCase):
    def _client(self) -> DBDClient:
        # Build one without touching the network: __init__ refreshes a token.
        return DBDClient.__new__(DBDClient)

    def test_cookies_load_from_a_list(self):
        import requests
        client = self._client()
        client.session = requests.Session()
        loaded = client.load_cookies([
            {"name": "incap_ses_1", "value": "abc", "domain": ".dbd.go.th", "path": "/"},
            {"name": "visid_incap", "value": "def", "domain": ".dbd.go.th", "path": "/"},
        ])
        self.assertEqual(loaded, 2)
        self.assertEqual(client.session.cookies.get("incap_ses_1", domain=".dbd.go.th"), "abc")

    def test_cookies_load_from_a_file_and_carry_the_user_agent(self):
        import requests
        client = self._client()
        client.session = requests.Session()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cookies.json"
            path.write_text(json.dumps([
                {"name": "a", "value": "1", "domain": ".dbd.go.th", "path": "/",
                 "userAgent": "TestBrowser/1.0"},
            ]), encoding="utf-8")
            self.assertEqual(client.load_cookies(path), 1)
        # The UA must travel with the cookies — Imperva ties a cleared session
        # to the client that cleared it.
        self.assertEqual(client.session.headers["User-Agent"], "TestBrowser/1.0")

    def test_malformed_entries_are_skipped_not_fatal(self):
        import requests
        client = self._client()
        client.session = requests.Session()
        loaded = client.load_cookies([{"value": "no name"}, {"name": "ok", "value": "1"}, {}])
        self.assertEqual(loaded, 1)


if __name__ == "__main__":
    unittest.main()
