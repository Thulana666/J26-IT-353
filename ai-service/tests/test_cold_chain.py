"""Tests for the cold-chain preprocessing, labels, splits, dataset builder and
the not-yet-trained model endpoint. Run from ai-service/ with the virtual
environment: .venv/Scripts/python -m unittest discover tests

The synthetic trips below are test fixtures for checking the code, never
training data or results.
"""

import csv
import json
import math
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cold_chain.evaluation.metrics import binary_metrics, tune_threshold
from cold_chain.labels import DelayLabelConfig, ExcursionLabelConfig, delivery_delay_label, temperature_excursion_label
from cold_chain.preprocessing import (
    BINARY_FEATURES,
    DELAY_FEATURES,
    SEQUENCE_FEATURES,
    SUMMARY_FEATURES,
    GridConfig,
    Reading,
    Scaler,
    TripContext,
    build_grid,
    clean_readings,
    delay_features,
    haversine_km,
    parse_time,
    sequence_at,
    window_summary,
)
from cold_chain.splits import InsufficientDataError, SplitConfig, TripSpan, chronological_split

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

try:
    import matplotlib
    import sklearn
except ImportError:  # pragma: no cover
    sklearn = matplotlib = None

try:
    import torch
except ImportError:  # pragma: no cover
    torch = None

try:
    from fastapi import HTTPException

    from cold_chain.router import predict
    from cold_chain.schemas import PredictRequest, PredictResponse
except ImportError:  # pragma: no cover - the pure preprocessing tests still run
    PredictRequest = None

START = datetime(2026, 10, 18, 2, 0, tzinfo=timezone.utc)  # 07:30 in Sri Lanka
COLOMBO, KANDY = (6.9271, 79.8612), (7.2906, 80.6337)


def at(minutes, **values):
    return Reading(START + timedelta(minutes=minutes), **values)


def trip(**overrides):
    values = {"temp_min_c": 2, "temp_max_c": 8, "started_at": START}
    values.update(overrides)
    return TripContext(**values)


def column(rows, name):
    return [row[name] for row in rows]


class CleanReadingsTest(unittest.TestCase):
    def test_sorts_and_removes_duplicates_and_readings_outside_the_trip(self):
        readings = [at(3, temperature_c=5), at(1, temperature_c=4), at(1, temperature_c=9), at(-1, temperature_c=5), at(70, temperature_c=5)]
        cleaned, report = clean_readings(readings, start=START, end=START + timedelta(minutes=60))
        self.assertEqual([r.temperature_c for r in cleaned], [4, 5])
        self.assertEqual((report.input, report.duplicates, report.outside_trip, report.output), (5, 1, 2, 2))

    def test_invalid_values_are_removed_and_counted_never_adjusted(self):
        readings = [
            at(1, temperature_c=120, humidity_pct=50),
            at(2, temperature_c=float("nan"), humidity_pct=50),
            at(3, temperature_c=5, latitude=7.0),
            at(4, temperature_c=5, latitude=0.0, longitude=0.0),
            at(5, humidity_pct=-3),
        ]
        cleaned, report = clean_readings(readings)
        self.assertEqual([r.temperature_c for r in cleaned], [None, None, 5, 5])
        self.assertEqual(report.invalid, {"temperature_c": 2, "humidity_pct": 1})
        self.assertEqual((report.incomplete_position, report.no_gps_fix, report.empty), (1, 1, 1))
        self.assertTrue(all(r.latitude is None for r in cleaned))

    def test_timestamps_need_a_time_zone(self):
        with self.assertRaises(ValueError):
            clean_readings([Reading(datetime(2026, 10, 18, 2, 0), temperature_c=5)])
        self.assertEqual(parse_time("2026-10-18T02:00:00Z"), START)
        self.assertIsNone(parse_time(""))


