"""Tests for the Stage 2 dataset preparation tools. Run from ai-service/:
python -m unittest discover tests

All articles and label values below are synthetic test fixtures written for
these tests. They are not research labels.
"""

import csv
import json
import tempfile
import unittest
from pathlib import Path

from event_intel.dataset.common import DatasetError, read_csv, text_sha256, write_csv
from event_intel.dataset.grouping import article_keys, build_groups, related_disasters, title_family
from event_intel.dataset.label_sheet import generate, output_paths, select_samples, sheet_row
from event_intel.dataset.schema import CATEGORIES, EXPORT_COLUMNS, GUIDE_VERSION, SHEET_COLUMNS
from event_intel.dataset.snapshot import load_snapshot
from event_intel.dataset.split import assign_groups, make_split
from event_intel.dataset.validate_labels import export_labels, validate_file, validate_rows
from event_intel.lexicons import CATEGORY_LABELS

PROSE = (" Health officials reported more patients at district hospitals and continued surveillance in the "
         "affected areas while relief teams distributed supplies to families.") * 6


def record(id, title, content=None, summary=None, source="ReliefWeb (UN OCHA)", language="en",
           url=None, published="2026-10-01T00:00:00+00:00"):
    return {"id": id, "data_source_id": "s1", "source": {"name": source, "source_type": "api"}, "title": title,
            "summary": summary, "content": content, "url": url or f"https://example.org/{id}", "author": None,
            "language": language, "country_code": "LK", "published_at": published, "fetched_at": published}


def fixture_records():
    records = [
        record("a01", "Dengue cases rise in Colombo District", "Dengue cases rose in Colombo." + PROSE),
        record("a02", "Situation Report - Sri Lanka 26th January 2025 at 0900hrs", "Floods affected 1,200 families." + PROSE),
        record("a03", "Situation Report - Sri Lanka 02nd August 2024 at 0900hrs", "Heavy rain caused landslides." + PROSE),
        record("a04", "Situation Report - Sri Lanka 14th May 2024 at 0900hrs", "Strong winds damaged houses." + PROSE),
        record("a05", "Situation Report - Sri Lanka 1st June 2024 at 0900hrs", "Flooding in Ratnapura." + PROSE),
        record("a06", "UNICEF Sri Lanka Humanitarian Situation Report No. 3",
               "Format: Situation Report\nThemes: Health\nRelated disaster: Tropical Cyclone Ditwah - Nov 2025\n" + PROSE),
        record("a07", "IFRC Emergency Appeal: Sri Lanka Cyclone",
               "Related disaster: Tropical Cyclone Ditwah - Nov 2025\nThe cyclone displaced thousands." + PROSE),
        record("a08", "Nipah virus disease - India", "Cases of Nipah virus infection were reported in Kerala." + PROSE,
               source="WHO Disease Outbreak News"),
        record("a09", "Nipah virus infection – India (update)", "Further Nipah cases were confirmed." + PROSE,
               source="WHO Disease Outbreak News"),
        record("a10", "NDCU: Current Status of Dengue (13.10.2026)",
               "Format: Infographic\nThemes: Health\nRelated disaster: Sri Lanka: Dengue Outbreak - May 2026\n"
               "Attachment: https://example.org/a10.pdf"),
        record("a11", "NDCU: Current Status of Dengue (14.10.2026)",
               "Format: Infographic\nThemes: Health\nRelated disaster: Sri Lanka: Dengue Outbreak - May 2026\n"
               "Attachment: https://example.org/a11.pdf"),
        record("a12", "Inondations au Sri Lanka", "Des inondations ont touché le pays." + PROSE, language="fr"),
        record("a13", "Copy of the dengue story", "Dengue cases rose in Colombo." + PROSE,
               published="2026-10-03T00:00:00+00:00"),
        record("a14", "Flood in Sri Lanka - Green alert, 14 Sep 2026",
               "Event type: Flood\nAlert level: Green\nAffected countries: Sri Lanka",
               source="GDACS (Global Disaster Alert and Coordination System)",
               url="https://www.gdacs.org/report.aspx?eventid=1104160&eventtype=FL"),
        record("a15", "Flood in Sri Lanka - Orange alert, 15 Sep 2026",
               "Event type: Flood\nAlert level: Orange\nAffected countries: Sri Lanka",
               source="GDACS (Global Disaster Alert and Coordination System)",
               url="https://www.gdacs.org/report.aspx?eventid=1104160&eventtype=FL&episodeid=2"),
        record("a16", "-Formula-looking title", "=SUM(A1) is not a formula here." + PROSE),
        record("a17", "Breaking news", "Short text only…", source="NewsAPI"),
    ]
    return records


