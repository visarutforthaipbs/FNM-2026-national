"""Scoring rules for DIW operator -> DBD juristic person.

Every case here is taken from the live registry. The point of the suite is not
that loose matches are found, but that the loosening stops exactly where the
evidence stops: a name that fits two companies of the right legal form is
ambiguous, and a spelling variant is only admissible once the spelling DIW
actually wrote has been shown to match nothing.
"""

from __future__ import annotations

import unittest

from dbd_resolve import (
    BASIS_IDENTICAL,
    BASIS_SPACING,
    BASIS_VARIANT,
    compare_key,
    name_equality,
    query_plan,
    score,
    split_legal_form,
)


def candidate(jp_no: str, jp_name: str, jp_type: str,
              province: str = "", status: str = "ยังดำเนินกิจการอยู่") -> dict:
    return {
        "jpNo": jp_no,
        "jpName": jp_name,
        "jpType": {"jpTypeDesc": jp_type},
        "jpStatus": {"jpStatDesc": status},
        "locationProvince": {"pvDesc": province},
    }


class NameEqualityTests(unittest.TestCase):
    def test_spacing_differences_are_not_identity_differences(self):
        # All three are real DIW/DBD pairs that used to score as different names.
        for dbd_name, diw_core in [
            ("เอส.เจ.ซี. คอนกรีต จำกัด", "เอส.เจ.ซี.คอนกรีต"),
            ("ปูนซิเมนต์ไทย (แก่งคอย) จำกัด", "ปูนซิเมนต์ไทย(แก่งคอย)"),
            ("ลินเด้ (ประเทศไทย ) จำกัด (มหาชน)", "ลินเด้ (ประเทศไทย)"),
        ]:
            self.assertEqual(
                name_equality(dbd_name, diw_core, None, False),
                BASIS_SPACING,
                msg=dbd_name,
            )

    def test_identical_names_report_the_strictest_basis(self):
        self.assertEqual(
            name_equality("สยามมิชลิน  จำกัด", "สยามมิชลิน", None, False),
            BASIS_IDENTICAL,
        )

    def test_variant_needs_the_original_spelling_to_have_found_nothing(self):
        dbd = "ปูนซิเมนต์ไทย (ท่าหลวง) จำกัด"
        diw = "ปูนซีเมนต์ไทย (ท่าหลวง)"
        variant_query = "ปูนซิเมนต์ไทย (ท่าหลวง)"
        # DIW's own spelling still matches something -> variant is inadmissible.
        self.assertIsNone(name_equality(dbd, diw, variant_query, False))
        # DIW's spelling matched nothing at all -> the variant may stand in.
        self.assertEqual(
            name_equality(dbd, diw, variant_query, True),
            BASIS_VARIANT,
        )

    def test_different_companies_do_not_collapse(self):
        self.assertIsNone(name_equality("ไทยวารี จำกัด", "ไทยวา", None, False))
        self.assertIsNone(name_equality("ซินหยวน โกลบอล จำกัด", "ซินหยวน เฮ้าโฮลด์", None, False))
        self.assertNotEqual(compare_key("สยามมิชลินกรุ๊ป"), compare_key("สยามมิชลิน"))