class BuildGridTest(unittest.TestCase):
    def test_one_row_per_step_and_readings_only_count_before_the_step_end(self):
        grid = build_grid([at(0, temperature_c=4), at(1, temperature_c=6)], trip(), until=START + timedelta(minutes=3))
        self.assertEqual(len(grid), 3)
        self.assertEqual(column(grid, "temperature_c"), [4, 6, 6])  # the reading at 1:00 belongs to step 2
        self.assertEqual(column(grid, "observed"), [1.0, 1.0, 0.0])
        self.assertEqual(column(grid, "minutes_since_reading"), [1.0, 1.0, 2.0])
        self.assertTrue(all(len(sequence_at(grid, i, 5)[0]) == len(SEQUENCE_FEATURES) for i in range(3)))

    def test_no_look_ahead(self):
        readings = [at(m, temperature_c=4 + m * 0.1, speed_kmh=30, latitude=6.9 + m * 0.001, longitude=79.9) for m in range(30)]
        until = START + timedelta(minutes=30)
        full = build_grid(readings, trip(destination=KANDY, expected_delivery_at=until), until=until)
        for k in (5, 17, 29):
            cut = START + timedelta(minutes=k)
            partial = build_grid([r for r in readings if r.recorded_at < cut], trip(destination=KANDY, expected_delivery_at=until), until=cut)
            self.assertEqual(full[:k], partial, f"rows up to minute {k} must not depend on later readings")

    def test_temperature_features(self):
        readings = [at(m, temperature_c=4 + 0.1 * m) for m in range(12)]
        grid = build_grid(readings, trip(), until=START + timedelta(minutes=12))
        last = grid[-1]
        self.assertAlmostEqual(last["temperature_c"], 5.1)
        self.assertAlmostEqual(last["temperature_pos"], (5.1 - 2) / 6)
        self.assertAlmostEqual(last["margin_to_limit_c"], 2.9)
        self.assertAlmostEqual(last["temperature_change_c"], 0.1)
        self.assertAlmostEqual(last["temperature_roll_slope_c_per_min"], 0.1)
        self.assertAlmostEqual(last["temperature_roll_mean_c"], 4.65)
        self.assertIsNone(grid[0]["temperature_change_c"])
        hot = build_grid([at(0, temperature_c=9)], trip(), until=START + timedelta(minutes=1))
        self.assertAlmostEqual(hot[0]["margin_to_limit_c"], -1.0)

    def test_movement_features_ignore_flagged_gps_jumps(self):
        readings = [
            at(0, latitude=COLOMBO[0], longitude=COLOMBO[1], speed_kmh=40),
            at(1, latitude=8.5, longitude=81.0, gps_jump=True, speed_kmh=40),
            at(2, latitude=COLOMBO[0] + 0.01, longitude=COLOMBO[1], speed_kmh=0),
            at(3, speed_kmh=0),
        ]
        grid = build_grid(readings, trip(destination=KANDY), until=START + timedelta(minutes=4))
        self.assertEqual(column(grid, "gps_jump"), [0.0, 1.0, 0.0, 0.0])
        self.assertAlmostEqual(grid[-1]["distance_travelled_km"], haversine_km(*COLOMBO, COLOMBO[0] + 0.01, COLOMBO[1]))
        self.assertAlmostEqual(grid[1]["km_to_destination"], haversine_km(*COLOMBO, *KANDY))
        self.assertEqual(column(grid, "minutes_stopped"), [0.0, 0.0, 1.0, 2.0])

    def test_unknown_values_stay_missing_with_flags(self):
        grid = build_grid([at(0, temperature_c=5)], trip(), until=START + timedelta(minutes=1))
        row = grid[0]
        self.assertIsNone(row["humidity_pct"])
        self.assertIsNone(row["km_to_destination"])
        self.assertIsNone(row["minutes_to_eta"])
        self.assertEqual((row["eta_known"], row["destination_known"], row["in_trip"]), (0.0, 0.0, 1.0))

    def test_eta_and_time_of_day(self):
        grid = build_grid([at(0, temperature_c=5)], trip(expected_delivery_at=START + timedelta(minutes=61)), until=START + timedelta(minutes=1))
        self.assertAlmostEqual(grid[0]["minutes_to_eta"], 60)
        hour = 7 + 31 / 60  # 02:01 UTC = 07:31 in Sri Lanka
        self.assertAlmostEqual(grid[0]["hour_sin"], math.sin(2 * math.pi * hour / 24))

    def test_sequences_are_left_padded_before_the_trip_start(self):
        grid = build_grid([at(0, temperature_c=5)], trip(), until=START + timedelta(minutes=3))
        sequence = sequence_at(grid, 2, 5)
        in_trip = SEQUENCE_FEATURES.index("in_trip")
        self.assertEqual([row[in_trip] for row in sequence], [0.0, 0.0, 1.0, 1.0, 1.0])
        self.assertIsNone(sequence[0][SEQUENCE_FEATURES.index("temperature_c")])

    def test_invalid_limits_are_rejected(self):
        with self.assertRaises(ValueError):
            trip(temp_min_c=8, temp_max_c=2)


class DelayFeaturesTest(unittest.TestCase):
    def test_progress_features(self):
        context = trip(origin=COLOMBO, destination=KANDY, expected_delivery_at=START + timedelta(minutes=120))
        readings = [at(m, latitude=COLOMBO[0] + 0.01 * m, longitude=COLOMBO[1], speed_kmh=40) for m in range(30)]
        grid = build_grid(readings, context, until=START + timedelta(minutes=30))
        values = dict(zip(DELAY_FEATURES, delay_features(grid, 29, context)))
        self.assertEqual(len(values), len(DELAY_FEATURES))
        self.assertEqual((values["elapsed_minutes"], values["planned_minutes"], values["minutes_to_eta"]), (30, 120, 90))
        self.assertAlmostEqual(values["elapsed_fraction"], 0.25)
        self.assertAlmostEqual(values["planned_km"], haversine_km(*COLOMBO, *KANDY))
        self.assertAlmostEqual(values["required_speed_kmh"], values["km_to_destination"] / 1.5)
        self.assertAlmostEqual(values["avg_speed_kmh"], values["distance_travelled_km"] / 0.5)
        self.assertEqual(values["missing_data_fraction"], 0)


class ScalerTest(unittest.TestCase):
    FEATURES = ("a", "flag")

    def test_fit_on_training_rows_missing_values_become_the_mean(self):
        scaler = Scaler.fit([[1.0, 1.0], [3.0, 0.0], [None, 1.0], [float("nan"), 0.0]], self.FEATURES, frozenset({"flag"}))
        self.assertEqual((scaler.mean, scaler.std, scaler.scaled), ([2.0, 0.0], [1.0, 1.0], [True, False]))
        self.assertEqual(scaler.transform([[3.0, 1.0], [None, None]]), [[1.0, 1.0], [0.0, 0.0]])
        self.assertEqual(Scaler.from_dict(json.loads(json.dumps(scaler.to_dict()))), scaler)

    def test_constant_feature_does_not_divide_by_zero(self):
        scaler = Scaler.fit([[5.0, 0.0], [5.0, 1.0]], self.FEATURES, frozenset({"flag"}))
        self.assertEqual(scaler.transform_row([5.0, 1.0]), [0.0, 1.0])

    @unittest.skipIf(np is None, "needs numpy")
    def test_array_and_row_transforms_agree(self):
        rows = [[1.0, 0.0], [2.5, 1.0], [None, 1.0]]
        scaler = Scaler.fit(np.array([[np.nan if v is None else v for v in r] for r in rows]), self.FEATURES, frozenset({"flag"}))
        array = scaler.transform_array(np.array([[[np.nan if v is None else v for v in r] for r in rows]]))
        np.testing.assert_allclose(array[0], scaler.transform(rows), rtol=1e-6)


