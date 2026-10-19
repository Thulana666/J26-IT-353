"""Delivery-delay model (needs requirements-training.txt).

Predicts from a trip-progress snapshot (preprocessing.DELAY_FEATURES), taken
while the truck is in transit and before the planned delivery time, whether
the trip will be delivered late (labels.delivery_delay_label). Personal data
is not used.

All snapshots of a trip share its label, so they are not independent: every
trip gets the same total weight in training, threshold tuning, model
selection and the headline ("trip-balanced") metrics. Snapshot-level metrics
are reported too.

Models, on the dataset's chronological trip-level split:
  no_skill, logistic_regression, random_forest, gradient_boosting
      the fixed baseline settings of baselines.py
  gradient_boosting_tuned
      histogram gradient boosting whose hyperparameters are chosen by
      forward-chaining cross-validation on the TRAINING trips only (earlier
      trips fit, the next block scores; trip-weighted average precision).
      Validation and test trips are never seen by the search.
Selection: the highest trip-balanced validation PR-AUC; within --tolerance,
the simpler model. The test set is only reported, never used to choose.

Outputs (default <dataset>/runs/delay-<time>/): metrics.json (with the
selection), metrics.csv, predictions.csv (compare.py --trip-weights reads it),
run.json (with the search), models/<name>.joblib, plots/. Outputs of test or
simulated data are labelled "PIPELINE CHECK ONLY".

Usage (from ai-service/):
  python -m cold_chain.training.delay --dataset <processed folder>
"""

from __future__ import annotations

import argparse
import csv
import itertools
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from ..evaluation.metrics import binary_metrics, tune_threshold
from ..preprocessing import Scaler
from .baselines import MODEL_NAMES, importance, make_models, task_data
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
from .compare import select

TUNED = "gradient_boosting_tuned"
GRIDS = {
    "default": {
        "learning_rate": (0.05, 0.1),
        "max_leaf_nodes": (7, 15),
        "min_samples_leaf": (5, 20),
        "max_iter": (100, 300),
        "l2_regularization": (1.0,),
    },
    # Two candidates: only for fast pipeline checks (tests).
    "quick": {"learning_rate": (0.1,), "max_leaf_nodes": (7, 15), "min_samples_leaf": (5,), "max_iter": (50,), "l2_regularization": (1.0,)},
}


def boosting(params: dict, seed: int):
    from sklearn.ensemble import HistGradientBoostingClassifier

    return HistGradientBoostingClassifier(**params, class_weight="balanced", early_stopping=False, random_state=seed)


def forward_folds(trip_order: list[str], trips, n_folds: int) -> list[tuple[np.ndarray, np.ndarray]]:
    """(fit mask, score mask) per fold: fold k fits on the earliest trips and
    scores the next block of trips (expanding window, never the future)."""
    from sklearn.model_selection import TimeSeriesSplit

    k = min(n_folds, len(trip_order) - 1)
    if k < 2:
        return []
    position = np.array([trip_order.index(t) for t in trips.tolist()])
    return [
        (np.isin(position, fit), np.isin(position, score))
        for fit, score in TimeSeriesSplit(n_splits=k).split(np.arange(len(trip_order)))
    ]


