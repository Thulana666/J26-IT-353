"""Baseline models for the cold-chain risk tasks (needs requirements-training.txt).

Trains logistic regression, random forest and gradient boosting, plus a
no-skill reference that always predicts the training positive rate, on a
processed dataset from build_dataset.py, using its chronological trip-level
split (the same split the CNN-LSTM uses):

  --task temperature  window summaries (preprocessing.window_summary)
                      -> temperature excursion within the horizon
  --task delay        trip-progress snapshots (preprocessing.delay_features)
                      -> late delivery

Imbalance: class weights ("balanced") on the training set, optionally equal
weight per trip (--trip-weights); no resampling, no synthetic samples.
Features are standardised with a scaler fitted on the training set; missing
values become the training mean. The decision threshold is tuned on the
validation set (maximum F1, or the highest threshold reaching --min-recall).
The test set is only scored, never used to choose anything.

Outputs (default <dataset>/runs/baselines-<task>-<time>/):
  metrics.json, metrics.csv  validation and test metrics per model, at the
                             tuned threshold and at 0.5
  predictions.csv            every validation/test score per model (compare.py)
  run.json                   seed, hyperparameters, features, dataset version,
                             class distribution, library and code versions
  models/<name>.joblib       fitted model + scaler + threshold + feature names
  plots/                     ROC and precision-recall curves, confusion
                             matrices, feature importance

Outputs of a dataset built from test/simulated data are labelled
"PIPELINE CHECK ONLY": they show that the code runs, not how well it predicts.

Usage (from ai-service/):
  python -m cold_chain.training.baselines --dataset <processed folder> --task temperature
"""

from __future__ import annotations

import argparse
import csv
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from ..evaluation.metrics import binary_metrics, tune_threshold
from ..preprocessing import DELAY_BINARY_FEATURES, DELAY_FEATURES, SUMMARY_BINARY_FEATURES, SUMMARY_FEATURES, Scaler, window_summary
from .common import (
    METRIC_COLUMNS,
    SETS,
    banner,
    code_version,
    environment,
    load_dataset,
    prediction_rows,
    run_directory,
    trip_weights,
    write_json,
    write_predictions,
)

MODEL_NAMES = ("logistic_regression", "random_forest", "gradient_boosting")
TASKS = {
    "temperature": {"prefix": "temp", "labels": ("No excursion", "Excursion"), "target": "temperature excursion within the horizon"},
    "delay": {"prefix": "delay", "labels": ("On time", "Late"), "target": "late delivery"},
}


def make_models(seed: int) -> dict:
    from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
    from sklearn.linear_model import LogisticRegression

    return {
        "logistic_regression": LogisticRegression(C=1.0, class_weight="balanced", max_iter=5000, random_state=seed),
        "random_forest": RandomForestClassifier(
            n_estimators=300, min_samples_leaf=2, class_weight="balanced_subsample", n_jobs=1, random_state=seed
        ),
        "gradient_boosting": HistGradientBoostingClassifier(
            learning_rate=0.05, max_iter=300, max_leaf_nodes=15, l2_regularization=1.0, class_weight="balanced",
            early_stopping=False, random_state=seed,
        ),
    }


def task_data(task: str, arrays: dict) -> tuple[dict, tuple[str, ...], frozenset]:
    """{set: (X, y, trip ids, times)} with unscaled features (NaN = missing)."""
    prefix = TASKS[task]["prefix"]
    data = {}
    for name in SETS:
        if task == "temperature":
            windows = arrays[f"temp_X_{name}"]
            x = np.array([[np.nan if v is None else v for v in window_summary(w)] for w in windows], dtype=np.float64).reshape(len(windows), len(SUMMARY_FEATURES))
        else:
            x = arrays[f"delay_X_{name}"].astype(np.float64)
        data[name] = (x, arrays[f"{prefix}_y_{name}"].astype(int), arrays[f"{prefix}_trip_{name}"], arrays[f"{prefix}_time_{name}"])
    if task == "temperature":
        return data, SUMMARY_FEATURES, SUMMARY_BINARY_FEATURES
    return data, DELAY_FEATURES, DELAY_BINARY_FEATURES


