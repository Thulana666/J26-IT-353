"""Tests for cold-chain sequence preprocessing and the not-yet-trained model
endpoint. Run from ai-service/ with the virtual environment:
.venv/Scripts/python -m unittest discover tests
"""

import unittest
from datetime import datetime, timedelta, timezone

from cold_chain.preprocessing import FEATURES, Reading, build_sequence, excursion_label, haversine_km

try:
    from fastapi import HTTPException

    from cold_chain.router import predict
    from cold_chain.schemas import PredictRequest
except ImportError:  # pragma: no cover - the pure preprocessing tests still run
    PredictRequest = None

NOW = datetime(2026, 10, 18, 6, 0, tzinfo=timezone.utc)


def at(minutes_ago, **values):
    return Reading(NOW - timedelta(minutes=minutes_ago), **values)


class BuildSequenceTest(unittest.TestCase):
    def test_shape_and_feature_order(self):
        rows = build_sequence([at(5, temperature_c=5)], temp_min_c=2, temp_max_c=8, now=NOW, steps=10)
        self.assertEqual(len(rows), 10)
        self.assertTrue(all(len(row) == len(FEATURES) for row in rows))

    def test_temperature_is_relative_to_the_limits(self):
        rows = build_sequence([at(1.5, temperature_c=8), at(3.5, temperature_c=2)], temp_min_c=2, temp_max_c=8, now=NOW, steps=4)
        position = FEATURES.index("temperature_pos")
        self.assertAlmostEqual(rows[0][position], 0.0)  # 2 °C = minimum
        self.assertAlmostEqual(rows[-1][position], 1.0)  # 8 °C = maximum

    def test_missing_steps_carry_values_forward_and_are_marked_unobserved(self):
        rows = build_sequence([at(9.5, temperature_c=5, humidity_pct=60)], temp_min_c=2, temp_max_c=8, now=NOW, steps=10)
        observed = FEATURES.index("observed")
        humidity = FEATURES.index("humidity")
        self.assertEqual([row[observed] for row in rows], [1.0] + [0.0] * 9)
        self.assertTrue(all(abs(row[humidity] - 0.6) < 1e-9 for row in rows))

    def test_distance_and_eta_features(self):
        colombo, kandy = (6.9271, 79.8612), (7.2906, 80.6337)
        self.assertAlmostEqual(haversine_km(*colombo, *kandy), 94.3, delta=1.5)
        rows = build_sequence(
            [at(1, temperature_c=5, latitude=colombo[0], longitude=colombo[1])],
            temp_min_c=2, temp_max_c=8, now=NOW, steps=2,
            expected_delivery_at=NOW + timedelta(minutes=60), destination=kandy,
        )
        self.assertAlmostEqual(rows[-1][FEATURES.index("minutes_to_eta")], 0.5)
        self.assertEqual(rows[-1][FEATURES.index("km_to_destination")], 1.0)  # clipped at 50 km

    def test_flagged_gps_jumps_do_not_move_the_position(self):
        rows = build_sequence(
            [at(2, latitude=6.9, longitude=79.8), at(1, latitude=8.0, longitude=81.0, gps_jump=True)],
            temp_min_c=2, temp_max_c=8, now=NOW, steps=2, destination=(6.9, 79.8),
        )
        self.assertEqual(rows[-1][FEATURES.index("gps_jump")], 1.0)
        self.assertEqual(rows[-1][FEATURES.index("km_to_destination")], 0.0)

    def test_invalid_limits_are_rejected(self):
        with self.assertRaises(ValueError):
            build_sequence([], temp_min_c=8, temp_max_c=2, now=NOW)

    def test_excursion_label(self):
        self.assertEqual(excursion_label([at(0, temperature_c=5)], temp_min_c=2, temp_max_c=8), 0)
        self.assertEqual(excursion_label([at(0, temperature_c=8.4)], temp_min_c=2, temp_max_c=8), 1)
        self.assertEqual(excursion_label([at(0, temperature_c=None)], temp_min_c=2, temp_max_c=8), 0)


@unittest.skipIf(PredictRequest is None, "needs fastapi/pydantic")
class PredictEndpointTest(unittest.TestCase):
    def request(self):
        return PredictRequest.model_validate(
            {
                "readings": [{"recordedAt": "2026-10-18T05:59:00Z", "temperatureC": 5.1, "qualityFlags": []}],
                "limits": {"tempMinC": 2, "tempMaxC": 8},
                "trip": {"expectedDeliveryAt": None, "intervalSeconds": 60},
                "now": "2026-10-18T06:00:00Z",
            }
        )

    def test_untrained_model_answers_501_instead_of_a_made_up_prediction(self):
        with self.assertRaises(HTTPException) as caught:
            predict(self.request())
        self.assertEqual(caught.exception.status_code, 501)
        self.assertIn("not been trained", caught.exception.detail)


if __name__ == "__main__":
    unittest.main()