def search(x, y, trips, trip_order: list[str], grid: dict, seed: int, n_folds: int) -> tuple[dict | None, dict]:
    from sklearn.metrics import average_precision_score

    folds = [
        (fit, score)
        for fit, score in forward_folds(trip_order, trips, n_folds)
        if 0 < y[fit].sum() < fit.sum() and 0 < y[score].sum() < score.sum()
    ]
    if not folds:
        return None, {"folds": 0, "reason": "no forward-chaining fold has both classes in its fit and score trips"}
    candidates = []
    for values in itertools.product(*grid.values()):
        params = dict(zip(grid, values))
        fold_ap = []
        for fit, score in folds:
            model = boosting(params, seed).fit(x[fit], y[fit], sample_weight=trip_weights(trips[fit]))
            fold_ap.append(float(average_precision_score(y[score], model.predict_proba(x[score])[:, 1], sample_weight=trip_weights(trips[score]))))
        candidates.append({"params": params, "meanAp": float(np.mean(fold_ap)), "foldAp": fold_ap})
    best = max(candidates, key=lambda c: c["meanAp"])
    return best["params"], {"folds": len(folds), "scoring": "trip-weighted average precision", "best": best, "candidates": candidates}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dataset", type=Path, required=True, help="folder with dataset.npz and dataset_card.json")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--grid", choices=sorted(GRIDS), default="default")
    parser.add_argument("--folds", type=int, default=3, help="forward-chaining folds over the training trips")
    parser.add_argument("--min-recall", type=float, help="tune the threshold for this recall instead of maximum F1")
    parser.add_argument("--tolerance", type=float, default=0.01, help="validation PR-AUC difference treated as a tie")
    parser.add_argument("--importance-repeats", type=int, default=10)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)

    import joblib

    from ..evaluation import plots

    card, arrays = load_dataset(args.dataset)
    label = banner(card)
    data, features, binary = task_data("delay", arrays)
    x_train_raw, y_train, trips_train, _ = data["train"]
    if not 0 < y_train.sum() < len(y_train):
        raise SystemExit(f"The training set needs late and on-time trips (it has {len(y_train)} snapshots, {int(y_train.sum())} late).")

    scaler = Scaler.fit(x_train_raw, features, binary)
    sets = {s: (scaler.transform_array(x), y, trips, times) for s, (x, y, trips, times) in data.items()}
    weights = {s: trip_weights(sets[s][2]) for s in SETS}
    best_params, search_info = search(sets["train"][0], y_train, trips_train, card["split"]["members"]["train"], GRIDS[args.grid], args.seed, args.folds)
    models = make_models(args.seed)
    if best_params is None:
        best_params = {k: v for k, v in models["gradient_boosting"].get_params().items() if k in GRIDS["default"]}
        search_info["fallback"] = "baseline gradient-boosting settings"
    models[TUNED] = boosting(best_params, args.seed)

    out = run_directory(args.dataset, "delay", args.out)
    (out / "models").mkdir(exist_ok=True)
    results, rows, predictions, hyperparameters, importances = {}, [], [], {}, {}
    curves = {s: {} for s in ("validation", "test")}
    positive_rate = float(np.average(y_train, weights=weights["train"]))
    for name in ("no_skill", *MODEL_NAMES, TUNED):
        if name == "no_skill":
            model, scores = None, {s: np.full(len(sets[s][1]), positive_rate) for s in SETS}
        else:
            model = models[name].fit(sets["train"][0], y_train, sample_weight=weights["train"])
            hyperparameters[name] = {k: v for k, v in model.get_params().items() if isinstance(v, (int, float, str, bool, type(None)))}
            scores = {s: model.predict_proba(sets[s][0])[:, 1] if len(sets[s][1]) else np.array([]) for s in SETS}
        threshold, threshold_info = tune_threshold(sets["validation"][1], scores["validation"], min_recall=args.min_recall, sample_weight=weights["validation"])
        results[name] = {"threshold": threshold, "thresholdChoice": threshold_info}
        for s in ("validation", "test"):
            y, w = sets[s][1], weights[s]
            results[name][s] = {
                "tuned": binary_metrics(y, scores[s], threshold, sample_weight=w if len(y) else None),
                "tuned_snapshots": binary_metrics(y, scores[s], threshold),
                "default_0.5": binary_metrics(y, scores[s], 0.5, sample_weight=w if len(y) else None),
            }
            curves[s][name] = (y, scores[s], w)
            predictions += prediction_rows(name, s, sets[s][2], sets[s][3], y, scores[s])
            for kind, metrics in results[name][s].items():
                rows.append({"model": name, "set": s, "threshold_kind": kind, **{k: v for k, v in metrics.items() if k != "confusion_matrix"}, **metrics.get("confusion_matrix", {})})
        if model is not None:
            joblib.dump(
                {"model": model, "scaler": scaler.to_dict(), "threshold": threshold, "features": list(features), "task": "delay",
                 "dataset_version": card["source"]["datasetVersion"], "valid_for_evaluation": card["validForEvaluation"]},
                out / "models" / f"{name}.joblib",
            )
            values, method = importance(name, model, *sets["validation"][:2], sets["train"][0], y_train, features, args.seed, args.importance_repeats,
                                        weights={"validation": weights["validation"], "training": weights["train"]})
            importances[name] = {"method": method, "values": dict(zip(features, map(float, values)))}

    selection = select({name: results[name]["validation"]["tuned"].get("pr_auc") for name in results}, args.tolerance)
    selection["metric"] = "trip-balanced validation PR-AUC"
    plotted = {}
    for s in ("validation", "test"):
        title = f"Delay task: {s} set, trip-balanced"
        for kind, draw in (("roc", plots.roc_curves), ("pr", plots.pr_curves)):
            path = draw(curves[s], out / "plots" / f"{kind}_{s}.png", f"{title} ({'ROC' if kind == 'roc' else 'precision-recall'})", label)
            plotted[f"{kind}_{s}"] = path.name if path else "not drawn: the set does not contain both classes"
    for name in {selection.get("model"), TUNED} - {None}:
        method = importances[name]["method"]
        plots.feature_importance(list(features), list(importances[name]["values"].values()), out / "plots" / f"importance_{name}.png",
                                 f"Delay task: {plots.MODEL_LABELS[name]} feature importance", label, xlabel=method.split(" (")[0])
        test = results[name]["test"]["tuned_snapshots"]
        if test.get("samples"):
            plots.confusion_matrix(test["confusion_matrix"], ("On time", "Late"), out / "plots" / f"confusion_{name}_test.png",
                                   f"{plots.MODEL_LABELS[name]}: test snapshots (threshold {results[name]['threshold']:.2f})", label)

    write_json(
        out / "metrics.json",
        {
            "status": label or "evaluation on real data",
            "validForEvaluation": card["validForEvaluation"],
            "task": "delay",
            "target": "late delivery",
            "metricKinds": {
                "tuned": "trip-balanced (each trip weighs the same), at the validation-tuned threshold",
                "tuned_snapshots": "every snapshot counts once, same threshold",
                "default_0.5": "trip-balanced, threshold 0.5",
            },
            "selection": selection,
            "models": results,
            "plots": plotted,
        },
    )
    write_predictions(out / "predictions.csv", predictions)
    with (out / "metrics.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, METRIC_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    write_json(
        out / "run.json",
        {
            "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "status": label or "evaluation on real data",
            "task": "delay",
            "seed": args.seed,
            "arguments": {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
            "dataset": {**card["source"], "configId": card.get("configId"), "config": card["config"], "validForEvaluation": card["validForEvaluation"]},
            "classes": {
                s: {"snapshots": int(len(sets[s][1])), "lateSnapshots": int(sets[s][1].sum()), "trips": len(set(sets[s][2].tolist())),
                    "lateTrips": len({t for t, y in zip(sets[s][2].tolist(), sets[s][1]) if y})}
                for s in SETS
            },
            "features": list(features),
            "imbalance": {"classWeight": "balanced", "tripWeights": True, "resampling": None},
            "thresholdRule": (f"highest threshold with trip-balanced recall >= {args.min_recall} on validation" if args.min_recall else "maximum trip-balanced F1 on validation"),
            "search": {"grid": GRIDS[args.grid], "gridName": args.grid, "requestedFolds": args.folds, **search_info},
            "hyperparameters": hyperparameters,
            "importance": importances,
            "environment": environment(),
            "code": code_version(),
        },
    )

    print(f"Run: {out}")
    if label:
        print(f"  {label}")
    print(f"  search: {search_info.get('folds')} fold(s), chosen {best_params}")
    for name, result in results.items():
        line = " ".join(
            f"{s[:4]}_{k}={result[s]['tuned'][k]:.3f}" if result[s]["tuned"].get(k) is not None else f"{s[:4]}_{k}=n/a"
            for s in ("validation", "test") for k in ("f1", "pr_auc")
        )
        print(f"  {name:24} {line}")
    print(f"  selected on validation: {selection.get('model')} ({selection.get('reason') or selection['rule']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
