"""Train and evaluate the cold-chain CNN-LSTM (temperature-excursion risk).

Input: a processed dataset from build_dataset.py (dataset.npz and
dataset_card.json) with the excursion labels and the chronological,
trip-level split. The baselines (baselines.py) use the same split, so the
models are compared on exactly the same windows (compare.py).

  scaling         Scaler fitted on the training trips' grid rows only and
                  saved in the checkpoint, so inference applies exactly the
                  same preprocessing
  imbalance       positive-class weight = negatives / positives of the
                  training set (BCE with logits); --no-pos-weight disables it
  early stopping  on the validation loss: stops after --patience epochs
                  without improvement and restores the best epoch's weights
                  (not possible when the validation set is empty)
  threshold       tuned on the validation set (maximum F1, or --min-recall)
  test set        scored once with the final model, never used to choose

Outputs (default <dataset>/runs/cnn_lstm-<time>/):
  cnn_lstm.pt                weights, hyperparameters, scaler, grid settings, threshold
  metrics.json, metrics.csv  validation/test metrics at the tuned threshold and at 0.5
  history.csv                loss, accuracy and PR-AUC per epoch (training/validation)
  predictions.csv            score of every validation/test window (for compare.py)
  run.json                   seed, architecture, hyperparameters, dataset version, environment
  plots/                     loss and accuracy curves, ROC, precision-recall, confusion matrix

Outputs of a dataset with test/simulated data are labelled "PIPELINE CHECK
ONLY". training/install.py installs a selected model for the AI service.

Usage (from ai-service/):
  python -m cold_chain.training.train --dataset <processed folder> [--max-epochs 100] [--patience 10]
"""

from __future__ import annotations

import argparse
import copy
import csv
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

from ..evaluation.metrics import binary_metrics, tune_threshold
from ..preprocessing import BINARY_FEATURES, SEQUENCE_FEATURES, Scaler
from .common import (
    METRIC_COLUMNS,
    SETS,
    banner,
    code_version,
    environment,
    load_dataset,
    prediction_rows,
    run_directory,
    write_json,
    write_predictions,
)

