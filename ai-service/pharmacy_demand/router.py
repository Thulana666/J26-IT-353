"""HTTP API for Component 4 pharmacy demand forecasting."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from . import model
from .schemas import TrainRequest

router = APIRouter(prefix="/pharmacy-demand", tags=["pharmacy-demand"])


@router.post("/train")
def train(request: TrainRequest) -> dict:
    """Trains the pooled ridge regression on the daily sales series (training window trainFrom..trainTo),
    evaluates it against the 28-day moving average on the last `testDays` days of that window
    (chronological holdout) and forecasts the next `horizonDays` days of every series. Returns the
    coefficients, MAE/RMSE overall and per series, which method each series should use, and the
    forecasts; or status "insufficient_history". Stateless: the backend stores the result with its
    forecast run. 422 on invalid input."""
    try:
        return model.train(request.series_dicts(), test_days=request.test_days, penalty=request.penalty,
                           horizon=request.horizon_days, train_from=request.train_from, train_to=request.train_to)
    except (ValueError, ArithmeticError) as error:
        raise HTTPException(status_code=422, detail={"reason": "training_failed", "message": str(error)}) from error