class ExcursionLabelTest(unittest.TestCase):
    END = START + timedelta(minutes=120)

    def label(self, readings, now=10, **config):
        return temperature_excursion_label(
            readings, now=START + timedelta(minutes=now), trip_end=self.END, temp_min_c=2, temp_max_c=8, config=ExcursionLabelConfig(**config)
        )

    def steady(self, until=60, value=5.0):
        return [at(m, temperature_c=value) for m in range(until)]

    def test_excursion_within_the_horizon(self):
        readings = self.steady()
        readings[25] = at(25, temperature_c=8.4)
        self.assertEqual(self.label(readings), (1, "excursion"))
        self.assertEqual(self.label(readings, horizon_minutes=10), (0, "no_excursion"))
        readings[10] = at(10, temperature_c=1.5)  # a reading exactly at `now` is in the future
        self.assertEqual(self.label(readings, horizon_minutes=5), (1, "excursion"))

    def test_minimum_excursion_duration(self):
        spike = self.steady()
        spike[20] = at(20, temperature_c=9)
        self.assertEqual(self.label(spike, min_excursion_minutes=5), (0, "no_excursion"))
        long = [at(m, temperature_c=9 if 20 <= m < 27 else 5) for m in range(60)]
        self.assertEqual(self.label(long, min_excursion_minutes=5), (1, "excursion"))

    def test_unknown_labels_are_not_guessed(self):
        ongoing = self.steady()
        ongoing[9] = at(9, temperature_c=9)
        self.assertEqual(self.label(ongoing), (None, "ongoing_excursion"))
        self.assertEqual(self.label(self.steady(), now=100), (None, "horizon_after_trip_end"))
        sparse = [at(m, temperature_c=5) for m in range(0, 60, 5)]
        self.assertEqual(self.label(sparse), (None, "sparse_future_data"))
        sparse.append(at(30, temperature_c=9))
        self.assertEqual(self.label(sorted(sparse, key=lambda r: r.recorded_at)), (1, "excursion"))


class DelayLabelTest(unittest.TestCase):
    def test_labels(self):
        eta = START + timedelta(minutes=60)
        self.assertEqual(delivery_delay_label(delivered_at=eta + timedelta(minutes=1), expected_delivery_at=eta), (1, "late"))
        self.assertEqual(delivery_delay_label(delivered_at=eta, expected_delivery_at=eta), (0, "on_time"))
        tolerant = DelayLabelConfig(tolerance_minutes=15)
        self.assertEqual(delivery_delay_label(delivered_at=eta + timedelta(minutes=10), expected_delivery_at=eta, config=tolerant), (0, "on_time"))
        self.assertEqual(delivery_delay_label(delivered_at=None, expected_delivery_at=eta), (None, "not_delivered"))
        self.assertEqual(delivery_delay_label(delivered_at=eta, expected_delivery_at=None), (None, "no_planned_delivery_time"))


class SplitTest(unittest.TestCase):
    def spans(self, n, hours=1):
        return [TripSpan(f"t{i:02}", START + timedelta(days=i), START + timedelta(days=i, hours=hours)) for i in range(n)]

    def test_earliest_trips_train_latest_test_and_no_trip_in_two_sets(self):
        split = chronological_split(list(reversed(self.spans(20))))
        self.assertEqual(split.members["train"], [f"t{i:02}" for i in range(14)])
        self.assertEqual(split.members["validation"], ["t14", "t15", "t16"])
        self.assertEqual(split.members["test"], ["t17", "t18", "t19"])
        self.assertEqual(split.set_of("t18"), "test")
        self.assertEqual(split.overlapping, {"validation": [], "test": []})

    def test_too_few_trips(self):
        with self.assertRaises(InsufficientDataError):
            chronological_split(self.spans(2))
        self.assertEqual(len(chronological_split(self.spans(3)).members["test"]), 1)

    def test_overlapping_trips_are_reported_and_can_be_purged(self):
        spans = self.spans(20)
        spans[13] = TripSpan("t13", spans[13].start, spans[14].start + timedelta(hours=2))  # still running when t14 starts
        self.assertEqual(chronological_split(spans).overlapping["validation"], ["t14"])
        purged = chronological_split(spans, SplitConfig(purge_overlap=True))
        self.assertEqual(purged.members["validation"], ["t15", "t16"])
        self.assertEqual(purged.purged, {"validation": ["t14"]})