HISTORY_COLUMNS = ("epoch", "train_loss", "validation_loss", "train_accuracy", "validation_accuracy", "validation_pr_auc")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dataset", type=Path, required=True, help="folder with dataset.npz and dataset_card.json")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--conv-channels", type=int, default=32)
    parser.add_argument("--kernel-size", type=int, default=3)
    parser.add_argument("--conv-layers", type=int, default=2)
    parser.add_argument("--lstm-hidden", type=int, default=64)
    parser.add_argument("--lstm-layers", type=int, default=1)
    parser.add_argument("--dropout", type=float, default=0.2)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--max-epochs", type=int, default=100)
    parser.add_argument("--patience", type=int, default=10)
    parser.add_argument("--min-delta", type=float, default=1e-4, help="smallest validation-loss improvement that counts")
    parser.add_argument("--no-pos-weight", action="store_true")
    parser.add_argument("--min-recall", type=float, help="tune the threshold for this recall instead of maximum F1")
    args = parser.parse_args(argv)

    import numpy as np
    import torch
    from sklearn.metrics import average_precision_score

    from ..evaluation import plots
    from ..model import build_model

    card, arrays = load_dataset(args.dataset)
    label = banner(card)
    y_np = {s: arrays[f"temp_y_{s}"].astype(np.float32) for s in SETS}
    if not 0 < y_np["train"].sum() < len(y_np["train"]):
        raise SystemExit("The training set needs both classes (excursion and no excursion).")

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.use_deterministic_algorithms(True)
    scaler = Scaler.fit(arrays["grid_X_train"], SEQUENCE_FEATURES, BINARY_FEATURES)
    x = {s: torch.from_numpy(scaler.transform_array(arrays[f"temp_X_{s}"])) for s in SETS}
    y = {s: torch.from_numpy(y_np[s]) for s in SETS}

    hyperparameters = {
        "n_features": len(SEQUENCE_FEATURES),
        "conv_channels": args.conv_channels,
        "kernel_size": args.kernel_size,
        "conv_layers": args.conv_layers,
        "lstm_hidden": args.lstm_hidden,
        "lstm_layers": args.lstm_layers,
        "dropout": args.dropout,
    }
    model = build_model(**hyperparameters)
    positives = float(y["train"].sum())
    pos_weight = None if args.no_pos_weight else (len(y["train"]) - positives) / positives
    loss_fn = torch.nn.BCEWithLogitsLoss(pos_weight=None if pos_weight is None else torch.tensor(pos_weight))
    optimiser = torch.optim.Adam(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    loader = torch.utils.data.DataLoader(
        torch.utils.data.TensorDataset(x["train"], y["train"]),
        batch_size=args.batch_size,
        shuffle=True,
        generator=torch.Generator().manual_seed(args.seed),
    )

    def scores(set_name: str):
        """(probabilities, loss) of a set with the current weights."""
        if not len(y[set_name]):
            return np.array([]), None
        model.eval()
        with torch.no_grad():
            logits = model(x[set_name])
            return torch.sigmoid(logits).numpy(), float(loss_fn(logits, y[set_name]))

    has_validation = len(y["validation"]) > 0
    history, best, stale = [], None, 0
    for epoch in range(1, args.max_epochs + 1):
        model.train()
        for batch_x, batch_y in loader:
            optimiser.zero_grad()
            loss_fn(model(batch_x), batch_y).backward()
            optimiser.step()
        (train_p, train_loss), (val_p, val_loss) = scores("train"), scores("validation")
        val_y = y_np["validation"]
        history.append(
            {
                "epoch": epoch,
                "train_loss": train_loss,
                "validation_loss": val_loss,
                "train_accuracy": float(((train_p >= 0.5) == y_np["train"]).mean()),
                "validation_accuracy": float(((val_p >= 0.5) == val_y).mean()) if has_validation else None,
                "validation_pr_auc": float(average_precision_score(val_y, val_p)) if has_validation and val_y.sum() else None,
            }
        )
        if not has_validation:
            continue
        if best is None or val_loss < best["loss"] - args.min_delta:
            best, stale = {"loss": val_loss, "epoch": epoch, "state": copy.deepcopy(model.state_dict())}, 0
        else:
            stale += 1
            if stale >= args.patience:
                break
    if best is not None:
        model.load_state_dict(best["state"])
    stopping = (
        {"monitored": "validation loss", "bestEpoch": best["epoch"], "epochsRun": len(history), "stoppedEarly": len(history) < args.max_epochs}
        if best is not None
        else {"monitored": None, "reason": "no validation samples: trained for --max-epochs", "epochsRun": len(history)}
    )

    probabilities = {s: scores(s)[0] for s in SETS}
    threshold, threshold_info = tune_threshold(y_np["validation"], probabilities["validation"], min_recall=args.min_recall)
    result = {"threshold": threshold, "thresholdChoice": threshold_info}
    rows, predictions = [], []
    for s in ("validation", "test"):
        result[s] = {"tuned": binary_metrics(y_np[s], probabilities[s], threshold), "default_0.5": binary_metrics(y_np[s], probabilities[s], 0.5)}
        for kind, metrics in result[s].items():
            rows.append({"model": "cnn_lstm", "set": s, "threshold_kind": kind, **{k: v for k, v in metrics.items() if k != "confusion_matrix"}, **metrics.get("confusion_matrix", {})})
        predictions += prediction_rows("cnn_lstm", s, arrays[f"temp_trip_{s}"], arrays[f"temp_time_{s}"], y_np[s], probabilities[s])

    out = run_directory(args.dataset, "cnn_lstm", args.out)
    version = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    checkpoint = {
        "state_dict": model.state_dict(),
        "version": version,
        "hyperparameters": hyperparameters,
        "features": list(SEQUENCE_FEATURES),
        "steps": card["config"]["window"]["steps"],
        "horizon_minutes": card["config"]["excursion"]["horizon_minutes"],
        "grid_config": card["config"]["grid"],
        "scaler": scaler.to_dict(),
        "threshold": threshold,
        "dataset_version": card["source"]["datasetVersion"],
        "dataset_config_id": card.get("configId"),
        "valid_for_evaluation": card["validForEvaluation"],
    }
    torch.save(checkpoint, out / "cnn_lstm.pt")

    with (out / "history.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, HISTORY_COLUMNS)
        writer.writeheader()
        writer.writerows(history)
    with (out / "metrics.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, METRIC_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    write_predictions(out / "predictions.csv", predictions)

    best_epoch = stopping.get("bestEpoch")
    plotted = {
        "loss": plots.training_curves(history, "loss", out / "plots" / "loss.png", "CNN-LSTM: loss per epoch", label, best_epoch=best_epoch),
        "accuracy": plots.training_curves(history, "accuracy", out / "plots" / "accuracy.png", "CNN-LSTM: accuracy per epoch (threshold 0.5)", label, best_epoch=best_epoch),
    }
    for s in ("validation", "test"):
        curve = {"cnn_lstm": (y_np[s], probabilities[s])}
        plotted[f"roc_{s}"] = plots.roc_curves(curve, out / "plots" / f"roc_{s}.png", f"CNN-LSTM: ROC, {s} set", label)
        plotted[f"pr_{s}"] = plots.pr_curves(curve, out / "plots" / f"pr_{s}.png", f"CNN-LSTM: precision-recall, {s} set", label)
    if result["test"]["tuned"].get("samples"):
        plotted["confusion_test"] = plots.confusion_matrix(
            result["test"]["tuned"]["confusion_matrix"], ("No excursion", "Excursion"), out / "plots" / "confusion_cnn_lstm_test.png",
            f"CNN-LSTM: test set (threshold {threshold:.2f})", label,
        )
    write_json(
        out / "metrics.json",
        {
            "status": label or "evaluation on real data",
            "validForEvaluation": card["validForEvaluation"],
            "task": "temperature",
            "target": "temperature excursion within the horizon",
            "models": {"cnn_lstm": result},
            "earlyStopping": stopping,
            "plots": {k: v.name if v else "not drawn: the set does not contain both classes" for k, v in plotted.items()},
        },
    )
    write_json(
        out / "run.json",
        {
            "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "status": label or "evaluation on real data",
            "task": "temperature",
            "model": "cnn_lstm",
            "modelVersion": version,
            "seed": args.seed,
            "deterministicAlgorithms": True,
            "arguments": {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
            "dataset": {**card["source"], "configId": card.get("configId"), "config": card["config"], "validForEvaluation": card["validForEvaluation"]},
            "classes": {s: {"samples": int(len(y_np[s])), "positives": int(y_np[s].sum()), "trips": len(set(arrays[f"temp_trip_{s}"].tolist()))} for s in SETS},
            "features": list(SEQUENCE_FEATURES),
            "sequenceLength": checkpoint["steps"],
            "horizonMinutes": checkpoint["horizon_minutes"],
            "architecture": str(model),
            "parameters": sum(p.numel() for p in model.parameters()),
            "hyperparameters": hyperparameters,
            "training": {
                "loss": "binary cross-entropy with logits",
                "positiveClassWeight": pos_weight,
                "optimizer": "Adam",
                "learningRate": args.lr,
                "weightDecay": args.weight_decay,
                "batchSize": args.batch_size,
                "maxEpochs": args.max_epochs,
                "patience": args.patience,
                "minDelta": args.min_delta,
                **stopping,
            },
            "thresholdRule": f"highest threshold with recall >= {args.min_recall} on validation" if args.min_recall else "maximum F1 on validation",
            "environment": environment(),
            "code": code_version(),
        },
    )

    print(f"Run: {out}")
    if label:
        print(f"  {label}")
    print(f"  epochs: {stopping['epochsRun']}, best epoch: {best_epoch}, threshold: {threshold:.3f} ({threshold_info['source']})")
    for s in ("validation", "test"):
        m = result[s]["tuned"]
        if m.get("samples"):
            print(f"  {s:10} n={m['samples']} pos={m['positives']} " + " ".join(f"{k}={m[k]:.3f}" if m[k] is not None else f"{k}=n/a" for k in ("precision", "recall", "f1", "roc_auc", "pr_auc")))
        else:
            print(f"  {s:10} no samples")
    return 0


if __name__ == "__main__":
    sys.exit(main())