def write_snapshot(directory: Path, records=None, with_manifest=True) -> Path:
    records = sorted(records or fixture_records(), key=lambda r: r["id"])
    text = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records)
    path = directory / "articles_test.jsonl"
    path.write_text(text, encoding="utf-8", newline="\n")
    if with_manifest:
        (directory / "articles_test.manifest.json").write_text(json.dumps(
            {"snapshot_file": path.name, "row_count": len(records), "sha256": text_sha256(text)}), encoding="utf-8")
    return path


def labelled(row: dict, **labels) -> dict:
    base = {"annotator": "T1", "guide_version": GUIDE_VERSION}
    return {**row, **base, **labels}


class SnapshotTests(unittest.TestCase):
    def test_loads_and_verifies_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = load_snapshot(write_snapshot(Path(tmp)))
            self.assertEqual(len(snapshot.records), 17)
            self.assertTrue(snapshot.describe()["manifest_verified"])

    def test_detects_a_changed_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_snapshot(Path(tmp))
            path.write_text(path.read_text(encoding="utf-8").replace("Colombo", "Kandy"), encoding="utf-8")
            with self.assertRaises(DatasetError):
                load_snapshot(path)


class GroupingTests(unittest.TestCase):
    def test_title_family_removes_dates_numbers_and_update_words(self):
        a = title_family("Situation Report - Sri Lanka 26th January 2025 at 0900hrs")
        b = title_family("Situation Report - Sri Lanka 02nd August 2024 at 0900hrs")
        self.assertEqual(a, b)
        self.assertEqual(title_family("Sri Lanka: Floods - Flash Update No. 4 (3 Dec)"), "sri lanka floods")
        self.assertIsNone(title_family("2026"))

    def test_month_names_are_not_cut_out_of_words(self):
        self.assertEqual(title_family("Sri Lanka: November monsoon floods"), "sri lanka monsoon floods")
        self.assertEqual(title_family("Snow in Novosibirsk"), "snow in novosibirsk")

    def test_related_disasters_split_on_year(self):
        r = record("x", "t", "Related disaster: Sri Lanka: Floods and Landslides - Nov 2025, Tropical Cyclone Ditwah - Nov 2025")
        self.assertEqual(related_disasters(r), ["sri lanka: floods and landslides - nov 2025", "tropical cyclone ditwah - nov 2025"])

    def test_keys_include_gdacs_event_glide_and_who_disease(self):
        keys = article_keys(fixture_records()[13])
        self.assertIn("gdacs:FL:1104160", keys)
        glide = article_keys(record("g", "Flood", "GLIDE: FL-2025-000218-LKA"))
        self.assertIn("glide:FL-2025-000218", glide)
        self.assertIn("who:Nipah virus", article_keys(fixture_records()[7]))

    def test_related_reports_share_a_group(self):
        grouping = build_groups(fixture_records())
        same = lambda a, b: grouping.group_of[a] == grouping.group_of[b]
        self.assertTrue(same("a02", "a03"))   # templated title series
        self.assertTrue(same("a06", "a07"))   # same ReliefWeb related disaster
        self.assertTrue(same("a08", "a09"))   # WHO follow-up on the same disease
        self.assertTrue(same("a14", "a15"))   # same GDACS event id
        self.assertTrue(same("a01", "a13"))   # same text under another URL
        self.assertFalse(same("a01", "a08"))
        self.assertIn("text:", " ".join(grouping.keys[grouping.group_of["a01"]]))


