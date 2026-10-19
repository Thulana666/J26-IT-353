"""Compares model runs on the same dataset (baselines vs CNN-LSTM).

Reads predictions.csv, metrics.json and run.json of each run (baselines.py,
train.py). The runs must share the dataset version, configuration and task,
and score exactly the same validation/test samples. Metrics are recomputed
from the saved predictions at each model's own validation-tuned threshold.

Selection uses the VALIDATION set only: the highest validation PR-AUC
(average precision, suited to rare events); within --tolerance of the
best, the simpler model wins (no skill < logistic regression < random forest
< gradient boosting < tuned gradient boosting < CNN-LSTM). --trip-weights
gives every trip the same weight (for the delay task, whose snapshots share
their trip's label). The CNN-LSTM is not assumed to be best. The
test metrics of every model are reported as the final estimate, and the
comparison says when no model beats the no-skill reference.

Outputs (default <dataset>/runs/comparison-<time>/): comparison.json,
comparison.csv, plots/roc_<set>.png, plots/pr_<set>.png. Runs on test or
simulated data are labelled "PIPELINE CHECK ONLY".

Usage (from ai-service/):
  python -m cold_chain.training.compare --runs <baselines run> <cnn_lstm run> [--out DIR]
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

from ..evaluation.metrics import binary_metrics
from .common import METRIC_COLUMNS, NOT_RESULTS, run_directory, trip_weights, write_json

COMPLEXITY = ("no_skill", "logistic_regression", "random_forest", "gradient_boosting", "gradient_boosting_tuned", "cnn_lstm")
SUMMARY_METRICS = ("precision", "recall", "f1", "roc_auc", "pr_auc", "brier")


def load_run(directory: Path) -> tuple[dict, dict, dict]:
    run = json.loads((directory / "run.json").read_text(encoding="utf-8"))
    metrics = json.loads((directory / "metrics.json").read_text(encoding="utf-8"))
    predictions: dict = defaultdict(lambda: defaultdict(list))
    with (directory / "predictions.csv").open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            predictions[row["model"]][row["set"]].append((row["shipment_id"], row["time"], int(row["label"]), float(row["score"])))
    return run, metrics, predictions


def select(validation_pr_auc: dict, tolerance: float) -> dict:
    candidates = {m: v for m, v in validation_pr_auc.items() if m != "no_skill" and v is not None}
    if not candidates:
        return {"model": None, "reason": "validation PR-AUC is undefined (the validation set needs both classes)"}
    best = max(candidates.values())
    chosen = min((m for m, v in candidates.items() if v >= best - tolerance), key=COMPLEXITY.index)
    no_skill = validation_pr_auc.get("no_skill")
    return {
        "model": chosen,
        "rule": f"highest validation PR-AUC; within {tolerance} of the best, the simpler model",
        "validationPrAuc": candidates[chosen],
        "bestValidationPrAuc": best,
        "beatsNoSkill": None if no_skill is None else candidates[chosen] > no_skill,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--runs", type=Path, nargs="+", required=True)
    parser.add_argument("--tolerance", type=float, default=0.01, help="PR-AUC difference treated as a tie")
    parser.add_argument("--trip-weights", action="store_true", help="every trip weighs the same in metrics and selection")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)

    from ..evaluation import plots

    runs = [load_run(directory) for directory in args.runs]
    keys = {(r["dataset"]["datasetVersion"], r["dataset"].get("configId"), r["task"]) for r, _, _ in runs}
    if len(keys) != 1:
        raise SystemExit(f"The runs use different datasets, configurations or tasks: {sorted(map(str, keys))}")
    dataset_version, config_id, task = keys.pop()
    valid = all(r["dataset"]["validForEvaluation"] for r, _, _ in runs)
    label = None if valid else NOT_RESULTS

    models, thresholds, sources = {}, {}, {}
    for directory, (run, metrics, predictions) in zip(args.runs, runs):
        for name, sets in predictions.items():
            if name in models:
                raise SystemExit(f"Model {name} appears in more than one run")
            models[name] = sets
            thresholds[name] = metrics["models"][name]["threshold"]
            sources[name] = str(directory)
    ordered = sorted(models, key=COMPLEXITY.index)
    for s in ("validation", "test"):
        reference = sorted((t, time, y) for t, time, y, _ in models[ordered[0]][s])
        for name in ordered[1:]:
            if sorted((t, time, y) for t, time, y, _ in models[name][s]) != reference:
                raise SystemExit(f"{name} was scored on different {s} samples than {ordered[0]}")

    table, rows, curves = {}, [], {"validation": {}, "test": {}}
    for name in ordered:
        table[name] = {"threshold": thresholds[name], "run": sources[name]}
        for s in ("validation", "test"):
            labels = np.array([y for *_, y, _ in models[name][s]])
            scores = np.array([p for *_, p in models[name][s]])
            weights = trip_weights([t for t, *_ in models[name][s]]) if args.trip_weights and len(labels) else None
            metrics = binary_metrics(labels, scores, thresholds[name], sample_weight=weights)
            table[name][s] = metrics
            curves[s][name] = (labels, scores, weights)
            rows.append({"model": name, "set": s, "threshold_kind": "tuned", **{k: v for k, v in metrics.items() if k != "confusion_matrix"}, **metrics.get("confusion_matrix", {})})

    selection = select({name: table[name]["validation"].get("pr_auc") for name in ordered}, args.tolerance)
    selection["metric"] = f"{'trip-balanced ' if args.trip_weights else ''}validation PR-AUC"
    out = run_directory(Path(args.runs[0]).parent.parent, "comparison", args.out)
    plotted = {}
    for s in ("validation", "test"):
        title = f"{task.capitalize()} task: model comparison, {s} set"
        roc = plots.roc_curves(curves[s], out / "plots" / f"roc_{s}.png", title + " (ROC)", label)
        pr = plots.pr_curves(curves[s], out / "plots" / f"pr_{s}.png", title + " (precision-recall)", label)
        plotted[f"roc_{s}"] = roc.name if roc else "not drawn: the set does not contain both classes"
        plotted[f"pr_{s}"] = pr.name if pr else "not drawn: the set does not contain both classes"
    write_json(
        out / "comparison.json",
        {
            "status": label or "evaluation on real data",
            "validForEvaluation": valid,
            "task": task,
            "dataset": {"datasetVersion": dataset_version, "configId": config_id},
            "selection": selection,
            "models": table,
            "plots": plotted,
            "note": "Selection uses validation results only; test results are the final, unbiased estimate and were not used to choose.",
        },
    )
    with (out / "comparison.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, METRIC_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

    print(f"Comparison: {out}")
    if label:
        print(f"  {label}")
    for name in ordered:
        line = " ".join(
            f"{s[:4]}_{k}={table[name][s][k]:.3f}" if table[name][s].get(k) is not None else f"{s[:4]}_{k}=n/a"
            for s in ("validation", "test")
            for k in ("f1", "pr_auc")
        )
        print(f"  {name:20} {line}")
    print(f"  selected on validation: {selection.get('model')} ({selection.get('reason') or selection['rule']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