class ScoreTests(unittest.TestCase):
    def test_spacing_only_difference_now_publishes(self):
        cands = [candidate("0205536000843", "เอส.เจ.ซี. คอนกรีต จำกัด", "บริษัทจำกัด", "ชลบุรี")]
        match, outcome, _ = score(cands, "บริษัทจำกัด", "เอส.เจ.ซี.คอนกรีต", "ชลบุรี")
        self.assertEqual(outcome, "exact")
        self.assertEqual(match["jpNo"], "0205536000843")

    def test_two_operating_companies_sharing_a_name_stay_ambiguous(self):
        # Both trading, same name, same legal form. Nothing can choose.
        cands = [
            candidate("0105569129617", "รีคัฟเวอรี่ เฮ้าส์ จำกัด", "บริษัทจำกัด", "กรุงเทพมหานคร"),
            candidate("0105557090265", "รีคัฟเวอรี่ เฮ้าส์ จำกัด", "บริษัทจำกัด", "พระนครศรีอยุธยา"),
        ]
        _, outcome, _ = score(cands, "บริษัทจำกัด", "รีคัฟเวอรี่ เฮ้าส์", "กรุงเทพมหานคร")
        self.assertEqual(outcome, "ambiguous")

    def test_a_dissolved_namesake_is_not_an_ambiguity(self):
        """SCG's สยามคราฟท์ before and after its merger.

        The registry keeps the ควบ half forever, so a name fitting "two
        companies" usually means one company across a restructuring. Only the
        surviving entity can be operating a factory today.
        """
        cands = [
            candidate("0105556020301", "สยามคราฟท์อุตสาหกรรม จำกัด", "บริษัทจำกัด", "กรุงเทพมหานคร"),
            candidate("0105527042092", "สยามคราฟท์อุตสาหกรรม จำกัด", "บริษัทจำกัด",
                      "กรุงเทพมหานคร", status="ควบ"),
        ]
        match, outcome, _ = score(cands, "บริษัทจำกัด", "สยามคราฟท์อุตสาหกรรม", "กรุงเทพมหานคร")
        self.assertEqual(outcome, "exact")
        self.assertEqual(match["jpNo"], "0105556020301")

    def test_province_cannot_elect_the_dissolved_namesake(self):
        """The regression this suite exists for.

        Province agreement is worth a point, so the dead company in the right
        province could outscore the live one elsewhere. Liveness has to be a
        gate, not a tie-breaker.
        """
        cands = [
            candidate("0105527042092", "ไทยวา จำกัด", "บริษัทจำกัด", "ชลบุรี", status="ควบ"),
            candidate("0105490000294", "ไทยวา จำกัด", "บริษัทจำกัด", "กรุงเทพมหานคร"),
        ]
        match, outcome, _ = score(cands, "บริษัทจำกัด", "ไทยวา", "ชลบุรี")
        self.assertEqual(outcome, "exact")
        self.assertEqual(match["jpNo"], "0105490000294")

    def test_all_namesakes_dissolved_stays_ambiguous(self):
        cands = [
            candidate("0105527042092", "ไทยวา จำกัด", "บริษัทจำกัด", "ชลบุรี", status="ควบ"),
            candidate("0105490000294", "ไทยวา จำกัด", "บริษัทจำกัด", "กรุงเทพมหานคร",
                      status="เสร็จการชำระบัญชี"),
        ]
        _, outcome, _ = score(cands, "บริษัทจำกัด", "ไทยวา", "ชลบุรี")
        self.assertEqual(outcome, "ambiguous")

    def test_legal_form_still_separates_same_named_companies(self):
        cands = [
            candidate("0107558000423", "ไทยวา จำกัด (มหาชน)", "บริษัทมหาชนจำกัด", "กรุงเทพมหานคร"),
            candidate("0105490000294", "ไทยวา จำกัด", "บริษัทจำกัด", "กรุงเทพมหานคร"),
        ]
        match, outcome, _ = score(cands, "บริษัทมหาชนจำกัด", "ไทยวา", "กรุงเทพมหานคร")
        self.assertEqual(outcome, "exact")
        self.assertEqual(match["jpNo"], "0107558000423")

    def test_name_coincidence_without_the_right_form_is_rejected(self):
        cands = [candidate("0103569002747", "ไทยวา", "ห้างหุ้นส่วนจำกัด", "กรุงเทพมหานคร")]
        match, outcome, _ = score(cands, "บริษัทมหาชนจำกัด", "ไทยวา", "กรุงเทพมหานคร")
        self.assertIsNone(match)
        self.assertEqual(outcome, "form_mismatch")

    def test_unrelated_results_are_not_matches(self):
        # What a noisy keyword actually returns: the keyword hits fields other
        # than the name, so none of these is the company we asked about.
        cands = [
            candidate("0103569002747", "ชาวสยามส์กรุ๊ป2026", "ห้างหุ้นส่วนจำกัด"),
            candidate("0365569001180", "ไพรม์เซฟ จำกัด", "บริษัทจำกัด"),
        ]
        match, outcome, _ = score(cands, "บริษัทมหาชนจำกัด", "เสริมสุข", "")
        self.assertIsNone(match)
        self.assertEqual(outcome, "form_mismatch")


class QueryPlanTests(unittest.TestCase):
    def test_bare_name_is_tried_first_so_the_archive_stays_valid(self):
        plan = query_plan("บริษัทจำกัด", "เสริมสุข")
        self.assertEqual(plan[0], ("เสริมสุข", True))

    def test_public_company_gets_its_own_suffix(self):
        queries = [q for q, _ in query_plan("บริษัทมหาชนจำกัด", "เสริมสุข")]
        # "เสริมสุข" alone returns 1,135 rows; this shape returns exactly one.
        self.assertIn("เสริมสุข จำกัด (มหาชน)", queries)

    def test_spelling_variants_are_planned_with_and_without_the_suffix(self):
        form, core = split_legal_form("บริษัท ปูนซีเมนต์ไทย (ท่าหลวง) จำกัด")
        queries = [q for q, _ in query_plan(form, core)]
        self.assertIn("ปูนซีเมนต์ไทย (ท่าหลวง)", queries)
        self.assertIn("ปูนซิเมนต์ไทย (ท่าหลวง)", queries)
        self.assertIn("ปูนซิเมนต์ไทย (ท่าหลวง) จำกัด", queries)

    def test_only_the_original_spelling_is_flagged_original(self):
        plan = query_plan("บริษัทจำกัด", "ปูนซีเมนต์ไทย")
        originals = [q for q, is_original in plan if is_original]
        self.assertEqual(originals, ["ปูนซีเมนต์ไทย"])


if __name__ == "__main__":
    unittest.main()