class LabelSheetTests(unittest.TestCase):
    def test_samples_are_separated_and_reproducible(self):
        records = fixture_records()
        first = select_samples(records, seed=7, family_cap=2, metadata_size=5, agreement_size=3)
        second = select_samples(list(reversed(records)), seed=7, family_cap=2, metadata_size=5, agreement_size=3)
        ids = lambda s, k: [r["id"] for r in s[k]]
        for key in ("main", "metadata_review", "agreement_review"):
            self.assertEqual(ids(first, key), ids(second, key))
        main, meta = set(ids(first, "main")), set(ids(first, "metadata_review"))
        self.assertEqual(meta, {"a10", "a11"})
        self.assertFalse(main & meta)
        self.assertTrue(set(ids(first, "agreement_review")) <= main)
        self.assertNotIn("a12", main)                      # French
        self.assertNotIn("a17", main)                      # truncated NewsAPI text
        self.assertFalse({"a01", "a13"} <= main)           # duplicate text labelled once
        series = {"a02", "a03", "a04", "a05"} & main
        self.assertEqual(len(series), 2)                   # family cap
        self.assertEqual(first["excluded"]["non_english"], 1)

    def test_sheet_rows_hold_no_rules_predictions(self):
        row = sheet_row(fixture_records()[0])
        for column in ("category", "relevance", "scope", "text_sufficient", "evidence", "flags", "diseases", "notes"):
            self.assertNotIn(column, row)
        self.assertNotIn("public_health", json.dumps(row))
        self.assertEqual(row["guide_version"], GUIDE_VERSION)

    def test_formula_like_cells_are_escaped(self):
        row = sheet_row(fixture_records()[15])
        self.assertTrue(row["title"].startswith("'-"))
        self.assertTrue(row["text_excerpt"].startswith("'="))

    def test_long_text_is_cut_into_an_excerpt(self):
        row = sheet_row(record("x", "t", "word " * 2000))
        self.assertTrue(row["text_excerpt"].endswith("[…]"))
        self.assertLessEqual(len(row["text_excerpt"]), 2010)
        self.assertEqual(row["text_chars"], len(("word " * 2000).strip()))

    def test_generate_writes_sheets_and_refuses_to_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = write_snapshot(Path(tmp))
            out = Path(tmp) / "labels"
            result = generate(snapshot, out, "t1", seed=1, family_cap=2, metadata_size=2, agreement_size=2)
            columns, rows = read_csv(result["paths"]["main"])
            self.assertEqual(tuple(columns), SHEET_COLUMNS)
            self.assertTrue(rows and all(not r["category"] and not r["relevance"] for r in rows))
            manifest = json.loads(result["paths"]["manifest"].read_text(encoding="utf-8"))
            self.assertEqual(manifest["snapshot"]["row_count"], 17)
            self.assertEqual(len(manifest["sheets"]["main"]["article_ids"]), len(rows))
            with self.assertRaises(DatasetError):
                generate(snapshot, out, "t1", seed=1)