def importance(
    name: str, model, x_val, y_val, x_train, y_train, features, seed: int, repeats: int, weights: dict | None = None
) -> tuple[np.ndarray, str]:
    """Logistic regression: standardised coefficients. Trees: permutation
    importance (drop in average precision) on the validation set, or on the
    training set when validation has one class."""
    if name == "logistic_regression":
        return model.coef_[0], "coefficient (standardised features; + raises the risk)"
    from sklearn.inspection import permutation_importance

    usable = len(y_val) and 0 < y_val.sum() < len(y_val)
    x, y, where = (x_val, y_val, "validation") if usable else (x_train, y_train, "training")
    weight = (weights or {}).get(where)
    result = permutation_importance(
        model, x, y, scoring="average_precision", n_repeats=repeats, random_state=seed, n_jobs=1, sample_weight=weight
    )
    weighting = ", trip-weighted" if weight is not None else ""
    return result.importances_mean, f"permutation importance on the {where} set (mean drop in average precision{weighting})"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dataset", type=Path, required=True, help="folder with dataset.npz and dataset_card.json")
    parser.add_argument("--task", choices=sorted(TASKS), default="temperature")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--min-recall", type=float, help="tune the threshold for this recall instead of maximum F1")
    parser.add_argument("--trip-weights", action="store_true", help="give every training trip the same total weight")
    parser.add_argument("--importance-repeats", type=int, default=10)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)

    import joblib

    from ..evaluation import plots

    card, arrays = load_dataset(args.dataset)
    label = banner(card)
    data, features, binary = task_data(args.task, arrays)
    x_train_raw, y_train, trips_train, _ = data["train"]
    if not 0 < y_train.sum() < len(y_train):
        raise SystemExit(f"The training set needs both classes for '{args.task}' (it has {len(y_train)} samples, {int(y_train.sum())} positive).")

    scaler = Scaler.fit(x_train_raw, features, binary)
    sets = {name: (scaler.transform_array(x), y, trips, times) for name, (x, y, trips, times) in data.items()}
    x_train = sets["train"][0]
    weights = trip_weights(trips_train) if args.trip_weights else None
    out = run_directory(args.dataset, f"baselines-{args.task}", args.out)
    (out / "models").mkdir(exist_ok=True)
    title = f"{args.task.capitalize()} task"

    results, rows, predictions, hyperparameters, importances = {}, [], [], {}, {}
    curves = {name: {} for name in ("validation", "test")}
    models = make_models(args.seed)
    positive_rate = float(y_train.mean())
    for name in ("no_skill", *MODEL_NAMES):
        if name == "no_skill":
            scores = {s: np.full(len(sets[s][1]), positive_rate) for s in SETS}
            model = None
        else:
            model = models[name]
            model.fit(x_train, y_train, sample_weight=weights)
            hyperparameters[name] = {k: v for k, v in model.get_params().items() if isinstance(v, (int, float, str, bool, type(None)))}
            scores = {s: model.predict_proba(sets[s][0])[:, 1] if len(sets[s][1]) else np.array([]) for s in SETS}
        threshold, threshold_info = tune_threshold(sets["validation"][1], scores["validation"], min_recall=args.min_recall)
        results[name] = {"threshold": threshold, "thresholdChoice": threshold_info}
        for s in ("validation", "test"):
            y = sets[s][1]
            results[name][s] = {"tuned": binary_metrics(y, scores[s], threshold), "default_0.5": binary_metrics(y, scores[s], 0.5)}
            curves[s][name] = (y, scores[s])
            predictions += prediction_rows(name, s, sets[s][2], sets[s][3], y, scores[s])
            for kind, metrics in results[name][s].items():
                row = {"model": name, "set": s, "threshold_kind": kind, **{k: v for k, v in metrics.items() if k != "confusion_matrix"}}
                row.update(metrics.get("confusion_matrix", {}))
                rows.append(row)
        if model is not None:
            joblib.dump(
                {
                    "model": model, "scaler": scaler.to_dict(), "threshold": threshold, "features": list(features), "task": args.task,
                    "dataset_version": card["source"]["datasetVersion"], "valid_for_evaluation": card["validForEvaluation"],
                },
                out / "models" / f"{name}.joblib",
            )
            values, method = importance(name, model, *sets["validation"][:2], x_train, y_train, features, args.seed, args.importance_repeats)
            importances[name] = {"method": method, "values": dict(zip(features, map(float, values)))}
            plots.feature_importance(
                list(features), values, out / "plots" / f"importance_{name}.png",
                f"{title}: {plots.MODEL_LABELS[name]} feature importance", label, xlabel=method.split(" (")[0],
            )
            test = results[name]["test"]["tuned"]
            if test.get("samples"):
                plots.confusion_matrix(
                    test["confusion_matrix"], TASKS[args.task]["labels"], out / "plots" / f"confusion_{name}_test.png",
                    f"{plots.MODEL_LABELS[name]}: test set (threshold {threshold:.2f})", label,
                )

    plotted = {}
    for s in ("validation", "test"):
        for kind, draw in (("roc", plots.roc_curves), ("pr", plots.pr_curves)):
            path = draw(curves[s], out / "plots" / f"{kind}_{s}.png", f"{title}: {'ROC' if kind == 'roc' else 'precision-recall'}, {s} set", label)
            plotted[f"{kind}_{s}"] = path.name if path else "not drawn: the set does not contain both classes"

    eligible = {n: r["validation"]["tuned"].get("pr_auc") for n, r in results.items() if n != "no_skill"}
    eligible = {n: v for n, v in eligible.items() if v is not None}
    summary = {
        "status": label or "evaluation on real data",
        "validForEvaluation": card["validForEvaluation"],
        "task": args.task,
        "target": TASKS[args.task]["target"],
        "bestOnValidation": (
            {"model": max(eligible, key=eligible.get), "by": "validation PR-AUC (average precision)"} if eligible else None
        ),
        "models": results,
        "plots": plotted,
    }
    write_json(out / "metrics.json", summary)
    write_predictions(out / "predictions.csv", predictions)
    with (out / "metrics.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, METRIC_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    write_json(
        out / "run.json",
        {
            "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "status": summary["status"],
            "task": args.task,
            "seed": args.seed,
            "arguments": {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
            "dataset": {**card["source"], "configId": card.get("configId"), "config": card["config"], "validForEvaluation": card["validForEvaluation"]},
            "classes": {s: {"samples": int(len(sets[s][1])), "positives": int(sets[s][1].sum()), "trips": len(set(sets[s][2].tolist()))} for s in SETS},
            "features": list(features),
            "imbalance": {"classWeight": "balanced", "tripWeights": args.trip_weights, "resampling": None},
            "thresholdRule": f"highest threshold with recall >= {args.min_recall} on validation" if args.min_recall else "maximum F1 on validation",
            "hyperparameters": hyperparameters,
            "importance": importances,
            "environment": environment(),
            "code": code_version(),
        },
    )

    print(f"Run: {out}")
    if label:
        print(f"  {label}")
    for name, result in results.items():
        for s in ("validation", "test"):
            m = result[s]["tuned"]
            if m.get("samples"):
                print(
                    f"  {name:20} {s:10} n={m['samples']:4} pos={m['positives']:3} thr={m['threshold']:.2f} "
                    + " ".join(f"{k}={m[k]:.3f}" if m[k] is not None else f"{k}=n/a" for k in ("precision", "recall", "f1", "roc_auc", "pr_auc"))
                )
            else:
                print(f"  {name:20} {s:10} no samples")
    return 0


if __name__ == "__main__":
    sys.exit(main())
