"""Builds the versioned training dataset from an export.

Input: a folder written by backend/scripts/export-cold-chain-dataset.js
(trips.csv, readings.csv, manifest.json). Output, in
<export>/processed/<dataset version>-<config id>/:

  dataset.npz        per set (train / validation / test):
                       temp_X_<set>   (windows, steps, features) float32, NaN = missing
                       temp_y_<set>   excursion label (0/1)
                       temp_trip_<set>, temp_time_<set>   trip id and window end time
                       grid_X_<set>   every grid row of the set's trips (to fit the scaler)
                       delay_X_<set>, delay_y_<set>, delay_trip_<set>, delay_time_<set>
  dataset_card.json  configuration, features, source version, cleaning report,
                     skipped samples by reason, class distribution per set,
                     split boundaries, code version and validity flags

Test/simulated data is refused unless --allow-test-data is given; the card then
says "validForEvaluation": false (pipeline smoke test only, never results).

Usage (from ai-service/, with requirements-training.txt installed):
  python -m cold_chain.training.build_dataset --export cold_chain/data/exports/<folder> [options]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from ..dataset import SnapshotConfig, WindowConfig, delay_snapshots, load_export, prepare_trip, temperature_windows
from ..labels import DelayLabelConfig, ExcursionLabelConfig
from ..preprocessing import BINARY_FEATURES, DELAY_BINARY_FEATURES, DELAY_FEATURES, SEQUENCE_FEATURES, CleaningReport, GridConfig
from ..splits import SETS, InsufficientDataError, SplitConfig, TripSpan, chronological_split
from .common import code_version


def distribution(labels: list[int]) -> dict:
    positives = sum(labels)
    return {"samples": len(labels), "positives": positives, "negatives": len(labels) - positives, "positiveRate": positives / len(labels) if labels else None}


def build(export: Path, configs: dict, allow_test_data: bool) -> tuple[dict, dict | None]:
    """(card, arrays or None when the data cannot be split)."""
    manifest, trips, unknown_readings = load_export(export)
    contains_test = bool(manifest.get("containsTestData")) or any(t.is_test for t in trips)
    if contains_test and not allow_test_data:
        raise SystemExit("This export contains test/simulated data. Use a real-data export, or --allow-test-data for a pipeline smoke test.")

    cleaning = CleaningReport()
    skipped = {"temperature": Counter(), "delay": Counter()}
    per_trip, samples, grids = [], {"temperature": [], "delay": []}, {}
    for trip in trips:
        readings, grid, report = prepare_trip(trip, configs["grid"])
        cleaning.add(report)
        windows, skipped_windows = temperature_windows(trip, readings, grid, configs["window"], configs["excursion"])
        snapshots, skipped_snapshots = delay_snapshots(trip, grid, configs["snapshot"], configs["delay"])
        skipped["temperature"].update(skipped_windows)
        skipped["delay"].update(skipped_snapshots)
        samples["temperature"] += windows
        samples["delay"] += snapshots
        grids[trip.shipment_id] = grid
        per_trip.append(
            {
                "shipmentNumber": trip.shipment_number,
                "isTest": trip.is_test,
                "storageCondition": trip.storage_condition,
                "limits": [trip.context.temp_min_c, trip.context.temp_max_c],
                "status": trip.trip_status,
                "startedAt": trip.context.started_at.isoformat(),
                "readings": report.output,
                "gridSteps": len(grid),
                "temperatureWindows": len(windows),
                "excursionWindows": sum(s.label for s in windows),
                "delaySnapshots": len(snapshots),
                "delayLabel": snapshots[0].label if snapshots else None,
                "etaSource": trip.eta_source,
                "etaChangedAfterStart": trip.eta_changed_after_start,
            }
        )

    card = {
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": {"export": export.name, "datasetVersion": manifest.get("datasetVersion"), "exportedAt": manifest.get("exportedAt")},
        "containsTestData": contains_test,
        "validForEvaluation": not contains_test and bool(manifest.get("validForEvaluation")),
        "code": code_version(),
        "config": {name: config.to_dict() for name, config in configs.items()},
        "features": {
            "sequence": list(SEQUENCE_FEATURES),
            "sequenceBinary": sorted(BINARY_FEATURES),
            "delay": list(DELAY_FEATURES),
            "delayBinary": sorted(DELAY_BINARY_FEATURES),
        },
        "cleaning": cleaning.to_dict(),
        "readingsOfUnknownTrips": unknown_readings,
        "skipped": {name: dict(counter) for name, counter in skipped.items()},
        "classes": {name: distribution([s.label for s in values]) for name, values in samples.items()},
        "trips": per_trip,
    }

    spans = [TripSpan(t.shipment_id, t.context.started_at, t.end) for t in trips if t.end]
    try:
        split = chronological_split(spans, configs["split"])
    except InsufficientDataError as error:
        card["status"] = "insufficient_data"
        card["message"] = f"Cannot split chronologically: {error}."
        return card, None

    card["status"] = "ok"
    card["split"] = split.to_dict()
    number = {t.shipment_id: t.shipment_number for t in trips}
    card["split"]["shipmentNumbers"] = {name: [number[i] for i in ids] for name, ids in split.members.items()}
    card["classesBySet"] = {}
    arrays = {}
    for name in SETS:
        ids = set(split.members[name])
        temp = [s for s in samples["temperature"] if s.shipment_id in ids]
        delay = [s for s in samples["delay"] if s.shipment_id in ids]
        card["classesBySet"][name] = {"temperature": distribution([s.label for s in temp]), "delay": distribution([s.label for s in delay])}
        arrays[name] = {
            "temp": temp,
            "delay": delay,
            "grid": [[row[f] for f in SEQUENCE_FEATURES] for i in split.members[name] for row in grids[i]],
        }
    for name, values in card["classesBySet"].items():
        for task, counts in values.items():
            if counts["samples"] and counts["positives"] in (0, counts["samples"]):
                card.setdefault("warnings", []).append(f"{name} set has only one {task} class: metrics such as recall/ROC-AUC are undefined")
    return card, arrays


def write(out: Path, card: dict, arrays: dict | None, steps: int) -> None:
    out.mkdir(parents=True, exist_ok=True)
    if arrays is not None:
        import numpy as np

        def to_array(values, *shape):
            """Nested lists with None -> float32 array (NaN = missing)."""

            def fill(value):
                return [fill(v) for v in value] if isinstance(value, list) else (np.nan if value is None else value)

            return np.array(fill(values), dtype=np.float32).reshape(*shape)

        payload = {}
        for name, parts in arrays.items():
            temp, delay = parts["temp"], parts["delay"]
            payload[f"temp_X_{name}"] = to_array([s.features for s in temp], len(temp), steps, len(SEQUENCE_FEATURES))
            payload[f"temp_y_{name}"] = np.array([s.label for s in temp], dtype=np.int8)
            payload[f"temp_trip_{name}"] = np.array([s.shipment_id for s in temp], dtype=str)
            payload[f"temp_time_{name}"] = np.array([s.time.isoformat() for s in temp], dtype=str)
            payload[f"grid_X_{name}"] = to_array(parts["grid"], len(parts["grid"]), len(SEQUENCE_FEATURES))
            payload[f"delay_X_{name}"] = to_array([s.features for s in delay], len(delay), len(DELAY_FEATURES))
            payload[f"delay_y_{name}"] = np.array([s.label for s in delay], dtype=np.int8)
            payload[f"delay_trip_{name}"] = np.array([s.shipment_id for s in delay], dtype=str)
            payload[f"delay_time_{name}"] = np.array([s.time.isoformat() for s in delay], dtype=str)
        np.savez_compressed(out / "dataset.npz", **payload)
    (out / "dataset_card.json").write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--export", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--step-seconds", type=int, default=GridConfig.step_seconds)
    parser.add_argument("--roll-steps", type=int, default=GridConfig.roll_steps)
    parser.add_argument("--steps", type=int, default=WindowConfig.steps, help="sequence length (grid steps)")
    parser.add_argument("--stride", type=int, default=WindowConfig.stride_steps)
    parser.add_argument("--min-history", type=int, default=WindowConfig.min_history_steps)
    parser.add_argument("--min-input-coverage", type=float, default=WindowConfig.min_input_coverage)
    parser.add_argument("--horizon", type=int, default=ExcursionLabelConfig.horizon_minutes, help="prediction horizon (minutes)")
    parser.add_argument("--min-excursion-minutes", type=float, default=ExcursionLabelConfig.min_excursion_minutes)
    parser.add_argument("--min-future-coverage", type=float, default=ExcursionLabelConfig.min_future_coverage)
    parser.add_argument("--include-ongoing", action="store_true", help="keep windows that end during an excursion")
    parser.add_argument("--delay-tolerance", type=float, default=DelayLabelConfig.tolerance_minutes, help="minutes late still counted on time")
    parser.add_argument("--delay-stride", type=int, default=SnapshotConfig.stride_steps)
    parser.add_argument("--split", type=float, nargs=3, default=(0.70, 0.15, 0.15), metavar=("TRAIN", "VALIDATION", "TEST"))
    parser.add_argument("--purge-overlap", action="store_true")
    parser.add_argument("--allow-test-data", action="store_true", help="pipeline smoke test with simulated data (not valid for evaluation)")
    args = parser.parse_args(argv)

    configs = {
        "grid": GridConfig(step_seconds=args.step_seconds, roll_steps=args.roll_steps),
        "window": WindowConfig(steps=args.steps, stride_steps=args.stride, min_history_steps=args.min_history, min_input_coverage=args.min_input_coverage),
        "excursion": ExcursionLabelConfig(
            horizon_minutes=args.horizon,
            min_excursion_minutes=args.min_excursion_minutes,
            min_future_coverage=args.min_future_coverage,
            exclude_ongoing=not args.include_ongoing,
        ),
        "snapshot": SnapshotConfig(stride_steps=args.delay_stride, min_history_steps=args.min_history),
        "delay": DelayLabelConfig(tolerance_minutes=args.delay_tolerance),
        "split": SplitConfig(*args.split, purge_overlap=args.purge_overlap),
    }
    card, arrays = build(args.export, configs, args.allow_test_data)
    config_id = hashlib.sha256(json.dumps(card["config"], sort_keys=True).encode()).hexdigest()[:8]
    card["configId"] = config_id
    out = args.out or args.export / "processed" / f"{card['source']['datasetVersion']}-{config_id}"
    write(out, card, arrays, args.steps)

    print(f"Dataset card: {out / 'dataset_card.json'}")
    print(f"  trips: {len(card['trips'])}, cleaning: {card['cleaning']}")
    for task, counts in card["classes"].items():
        print(f"  {task}: {counts}  skipped: {card['skipped'][task]}")
    if not card["validForEvaluation"]:
        print("  NOT VALID FOR EVALUATION: contains test/simulated data (pipeline smoke test only).")
    if arrays is None:
        print(f"  {card['message']} No dataset.npz written.")
        return 2
    for name, values in card["classesBySet"].items():
        print(f"  {name}: {values}")
    for warning in card.get("warnings", []):
        print(f"  WARNING: {warning}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