class ValidatorTests(unittest.TestCase):
    def setUp(self):
        self.records = {r["id"]: r for r in fixture_records()}
        self.rows = [sheet_row(self.records[i]) for i in ("a01", "a08", "a02")]

    def validate(self, rows):
        return validate_rows(list(SHEET_COLUMNS), rows, "test.csv", self.records)

    def test_unlabelled_sheet_has_no_errors(self):
        report = self.validate(self.rows)
        self.assertEqual(report.errors, [])
        self.assertEqual(report.summary()["unlabelled"], 3)

    def test_valid_labels_pass(self):
        rows = [labelled(self.rows[0], category="public_health", relevance="yes", scope="sri_lanka",
                         text_sufficient="yes", evidence="Dengue cases rose in Colombo", diseases="dengue"),
                labelled(self.rows[1], category="Public_Health", relevance="possibly", scope="foreign",
                         text_sufficient="yes", evidence="Cases of Nipah virus infection | reported in Kerala",
                         flags="follow_up"),
                self.rows[2]]
        report = self.validate(rows)
        self.assertEqual(report.errors, [], report.errors)
        self.assertEqual(report.warnings, [])
        summary = report.summary()
        self.assertEqual(summary["labelled"], 2)
        self.assertEqual(summary["distributions"]["category"], {"public_health": 2})

    def test_invalid_values_partial_rows_and_missing_evidence_are_errors(self):
        rows = [labelled(self.rows[0], category="flood", relevance="yes", scope="sri_lanka", text_sufficient="yes",
                         evidence="Dengue cases rose"),
                labelled(self.rows[1], category="public_health"),
                labelled(self.rows[2], category="natural_disaster", relevance="yes", scope="sri_lanka",
                         text_sufficient="yes", flags="follow_up, duplicate")]
        messages = " ".join(i.message for i in self.validate(rows).errors)
        self.assertIn("Invalid category 'flood'", messages)
        self.assertIn("Missing relevance", messages)
        self.assertIn("Evidence quote required", messages)
        self.assertIn("Separate flags with ';'", messages)

    def test_edited_url_and_unknown_article_are_errors(self):
        rows = [dict(self.rows[0], url="https://example.org/changed"), dict(self.rows[1], article_id="zzz")]
        messages = " ".join(i.message for i in self.validate(rows).errors)
        self.assertIn("URL differs", messages)
        self.assertIn("not in the snapshot", messages)

    def test_evidence_not_in_text_and_odd_combinations_are_warnings(self):
        rows = [labelled(self.rows[0], category="other", relevance="cannot_tell", scope="unknown",
                         text_sufficient="yes", evidence="words that are not in the article", flags="no_actual_event")]
        report = self.validate(rows)
        self.assertEqual(report.errors, [])
        warnings = " ".join(i.message for i in report.warnings)
        self.assertIn("Quote not found", warnings)
        self.assertIn("cannot_tell although text_sufficient is yes", warnings)

    def test_cannot_tell_is_counted_and_excluded_from_binary_relevance(self):
        rows = [labelled(self.rows[0], category="other", relevance="cannot_tell", scope="unknown", text_sufficient="no"),
                labelled(self.rows[1], category="public_health", relevance="no", scope="foreign", text_sufficient="yes",
                         evidence="Nipah virus infection")]
        binary = self.validate(rows).summary()["binary_relevance"]
        self.assertEqual(binary, {"positive_yes_or_possibly": 0, "negative_no": 1, "excluded_cannot_tell": 1})

    def test_duplicate_rows_need_no_core_labels(self):
        rows = [labelled(self.rows[0], flags="duplicate", notes="same as a13")]
        report = self.validate(rows)
        self.assertEqual(report.errors, [])
        self.assertEqual(report.summary()["duplicates_flagged"], 1)

    def test_validation_does_not_modify_the_file_and_export_has_no_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = write_snapshot(Path(tmp))
            sheet = Path(tmp) / "labels.sheet.csv"
            rows = [labelled(self.rows[0], category="public_health", relevance="yes", scope="sri_lanka",
                             text_sufficient="yes", evidence="Dengue cases rose in Colombo"), self.rows[1]]
            write_csv(sheet, SHEET_COLUMNS, rows)
            before = sheet.read_bytes()
            report = validate_file(sheet, snapshot)
            self.assertEqual(sheet.read_bytes(), before)
            with self.assertRaises(DatasetError):
                export_labels(report, Path(tmp) / "x.sheet.csv")
            out = Path(tmp) / "labels.labels.csv"
            self.assertEqual(export_labels(report, out, sheet), 1)
            columns, exported = read_csv(out)
            self.assertEqual(tuple(columns), EXPORT_COLUMNS)
            self.assertNotIn("text_excerpt", columns)
            self.assertEqual(validate_file(out, snapshot).errors, [])


