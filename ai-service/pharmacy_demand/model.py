"""Pooled ridge linear regression for next-day demand per medicine.

One model for all products of a pharmacy. Each product's figures are divided by
its own average of the previous 28 days ("scale"), so fast and slow movers share
one set of coefficients:

    sold[t] / scale ~ b0 + b1 * sold[t-1]/scale + b2 * sold[t-7]/scale
                      + b3 * mean(sold[t-7..t-1])/scale + day-of-week terms

Every feature uses only days before t (no leakage); current stock is never a
feature. Days that ended out of stock are not targets (their sales were cut
short). Fitted with scikit-learn Ridge (intercept not penalised).

Evaluation is chronological: the last `test_days` days of the training window
are held out, the model is fitted on the days before them, and both the model
and the 28-day moving average (the app's baseline) predict each held-out day one
step ahead. A product uses the regression only where it was more accurate. The
final model is refitted on the whole training window and forecasts the next
`horizon` days of every product, day by day, from the end of its series.
"""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import sklearn
from sklearn.linear_model import Ridge

LOOKBACK = 28
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat"]  # Sunday is the reference day
FEATURES = ["intercept", "lag1", "lag7", "mean7", *DAYS]
# Held-out days a product needs before its own comparison can select the regression.
MIN_SELECT_OBSERVATIONS = 14


def _iso(value: date | str) -> date:
    return value if isinstance(value, date) else date.fromisoformat(value)


def features_at(sold: list[float], t: int, day: date) -> tuple[list[float], float] | None:
    """Features (without the intercept) for day t from sold[t-28..t-1], and the scale."""
    if t < LOOKBACK:
        return None
    scale = float(np.mean(sold[t - LOOKBACK:t]))
    if not scale > 0:
        return None
    weekday = day.weekday()  # Monday = 0 ... Sunday = 6
    x = [sold[t - 1] / scale, sold[t - 7] / scale, float(np.mean(sold[t - 7:t])) / scale]
    x += [1.0 if weekday == i else 0.0 for i in range(len(DAYS))]
    return x, scale


def _stocked(day: dict) -> bool:
    return day["closingOnHand"] is not None


def _observed(day: dict) -> bool:
    return day["closingOnHand"] is not None and day["closingOnHand"] > 0


def series_rows(series_id: str, days: list[dict], train_from: date | None = None, train_to: date | None = None) -> list[dict]:
    """Training rows of one series [{date, sold, closingOnHand}] (one entry per calendar day),
    for target days inside [train_from, train_to]. Earlier days still serve as history."""
    sold = [float(d["sold"]) for d in days]
    rows = []
    for t in range(LOOKBACK, len(days)):
        day = _iso(days[t]["date"])
        if (train_from and day < train_from) or (train_to and day > train_to):
            continue
        if not _observed(days[t]) or not all(_stocked(d) for d in days[t - LOOKBACK:t]):
            continue
        found = features_at(sold, t, day)
        if found is None:
            continue
        x, scale = found
        rows.append({"id": series_id, "date": day, "x": x, "y": sold[t] / scale, "scale": scale, "actual": sold[t]})
    return rows


def _fit(rows: list[dict], penalty: float) -> Ridge:
    X = np.array([r["x"] for r in rows], dtype=float)
    y = np.array([r["y"] for r in rows], dtype=float)
    return Ridge(alpha=penalty, fit_intercept=True, solver="cholesky").fit(X, y)


def _predict_scaled(model: Ridge, x: list[float]) -> float:
    return float(model.intercept_ + np.dot(model.coef_, x))


def _metrics(errors: list[float]) -> dict:
    if not errors:
        return {"mae": None, "rmse": None}
    e = np.array(errors, dtype=float)
    return {"mae": float(np.mean(np.abs(e))), "rmse": float(np.sqrt(np.mean(e * e)))}


def forecast_series(model: Ridge, days: list[dict], horizon: int) -> dict | None:
    """Demand for the `horizon` days after the last day of `days`, each prediction feeding the
    next day's features; never negative. None when the last 28 days were not all stocked or had
    no sales (the backend then uses the moving average)."""
    if len(days) < LOOKBACK or not all(_stocked(d) for d in days[-LOOKBACK:]):
        return None
    sold = [float(d["sold"]) for d in days]
    start = _iso(days[-1]["date"]) + timedelta(days=1)
    values = []
    for h in range(horizon):
        found = features_at(sold, len(sold), start + timedelta(days=h))
        if found is None:
            return None
        x, scale = found
        value = max(0.0, scale * _predict_scaled(model, x))
        values.append(value)
        sold.append(value)
    return {"start": start.isoformat(), "values": values}


def train(series: list[dict], test_days: int = 28, penalty: float = 1.0, horizon: int = 30,
          train_from: date | str | None = None, train_to: date | str | None = None,
          min_train_rows: int = 100, min_test_rows: int = 28) -> dict:
    """Evaluates and trains the model and forecasts every series.

    series: [{id, days: [{date, sold, closingOnHand}]}], each ending on the last recorded day.
    train_from / train_to: the training window (target days); default the whole series.
    Returns {"status": "trained", ...} or {"status": "insufficient_history"} when there is not
    enough data for a meaningful evaluation."""
    start = _iso(train_from) if train_from else None
    end = _iso(train_to) if train_to else None
    rows = [row for s in series for row in series_rows(s["id"], s["days"], start, end)]
    if not rows:
        return {"status": "insufficient_history"}
    last = max(r["date"] for r in rows)
    cut = last - timedelta(days=test_days - 1)
    train_rows = [r for r in rows if r["date"] < cut]
    test_rows = [r for r in rows if r["date"] >= cut]
    if len(train_rows) < min_train_rows or len(test_rows) < min_test_rows:
        return {"status": "insufficient_history"}

    holdout_model = _fit(train_rows, penalty)
    points = [{"id": r["id"], "actual": r["actual"], "model": max(0.0, r["scale"] * _predict_scaled(holdout_model, r["x"])),
               "baseline": r["scale"]} for r in test_rows]
    per_series = {}
    for s in series:
        own = [p for p in points if p["id"] == s["id"]]
        errors = [p["actual"] - p["model"] for p in own]
        lr, ma = _metrics(errors), _metrics([p["actual"] - p["baseline"] for p in own])
        per_series[s["id"]] = {
            "observations": len(own),
            "linearRegression": lr,
            "movingAverage": ma,
            "residualSd": float(np.std(errors, ddof=1)) if len(errors) > 1 else None,
            "selected": len(own) >= MIN_SELECT_OBSERVATIONS and lr["mae"] is not None and lr["mae"] < ma["mae"],
        }

    final = _fit(rows, penalty)
    return {
        "status": "trained",
        "method": "linear_regression",
        "features": FEATURES,
        "coefficients": [float(final.intercept_), *(float(c) for c in final.coef_)],
        "lambda": penalty,
        "lookbackDays": LOOKBACK,
        "rows": len(rows),
        "evaluation": {
            "train": {"observations": len(train_rows), "from": min(r["date"] for r in train_rows).isoformat(),
                      "to": (cut - timedelta(days=1)).isoformat()},
            "test": {"observations": len(test_rows), "from": cut.isoformat(), "to": last.isoformat()},
            "overall": {"linearRegression": _metrics([p["actual"] - p["model"] for p in points]),
                        "movingAverage": _metrics([p["actual"] - p["baseline"] for p in points])},
            "perSeries": per_series,
        },
        "forecasts": {s["id"]: forecast_series(final, s["days"], horizon) for s in series},
        "library": {"scikitLearn": sklearn.__version__, "numpy": np.__version__},
    }
