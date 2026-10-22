"""HTTP API for cold-chain risk prediction (Component 2)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from . import inference
from .schemas import PredictRequest

router = APIRouter(prefix="/cold-chain", tags=["cold-chain"])


@router.post("/predict")
def predict(request: PredictRequest) -> dict:
    """Temperature-excursion, delivery-delay and overall risk from the installed
    trained models (inference.py). 501 while no model is installed: the backend
    then keeps using its labelled prototype, never a made-up result. 422 when
    no risk can be estimated yet (e.g. the trip just started)."""
    try:
        return inference.predict(request)
    except inference.ModelNotTrainedError as error:
        raise HTTPException(status_code=501, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
