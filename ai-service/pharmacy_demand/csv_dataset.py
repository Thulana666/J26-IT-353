"""Offline evaluation of the demand model on a daily-sales CSV.

    python -m pharmacy_demand.csv_dataset path/to/sales.csv [--test-days 14] [--out report.json]

Expected columns: date, pharmacy_id, product_id, product_name, dispensing_unit,
units_sold (one row per product per day). The file is checked (missing values,
duplicate product-days, gaps, negative or fractional sales) and passed to the
same model.train() the backend uses; nothing is written to the database.

The CSV has no stock levels, so every day is treated as in stock: out-of-stock
days cannot be excluded as they are for recorded pharmacy data.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta

from .model import LOOKBACK, train

COLUMNS = ["date", "pharmacy_id", "product_id", "product_name", "dispensing_unit", "units_sold"]
# Placeholder stock level: the CSV has none, so every day counts as stocked and observed.
ASSUMED_IN_STOCK = 1.0


# ISO dates, or the month/day/year form spreadsheet programs often save CSVs with.
DATE_FORMATS = ["%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y"]
MAX_PROBLEMS = 10
# Below this, results are flagged as unstable (the backend also asks for 90 days of real sales).
SHORT_HISTORY_DAYS = 90


class DatasetError(ValueError):
    pass


def date_parser(values: list[str]):
    """The one date format that reads every value; refuses a file whose day/month order is ambiguous."""
    fitting = []
    for fmt in DATE_FORMATS:
        try:
            for v in values:
                datetime.strptime(v, fmt)
        except ValueError:
            continue
        fitting.append(fmt)
    if not fitting:
        raise DatasetError("dates must be YYYY-MM-DD, M/D/YYYY or D/M/YYYY")
    if len(fitting) > 1 and fitting[0] != "%Y-%m-%d":
        raise DatasetError("dates could be month/day or day/month; save them as YYYY-MM-DD")
    return lambda v: datetime.strptime(v, fitting[0]).date()


def load(path: str) -> tuple[list[dict], dict]:
    """Reads the CSV into model series [{id, name, unit, days}] and a profile of the data.
    Raises DatasetError when the file cannot be used as it is."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        missing_columns = [c for c in COLUMNS if c not in (reader.fieldnames or [])]
        if missing_columns:
            raise DatasetError(f"missing columns: {', '.join(missing_columns)}")
        records = list(reader)
    if not records:
        raise DatasetError("no rows")

    parse_date = date_parser([(r["date"] or "").strip() for r in records if (r["date"] or "").strip()])
    problems = []
    missing_values = defaultdict(int)
    by_product: dict[str, dict] = {}
    for line, r in enumerate(records, start=2):
        for c in COLUMNS:
            if not (r.get(c) or "").strip():
                missing_values[c] += 1
        try:
            day = parse_date(r["date"].strip())
            sold = float(r["units_sold"])
        except (ValueError, AttributeError):
            problems.append(f"line {line}: bad date or units_sold")
            continue
        if sold < 0 or sold != int(sold):
            problems.append(f"line {line}: units_sold must be a whole number >= 0")
        key = r["product_id"].strip()
        p = by_product.setdefault(key, {"name": r["product_name"].strip(), "unit": r["dispensing_unit"].strip(),
                                         "pharmacies": set(), "sold": {}, "duplicates": 0})
        p["pharmacies"].add(r["pharmacy_id"].strip())
        if day in p["sold"]:
            p["duplicates"] += 1
        p["sold"][day] = sold

    duplicates = sum(p["duplicates"] for p in by_product.values())
    pharmacies = set().union(*(p["pharmacies"] for p in by_product.values()))
    if missing_values:
        problems.append(f"missing values: {dict(missing_values)}")
    if duplicates:
        problems.append(f"{duplicates} duplicate product-date rows")
    if len(pharmacies) > 1:
        problems.append(f"more than one pharmacy ({len(pharmacies)}); the model is trained per pharmacy")

    series, products = [], []
    for pid, p in sorted(by_product.items()):
        first, last = min(p["sold"]), max(p["sold"])
        span = (last - first).days + 1
        gaps = span - len(p["sold"])
        if gaps:
            problems.append(f"{pid}: {gaps} missing day(s) between {first} and {last}")
        days = [{"date": first + timedelta(days=i), "sold": p["sold"].get(first + timedelta(days=i), 0.0),
                 "closingOnHand": ASSUMED_IN_STOCK} for i in range(span)]
        values = [d["sold"] for d in days]
        series.append({"id": pid, "days": days})
        products.append({"id": pid, "name": p["name"], "unit": p["unit"], "days": span, "from": first.isoformat(),
                         "to": last.isoformat(), "total": sum(values), "mean": round(sum(values) / span, 3),
                         "min": min(values), "max": max(values), "zeroDays": values.count(0.0)})
    if problems:
        more = f"; and {len(problems) - MAX_PROBLEMS} more" if len(problems) > MAX_PROBLEMS else ""
        raise DatasetError("; ".join(problems[:MAX_PROBLEMS]) + more)

    all_days = [d["date"] for s in series for d in s["days"]]
    profile = {
        "rows": len(records),
        "pharmacies": sorted(pharmacies),
        "products": len(series),
        "from": min(all_days).isoformat(),
        "to": max(all_days).isoformat(),
        "days": (max(all_days) - min(all_days)).days + 1,
        "missingValues": 0,
        "duplicateProductDays": 0,
        "unitsSold": {"total": sum(p["total"] for p in products), "min": min(p["min"] for p in products),
                      "max": max(p["max"] for p in products)},
        "perProduct": products,
    }
    return series, profile


