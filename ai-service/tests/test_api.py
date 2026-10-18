"""API-level tests of the spatial service: request validation and the
response contract the Node.js backend relies on. Run from ai-service/ with the
virtual environment (needs pydantic/fastapi):
.venv/Scripts/python -m unittest discover tests
"""

import unittest

try:
    from pydantic import ValidationError

    from warehouse.router import recommend
    from warehouse.schemas import RecommendRequest
except ImportError:  # pragma: no cover - tests of the pure logic still run
    RecommendRequest = None


def request(**overrides):
    body = {
        "today": "2026-10-07",
        "thresholds": {"nearExpiryDays": 90, "criticalExpiryDays": 30},
        "batch": {"quantity": 20, "expiryDate": "2026-10-27", "storageCondition": "ambient"},
        "locations": [
            {"id": "near", "code": "A01-1", "zoneType": "storage", "storageCondition": "ambient",
             "capacityUnits": 100, "occupiedUnits": 0, "accessibility": "high", "distanceToDispatchM": 5},
            {"id": "far", "code": "A09-1", "zoneType": "storage", "storageCondition": "ambient",
             "capacityUnits": 100, "occupiedUnits": 0, "accessibility": "low", "distanceToDispatchM": 40},
            {"id": "cold", "code": "R01-1", "zoneType": "storage", "storageCondition": "refrigerated",
             "capacityUnits": 100, "occupiedUnits": 0},
        ],
        "limit": 5,
    }
    body.update(overrides)
    return body


@unittest.skipIf(RecommendRequest is None, "pydantic/fastapi not installed")
class ApiTests(unittest.TestCase):
    def test_response_contract(self):
        result = recommend(RecommendRequest.model_validate(request())).model_dump(by_alias=True)
        self.assertEqual(result["recommended"]["code"], "A01-1")
        self.assertEqual([a["code"] for a in result["alternatives"]], ["A09-1"])
        self.assertEqual(result["summary"], {"candidates": 3, "feasible": 2, "rejectedByReason": {"storage_condition": 1}})
        self.assertEqual(result["assessment"]["expiryStatus"], "critical")
        self.assertEqual(set(result["recommended"]["factors"]), {"expiryAccessibility", "capacityFit", "consolidation", "zoneEfficiency"})
        self.assertEqual(result["algorithm"]["name"], "weighted-multi-criteria")
        self.assertIsNone(result["message"])

    def test_invalid_requests_are_rejected_by_validation(self):
        bad = [
            request(batch={"quantity": 0, "expiryDate": "2026-10-27", "storageCondition": "ambient"}),
            request(batch={"quantity": 1, "expiryDate": "not a date", "storageCondition": "ambient"}),
            request(batch={"quantity": 1, "expiryDate": "2026-10-27", "storageCondition": "warm"}),
            request(thresholds={"nearExpiryDays": 30, "criticalExpiryDays": 30}),
            request(weights={"expiryAccessibility": 0, "capacityFit": 0, "consolidation": 0, "zoneEfficiency": 0}),
            request(weights={"expiryAccessibility": -1}),
            request(limit=0),
        ]
        for body in bad:
            with self.assertRaises(ValidationError):
                RecommendRequest.model_validate(body)

    def test_no_feasible_location_returns_an_explanation(self):
        body = request(batch={"quantity": 500, "expiryDate": "2027-10-27", "storageCondition": "ambient"})
        result = recommend(RecommendRequest.model_validate(body)).model_dump(by_alias=True)
        self.assertIsNone(result["recommended"])
        self.assertIn("Split the batch", result["message"])


if __name__ == "__main__":
    unittest.main()
