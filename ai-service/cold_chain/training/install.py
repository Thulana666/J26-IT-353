"""Installs a trained, selected model for the AI service (one per task).

  python -m cold_chain.training.install --comparison <comparison folder>
      the model selected there (compare.py)
  python -m cold_chain.training.install --run <run folder> [--model NAME]
      a model of one run (default: the run's own selection, or its only model)

Writes cold_chain/models/<task>/ (task = temperature or delay):
  model.pt or model.joblib  CNN-LSTM weights (PyTorch) or scikit-learn model
  manifest.json             model, version, decision threshold, the training
                            preprocessing (grid, sequence length, horizon, skip
                            rules), features, dataset version and the model's
                            validation/test metrics
so cold_chain/inference.py predicts with exactly the training preprocessing.

Models trained on test/simulated data are refused. --allow-test-data exists
only for pipeline checks and only with a --target outside cold_chain/models:
the live service can never load such a model. Only install files produced by
this project's training scripts (model.joblib is a pickle).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from .common import code_version, write_json

SERVICE_MODELS = Path(__file__).resolve().parents[1] / "models"
MANAGED_FILES = ("manifest.json", "model.pt", "model.joblib")


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve(args) -> tuple[Path, str, dict | None]:
    """(run folder, model name, selection record)."""
    if args.comparison:
        comparison = _read(args.comparison / "comparison.json")
        name = args.model or comparison["selection"].get("model")
        if not name:
            raise SystemExit(f"The comparison selected no model: {comparison['selection'].get('reason')}")
        if name not in comparison["models"]:
            raise SystemExit(f"{name} is not part of this comparison")
        return Path(comparison["models"][name]["run"]), name, comparison["selection"]
    metrics = _read(args.run / "metrics.json")
    selection = metrics.get("selection")
    models = [m for m in metrics["models"] if m != "no_skill"]
    name = args.model or (selection or {}).get("model") or (models[0] if len(models) == 1 else None)
    if not name:
        raise SystemExit(f"Pass --model: this run has several models ({', '.join(models)}) and no selection")
    if name not in metrics["models"]:
        raise SystemExit(f"{name} is not part of this run")
    return args.run, name, selection


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--comparison", type=Path, help="comparison folder (compare.py): install its selected model")
    source.add_argument("--run", type=Path, help="run folder (baselines.py, train.py or delay.py)")
    parser.add_argument("--model", help="model name instead of the selection")
    parser.add_argument("--target", type=Path, help="models folder (default: cold_chain/models of the AI service)")
    parser.add_argument("--allow-test-data", action="store_true", help="pipeline checks only, with a --target outside cold_chain/models")
    args = parser.parse_args(argv)

    run_dir, name, selection = resolve(args)
    if name == "no_skill":
        raise SystemExit("The no-skill reference is not a model to install")
    run, metrics = _read(run_dir / "run.json"), _read(run_dir / "metrics.json")
    dataset, task = run["dataset"], run["task"]
    target = (args.target or SERVICE_MODELS).resolve()
    if not dataset["validForEvaluation"]:
        if not args.allow_test_data:
            raise SystemExit("Refused: the model was trained on test/simulated data and must never serve predictions.")
        service = SERVICE_MODELS.resolve()
        if target == service or service in target.parents:
            raise SystemExit("--allow-test-data is only allowed with a --target outside cold_chain/models.")

    config = dataset["config"]
    result = metrics["models"][name]
    if name == "cnn_lstm":
        kind, file, source_file = "torch_cnn_lstm", "model.pt", run_dir / "cnn_lstm.pt"
    else:
        kind, file, source_file = "sklearn", "model.joblib", run_dir / "models" / f"{name}.joblib"
    manifest = {
        "task": task,
        "model": name,
        "kind": kind,
        "file": file,
        "input": {"temperature": "sequence" if kind == "torch_cnn_lstm" else "window_summary", "delay": "delay_features"}[task],
        "version": run.get("modelVersion") or run["createdAt"],
        "threshold": result["threshold"],
        "thresholdChoice": result["thresholdChoice"],
        "horizonMinutes": config["excursion"]["horizon_minutes"] if task == "temperature" else None,
        "grid": config["grid"],
        "window": config["window"],
        "excursion": config["excursion"],
        "snapshot": config["snapshot"],
        "delayLabel": config["delay"],
        "features": run["features"],
        "dataset": {"datasetVersion": dataset["datasetVersion"], "configId": dataset.get("configId"), "validForEvaluation": dataset["validForEvaluation"]},
        "metrics": {"validation": result["validation"]["tuned"], "test": result["test"]["tuned"]},
        "selection": selection,
        "sourceRun": str(run_dir.resolve()),
        "installedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "code": code_version(),
    }

    directory = target / task
    directory.mkdir(parents=True, exist_ok=True)
    for stale in MANAGED_FILES:
        (directory / stale).unlink(missing_ok=True)
    shutil.copyfile(source_file, directory / file)
    write_json(directory / "manifest.json", manifest)  # last: the service only loads a complete install
    print(f"Installed {task} model {name} ({kind}, version {manifest['version']}) in {directory}")
    if not dataset["validForEvaluation"]:
        print("  PIPELINE CHECK ONLY - trained on simulated/test data, not for the service")
    return 0


if __name__ == "__main__":
    sys.exit(main())
