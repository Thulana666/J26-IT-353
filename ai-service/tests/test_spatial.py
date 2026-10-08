"""Tests for warehouse spatial allocation. Run from ai-service/:
python -m unittest discover tests
"""

import unittest
from dataclasses import replace
from datetime import date, timedelta

from warehouse import spatial
from warehouse.spatial import BatchInput, LocationInput, Thresholds

TODAY = date(2026, 10, 7)


def batch(days_to_expiry=200, **overrides):
    values = dict(quantity=20, expiry_date=TODAY + timedelta(days=days_to_expiry), storage_condition="ambient")
    values.update(overrides)
    return BatchInput(**values)


def location(code, **overrides):
    values = dict(
        id=code, code=code, zone_type="storage", storage_condition="ambient",
        capacity_units=100, occupied_units=0, accessibility="medium", distance_to_dispatch_m=20,
    )
    values.update(overrides)
    return LocationInput(**values)


def ranked_codes(result):
    return [c.location.code for c in result.ranked]


def rejection_codes(result, code):
    return {c for r in result.rejected if r.location.code == code for c, _ in r.violations}


class HardConstraintTests(unittest.TestCase):
    def test_storage_condition_must_match(self):
        result = spatial.recommend(
            batch(storage_condition="refrigerated"),
            [location("AMB"), location("COLD", storage_condition="refrigerated")],
            TODAY,
        )
        self.assertEqual(ranked_codes(result), ["COLD"])
        self.assertEqual(rejection_codes(result, "AMB"), {"storage_condition"})

    def test_controlled_medicine_needs_secure_zone(self):
        result = spatial.recommend(
            batch(is_controlled=True), [location("OPEN"), location("SAFE", is_secure=True)], TODAY
        )
        self.assertEqual(ranked_codes(result), ["SAFE"])
        self.assertEqual(rejection_codes(result, "OPEN"), {"security"})

    def test_capacity_and_inactive_locations(self):
        result = spatial.recommend(
            batch(quantity=50),
            [location("SMALL", occupied_units=60), location("OFF", is_active=False), location("OK")],
            TODAY,
        )
        self.assertEqual(ranked_codes(result), ["OK"])
        self.assertEqual(rejection_codes(result, "SMALL"), {"capacity"})
        self.assertEqual(rejection_codes(result, "OFF"), {"inactive"})

    def test_quarantine_zone_rules(self):
        locations = [location("STORE"), location("QUAR", zone_type="quarantine")]
        self.assertEqual(ranked_codes(spatial.recommend(batch(), locations, TODAY)), ["STORE"])
        for blocked in (batch(status="quarantined"), batch(status="recalled"), batch(days_to_expiry=-1)):
            result = spatial.recommend(blocked, locations, TODAY)
            self.assertTrue(result.requires_quarantine)
            self.assertEqual(ranked_codes(result), ["QUAR"])

    def test_no_feasible_location_explains_why(self):
        result = spatial.recommend(batch(quantity=150), [location("A"), location("B", occupied_units=10)], TODAY)
        self.assertEqual(result.ranked, [])
        self.assertIn("Split the batch", result.message)
        self.assertIn("largest has 100 free", result.message)

        result = spatial.recommend(batch(storage_condition="frozen"), [location("A")], TODAY)
        self.assertIn("No compatible location", result.message)


