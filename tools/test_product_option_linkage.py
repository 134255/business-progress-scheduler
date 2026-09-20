"""Synthetic importer tests; opt into the private workbook via an environment path."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
from zipfile import ZipFile

from openpyxl import Workbook


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools" / "build-product-option-linkage.py"
KEYS = ["category", "brand", "model", "attribute1", "attribute2",
        "attribute3", "attribute4", "attribute5"]
EXPECTED_DIGEST = "ee23f9c98dddeb9ca4d6298c0c1e9b4daa84124cfedbcd3b1c2c8c2e2798b50d"


def fixture(*records):
    """Each synthetic record is in logical order, not physical column order."""
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Sheet1"
    sheet.append(["synthetic header"] * 12)
    for record in records:
        physical = [None] * 12
        for column, value in zip((11, 3, 1, 4, 5, 6, 7, 8), record):
            physical[column] = value
        sheet.append(physical)
    return workbook


def row(model="sample-model", brand="sample-brand", category="灯具", attrs=()):
    return [category, brand, model, *attrs, *([None] * (5 - len(attrs)))]


def decode(payload):
    dictionaries = [field["constraints"]["options"] for field in payload["fields"]]
    return [[None if value is None else dictionaries[i][value]
             for i, value in enumerate(record)]
            for record in payload["optionLinkage"]["rows"]]


class ImporterTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), "local workbook importer is not implemented")
        spec = importlib.util.spec_from_file_location("product_option_importer", SCRIPT)
        self.importer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.importer)

    def test_fields_have_logical_keys_and_ordered_nonempty_dictionaries(self):
        result = self.importer.build_import(fixture(row(attrs=("a",))))
        self.assertEqual(result["schemaVersion"], 1)
        self.assertEqual(result["optionLinkage"]["schemaVersion"], 1)
        self.assertEqual(result["optionLinkage"]["fieldKeys"], KEYS)
        self.assertEqual([f["fieldKey"] for f in result["fields"]], KEYS)
        self.assertEqual([f["name"] for f in result["fields"]],
                         ["分类", "品牌", "型号", "属性1", "属性2", "属性3", "属性4", "属性5"])
        for field in result["fields"]:
            self.assertEqual(field["type"], "single_select")
            self.assertIs(field["required"], True)
            self.assertTrue(field["constraints"]["options"])
        self.assertEqual(result["fields"][4]["constraints"]["options"], ["不适用"])
        self.assertEqual(result["optionLinkage"]["rows"], [[0, 0, 0, 0, None, None, None, None]])

    def test_preserves_embedded_commas_newlines_and_attribute_gaps(self):
        expected = row(attrs=("red,blue\nsecond line", None, "wide，tall", None, "last"))
        result = self.importer.build_import(fixture(expected))
        self.assertEqual(decode(result), [expected])
        self.assertEqual(result["fields"][3]["constraints"]["options"], [expected[3]])

    def test_keeps_source_first_occurrence_and_never_expands_cartesian_product(self):
        records = [row(attrs=("z", "small")), row(attrs=("a", "large")),
                   row(model="second", attrs=("a", "small"))]
        result = self.importer.build_import(fixture(*records, records[0]))
        self.assertEqual(decode(result), records)
        self.assertEqual(result["fields"][3]["constraints"]["options"], ["z", "a"])
        self.assertEqual(result["optionLinkage"]["rows"],
                         [[0, 0, 0, 0, 0, None, None, None],
                          [0, 0, 0, 1, 1, None, None, None],
                          [0, 0, 1, 1, 0, None, None, None]])
        self.assertEqual(result["summary"]["duplicateRows"], [5])

    def test_normalizes_edges_deduplicates_and_hashes_blank_source_text(self):
        result = self.importer.build_import(fixture(
            row(model=" sample-model ", attrs=(" one ", " ")),
            row(attrs=("one", ""))))
        expected = [["灯具", "sample-brand", "sample-model", "one", "", "", "", ""]]
        digest = hashlib.sha256(json.dumps(expected, ensure_ascii=False,
                                            separators=(",", ":")).encode("utf-8")).hexdigest()
        self.assertEqual(result["summary"]["sourceTupleDigest"], digest)
        self.assertEqual(result["summary"]["tupleCount"], 1)
        self.assertEqual(decode(result), [row(attrs=("one",))])

    def test_missing_core_never_infers_brand_from_neighboring_rows(self):
        result = self.importer.build_import(fixture(
            row(), row(brand=None), row(model=" "), row(category=None),
            row(category="outside-category")))
        self.assertEqual(decode(result), [row()])
        self.assertEqual(result["summary"]["excludedRows"], [3, 4, 5, 6])
        self.assertEqual([x["reason"] for x in result["summary"]["exclusions"]],
                         ["missing_brand", "missing_model", "missing_category", "outside_category"])

    def test_explicit_source_exclusions_are_applied_before_conflict_detection(self):
        book = fixture(row(attrs=("one",)))
        for number in (2185, 2859, 2860):
            for column, value in zip((12, 4, 2, 5, 6, 7, 8, 9), row()):
                book["Sheet1"].cell(number, column, value)
        result = self.importer.build_import(book)
        self.assertEqual(decode(result), [row(attrs=("one",))])
        self.assertEqual(result["summary"]["explicitlyExcludedRows"], [2185, 2859, 2860])

    def test_excludes_entire_conflicting_model_group_without_guessing_applicability(self):
        result = self.importer.build_import(fixture(
            row(attrs=("one",)), row(attrs=(None, "two")), row(model="valid")))
        self.assertEqual(decode(result), [row(model="valid")])
        self.assertEqual(result["summary"]["excludedRows"], [2, 3])
        self.assertTrue(all(x["reason"] == "inconsistent_applicability"
                            for x in result["summary"]["exclusions"]))

    def test_model_applicability_is_scoped_by_category_and_brand(self):
        records = [row(attrs=("one",)), row(brand="other", attrs=(None, "two")),
                   row(category="升降桌", attrs=(None, None, "three"))]
        result = self.importer.build_import(fixture(*records))
        self.assertEqual(decode(result), records)
        self.assertEqual(result["summary"]["modelCount"], 3)

    def test_rejects_error_cells_unresolved_formulas_and_boolean_options(self):
        book = fixture(row(), row(model="error", attrs=("#VALUE!",)),
                       row(model="formula", attrs=('="not-a-cache"',)),
                       row(model="boolean", attrs=(False,)))
        result = self.importer.build_import(book)
        self.assertEqual(decode(result), [row()])
        self.assertEqual(result["summary"]["excludedRows"], [3, 4, 5])

    def test_converts_numeric_options_without_losing_zero(self):
        result = self.importer.build_import(fixture(row(model=7, attrs=(0, 2.5))))
        self.assertEqual(decode(result), [row(model="7", attrs=("0", "2.5"))])

    def test_empty_catalog_and_missing_sheet_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "NO_VALID_TUPLES"):
            self.importer.build_import(fixture(row(brand=None)))
        book = fixture(row())
        book.active.title = "NotSheet1"
        with self.assertRaisesRegex(ValueError, "MISSING_SHEET"):
            self.importer.build_import(book)

    def test_limits_unique_rows_and_utf8_matrix_plus_dictionaries(self):
        # Three source row numbers are reserved exclusions, even in fixtures.
        book = fixture(*(row(model=f"m-{i}") for i in range(5004)))
        with self.assertRaisesRegex(ValueError, "ROW_LIMIT"):
            self.importer.build_import(book)
        # Excel itself truncates long cell strings, so use several legal-sized cells.
        book = fixture(*(row(model=f"large-{i}", attrs=(str(i) + "字" * 30000,))
                         for i in range(3)))
        with self.assertRaisesRegex(ValueError, "LINKAGE_SIZE_LIMIT"):
            self.importer.build_import(book)

    def test_summary_contains_only_metadata_not_source_values(self):
        result = self.importer.build_import(fixture(
            row(model="private-model", brand="private-brand", attrs=("private-option",)),
            row(model="private-rejected", brand=None)))
        summary = json.dumps(result["summary"])
        for secret in ("private-model", "private-brand", "private-option", "private-rejected"):
            self.assertNotIn(secret, summary)

    def test_non_target_count_includes_unknown_category_but_preserves_precise_reason(self):
        result = self.importer.build_import(fixture(
            row(), row(category='="uncached"'), row(category="outside")))
        self.assertEqual(result["summary"]["outsideCategoryCount"], 2)
        self.assertEqual(result["summary"]["exclusions"],
                         [{"row": 3, "reason": "missing_formula_cache"},
                          {"row": 4, "reason": "outside_category"}])

    def test_exactly_5000_unique_tuples_are_permitted(self):
        book = fixture(*(row(model=f"m-{i}") for i in range(5003)))
        result = self.importer.build_import(book)
        self.assertEqual(result["summary"]["tupleCount"], 5000)


class CliTests(unittest.TestCase):
    setUp = ImporterTests.setUp

    def temporary_qa(self):
        (ROOT / "qa").mkdir(exist_ok=True)
        return tempfile.TemporaryDirectory(prefix="product-linkage-test-", dir=ROOT / "qa")

    def test_reads_saved_formula_cache_not_formula_expression(self):
        book = fixture(row(category='="灯具"'))
        source = io.BytesIO()
        book.save(source)
        source.seek(0)
        cached = io.BytesIO()
        namespace = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        with ZipFile(source) as original, ZipFile(cached, "w") as target:
            for entry in original.infolist():
                data = original.read(entry.filename)
                if entry.filename == "xl/worksheets/sheet1.xml":
                    xml = ET.fromstring(data)
                    cell = xml.find('.//s:c[@r="L2"]', namespace)
                    cell.set("t", "str")
                    cell.find("s:v", namespace).text = "灯具"
                    data = ET.tostring(xml)
                target.writestr(entry, data)
        with self.temporary_qa() as directory:
            path = Path(directory) / "cached.xlsx"
            path.write_bytes(cached.getvalue())
            before = path.read_bytes()
            result = self.importer.import_workbook(path)
            self.assertEqual(decode(result), [row()])
            self.assertEqual(path.read_bytes(), before)

    def test_missing_formula_cache_is_excluded_even_for_optional_attribute(self):
        with self.temporary_qa() as directory:
            path = Path(directory) / "uncached.xlsx"
            fixture(row(), row(model="uncached", attrs=("=1+1",))).save(path)
            result = self.importer.import_workbook(path)
            self.assertEqual(decode(result), [row()])
            self.assertEqual(result["summary"]["exclusions"],
                             [{"row": 3, "reason": "missing_formula_cache"}])

    def test_corrupt_workbook_cannot_leak_parser_values_or_create_output(self):
        with self.temporary_qa() as directory:
            path = Path(directory) / "broken.xlsx"
            destination = Path(directory) / "output.json"
            source = io.BytesIO()
            fixture(row()).save(source)
            source.seek(0)
            with ZipFile(source) as original, ZipFile(path, "w") as target:
                for entry in original.infolist():
                    data = original.read(entry.filename)
                    if entry.filename == "xl/worksheets/sheet1.xml":
                        data = b"<private-parser-value>"
                    target.writestr(entry, data)
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = self.importer.main(["--input", str(path), "--output", str(destination)])
            self.assertNotEqual(code, 0)
            self.assertEqual(stdout.getvalue(), "")
            self.assertIn("WORKBOOK_READ_FAILED", stderr.getvalue())
            self.assertNotIn("private-parser-value", stderr.getvalue())
            self.assertFalse(destination.exists())

    def test_cli_requires_explicit_output_and_prints_only_summary(self):
        with self.temporary_qa() as directory:
            path = Path(directory) / "fixture.xlsx"
            destination = Path(directory) / "output.json"
            fixture(row(model="private-model")).save(path)
            missing = subprocess.run([sys.executable, "-B", str(SCRIPT), "--input", str(path)],
                                     capture_output=True, text=True)
            self.assertNotEqual(missing.returncode, 0)
            self.assertFalse(destination.exists())
            done = subprocess.run([sys.executable, "-B", str(SCRIPT), "--input", str(path),
                                   "--output", str(destination)], capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertNotIn("private-model", done.stdout + done.stderr)
            self.assertEqual(json.loads(done.stdout)["tupleCount"], 1)
            self.assertEqual(decode(json.loads(destination.read_text(encoding="utf-8"))),
                             [row(model="private-model")])

    def test_refuses_outputs_outside_qa_traversal_and_wrong_extensions(self):
        for path in (ROOT / "leak.json", ROOT / "qa/../leak.json",
                     ROOT.parent / "qa/leak.json", ROOT / "qa/not-json.txt", ROOT / "qa"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.importer.validate_output_path(path)

    def test_refuses_unignored_output_when_git_cannot_confirm_ignore(self):
        with patch.object(self.importer.subprocess, "run",
                          return_value=subprocess.CompletedProcess([], 1, b"", b"")):
            with self.assertRaises(ValueError):
                self.importer.validate_output_path(ROOT / "qa/not-confirmed.json")

    def test_refuses_symlink_escape_from_qa(self):
        with self.temporary_qa() as directory, tempfile.TemporaryDirectory() as outside:
            link = Path(directory) / "escape"
            try:
                link.symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest("host does not allow symlink creation")
            with self.assertRaises(ValueError):
                self.importer.validate_output_path(link / "leak.json")

    def test_never_overwrites_existing_file_or_writes_before_expected_checks(self):
        with self.temporary_qa() as directory:
            path = Path(directory) / "fixture.xlsx"
            destination = Path(directory) / "output.json"
            fixture(row()).save(path)
            args = ["--input", str(path), "--output", str(destination)]
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertNotEqual(self.importer.main(args + ["--expect-count", "2"]), 0)
                self.assertFalse(destination.exists())
                self.assertNotEqual(self.importer.main(args + ["--expect-digest", "0" * 64]), 0)
                self.assertFalse(destination.exists())
                self.assertEqual(self.importer.main(args), 0)
                before = destination.read_bytes()
                self.assertNotEqual(self.importer.main(args), 0)
                self.assertEqual(destination.read_bytes(), before)


class PrivateWorkbookTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("PRODUCT_OPTION_LINKAGE_WORKBOOK"),
                         "private workbook path not explicitly provided")
    def test_actual_workbook_counts_digest_and_read_only_integrity(self):
        ImporterTests.setUp(self)
        path = Path(os.environ["PRODUCT_OPTION_LINKAGE_WORKBOOK"])
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        result = self.importer.import_workbook(path)
        self.assertEqual(result["summary"]["tupleCount"], 2495)
        self.assertEqual(result["summary"]["modelCount"], 229)
        self.assertEqual(result["summary"]["sourceTupleDigest"], EXPECTED_DIGEST)
        self.assertEqual(result["summary"]["explicitlyExcludedRows"], [2185, 2859, 2860])
        self.assertEqual(result["summary"]["outsideCategoryCount"], 368)
        self.assertEqual(result["summary"]["optionCounts"], [4, 47, 229, 543, 396, 172, 39, 7])
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)
        # Do not let assertion diagnostics expose rows from the private workbook.
        decoded = decode(result)
        source_text = [["" if cell is None else cell for cell in item] for item in decoded]
        digest = hashlib.sha256(json.dumps(source_text, ensure_ascii=False,
                                          separators=(",", ":")).encode("utf-8")).hexdigest()
        self.assertEqual(digest, EXPECTED_DIGEST)


if __name__ == "__main__":
    unittest.main()
