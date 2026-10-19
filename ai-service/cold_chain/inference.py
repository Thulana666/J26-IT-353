"""Cold-chain risk inference with the installed trained models (Component 2).

  predict_temperature_risk(sequence)  risk of a temperature excursion within
                                      the horizon; `sequence` comes from
                                      preprocessing.sequence_at (unscaled)
  predict_delay_risk(features)        risk of a late delivery; `features` come
                                      from preprocessing.delay_features
  predict_overall_risk(...)           the two combined by risk.combine
                                      (configurable, documented there)
  predict(request)                    POST /cold-chain/predict: raw readings ->
                                      the training's cleaning, grid, features
                                      and skip rules -> the three above

Models are installed by training/install.py into models/<task>/
(manifest.json + weights) with the scaler and settings they were trained
with. With no model installed predict() raises ModelNotTrainedError and the
API answers 501: the backend keeps its labelled rule-based prototype and no
prediction is made up. A model trained on test/simulated data is never loaded
from the service's models folder. Serving a model needs the training
requirements (numpy, scikit-learn and, for the CNN-LSTM, PyTorch).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .dataset import SnapshotConfig, WindowConfig, snapshot_skip_reason, window_skip_reason
from .preprocessing import (
    DELAY_FEATURES,
    GridConfig,
    Reading,
    Scaler,
    TripContext,
    build_grid,
    clean_readings,
    delay_features,
    sequence_at,
    window_summary,
)
from .risk import RiskConfig, combine
from .schemas import PredictRequest

SERVICE_MODELS = Path(__file__).parent / "models"
MODELS_DIR = SERVICE_MODELS  # tests point this at a temporary folder
TASKS = ("temperature", "delay")
REASONS = {
    "not_installed": "no trained model is installed",
    "trip_too_short": "not enough trip history yet for the model",
    "no_temperature_yet": "no temperature reading yet",
    "sparse_input": "too few recent readings",
    "ongoing_excursion": "the temperature is already outside the limits (an observed excursion, not a prediction)",
    "no_planned_delivery_time": "the trip has no planned delivery time",
    "planned_delivery_before_start": "the planned delivery time is before the trip start",
    "past_planned_delivery_time": "the planned delivery time has passed (the trip is already late, not a prediction)",
}


class ModelNotTrainedError(RuntimeError):
    pass


@dataclass
class InstalledModel:
    task: str
    manifest: dict
    model: object
    scaler: Scaler


_cache: dict = {}


def load_model(task: str) -> InstalledModel | None:
    """The installed model of a task, or None."""
    directory = Path(MODELS_DIR) / task
    manifest_path = directory / "manifest.json"
    if not manifest_path.exists():
        return None
    key = (str(manifest_path.resolve()), manifest_path.stat().st_mtime_ns)
    if key in _cache:
        return _cache[key]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not manifest["dataset"]["validForEvaluation"] and directory.resolve().parent == SERVICE_MODELS.resolve():
        raise ModelNotTrainedError(f"The installed {task} model was trained on test/simulated data and is not used")
    if manifest["kind"] == "torch_cnn_lstm":
        try:
            import torch

            from .model import build_model
        except ImportError as error:
            raise ModelNotTrainedError("PyTorch is not installed in the AI service (requirements-training.txt)") from error
        checkpoint = torch.load(directory / manifest["file"], map_location="cpu", weights_only=True)
        model = build_model(**checkpoint["hyperparameters"])
        model.load_state_dict(checkpoint["state_dict"])
        model.eval()
        scaler = Scaler.from_dict(checkpoint["scaler"])
    else:
        try:
            import joblib
        except ImportError as error:
            raise ModelNotTrainedError("scikit-learn is not installed in the AI service (requirements-training.txt)") from error
        bundle = joblib.load(directory / manifest["file"])
        model, scaler = bundle["model"], Scaler.from_dict(bundle["scaler"])
    loaded = InstalledModel(task, manifest, model, scaler)
    _cache[key] = loaded
    return loaded


def _require(task: str) -> InstalledModel:
    installed = load_model(task)
    if installed is None:
        raise ModelNotTrainedError(f"No trained {task} model is installed")
    return installed


def _result(installed: InstalledModel, probability: float) -> dict:
    threshold = installed.manifest["threshold"]
    return {
        "probability": probability,
        "threshold": threshold,
        "aboveThreshold": probability >= threshold,
        "model": installed.manifest["model"],
        "version": installed.manifest["version"],
    }


def _sklearn_probability(installed: InstalledModel, row: list) -> float:
    import numpy as np

    return float(installed.model.predict_proba(np.array(installed.scaler.transform([row])))[0, 1])


def predict_temperature_risk(sequence: list[list[float | None]]) -> dict:
    """Excursion risk for one unscaled sequence (preprocessing.sequence_at)."""
    installed = _require("temperature")
    if installed.manifest["kind"] == "torch_cnn_lstm":
        import torch

        with torch.no_grad():
            probability = float(torch.sigmoid(installed.model(torch.tensor([installed.scaler.transform(sequence)], dtype=torch.float32)))[0])
    else:
        probability = _sklearn_probability(installed, window_summary(sequence))
    return {**_result(installed, probability), "horizonMinutes": installed.manifest["horizonMinutes"]}


def predict_delay_risk(features: list[float | None]) -> dict:
    """Late-delivery risk for one unscaled snapshot (preprocessing.delay_features)."""
    installed = _require("delay")
    return _result(installed, _sklearn_probability(installed, features))


def predict_overall_risk(temperature: dict | None, delay: dict | None, config: RiskConfig | None = None) -> dict:
    """temperature / delay: results of the two functions above, or None when
    that risk could not be estimated."""
    return combine(
        {"temperature": temperature["probability"] if temperature else None, "delay": delay["probability"] if delay else None},
        config or RiskConfig.from_env(),
    )


def _number(value, pattern: str) -> str | None:
    return pattern.format(value) if value is not None else None


def _limit(value: float) -> str:
    return f"{value:g}"


def _explain_temperature(result: dict, row: dict, trip: TripContext) -> str:
    facts = [
        _number(row["temperature_c"], "now {:.1f} °C"),
        _number(row["margin_to_limit_c"], "{:.1f} °C from the nearest limit"),
        _number(row["temperature_roll_slope_c_per_min"], "trend {:+.2f} °C/min"),
    ]
    return (
        f"Temperature: {result['probability']:.0%} estimated risk of leaving {_limit(trip.temp_min_c)}–{_limit(trip.temp_max_c)} °C "
        f"within the next {result['horizonMinutes']} min ({', '.join(f for f in facts if f)})."
    )


def _explain_delay(result: dict, values: dict) -> str:
    facts = [
        _number(values["minutes_to_eta"], "{:.0f} min to the planned delivery time"),
        _number(values["km_to_destination"], "{:.1f} km left in a straight line"),
        _number(values["recent_speed_kmh"], "recent speed {:.0f} km/h"),
        _number(values["required_speed_kmh"], "{:.0f} km/h needed"),
    ]
    known = [f for f in facts if f]
    return f"Delivery: {result['probability']:.0%} estimated risk of arriving after the planned time" + (f" ({', '.join(known)})." if known else ".")


def predict(request: PredictRequest) -> dict:
    installed = {task: load_model(task) for task in TASKS}
    if not any(installed.values()):
        raise ModelNotTrainedError("No trained cold-chain model is installed (models/temperature, models/delay)")
    readings = [
        Reading(r.recorded_at, r.temperature_c, r.humidity_pct, r.latitude, r.longitude, r.speed_kmh, "gps_jump" in r.quality_flags)
        for r in request.readings
    ]
    started = request.trip.started_at or min((r.recorded_at for r in readings), default=request.now)
    trip = TripContext(
        temp_min_c=request.limits.temp_min_c,
        temp_max_c=request.limits.temp_max_c,
        started_at=started,
        expected_delivery_at=request.trip.expected_delivery_at,
        destination=(request.destination.latitude, request.destination.longitude) if request.destination else None,
        origin=(request.origin.latitude, request.origin.longitude) if request.origin else None,
    )
    cleaned, report = clean_readings(readings, start=started, end=request.now)
    grids: dict = {}

    def grid_for(manifest: dict) -> list[dict]:
        key = json.dumps(manifest["grid"], sort_keys=True)
        if key not in grids:
            grids[key] = build_grid(cleaned, trip, until=request.now, config=GridConfig(**manifest["grid"]))
        return grids[key]

    components, factors, results = {}, {}, {}
    for task in TASKS:
        model = installed[task]
        if model is None:
            components[task] = {"available": False, "reason": "not_installed"}
            continue
        grid = grid_for(model.manifest)
        index = len(grid) - 1
        if task == "temperature":
            window = WindowConfig(**model.manifest["window"])
            reason = "trip_too_short" if index < 0 else window_skip_reason(grid, index, window)
            if reason is None and model.manifest["excursion"]["exclude_ongoing"] and grid[index]["margin_to_limit_c"] < 0:
                reason = "ongoing_excursion"
            if reason is None:
                result = predict_temperature_risk(sequence_at(grid, index, window.steps))
                row = grid[index]
                factors["temperature_excursion"] = {
                    "probability": round(result["probability"], 4),
                    "explanation": _explain_temperature(result, row, trip),
                    "details": {"temperatureC": row["temperature_c"], "marginC": row["margin_to_limit_c"],
                                "trendCPerMin": row["temperature_roll_slope_c_per_min"], "threshold": result["threshold"], "model": result["model"]},
                }
        else:
            reason = "trip_too_short" if index < 0 else snapshot_skip_reason(grid, index, trip, SnapshotConfig(**model.manifest["snapshot"]))
            if reason is None:
                values = delay_features(grid, index, trip)
                result = predict_delay_risk(values)
                named = dict(zip(DELAY_FEATURES, values))
                factors["delivery_delay"] = {
                    "probability": round(result["probability"], 4),
                    "explanation": _explain_delay(result, named),
                    "details": {"minutesToEta": named["minutes_to_eta"], "kmToDestination": named["km_to_destination"],
                                "recentSpeedKmh": named["recent_speed_kmh"], "requiredSpeedKmh": named["required_speed_kmh"],
                                "threshold": result["threshold"], "model": result["model"]},
                }
        if reason is None:
            results[task] = result
            components[task] = {"available": True, **result}
        else:
            components[task] = {"available": False, "reason": reason}

    if not results:
        raise ValueError("No risk could be estimated yet: " + "; ".join(f"{task}: {REASONS[c['reason']]}" for task, c in components.items()))
    overall = predict_overall_risk(results.get("temperature"), results.get("delay"))
    notes = [
        f"{'Temperature' if task == 'temperature' else 'Delay'} risk not estimated: {REASONS[c['reason']]}."
        for task, c in components.items()
        if not c["available"]
    ]
    summary = f"Overall {overall['riskLevel'].upper()} risk ({overall['combination']['method']} of the estimated risks)."
    used = [m for m in installed.values() if m]
    return {
        **overall,
        "temperatureRisk": round(results["temperature"]["probability"], 4) if "temperature" in results else None,
        "delayRisk": round(results["delay"]["probability"], 4) if "delay" in results else None,
        "explanation": " ".join([summary, *(f["explanation"] for f in factors.values()), *notes]),
        "factors": factors,
        "components": components,
        "horizonMinutes": results["temperature"]["horizonMinutes"] if "temperature" in results else None,
        "readingsUsed": len(cleaned),
        "dataUntil": max((r.recorded_at for r in cleaned), default=None),
        "cleaning": report.to_dict(),
        "modelName": "+".join(f"{m.task}:{m.manifest['model']}" for m in used),
        "modelVersion": ";".join(f"{m.task}:{m.manifest['version']}" for m in used),
    }