def write_synthetic_export(directory: Path, trips: int = 12) -> None:
    """Test fixture in the exporter's format: is_test trips with simulated readings.

    Planted signals, so tests can check that the models learn when there is
    something to learn (a positive control, not evidence about real trips):
    every 3rd trip warms up from minute 25 and leaves 2-8 °C at minutes 40-44;
    odd trips drive at 30 instead of 45 km/h and arrive 5 min late."""
    directory.mkdir(parents=True, exist_ok=True)
    trip_columns = (
        "shipment_id,shipment_number,is_test,storage_condition,temp_min_c,temp_max_c,humidity_min_pct,humidity_max_pct,"
        "reading_interval_seconds,trip_status,trip_started_at,expected_delivery_at,expected_delivery_at_start,eta_source,"
        "eta_changed_after_start,delivered_at,truck_type,truck_is_refrigerated,device_type,origin_latitude,origin_longitude,"
        "destination_latitude,destination_longitude"
    ).split(",")
    reading_columns = "shipment_id,source,recorded_at,received_at,temperature_c,humidity_pct,latitude,longitude,speed_kmh,vibration_g,quality_flags".split(",")
    with (directory / "trips.csv").open("w", newline="", encoding="utf-8") as t, (directory / "readings.csv").open("w", newline="", encoding="utf-8") as r:
        trips_out, readings_out = csv.DictWriter(t, trip_columns), csv.DictWriter(r, reading_columns)
        trips_out.writeheader()
        readings_out.writeheader()
        for i in range(trips):
            start = START + timedelta(days=i)
            eta = start + timedelta(minutes=60)
            trips_out.writerow(
                {
                    "shipment_id": f"00000000-0000-0000-0000-{i:012}",
                    "shipment_number": f"SH-T{i:03}",
                    "is_test": "true",
                    "storage_condition": "refrigerated",
                    "temp_min_c": 2,
                    "temp_max_c": 8,
                    "trip_status": "delivered",
                    "trip_started_at": start.isoformat(),
                    "expected_delivery_at": eta.isoformat(),
                    "expected_delivery_at_start": eta.isoformat(),
                    "eta_source": "audit",
                    "eta_changed_after_start": "false",
                    "delivered_at": (eta + timedelta(minutes=5 if i % 2 else -5)).isoformat(),
                    "device_type": "simulator",
                    "origin_latitude": COLOMBO[0],
                    "origin_longitude": COLOMBO[1],
                    "destination_latitude": KANDY[0],
                    "destination_longitude": KANDY[1],
                }
            )
            speed = 30 if i % 2 else 45
            for m in range(66):
                temperature = 5.0
                if i % 3 == 0 and 25 <= m < 40:
                    temperature = 5.0 + 0.2 * (m - 25)  # still inside the limits (max 7.8 °C)
                elif i % 3 == 0 and 40 <= m < 45:
                    temperature = 9.0
                readings_out.writerow(
                    {
                        "shipment_id": f"00000000-0000-0000-0000-{i:012}",
                        "source": "simulator",
                        "recorded_at": (start + timedelta(minutes=m)).isoformat(),
                        "temperature_c": round(temperature, 2),
                        "humidity_pct": 60,
                        "latitude": COLOMBO[0] + 0.005 * m * speed / 45,
                        "longitude": COLOMBO[1] + 0.01 * m * speed / 45,
                        "speed_kmh": speed,
                        "quality_flags": "",
                    }
                )
    manifest = {"datasetVersion": "synthetic000", "containsTestData": True, "validForEvaluation": False}
    (directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


@unittest.skipIf(np is None, "needs numpy")
class BuildDatasetTest(unittest.TestCase):
    def test_pipeline_on_a_synthetic_export(self):
        from cold_chain.training.build_dataset import main

        with tempfile.TemporaryDirectory() as tmp:
            export = Path(tmp) / "export"
            write_synthetic_export(export)
            with self.assertRaises(SystemExit):
                main(["--export", str(export)])  # test data is refused by default
            out = Path(tmp) / "processed"
            self.assertEqual(main(["--export", str(export), "--out", str(out), "--allow-test-data"]), 0)
            card = json.loads((out / "dataset_card.json").read_text(encoding="utf-8"))
            with np.load(out / "dataset.npz") as npz:
                data = {name: npz[name] for name in npz.files}

        self.assertFalse(card["validForEvaluation"])
        self.assertTrue(card["containsTestData"])
        members = card["split"]["members"]
        self.assertEqual([len(members[s]) for s in ("train", "validation", "test")], [8, 2, 2])
        self.assertEqual(len({i for ids in members.values() for i in ids}), 12)
        self.assertLess(card["split"]["boundaries"]["train"]["last_start"], card["split"]["boundaries"]["test"]["first_start"])
        self.assertEqual(data["temp_X_train"].shape[1:], (30, len(SEQUENCE_FEATURES)))
        self.assertEqual(data["delay_X_test"].shape[1], len(DELAY_FEATURES))
        self.assertEqual(set(data["temp_trip_test"]), set(members["test"]))
        # Windows every 5 min from minute 10 while the 30-min horizon ends by delivery:
        # 4 on 55-min (on-time) trips, 6 on 65-min (late) trips.
        self.assertEqual(card["classes"]["temperature"]["samples"], 6 * 4 + 6 * 6)
        self.assertEqual(card["skipped"]["temperature"], {"horizon_after_trip_end": 72})
        # Excursion at minute 40 on trips 0, 6 (55 min) and 3, 9 (65 min): windows ending 15+ min.
        self.assertEqual(card["classes"]["temperature"]["positives"], 3 + 3 + 5 + 5)
        self.assertEqual(card["classes"]["delay"], {"samples": 60, "positives": 30, "negatives": 30, "positiveRate": 0.5})
        self.assertIn("test set has only one temperature class: metrics such as recall/ROC-AUC are undefined", card["warnings"])
        self.assertTrue(np.isnan(data["temp_X_train"][0, 0, SEQUENCE_FEATURES.index("temperature_c")]))  # padding
        self.assertEqual(card["features"]["sequenceBinary"], sorted(BINARY_FEATURES))


class WindowSummaryTest(unittest.TestCase):
    def test_latest_row_and_window_statistics_without_padding(self):
        readings = [at(m, temperature_c=4 + 0.5 * m, speed_kmh=30) for m in range(4)]
        grid = build_grid(readings, trip(), until=START + timedelta(minutes=4))
        summary = dict(zip(SUMMARY_FEATURES, window_summary(sequence_at(grid, 3, 10))))
        self.assertEqual(len(summary), len(SUMMARY_FEATURES))
        self.assertEqual(summary["last_temperature_c"], 5.5)
        self.assertEqual((summary["window_min_temperature_c"], summary["window_max_temperature_c"]), (4.0, 5.5))
        self.assertAlmostEqual(summary["window_mean_temperature_c"], 4.75)
        self.assertAlmostEqual(summary["window_slope_per_step_temperature_c"], 0.5)
        self.assertEqual(summary["window_std_speed_kmh"], 0.0)
        self.assertIsNone(summary["window_mean_humidity_pct"])
        self.assertEqual((summary["window_observed_fraction"], summary["window_history_fraction"]), (1.0, 0.4))


class MetricsTest(unittest.TestCase):
    def test_metrics_from_the_confusion_matrix(self):
        m = binary_metrics([1, 1, 0, 0, 0], [0.9, 0.4, 0.6, 0.2, 0.1], threshold=0.5)
        self.assertEqual(m["confusion_matrix"], {"tn": 2, "fp": 1, "fn": 1, "tp": 1})
        self.assertEqual((m["precision"], m["recall"], m["f1"]), (0.5, 0.5, 0.5))
        self.assertAlmostEqual(m["specificity"], 2 / 3)
        self.assertAlmostEqual(m["roc_auc"], 5 / 6)

    def test_undefined_metrics_are_none(self):
        m = binary_metrics([0, 0, 0], [0.1, 0.2, 0.3])
        self.assertEqual((m["precision"], m["recall"], m["f1"], m["roc_auc"], m["pr_auc"]), (None, None, None, None, None))
        self.assertEqual(m["accuracy"], 1.0)
        self.assertEqual(binary_metrics([], []), {"samples": 0})

    def test_threshold_is_tuned_on_validation(self):
        y, scores = [0, 0, 1, 0, 1, 1], [0.1, 0.3, 0.35, 0.4, 0.8, 0.9]
        threshold, info = tune_threshold(y, scores)
        self.assertEqual((threshold, info["source"], info["f1"]), (0.35, "validation", 6 / 7))
        threshold, info = tune_threshold(y, scores, min_recall=0.6)
        self.assertEqual((threshold, info["recall"]), (0.8, 2 / 3))
        self.assertEqual(tune_threshold([0, 0], [0.2, 0.7])[0], 0.5)


@unittest.skipIf(sklearn is None, "needs scikit-learn and matplotlib")
class BaselinesTest(unittest.TestCase):
    """Checks that the baseline pipeline runs and labels its outputs. The
    fixture is trivially separable: its scores mean nothing."""

    def test_baselines_on_a_synthetic_dataset(self):
        import joblib

        from cold_chain.training.baselines import main as baselines
        from cold_chain.training.build_dataset import main as build
        from cold_chain.training.common import NOT_RESULTS

        with tempfile.TemporaryDirectory() as tmp:
            export, dataset = Path(tmp) / "export", Path(tmp) / "dataset"
            write_synthetic_export(export, trips=20)
            build(["--export", str(export), "--out", str(dataset), "--allow-test-data"])
            for task in ("temperature", "delay"):
                out = Path(tmp) / task
                self.assertEqual(baselines(["--dataset", str(dataset), "--task", task, "--out", str(out), "--importance-repeats", "2"]), 0)
                metrics = json.loads((out / "metrics.json").read_text(encoding="utf-8"))
                run = json.loads((out / "run.json").read_text(encoding="utf-8"))
                self.assertEqual(metrics["status"], NOT_RESULTS)
                self.assertFalse(metrics["validForEvaluation"])
                self.assertEqual(set(metrics["models"]), {"no_skill", "logistic_regression", "random_forest", "gradient_boosting"})
                self.assertEqual(metrics["models"]["random_forest"]["thresholdChoice"]["source"], "validation")
                self.assertEqual(run["seed"], 42)
                self.assertEqual(run["classes"]["test"]["trips"], 3)
                self.assertIn("n_estimators", run["hyperparameters"]["random_forest"])
                with (out / "metrics.csv").open(encoding="utf-8") as handle:
                    self.assertEqual(len(list(csv.DictReader(handle))), 4 * 2 * 2)
                for plot in ("roc_test.png", "pr_validation.png", "confusion_gradient_boosting_test.png", "importance_logistic_regression.png"):
                    self.assertTrue((out / "plots" / plot).exists(), plot)
                saved = joblib.load(out / "models" / "logistic_regression.joblib")
                self.assertEqual((saved["task"], saved["valid_for_evaluation"]), (task, False))
                self.assertEqual(Scaler.from_dict(saved["scaler"]).features, tuple(saved["features"]))


class TripWeightingTest(unittest.TestCase):
    @unittest.skipIf(np is None, "needs numpy")
    def test_every_trip_weighs_the_same(self):
        from cold_chain.training.common import trip_weights

        self.assertEqual(trip_weights(["a", "a", "b"]).tolist(), [0.75, 0.75, 1.5])

    @unittest.skipIf(sklearn is None, "needs scikit-learn")
    def test_weighted_metrics(self):
        m = binary_metrics([1, 0, 0], [0.9, 0.6, 0.1], 0.5, sample_weight=[2, 1, 1])
        self.assertEqual(m["confusion_matrix"], {"tn": 1.0, "fp": 1.0, "fn": 0.0, "tp": 2.0})
        self.assertEqual((m["precision"], m["recall"], m["accuracy"], m["weighted"]), (2 / 3, 1.0, 0.75, True))

    @unittest.skipIf(sklearn is None, "needs scikit-learn")
    def test_forward_chaining_folds_never_score_earlier_trips(self):
        from cold_chain.training.delay import forward_folds

        order = [f"t{i}" for i in range(6)]
        trips = np.array([t for t in order for _ in range(2)])
        folds = forward_folds(order, trips, 3)
        self.assertEqual(len(folds), 3)
        for fit, score in folds:
            self.assertLess(max(order.index(t) for t in trips[fit]), min(order.index(t) for t in trips[score]))


@unittest.skipIf(sklearn is None, "needs scikit-learn and matplotlib")
class DelayModelTest(unittest.TestCase):
    def test_delay_models_on_a_synthetic_dataset(self):
        from cold_chain.training.build_dataset import main as build
        from cold_chain.training.common import NOT_RESULTS
        from cold_chain.training.compare import main as compare
        from cold_chain.training.delay import main as delay

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_synthetic_export(root / "export", trips=20)
            build(["--export", str(root / "export"), "--out", str(root / "dataset"), "--allow-test-data"])
            self.assertEqual(delay(["--dataset", str(root / "dataset"), "--grid", "quick", "--importance-repeats", "1", "--out", str(root / "delay")]), 0)
            metrics = json.loads((root / "delay" / "metrics.json").read_text(encoding="utf-8"))
            run = json.loads((root / "delay" / "run.json").read_text(encoding="utf-8"))
            self.assertEqual(compare(["--runs", str(root / "delay"), "--trip-weights", "--out", str(root / "comparison")]), 0)
            comparison = json.loads((root / "comparison" / "comparison.json").read_text(encoding="utf-8"))
            plots_written = {p.name for p in (root / "delay" / "plots").iterdir()}

        self.assertEqual(metrics["status"], NOT_RESULTS)
        self.assertEqual(set(metrics["models"]), {"no_skill", "logistic_regression", "random_forest", "gradient_boosting", "gradient_boosting_tuned"})
        selected = metrics["selection"]["model"]
        self.assertIn(selected, set(metrics["models"]) - {"no_skill"})
        self.assertEqual(metrics["selection"]["metric"], "trip-balanced validation PR-AUC")
        validation = metrics["models"][selected]["validation"]
        self.assertTrue(validation["tuned"]["weighted"])
        self.assertFalse(validation["tuned_snapshots"]["weighted"])
        # Positive control: the planted speed difference must be found.
        self.assertGreaterEqual(validation["tuned"]["roc_auc"], 0.9)
        self.assertGreaterEqual(run["search"]["folds"], 1)
        self.assertEqual(len(run["search"]["candidates"]), 2)
        self.assertEqual(run["classes"]["test"]["trips"], 3)
        self.assertTrue(run["imbalance"]["tripWeights"])
        self.assertEqual(comparison["selection"]["model"], selected)
        self.assertTrue({"roc_test.png", "pr_validation.png", "importance_gradient_boosting_tuned.png"} <= plots_written)


class RiskCombinationTest(unittest.TestCase):
    def test_methods(self):
        from cold_chain.risk import RiskConfig, combine

        parts = {"temperature": 0.6, "delay": 0.5}
        self.assertEqual(combine(parts)["riskProbability"], 0.6)
        self.assertEqual(combine(parts, RiskConfig(method="noisy_or"))["riskProbability"], 0.8)
        weighted = RiskConfig(method="weighted_mean", weights={"temperature": 3, "delay": 1})
        self.assertEqual(combine(parts, weighted)["riskProbability"], 0.575)

    def test_levels_types_and_missing_components(self):
        from cold_chain.risk import combine

        self.assertEqual(combine({"temperature": 0.75, "delay": 0.1})["riskLevel"], "high")
        self.assertEqual(combine({"temperature": 0.75, "delay": 0.1})["riskType"], "temperature_excursion")
        self.assertEqual(combine({"temperature": 0.4, "delay": 0.35})["riskType"], "combined")
        low = combine({"temperature": 0.1, "delay": None})
        self.assertEqual((low["riskLevel"], low["riskType"], low["combination"]["missing"]), ("low", None, ["delay"]))
        self.assertEqual(combine({"temperature": None, "delay": 0.3})["riskLevel"], "medium")
        with self.assertRaises(ValueError):
            combine({"temperature": None, "delay": None})

    def test_configuration_from_the_environment(self):
        from cold_chain.risk import RiskConfig

        config = RiskConfig.from_env({"COLD_CHAIN_RISK_COMBINATION": "weighted_mean", "COLD_CHAIN_RISK_WEIGHTS": "temperature=0.7,delay=0.3", "COLD_CHAIN_RISK_HIGH": "0.8"})
        self.assertEqual((config.method, config.weights, config.medium, config.high), ("weighted_mean", {"temperature": 0.7, "delay": 0.3}, 0.3, 0.8))
        for bad in ({"COLD_CHAIN_RISK_COMBINATION": "mean"}, {"COLD_CHAIN_RISK_MEDIUM": "0.9"}, {"COLD_CHAIN_RISK_WEIGHTS": "humidity=1"}):
            with self.assertRaises(ValueError):
                RiskConfig.from_env(bad)


@unittest.skipIf(torch is None or sklearn is None or PredictRequest is None, "needs PyTorch, scikit-learn, matplotlib and fastapi")
class TrainedPipelineTest(unittest.TestCase):
    """Dataset -> baselines, CNN-LSTM, delay model -> comparison -> install ->
    inference, on the synthetic fixture (pipeline check: the scores mean nothing).
    Built once for all tests of the class."""

    @classmethod
    def setUpClass(cls):
        from cold_chain.dataset import load_export
        from cold_chain.training.baselines import main as baselines
        from cold_chain.training.build_dataset import main as build
        from cold_chain.training.compare import main as compare
        from cold_chain.training.delay import main as delay
        from cold_chain.training.train import main as train

        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = root = Path(cls.tmp.name)
        write_synthetic_export(root / "export", trips=20)
        dataset = str(root / "dataset")
        build(["--export", str(root / "export"), "--out", dataset, "--allow-test-data"])
        baselines(["--dataset", dataset, "--out", str(root / "baselines"), "--importance-repeats", "1"])
        train(["--dataset", dataset, "--conv-channels", "8", "--lstm-hidden", "16", "--max-epochs", "12", "--patience", "3", "--out", str(root / "cnn")])
        compare(["--runs", str(root / "baselines"), str(root / "cnn"), "--out", str(root / "comparison")])
        delay(["--dataset", dataset, "--grid", "quick", "--importance-repeats", "1", "--out", str(root / "delay")])
        cls.trips = {t.shipment_id: t for t in load_export(root / "export")[1]}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def setUp(self):
        from cold_chain import inference

        self.inference = inference
        self.saved = (inference.MODELS_DIR, inference.SERVICE_MODELS)
        inference._cache.clear()

    def tearDown(self):
        self.inference.MODELS_DIR, self.inference.SERVICE_MODELS = self.saved
        self.inference._cache.clear()

    def install(self, *args):
        from cold_chain.training.install import main as install

        return install([*args])

    def request(self, record, now):
        return PredictRequest.model_validate(
            {
                "readings": [
                    {"recordedAt": r.recorded_at.isoformat(), "temperatureC": r.temperature_c, "humidityPct": r.humidity_pct,
                     "latitude": r.latitude, "longitude": r.longitude, "speedKmh": r.speed_kmh, "qualityFlags": []}
                    for r in record.readings if r.recorded_at <= now
                ],
                "limits": {"tempMinC": record.context.temp_min_c, "tempMaxC": record.context.temp_max_c},
                "trip": {"startedAt": record.context.started_at.isoformat(), "expectedDeliveryAt": record.context.expected_delivery_at.isoformat()},
                "destination": {"latitude": record.context.destination[0], "longitude": record.context.destination[1]},
                "origin": {"latitude": record.context.origin[0], "longitude": record.context.origin[1]},
                "now": now.isoformat(),
            }
        )

    def first_test_prediction(self, run: str, model: str) -> dict:
        with (self.root / run / "predictions.csv").open(encoding="utf-8") as handle:
            return next(row for row in csv.DictReader(handle) if row["set"] == "test" and row["model"] == model)

    def test_cnn_lstm_training_outputs(self):
        from cold_chain.training.common import NOT_RESULTS

        metrics = json.loads((self.root / "cnn" / "metrics.json").read_text(encoding="utf-8"))
        run = json.loads((self.root / "cnn" / "run.json").read_text(encoding="utf-8"))
        with (self.root / "cnn" / "history.csv").open(encoding="utf-8") as handle:
            history = list(csv.DictReader(handle))
        self.assertEqual(metrics["status"], NOT_RESULTS)
        stopping = metrics["earlyStopping"]
        self.assertEqual(len(history), stopping["epochsRun"])
        self.assertLessEqual(stopping["bestEpoch"], stopping["epochsRun"])
        self.assertEqual(stopping["stoppedEarly"], stopping["epochsRun"] < 12)
        self.assertEqual(metrics["models"]["cnn_lstm"]["thresholdChoice"]["source"], "validation")
        self.assertEqual((run["seed"], run["sequenceLength"], run["horizonMinutes"]), (42, 30, 30))
        for plot in ("loss.png", "accuracy.png", "roc_test.png", "confusion_cnn_lstm_test.png"):
            self.assertTrue((self.root / "cnn" / "plots" / plot).exists(), plot)
        comparison = json.loads((self.root / "comparison" / "comparison.json").read_text(encoding="utf-8"))
        self.assertEqual(comparison["status"], NOT_RESULTS)
        self.assertEqual(set(comparison["models"]), {"no_skill", "logistic_regression", "random_forest", "gradient_boosting", "cnn_lstm"})
        self.assertIn(comparison["selection"]["model"], set(comparison["models"]) - {"no_skill"})

    def test_models_of_test_data_never_reach_the_service(self):
        with self.assertRaises(SystemExit):
            self.install("--run", str(self.root / "delay"))
        with self.assertRaises(SystemExit):
            self.install("--run", str(self.root / "delay"), "--allow-test-data")  # default target = the service
        with self.assertRaises(SystemExit):
            self.install("--run", str(self.root / "baselines"), "--model", "no_skill", "--target", str(self.root / "x"), "--allow-test-data")
        # Even if such a manifest ended up in the service folder, it is not loaded.
        target = self.root / "service-models"
        self.install("--run", str(self.root / "delay"), "--target", str(target), "--allow-test-data")
        self.inference.MODELS_DIR = self.inference.SERVICE_MODELS = target
        with self.assertRaises(self.inference.ModelNotTrainedError):
            self.inference.load_model("delay")

    def test_inference_reproduces_the_training_scores(self):
        target = self.root / "models"
        self.install("--comparison", str(self.root / "comparison"), "--target", str(target), "--allow-test-data")
        self.install("--run", str(self.root / "delay"), "--target", str(target), "--allow-test-data")
        manifest = json.loads((target / "temperature" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["model"], json.loads((self.root / "comparison" / "comparison.json").read_text(encoding="utf-8"))["selection"]["model"])
        self.assertEqual((manifest["horizonMinutes"], manifest["window"]["steps"], manifest["dataset"]["validForEvaluation"]), (30, 30, False))
        self.inference.MODELS_DIR = target
        delay_model = json.loads((target / "delay" / "manifest.json").read_text(encoding="utf-8"))["model"]

        window = self.first_test_prediction("cnn" if manifest["model"] == "cnn_lstm" else "baselines", manifest["model"])
        result = self.inference.predict(self.request(self.trips[window["shipment_id"]], parse_time(window["time"])))
        self.assertAlmostEqual(result["temperatureRisk"], float(window["score"]), places=4)
        snapshot = self.first_test_prediction("delay", delay_model)
        result = self.inference.predict(self.request(self.trips[snapshot["shipment_id"]], parse_time(snapshot["time"])))
        self.assertAlmostEqual(result["delayRisk"], float(snapshot["score"]), places=4)

        validated = PredictResponse.model_validate(result)
        self.assertEqual(validated.risk_probability, round(max(p for p in (result["temperatureRisk"], result["delayRisk"]) if p is not None), 4))
        self.assertEqual(result["combination"]["method"], "max")
        self.assertTrue(set(result["factors"]) <= {"temperature_excursion", "delivery_delay"})
        self.assertTrue(result["explanation"].startswith(f"Overall {result['riskLevel'].upper()} risk"))
        self.assertEqual(result["modelName"], f"temperature:{manifest['model']}+delay:{delay_model}")

    def test_cnn_lstm_is_served_with_its_training_preprocessing(self):
        target = self.root / "cnn-models"
        self.install("--run", str(self.root / "cnn"), "--target", str(target), "--allow-test-data")
        self.inference.MODELS_DIR = target
        window = self.first_test_prediction("cnn", "cnn_lstm")
        result = self.inference.predict(self.request(self.trips[window["shipment_id"]], parse_time(window["time"])))
        self.assertAlmostEqual(result["temperatureRisk"], float(window["score"]), places=4)
        self.assertEqual(result["components"]["delay"], {"available": False, "reason": "not_installed"})
        self.assertIn("Delay risk not estimated: no trained model is installed.", result["explanation"])

    def test_models_are_only_asked_about_inputs_like_their_training_data(self):
        target = self.root / "guard-models"
        self.install("--comparison", str(self.root / "comparison"), "--target", str(target), "--allow-test-data")
        self.install("--run", str(self.root / "delay"), "--target", str(target), "--allow-test-data")
        self.inference.MODELS_DIR = target
        record = next(t for t in self.trips.values() if t.delivered_at > t.context.expected_delivery_at)
        start = record.context.started_at
        with self.assertRaises(ValueError) as caught:  # 5 minutes into the trip: too little history for both models
            self.inference.predict(self.request(record, start + timedelta(minutes=5)))
        self.assertIn("not enough trip history", str(caught.exception))
        overdue = self.inference.predict(self.request(record, start + timedelta(minutes=62)))
        self.assertEqual(overdue["components"]["delay"]["reason"], "past_planned_delivery_time")
        self.assertIsNone(overdue["delayRisk"])
        self.assertIsNotNone(overdue["temperatureRisk"])
        hot = next(t for t in self.trips.values() if any(r.temperature_c == 9.0 for r in t.readings))
        during = self.inference.predict(self.request(hot, hot.context.started_at + timedelta(minutes=42)))
        self.assertEqual(during["components"]["temperature"]["reason"], "ongoing_excursion")


@unittest.skipIf(PredictRequest is None, "needs fastapi/pydantic")
class PredictEndpointTest(unittest.TestCase):
    def request(self):
        return PredictRequest.model_validate(
            {
                "readings": [{"recordedAt": "2026-10-18T05:59:00Z", "temperatureC": 5.1, "qualityFlags": []}],
                "limits": {"tempMinC": 2, "tempMaxC": 8},
                "trip": {"expectedDeliveryAt": None, "intervalSeconds": 60},
                "now": "2026-10-18T06:00:00Z",
            }
        )

    def test_untrained_model_answers_501_instead_of_a_made_up_prediction(self):
        with self.assertRaises(HTTPException) as caught:
            predict(self.request())
        self.assertEqual(caught.exception.status_code, 501)
        self.assertIn("No trained cold-chain model is installed", caught.exception.detail)


if __name__ == "__main__":
    unittest.main()
