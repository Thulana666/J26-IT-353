"""Tests for the Component 4 pharmacy demand model (POST /pharmacy-demand/train). Run from
ai-service/ with the virtual environment: .venv/Scripts/python -m unittest discover tests

The series are generated test data, not pharmacy records.
"""

import unittest
from datetime import date, timedelta

try:
    import numpy as np
    from pydantic import ValidationError

    from pharmacy_demand import model
    from pharmacy_demand import router as demand_router
    from pharmacy_demand.schemas import TrainRequest
except ImportError:  # pragma: no cover - needs numpy, scikit-learn and fastapi
    model = None

START = date(2026, 1, 4)  # a Sunday


def weekly_series(series_id, length, base=20.0, closing=lambda i: 100, seed=1):
    """A fixed weekly pattern with deterministic noise."""
    pattern = [0.6, 1.2, 1.1, 1.0, 1.0, 1.3, 0.9]
    state = seed
    days = []
    for i in range(length):
        state = (state * 1664525 + 1013904223) % 4294967296
        noise = 0.7 + 0.6 * state / 4294967296
        days.append({"date": START + timedelta(days=i), "sold": round(base * pattern[i % 7] * noise), "closingOnHand": closing(i)})
    return {"id": series_id, "days": days}


@unittest.skipIf(model is None, "numpy, scikit-learn and fastapi are required")
class ModelTest(unittest.TestCase):
    def test_scikit_learn_matches_the_closed_form_ridge_solution(self):
        """Independent check: (X'X + lambda*D) b = X'y with an unpenalised intercept."""
        series = [weekly_series("a", 200), weekly_series("b", 200, base=6, seed=2)]
        rows = [r for s in series for r in model.series_rows(s["id"], s["days"])]
        X = np.array([[1.0, *r["x"]] for r in rows])
        y = np.array([r["y"] for r in rows])
        D = np.eye(X.shape[1])
        D[0, 0] = 0.0
        expected = np.linalg.solve(X.T @ X + 1.0 * D, X.T @ y)
        result = model.train(series, penalty=1.0)
        np.testing.assert_allclose(result["coefficients"], expected, rtol=1e-9, atol=1e-9)

    def test_features_for_day_t_use_only_earlier_days(self):
        s = weekly_series("a", 60)
        sold = [d["sold"] for d in s["days"]]
        before = model.features_at(sold, 40, s["days"][40]["date"])
        changed = [v if i < 40 else v * 50 + 999 for i, v in enumerate(sold)]
        self.assertEqual(model.features_at(changed, 40, s["days"][40]["date"]), before)
        self.assertIsNone(model.features_at(sold, 27, s["days"][27]["date"]))

    def test_days_that_ended_out_of_stock_are_not_targets(self):
        s = weekly_series("a", 60, closing=lambda i: 0 if i == 45 else 100)
        dates = {r["date"] for r in model.series_rows("a", s["days"])}
        self.assertNotIn(s["days"][45]["date"], dates)
        self.assertIn(s["days"][44]["date"], dates)

    def test_holdout_is_chronological_and_the_regression_beats_the_baseline_on_a_weekly_pattern(self):
        result = model.train([weekly_series("a", 200), weekly_series("b", 200, base=6, seed=2)])
        ev = result["evaluation"]
        self.assertLess(ev["train"]["to"], ev["test"]["from"])
        self.assertEqual(len(result["coefficients"]), len(model.FEATURES))
        self.assertLess(ev["overall"]["linearRegression"]["mae"], ev["overall"]["movingAverage"]["mae"])
        self.assertTrue(all(isinstance(s["selected"], bool) for s in ev["perSeries"].values()))
        self.assertIn("scikitLearn", result["library"])

    def test_the_training_window_excludes_later_days_but_forecasts_start_after_the_series(self):
        s = weekly_series("a", 240)
        window_end = s["days"][199]["date"]
        result = model.train([s], train_to=window_end)
        self.assertEqual(result["evaluation"]["test"]["to"], window_end.isoformat())
        forecast = result["forecasts"]["a"]
        self.assertEqual(forecast["start"], (s["days"][-1]["date"] + timedelta(days=1)).isoformat())

    def test_forecasts_cover_the_horizon_and_are_never_negative(self):
        result = model.train([weekly_series("a", 200)], horizon=30)
        values = result["forecasts"]["a"]["values"]
        self.assertEqual(len(values), 30)
        self.assertTrue(all(v >= 0 and np.isfinite(v) for v in values))

    def test_no_forecast_without_28_recent_stocked_days(self):
        s = weekly_series("a", 200)
        short = {"id": "short", "days": s["days"][-20:]}
        unstocked = weekly_series("late", 200, closing=lambda i: None if i > 190 else 50)
        result = model.train([s, short, unstocked])
        self.assertIsNotNone(result["forecasts"]["a"])
        self.assertIsNone(result["forecasts"]["short"])
        self.assertIsNone(result["forecasts"]["late"])

    def test_too_little_history_is_reported_not_evaluated(self):
        self.assertEqual(model.train([weekly_series("a", 40)])["status"], "insufficient_history")


@unittest.skipIf(model is None, "numpy, scikit-learn and fastapi are required")
class ApiTest(unittest.TestCase):
    def payload(self, **extra):
        series = (weekly_series("a", 200), weekly_series("b", 200, base=6, seed=2))
        return {"series": [{"id": s["id"], "days": [{**d, "date": d["date"].isoformat()} for d in s["days"]]} for s in series],
                "testDays": 28, "lambda": 1, "horizonDays": 30, **extra}

    def test_train_endpoint_accepts_the_backend_payload(self):
        result = demand_router.train(TrainRequest.model_validate(self.payload(trainFrom="2026-01-04", trainTo="2026-07-01")))
        self.assertEqual(result["status"], "trained")
        self.assertEqual(set(result["forecasts"]), {"a", "b"})

    def test_invalid_input_is_rejected(self):
        with self.assertRaises(ValidationError):
            TrainRequest.model_validate({"series": [{"id": "a", "days": [{"date": "2026-01-01", "sold": -1}]}]})
        with self.assertRaises(ValidationError):
            TrainRequest.model_validate({"series": []})
        with self.assertRaises(ValidationError):
            TrainRequest.model_validate(self.payload(**{"lambda": -5}))
        with self.assertRaises(ValidationError):
            TrainRequest.model_validate(self.payload(trainFrom="2026-05-01", trainTo="2026-04-01"))


if __name__ == "__main__":
    unittest.main()
