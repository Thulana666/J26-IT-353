"""Tests for the offline CSV evaluation (pharmacy_demand.csv_dataset). Run from ai-service/
with the virtual environment: .venv/Scripts/python -m unittest discover tests

The CSV files are generated test data, not pharmacy records.
"""

import contextlib
import io
import os
import tempfile
import unittest
from datetime import date, timedelta

try:
    from pharmacy_demand import csv_dataset
except ImportError:  # pragma: no cover - needs numpy and scikit-learn
    csv_dataset = None

HEADER = "date,pharmacy_id,product_id,product_name,dispensing_unit,units_sold\n"
START = date(2025, 1, 1)


def rows(days=72, products=3, fmt=lambda d: d.isoformat()):
    lines = []
    for i in range(days):
        day = START + timedelta(days=i)
        for p in range(products):
            sold = (3 + p) * (1.4 if day.weekday() in (2, 5) else 1) + (i * 7 + p * 3) % 4
            lines.append(f"{fmt(day)},PH1,MED{p:03d},Medicine {p},tablet,{round(sold)}")
    return lines


@unittest.skipIf(csv_dataset is None, "numpy and scikit-learn are required")
class CsvDatasetTest(unittest.TestCase):
    def write(self, lines, header=HEADER):
        f = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8", newline="")
        f.write(header + "\n".join(lines) + "\n")
        f.close()
        self.addCleanup(os.unlink, f.name)
        return f.name

    def test_profile_of_a_clean_file(self):
        series, profile = csv_dataset.load(self.write(rows()))
        self.assertEqual((profile["rows"], profile["products"], profile["days"]), (216, 3, 72))
        self.assertEqual((profile["from"], profile["to"]), ("2025-01-01", "2025-03-13"))
        self.assertEqual([len(s["days"]) for s in series], [72, 72, 72])
        self.assertEqual(profile["pharmacies"], ["PH1"])

    def test_spreadsheet_month_day_year_dates_read_like_iso_dates(self):
        iso, _ = csv_dataset.load(self.write(rows()))
        mdy, _ = csv_dataset.load(self.write(rows(fmt=lambda d: f"{d.month}/{d.day}/{d.year}")))
        self.assertEqual(iso, mdy)

    def test_ambiguous_day_month_order_is_refused(self):
        lines = [f"{d}/{m}/2025,PH1,MED001,M,tablet,1" for m in (1, 2) for d in (3, 4)]
        with self.assertRaisesRegex(csv_dataset.DatasetError, "ambiguous|month/day or day/month"):
            csv_dataset.load(self.write(lines))

    def test_problems_are_reported_not_guessed(self):
        lines = rows(days=40, products=1)
        bad = [lines[0], *lines[2:], lines[5], "2025-03-01,PH1,MED000,Medicine 0,tablet,-1"]
        with self.assertRaises(csv_dataset.DatasetError) as caught:
            csv_dataset.load(self.write(bad))
        message = str(caught.exception)
        self.assertIn("duplicate product-date", message)
        self.assertIn("missing day", message)
        self.assertIn("whole number >= 0", message)

    def test_missing_columns_and_values(self):
        with self.assertRaisesRegex(csv_dataset.DatasetError, "missing columns: units_sold"):
            csv_dataset.load(self.write(["2025-01-01,PH1,MED001,M,tablet"], header="date,pharmacy_id,product_id,product_name,dispensing_unit\n"))
        with self.assertRaisesRegex(csv_dataset.DatasetError, "missing values"):
            csv_dataset.load(self.write(["2025-01-01,PH1,MED001,,tablet,1"]))

    def test_evaluation_is_chronological_and_flags_short_history(self):
        report = csv_dataset.evaluate(self.write(rows(products=4)), test_days=14)
        result = report["result"]
        self.assertEqual(result["status"], "trained")
        ev = result["evaluation"]
        self.assertLess(ev["train"]["to"], ev["test"]["from"])
        self.assertEqual(ev["test"], {"observations": 56, "from": "2025-02-28", "to": "2025-03-13"})
        self.assertEqual(ev["train"]["observations"], 120)  # 30 target days x 4 products
        self.assertTrue(any("may be unstable" in n for n in report["notes"]))
        self.assertTrue(any("Synthetic" in n for n in report["notes"]))
        for f in result["forecasts"].values():
            self.assertEqual(f["start"], "2025-03-14")
            self.assertTrue(all(v >= 0 for v in f["values"]))

    def test_too_little_history_is_not_evaluated(self):
        report = csv_dataset.evaluate(self.write(rows(days=35)), test_days=14)
        self.assertEqual(report["result"], {"status": "insufficient_history"})

    def test_cli_exit_codes(self):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(csv_dataset.main([self.write(rows(days=35)), "--test-days", "14"]), 0)
            self.assertEqual(csv_dataset.main([self.write(["x,PH1,MED001,M,tablet,1"])]), 1)


if __name__ == "__main__":
    unittest.main()
