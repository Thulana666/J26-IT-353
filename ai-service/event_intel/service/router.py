"""HTTP API for Component 1 event intelligence (article classification)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from . import inference
from .schemas import ClassifyRequest

router = APIRouter(prefix="/event-intel", tags=["event-intel"])


@router.post("/classify")
def classify(request: ClassifyRequest) -> dict:
    """Frozen rules result, fine-tuned DistilRoBERTa category (natural_disaster / public_health /
    other) and the hybrid decision for one article. Without a usable model the response is a
    documented rules-only result (model.status = "unavailable"); with requireModel = true it is a
    501 instead, so a model result is never claimed without a loaded model. 422 on invalid input."""
    try:
        return inference.classify(request, require_model=request.require_model)
    except inference.ModelUnavailableError as error:
        raise HTTPException(status_code=501, detail={"reason": error.reason, "message": error.detail}) from error


@router.get("/status")
def status() -> dict:
    """Whether the event model is configured and loads (loading happens on first use)."""
    return inference.status()
