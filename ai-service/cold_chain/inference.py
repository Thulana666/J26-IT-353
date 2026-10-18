"""Inference with the trained CNN-LSTM, once weights exist.

Weights are expected at models/cnn_lstm.pt (written by training/train.py).
Without them, or without PyTorch, predict() raises ModelNotTrainedError and
the API answers 501: no prediction is made up.
"""

from __future__ import annotations

from pathlib import Path

from .preprocessing import Reading, build_sequence
from .schemas import PredictRequest

MODEL_PATH = Path(__file__).parent / "models" / "cnn_lstm.pt"


class ModelNotTrainedError(RuntimeError):
    pass


_model = None


def _load():
    global _model
    if _model is not None:
        return _model
    if not MODEL_PATH.exists():
        raise ModelNotTrainedError("The CNN-LSTM model has not been trained yet (no models/cnn_lstm.pt)")
    try:  # pragma: no cover - needs the training requirements and real weights
        import torch

        from .model import build_model
    except ImportError as error:  # pragma: no cover
        raise ModelNotTrainedError("PyTorch is not installed in the AI service") from error
    checkpoint = torch.load(MODEL_PATH, map_location="cpu")  # pragma: no cover
    model = build_model(**checkpoint.get("hyperparameters", {}))  # pragma: no cover
    model.load_state_dict(checkpoint["state_dict"])  # pragma: no cover
    model.eval()  # pragma: no cover
    _model = (model, checkpoint)  # pragma: no cover
    return _model  # pragma: no cover


def predict(request: PredictRequest) -> dict:
    model, checkpoint = _load()
    import torch  # pragma: no cover

    readings = [  # pragma: no cover
        Reading(r.recorded_at, r.temperature_c, r.humidity_pct, r.latitude, r.longitude, r.speed_kmh, "gps_jump" in r.quality_flags)
        for r in request.readings
    ]
    sequence = build_sequence(  # pragma: no cover
        readings,
        temp_min_c=request.limits.temp_min_c,
        temp_max_c=request.limits.temp_max_c,
        now=request.now,
        expected_delivery_at=request.trip.expected_delivery_at,
        destination=(request.destination.latitude, request.destination.longitude) if request.destination else None,
    )
    with torch.no_grad():  # pragma: no cover
        probability = float(model(torch.tensor([sequence], dtype=torch.float32))[0])
    level = "high" if probability >= 0.7 else "medium" if probability >= 0.3 else "low"  # pragma: no cover
    return {  # pragma: no cover
        "riskLevel": level,
        "riskProbability": round(probability, 4),
        "riskType": "temperature_excursion" if probability >= 0.3 else None,
        "explanation": f"The CNN-LSTM model estimates a {round(probability * 100)}% probability of a temperature excursion within the horizon.",
        "factors": {},
        "horizonMinutes": checkpoint.get("horizon_minutes", 60),
        "readingsUsed": len(readings),
        "dataUntil": max((r.recorded_at for r in readings), default=None),
        "modelName": "cnn_lstm",
        "modelVersion": checkpoint.get("version", "unversioned"),
    }