def evaluate(path: str, test_days: int = 14, penalty: float = 1.0, horizon: int = 30) -> dict:
    series, profile = load(path)
    # Days that can be targets: each needs the 28 days before it as history.
    target_days = profile["days"] - LOOKBACK
    notes = [
        "Synthetic demonstration data, not real pharmacy sales; the metrics show the method working, "
        "not real-world accuracy.",
        "The CSV has no stock levels, so every day is treated as in stock.",
    ]
    if profile["days"] < SHORT_HISTORY_DAYS:
        notes.append(f"Only {profile['days']} days: {max(target_days, 0)} days per product can be targets after the "
                     f"{LOOKBACK}-day history, so the holdout model is fitted on {max(target_days - test_days, 0)} "
                     f"days per product and evaluated on {test_days}. Results may be unstable and small "
                     f"differences between the methods are not meaningful.")
    result = train(series, test_days=test_days, penalty=penalty, horizon=horizon)
    if result["status"] == "trained":
        names = {p["id"]: p["name"] for p in profile["perProduct"]}
        for pid, ev in result["evaluation"]["perSeries"].items():
            ev["name"] = names[pid]
    return {"dataset": profile, "settings": {"testDays": test_days, "lambda": penalty, "horizonDays": horizon},
            "notes": notes, "result": result}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("csv")
    parser.add_argument("--test-days", type=int, default=14)
    parser.add_argument("--lambda", dest="penalty", type=float, default=1.0)
    parser.add_argument("--horizon", type=int, default=30)
    parser.add_argument("--out", help="also write the full JSON report here")
    args = parser.parse_args(argv)
    try:
        report = evaluate(args.csv, args.test_days, args.penalty, args.horizon)
    except (DatasetError, OSError) as e:
        print(f"Cannot use {args.csv}: {e}", file=sys.stderr)
        return 1
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)

    d, r = report["dataset"], report["result"]
    print(f"{d['rows']} rows, {d['products']} products, {d['from']} to {d['to']} ({d['days']} days), "
          f"pharmacy {', '.join(d['pharmacies'])}; no missing values or duplicate product-days.")
    for note in report["notes"]:
        print(f"- {note}")
    if r["status"] != "trained":
        print("Not enough history to evaluate the model; the moving average would be used.")
        return 0
    ev = r["evaluation"]
    lr, ma = ev["overall"]["linearRegression"], ev["overall"]["movingAverage"]
    print(f"\nTraining: {ev['train']['observations']} observations ({ev['train']['from']} to {ev['train']['to']}); "
          f"holdout: {ev['test']['observations']} observations ({ev['test']['from']} to {ev['test']['to']}).")
    print(f"Ridge regression  MAE {lr['mae']:.3f}  RMSE {lr['rmse']:.3f}")
    print(f"28-day moving avg MAE {ma['mae']:.3f}  RMSE {ma['rmse']:.3f}   (units/day, one step ahead)")
    print(f"\n{'product':<22}{'obs':>4}{'ridge MAE':>11}{'MA MAE':>9}  uses")
    for pid, p in ev["perSeries"].items():
        print(f"{p['name']:<22}{p['observations']:>4}{p['linearRegression']['mae']:>11.3f}"
              f"{p['movingAverage']['mae']:>9.3f}  {'ridge' if p['selected'] else 'moving average'}")
    chosen = sum(p["selected"] for p in ev["perSeries"].values())
    print(f"\nRidge selected for {chosen} of {len(ev['perSeries'])} products. Coefficients "
          + ", ".join(f"{n} {c:.3f}" for n, c in zip(r["features"], r["coefficients"])))
    forecasts = [f for f in r["forecasts"].values() if f]
    print(f"{len(forecasts)} products forecast for {args.horizon} days from "
          f"{', '.join(sorted({f['start'] for f in forecasts})) or '-'} (offline only; not stored).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
