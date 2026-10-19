"""Shared by the training scripts: loading a processed dataset, run metadata
and the label every output gets when the data is not real research data."""

from __future__ import annotations

import json
import platform
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SETS = ("train", "validation", "test")
NOT_RESULTS = "PIPELINE CHECK ONLY - simulated/test data, not research results"


def code_version() -> dict:
    def git(*args):
        return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()

    try:
        return {"commit": git("rev-parse", "HEAD"), "uncommittedChanges": bool(git("status", "--porcelain", "--", "cold_chain"))}
    except (OSError, subprocess.CalledProcessError):
        return {"commit": None, "uncommittedChanges": None}


def environment() -> dict:
    versions = {"python": platform.python_version()}
    for name in ("numpy", "sklearn", "torch", "matplotlib"):
        try:
            versions[name] = __import__(name).__version__
        except ImportError:
            pass
    return versions


def load_dataset(directory: Path) -> tuple[dict, dict]:
    """(dataset card, arrays) from build_dataset.py's output. Refuses a dataset
    whose sets share a trip."""
    import numpy as np

    card = json.loads((directory / "dataset_card.json").read_text(encoding="utf-8"))
    if card.get("status") != "ok":
        raise SystemExit(f"The dataset has no train/validation/test split: {card.get('message', card.get('status'))}")
    with np.load(directory / "dataset.npz") as npz:
        arrays = {name: npz[name] for name in npz.files}
    members = {name: set(ids) for name, ids in card["split"]["members"].items()}
    for i, a in enumerate(SETS):
        for b in SETS[i + 1 :]:
            if members[a] & members[b]:
                raise SystemExit(f"Trips appear in both {a} and {b}: the dataset is invalid")
    return card, arrays


def banner(card: dict) -> str | None:
    """The label for plots and reports, or None for real data."""
    return None if card["validForEvaluation"] else NOT_RESULTS


def run_directory(dataset: Path, name: str, out: Path | None) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    directory = out or dataset / "runs" / f"{name}-{stamp}"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2, default=str) + "\n", encoding="utf-8")


PREDICTION_COLUMNS = ("model", "set", "shipment_id", "time", "label", "score")
METRIC_COLUMNS = (
    "model", "set", "threshold_kind", "weighted", "threshold", "samples", "positives", "accuracy", "balanced_accuracy", "precision",
    "recall", "f1", "specificity", "roc_auc", "pr_auc", "brier", "tn", "fp", "fn", "tp",
)


def trip_weights(trips):
    """Sample weights giving every trip the same total weight, however many
    samples it has (mean weight 1)."""
    from collections import Counter

    import numpy as np

    trips = list(trips)
    if not trips:
        return np.array([])
    counts = Counter(trips)
    weights = np.array([1 / counts[t] for t in trips])
    return weights * len(weights) / weights.sum()


def write_predictions(path: Path, rows: list[dict]) -> None:
    """Every validation/test sample's score per model (read by compare.py)."""
    import csv

    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, PREDICTION_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


def prediction_rows(model: str, set_name: str, trips, times, labels, scores) -> list[dict]:
    return [
        {"model": model, "set": set_name, "shipment_id": t, "time": time, "label": int(y), "score": repr(float(s))}
        for t, time, y, s in zip(trips, times, labels, scores)
    ]
