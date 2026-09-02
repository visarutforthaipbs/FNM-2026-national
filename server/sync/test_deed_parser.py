"""
Regression tests for DOLLandsMapsCollector.parse_deed_text.

Stdlib-only, no network, no cookies/JSON side files (data_dir points at a
throwaway tempfile.mkdtemp() directory so _load_administrative_mappings and
_load_session_cookies find nothing to load).

Run: python3 server/sync/test_deed_parser.py
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dol_landsmaps_collector import DOLLandsMapsCollector


class ParseDeedTextTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.collector = DOLLandsMapsCollector(data_dir=tempfile.mkdtemp())

    def test_regression_deed_and_land_no_not_conflated(self):
        # Previously land_no was set to the deed number here — the bug this
        # suite exists to catch. See COLLECTORS.md §6.
        result = self.collector.parse_deed_text(
            "โฉนดที่ดินเลขที่ 5419 เลขที่ดิน 130 ม.2 ต.ห้วยน้ำขาว"
        )
        self.assertEqual(result["deed_no"], "5419")
        self.assertEqual(result["land_no"], "130")

    def test_deed_with_range_suffix(self):
        result = self.collector.parse_deed_text(
            "โฉนดเลขที่ 22816-9 เลขที่ดิน 49"
        )
        self.assertEqual(result["deed_no"], "22816-9")
        self.assertEqual(result["land_no"], "49")

    def test_bare_chor_deed_prefix(self):
        result = self.collector.parse_deed_text(
            "ฉ.40213 เลขที่ดิน 49 ม.6"
        )
        self.assertEqual(result["deed_no"], "40213")
        self.assertEqual(result["land_no"], "49")

    def test_deed_list_and_survey_no_without_land_no(self):
        result = self.collector.parse_deed_text(
            "โฉนดที่ดินเลขที่ 14420-14430, 43511-43512 หน้าสำรวจ 12"
        )
        self.assertIn("14420-14430", result["deed_no"])
        self.assertEqual(result["survey_no"], "12")
        self.assertIsNone(result["land_no"])

    def test_utm_map_with_html_entity_apostrophe_list(self):
        result = self.collector.parse_deed_text(
            "นส.3 เลขที่ 380&#39;381&#39;38 ระวาง 5742II4052"
        )
        self.assertEqual(result["utm_map"], "5742II4052")
        self.assertIsNone(result["deed_no"])
        self.assertIsNone(result["land_no"])
        self.assertIsNone(result["survey_no"])

    def test_no_deed_keywords_returns_all_none(self):
        result = self.collector.parse_deed_text("โรงงานผลิตสุรา")
        self.assertEqual(
            result,
            {"deed_no": None, "land_no": None, "survey_no": None, "utm_map": None},
        )

    def test_empty_string_returns_all_none(self):
        result = self.collector.parse_deed_text("")
        self.assertEqual(
            result,
            {"deed_no": None, "land_no": None, "survey_no": None, "utm_map": None},
        )

    # --- fixes applied 2026-08-18 (agy review found these) ---

    def test_thai_numerals_converted_to_arabic(self):
        # DOL API needs Arabic digits; source data carries Thai numerals.
        result = self.collector.parse_deed_text(
            "โฉนดที่ดินเลขที่ ๑๒๓๔๕ เลขที่ดิน ๖๗"
        )
        self.assertEqual(result["deed_no"], "12345")
        self.assertEqual(result["land_no"], "67")

    def test_bare_chor_with_range_suffix(self):
        result = self.collector.parse_deed_text("ฉ.1234-1236 เลขที่ดิน 50")
        self.assertEqual(result["deed_no"], "1234-1236")
        self.assertEqual(result["land_no"], "50")

    def test_colon_separator(self):
        result = self.collector.parse_deed_text(
            "โฉนดที่ดิน: 12345 เลขที่ดิน: 56 หน้าสำรวจ: 78"
        )
        self.assertEqual(result["deed_no"], "12345")
        self.assertEqual(result["land_no"], "56")
        self.assertEqual(result["survey_no"], "78")

    def test_plangthi_phrasing(self):
        result = self.collector.parse_deed_text("โฉนดที่ดินแปลงที่ 1234")
        self.assertEqual(result["deed_no"], "1234")


if __name__ == "__main__":
    unittest.main()
