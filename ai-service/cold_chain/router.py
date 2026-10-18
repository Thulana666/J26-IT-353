"""HTTP API for cold-chain risk prediction (Component 2)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from . import inference
from .schemas import PredictRequest

router = APIRouter(prefix="/cold-chain", tags=["cold-chain"])


@router.post("/predict")
def predict(request: PredictRequest) -> dict:
    """Risk prediction with the trained CNN-LSTM. 501 until a model is trained:
    the backend then keeps using its labelled prototype, never a made-up result."""
    try:
        return inference.predict(request)
    except inference.ModelNotTrainedError as error:
        raise HTTPException(status_code=501, detail=str(error)) from error