class ScoringTests(unittest.TestCase):
    # Same rack position and space; only accessibility/distance differ.
    PRIME = dict(accessibility="high", distance_to_dispatch_m=5)
    DEEP = dict(accessibility="low", distance_to_dispatch_m=40)

    def test_short_dated_stock_goes_to_accessible_locations(self):
        result = spatial.recommend(
            batch(days_to_expiry=20), [location("DEEP", **self.DEEP), location("PRIME", **self.PRIME)], TODAY
        )
        self.assertEqual(ranked_codes(result), ["PRIME", "DEEP"])
        self.assertEqual(result.expiry_status, "critical")
        self.assertEqual(result.urgency, 1.0)

    def test_long_dated_stock_goes_deeper(self):
        result = spatial.recommend(
            batch(days_to_expiry=700), [location("PRIME", **self.PRIME), location("DEEP", **self.DEEP)], TODAY
        )
        self.assertEqual(ranked_codes(result), ["DEEP", "PRIME"])
        self.assertEqual(result.urgency, 0.0)

    def test_best_fit_prefers_locations_the_batch_fills(self):
        result = spatial.recommend(
            batch(quantity=40), [location("BIG", capacity_units=400), location("SNUG", capacity_units=50)], TODAY
        )
        self.assertEqual(ranked_codes(result)[0], "SNUG")
        snug = result.ranked[0]
        self.assertAlmostEqual(snug.factors["capacity_fit"], 0.8)

    def test_consolidation_avoids_mixing_medicines(self):
        result = spatial.recommend(
            batch(),
            [
                location("MIXED", other_medicine_units=30, occupied_units=30),
                location("SAME-RACK", same_medicine_in_rack=True),
                location("SAME-BATCH", same_batch_units=30, same_medicine_units=30, occupied_units=30),
            ],
            TODAY,
            weights={"expiry_accessibility": 0, "capacity_fit": 0, "consolidation": 1, "zone_efficiency": 0},
        )
        self.assertEqual(ranked_codes(result), ["SAME-BATCH", "SAME-RACK", "MIXED"])

    def test_secure_space_is_kept_for_controlled_medicines(self):
        result = spatial.recommend(batch(), [location("SECURE", is_secure=True), location("NORMAL")], TODAY)
        self.assertEqual(ranked_codes(result), ["NORMAL", "SECURE"])
        self.assertEqual(result.ranked[1].factors["zone_efficiency"], 0.0)
        # A secure quarantine area is not penalised.
        quarantined = spatial.recommend(
            batch(status="recalled"), [location("Q", zone_type="quarantine", is_secure=True)], TODAY
        )
        self.assertEqual(quarantined.ranked[0].factors["zone_efficiency"], 1.0)

    def test_scores_are_bounded_and_explained(self):
        result = spatial.recommend(batch(), [location(f"L{i}", occupied_units=i * 10) for i in range(8)], TODAY)
        for candidate in result.ranked:
            self.assertGreaterEqual(candidate.score, 0)
            self.assertLessEqual(candidate.score, 100)
            self.assertTrue(all(0 <= v <= 1 for v in candidate.factors.values()))
            self.assertGreaterEqual(len(candidate.reasons), 3)
        self.assertEqual([c.rank for c in result.ranked], list(range(1, 9)))

    def test_ties_go_to_the_location_nearer_dispatch(self):
        far = location("FAR", distance_to_dispatch_m=30)
        result = spatial.recommend(batch(), [far, replace(far, id="NEAR", code="NEAR", distance_to_dispatch_m=30)], TODAY)
        self.assertEqual(ranked_codes(result), ["FAR", "NEAR"])  # equal: code order
        near = replace(far, id="NEAR", code="NEAR", distance_to_dispatch_m=29.999)
        self.assertEqual(spatial.recommend(batch(), [far, near], TODAY).ranked[0].location.code, "NEAR")


class HelperTests(unittest.TestCase):
    def test_expiry_status_matches_backend_rules(self):
        t = Thresholds(near_expiry_days=90, critical_expiry_days=30)
        self.assertEqual(spatial.expiry_status(-1, t), "expired")
        self.assertEqual(spatial.expiry_status(0, t), "critical")
        self.assertEqual(spatial.expiry_status(30, t), "critical")
        self.assertEqual(spatial.expiry_status(31, t), "near_expiry")
        self.assertEqual(spatial.expiry_status(90, t), "near_expiry")
        self.assertEqual(spatial.expiry_status(91, t), "ok")

    def test_urgency_falls_linearly(self):
        t = Thresholds()
        self.assertEqual(spatial.urgency(10, t), 1.0)
        self.assertEqual(spatial.urgency(365, t), 0.0)
        self.assertAlmostEqual(spatial.urgency(197.5, t), 0.5)
        self.assertGreater(spatial.urgency(100, t), spatial.urgency(200, t))

    def test_weights_are_validated_and_normalised(self):
        weights = spatial.normalize_weights({"expiry_accessibility": 2, "capacity_fit": 1, "consolidation": 1, "zone_efficiency": 0})
        self.assertAlmostEqual(sum(weights.values()), 1.0)
        self.assertAlmostEqual(weights["expiry_accessibility"], 0.5)
        with self.assertRaises(ValueError):
            spatial.normalize_weights({"speed": 1})
        with self.assertRaises(ValueError):
            spatial.normalize_weights({"capacity_fit": -1})
        with self.assertRaises(ValueError):
            spatial.normalize_weights(dict.fromkeys(spatial.DEFAULT_WEIGHTS, 0))


if __name__ == "__main__":
    unittest.main()