class SplitTests(unittest.TestCase):
    def test_groups_never_cross_splits_and_ratios_are_respected(self):
        groups = {f"g{i:03d}": [f"g{i:03d}-{j}" for j in range(1 + i % 3)] for i in range(120)}
        strata = {a: CATEGORIES[i % 3] for i, members in enumerate(groups.values()) for a in members}
        assignment = assign_groups(groups, strata, seed=42)
        self.assertEqual(set(assignment), set(groups))
        sizes = {s: sum(len(groups[g]) for g, x in assignment.items() if x == s) for s in ("train", "validation", "test")}
        total = sum(sizes.values())
        self.assertAlmostEqual(sizes["train"] / total, 0.70, delta=0.03)
        self.assertAlmostEqual(sizes["test"] / total, 0.15, delta=0.03)
        self.assertEqual(assignment, assign_groups(groups, strata, seed=42))

    def test_bad_ratios_are_rejected(self):
        with self.assertRaises(DatasetError):
            assign_groups({"g": ["a"]}, {"a": ""}, ratios=(0.8, 0.3, 0.1))

    def _labelled_sheet(self, tmp: Path, records) -> Path:
        rows = []
        for r in records:
            if r["id"] in ("a10", "a11", "a12", "a17"):
                continue
            rows.append(labelled(sheet_row(r), category="natural_disaster", relevance="cannot_tell" if r["id"] == "a16"
                                 else "yes", scope="sri_lanka", text_sufficient="yes", evidence=r["title"]))
        rows[0] = labelled(sheet_row(records[0]), flags="duplicate", notes="test duplicate")
        path = tmp / "split_input.labels.csv"
        write_csv(path, SHEET_COLUMNS, rows)
        return path

    def test_make_split_keeps_related_reports_together_and_is_reproducible(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            records = fixture_records()
            snapshot = write_snapshot(tmp, records)
            labels = self._labelled_sheet(tmp, records)
            meta = tmp / "meta.sheet.csv"
            write_csv(meta, SHEET_COLUMNS, [sheet_row(r) for r in records if r["id"] in ("a10", "a11")])
            first = make_split(snapshot, labels, seed=3, metadata_review_path=meta)
            second = make_split(snapshot, labels, seed=3, metadata_review_path=meta)
            self.assertEqual(first["articles"], second["articles"])
            split_of = {a["article_id"]: a["split"] for a in first["articles"]}
            group_split = {}
            for a in first["articles"]:
                self.assertEqual(group_split.setdefault(a["group_id"], a["split"]), a["split"])
            self.assertEqual(split_of["a02"], split_of["a03"])
            self.assertEqual(split_of["a14"], split_of["a15"])
            self.assertNotIn("a01", split_of)                  # flagged duplicate is excluded
            self.assertEqual(first["counts"]["excluded"], {"duplicate": 1})
            self.assertEqual(sum(first["binary_relevance_excluded_cannot_tell"].values()), 1)
            self.assertEqual(first["metadata_review"]["articles"], 2)
            self.assertEqual(first["labels"]["guide_version"], GUIDE_VERSION)

    def test_split_refuses_labels_with_errors_and_unlabelled_without_dry_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            records = fixture_records()
            snapshot = write_snapshot(tmp, records)
            bad = tmp / "bad.labels.csv"
            write_csv(bad, SHEET_COLUMNS, [labelled(sheet_row(records[0]), category="flood")])
            with self.assertRaises(DatasetError):
                make_split(snapshot, bad)
            blank = tmp / "blank.sheet.csv"
            write_csv(blank, SHEET_COLUMNS, [sheet_row(r) for r in records[:5]])
            with self.assertRaises(DatasetError):
                make_split(snapshot, blank)
            with self.assertRaises(DatasetError):
                make_split(snapshot, blank, include_unlabelled=True)  # needs --stratify none
            dry = make_split(snapshot, blank, include_unlabelled=True, stratify="none")
            self.assertFalse(dry["labelled_only"])
            self.assertEqual(sum(dry["counts"]["articles"].values()), 5)


class SchemaTests(unittest.TestCase):
    def test_categories_are_the_original_six_rules_keys(self):
        self.assertEqual(CATEGORIES, tuple(CATEGORY_LABELS))
        self.assertEqual(len(CATEGORIES), 6)


if __name__ == "__main__":
    unittest.main()
