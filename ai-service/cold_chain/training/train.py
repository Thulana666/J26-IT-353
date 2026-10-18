"""Train and evaluate the cold-chain CNN-LSTM (needs requirements-training.txt).

Input: a CSV of real sensor readings exported from Supabase, one row per
reading, e.g. (SQL editor):

  select c.shipment_id, c.is_test, c.temp_min_c, c.temp_max_c, c.expected_delivery_at,
         r.recorded_at, r.temperature_c, r.humidity_pct, r.latitude, r.longitude, r.speed_kmh,
         'gps_jump' = any(r.quality_flags) as gps_jump
  from cold_chain_readings r join cold_chain_shipments c using (shipment_id)
  order by c.shipment_id, r.recorded_at;

For every trip, windows of `--steps` minutes are cut every `--stride` minutes;
the label is 1 if the temperature leaves the shipment's range within the next
`--horizon` minutes. Trips (not windows) are split into train/validation/test
so no trip appears in two sets. Reported metrics (precision, recall, F1,
ROC-AUC on the test trips) are computed from the data; nothing is assumed.

Simulated test shipments (is_test) are EXCLUDED: they are not research data.
--include-test exists only to smoke-test the pipeline; its outputs are marked
as not valid for evaluation.

Usage (from ai-service/):
  python -m cold_chain.training.train --csv readings.csv [--epochs 30] [--include-test]
Writes cold_chain/models/cnn_lstm.pt and cold_chain/models/metrics.json.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

from ..preprocessing import Reading, build_sequence, excursion_label

MODELS = Path(__file__).resolve().parent.parent / "models"


def _float(value: str) -> float | None:
    return float(value) if value not in ("", None) else None


def load_trips(path: Path, include_test: bool) -> dict:
    trips = defaultdict(lambda: {"readings": []})
    with path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            if row["is_test"].lower() in ("true", "t", "1") and not include_test:
                continue
            trip = trips[row["shipment_id"]]
            trip["limits"] = (float(row["temp_min_c"]), float(row["temp_max_c"]))
            trip["eta"] = datetime.fromisoformat(row["expected_delivery_at"]) if row.get("expected_delivery_at") else None
            trip["readings"].append(
                Reading(
                    datetime.fromisoformat(row["recorded_at"]),
                    _float(row["temperature_c"]),
                    _float(row["humidity_pct"]),
                    _float(row["latitude"]),
                    _float(row["longitude"]),
                    _float(row["speed_kmh"]),
                    row.get("gps_jump", "").lower() in ("true", "t", "1"),
                )
            )
    return trips


def windows(trip: dict, steps: int, stride: int, horizon: int):
    readings = sorted(trip["readings"], key=lambda r: r.recorded_at)
    if not readings:
        return
    low, high = trip["limits"]
    now = readings[0].recorded_at + timedelta(minutes=steps)
    end = readings[-1].recorded_at - timedelta(minutes=horizon)
    while now <= end:
        future = [r for r in readings if now < r.recorded_at <= now + timedelta(minutes=horizon)]
        past = [r for r in readings if r.recorded_at <= now]
        yield build_sequence(past, temp_min_c=low, temp_max_c=high, now=now, expected_delivery_at=trip["eta"], steps=steps), excursion_label(
            future, temp_min_c=low, temp_max_c=high
        )
        now += timedelta(minutes=stride)


def main() -> None:  # pragma: no cover - needs PyTorch, scikit-learn and real data
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--csv", type=Path, required=True)
    parser.add_argument("--steps", type=int, default=60)
    parser.add_argument("--stride", type=int, default=5)
    parser.add_argument("--horizon", type=int, default=60)
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--include-test", action="store_true")
    args = parser.parse_args()

    import torch
    from sklearn.metrics import f1_score, precision_score, recall_score, roc_auc_score

    from ..model import build_model

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    trips = load_trips(args.csv, args.include_test)
    ids = sorted(trips)
    random.shuffle(ids)
    n = len(ids)
    if n < 10:
        raise SystemExit(f"Only {n} trips: collect more real trips before training.")
    split = {"train": ids[: int(n * 0.7)], "validation": ids[int(n * 0.7) : int(n * 0.85)], "test": ids[int(n * 0.85) :]}
    data = {name: [w for i in members for w in windows(trips[i], args.steps, args.stride, args.horizon)] for name, members in split.items()}
    if not any(label for _, label in data["train"]):
        raise SystemExit("No excursions in the training trips: the model cannot learn the positive class yet.")

    def tensors(rows):
        return torch.tensor([x for x, _ in rows], dtype=torch.float32), torch.tensor([y for _, y in rows], dtype=torch.float32)

    model = build_model()
    optimiser = torch.optim.Adam(model.parameters(), lr=1e-3)
    x_train, y_train = tensors(data["train"])
    positives = float(y_train.sum())
    weight = torch.tensor((len(y_train) - positives) / max(positives, 1.0))
    for epoch in range(args.epochs):
        model.train()
        optimiser.zero_grad()
        p = model(x_train)
        loss = torch.nn.functional.binary_cross_entropy(p, y_train, weight=1 + (weight - 1) * y_train)
        loss.backward()
        optimiser.step()
        print(f"epoch {epoch + 1}: loss {loss.item():.4f}")

    model.eval()
    x_test, y_test = tensors(data["test"])
    with torch.no_grad():
        scores = model(x_test).tolist()
    truth = [int(v) for v in y_test.tolist()]
    predicted = [int(s >= 0.5) for s in scores]
    metrics = {
        "valid_for_evaluation": not args.include_test,
        "trips": {k: len(v) for k, v in split.items()},
        "windows": {k: len(v) for k, v in data.items()},
        "test_positives": sum(truth),
        "precision": precision_score(truth, predicted, zero_division=0),
        "recall": recall_score(truth, predicted, zero_division=0),
        "f1": f1_score(truth, predicted, zero_division=0),
        "roc_auc": roc_auc_score(truth, scores) if 0 < sum(truth) < len(truth) else None,
        "trained_at": datetime.now().isoformat(timespec="seconds"),
    }
    MODELS.mkdir(exist_ok=True)
    version = metrics["trained_at"].replace(":", "")
    torch.save({"state_dict": model.state_dict(), "version": version, "horizon_minutes": args.horizon, "hyperparameters": {}}, MODELS / "cnn_lstm.pt")
    (MODELS / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":  # pragma: no cover
    main()
