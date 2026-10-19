"""Tests for the isolated research experiment module (event_intel.experiments).
All examples are synthetic fixtures, not research labels. Run from ai-service/:
python -m unittest discover tests
"""

import os
import random
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from event_intel.experiments import data as D
from event_intel.experiments import models as M
from event_intel.experiments import run as R
from event_intel.experiments.hybrid import decide, select_threshold
from event_intel.experiments.metrics import bootstrap, confusion, macro_f1, report
from event_intel.experiments.models import MissingDependency, NaiveBayes, Transformer, environment

PROSE = " Officials reported the situation in detail and teams continued work across the affected districts." * 8


def record(rid, title, content, source="ReliefWeb (UN OCHA)", url=None):
    return {"id": rid, "title": title, "content": content, "summary": None, "url": url or f"https://example.org/{rid}",
            "language": "en", "country_code": "LK", "published_at": "2026-10-01", "source": {"name": source, "source_type": "api"}}


def ex(rid, split, status="confirmed_human", category="natural_disaster", relevance="yes", group=None,
       excluded="", ts="yes", text=None, rec=None):
    rec = rec or record(rid, f"Title {rid}", (text or f"unique text {rid}") + PROSE.replace("Officials", f"Officials{rid}"))
    return D.Example(rid, split, group or f"g_{rid}", status, excluded, ts, category, relevance,
                     D.model_text(rec), rec)


class FilteringTests(unittest.TestCase):
    def setUp(self):
        self.rows = [
            ex("a", "train"), ex("b", "train", status="proposed_high"), ex("c", "train", status="proposed_medium"),
            ex("d", "train", status="manual_review"), ex("e", "train", excluded="duplicate"),
            ex("f", "train", ts="no"), ex("g", "train", category="pharma_supply"), ex("h", "test"),
            ex("i", "train", relevance="cannot_tell"),
        ]

    def test_tiers_admit_only_their_label_statuses(self):
        ids = lambda tier: {e.article_id for e in D.eligible(self.rows, tier, "train")}
        self.assertEqual(ids("confirmed"), {"a", "i"})
        self.assertEqual(ids("confirmed_high"), {"a", "b", "i"})
        self.assertEqual(ids("confirmed_high_medium"), {"a", "b", "c", "i"})

    def test_excluded_unsupported_and_other_splits_are_never_used(self):
        ids = {e.article_id for e in D.eligible(self.rows, "confirmed_high_medium", "train")}
        self.assertTrue(ids.isdisjoint({"d", "e", "f", "g", "h"}))

    def test_cannot_tell_is_excluded_from_relevance_only(self):
        self.assertNotIn("i", {e.article_id for e in D.eligible(self.rows, "confirmed", "train", "relevance")})
        self.assertIn("i", {e.article_id for e in D.eligible(self.rows, "confirmed", "train", "category")})

    def test_label_provenance_is_kept(self):
        kinds = {e.article_id: e.label_kind for e in self.rows}
        self.assertEqual(kinds["a"], D.HUMAN)
        self.assertEqual(kinds["b"], D.SILVER)
        self.assertEqual(kinds["d"], "none")


class AcceptedTierTests(unittest.TestCase):
    def test_only_accepted_proposals_and_human_labels_enter_the_accepted_tier(self):
        rows = [ex("h", "train"), ex("a", "train", status="proposed_high"), ex("m", "train", status="proposed_medium"),
                ex("r", "train", status="manual_review")]
        rows = [r if r.article_id != "a" else D.Example(**{**r.__dict__, "accepted": True}) for r in rows]
        ids = {e.article_id for e in D.eligible(rows, "accepted", "train")}
        self.assertEqual(ids, {"h", "a"})  # m not accepted, r manual review
        kinds = {e.article_id: e.label_kind for e in rows}
        self.assertEqual((kinds["h"], kinds["a"], kinds["m"]), (D.HUMAN, D.ACCEPTED, D.SILVER))

    def test_accepted_ids_reads_only_accept_decisions(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "accepted.csv"
            path.write_text("article_id,human_decision\nx,accept\ny,\nz,reject\n", encoding="utf-8")
            self.assertEqual(D.accepted_ids(path), {"x"})
            self.assertEqual(D.accepted_ids(Path(tmp) / "missing.csv"), set())


class LeakageTests(unittest.TestCase):
    def test_shared_group_is_rejected(self):
        with self.assertRaises(D.LeakageError):
            D.assert_disjoint([ex("a", "train", group="g1")], [ex("b", "test", group="g1")])

    def test_identical_text_in_different_groups_is_rejected(self):
        rec1, rec2 = record("a", "x", "Same flood text." + PROSE), record("b", "y", "same FLOOD text" + PROSE)
        with self.assertRaises(D.LeakageError):
            D.assert_disjoint([ex("a", "train", rec=rec1)], [ex("b", "test", rec=rec2)])

    def test_audit_raises_on_cross_split_groups(self):
        with self.assertRaises(D.LeakageError):
            D.audit([ex("a", "train", group="g1"), ex("b", "validation", group="g1")])

    def test_clean_split_passes(self):
        report_ = D.audit([ex("a", "train"), ex("b", "validation"), ex("c", "test")])
        self.assertEqual(report_["groups_crossing_splits"], 0)


class NaiveBayesTests(unittest.TestCase):
    def test_learns_separable_classes_and_is_deterministic(self):
        texts = ["flood rain river overflow"] * 3 + ["dengue cases outbreak hospital"] * 3
        labels = ["natural_disaster"] * 3 + ["public_health"] * 3
        a = NaiveBayes(0.5).fit(texts, labels).predict_proba(["heavy flood and river overflow"])
        b = NaiveBayes(0.5).fit(texts, labels).predict_proba(["heavy flood and river overflow"])
        self.assertEqual(a, b)
        self.assertEqual(max(a[0], key=a[0].get), "natural_disaster")
        self.assertAlmostEqual(sum(a[0].values()), 1.0)


class HybridTests(unittest.TestCase):
    full = record("f", "Floods in Ratnapura District", "Heavy rain caused floods and landslides; families displaced." + PROSE)

    def test_insufficient_text_uses_rules(self):
        meta = record("m", "Situation map", "Format: Map\nThemes: Health\nAttachment: https://example.org/x.pdf")
        d = decide(meta, {"public_health": 0.99, "other": 0.01, "natural_disaster": 0.0}, 0.5)
        self.assertEqual(d.method, "rules_insufficient_text")
        self.assertTrue(d.needs_review)

    def test_structured_alert_uses_rules(self):
        gdacs = record("g", "Flood in Sri Lanka - Green alert", "Event type: Flood\nAlert level: Green\nAffected countries: Sri Lanka",
                       source="GDACS (Global Disaster Alert and Coordination System)")
        d = decide(gdacs, {"other": 0.99, "natural_disaster": 0.01, "public_health": 0.0}, 0.5)
        self.assertEqual((d.method, d.category), ("rules_structured_alert", "natural_disaster"))

    def test_unsupported_rules_category_is_kept_for_review(self):
        shortage = record("s", "Medicine shortage in Sri Lankan hospitals",
                          "Hospitals report a shortage of essential medicines and drug shortages of insulin; pharmaceutical supply is disrupted." + PROSE)
        d = decide(shortage, {"other": 0.9, "natural_disaster": 0.05, "public_health": 0.05}, 0.5)
        self.assertEqual(d.method, "rules_unsupported_category")
        self.assertEqual(d.category, "pharma_supply")
        self.assertTrue(d.needs_review)

    def test_confident_model_wins_and_low_confidence_falls_back(self):
        hi = decide(self.full, {"public_health": 0.9, "natural_disaster": 0.05, "other": 0.05}, 0.7)
        self.assertEqual((hi.method, hi.category, hi.needs_review), ("model", "public_health", False))
        lo = decide(self.full, {"public_health": 0.5, "natural_disaster": 0.3, "other": 0.2}, 0.7)
        self.assertEqual((lo.method, lo.category, lo.needs_review), ("rules_fallback", "natural_disaster", True))
        self.assertEqual(lo.model_category, "public_health")

    def test_no_model_uses_rules(self):
        self.assertEqual(decide(self.full, None, 0.5).method, "rules_only_no_model")

    def test_threshold_selection_prefers_lowest_tie_and_uses_given_data_only(self):
        probs = [{"public_health": 0.6, "natural_disaster": 0.3, "other": 0.1}]
        best, results = select_threshold([self.full], probs, ["natural_disaster"], macro_f1(list(D.SUPPORTED_CATEGORIES)),
                                         grid=(0.0, 0.5, 0.7, 0.9))
        self.assertEqual(best, 0.7)  # model wrong (0.6 < 0.7 falls back to correct rules); 0.7 ties 0.9
        self.assertEqual(set(results), {0.0, 0.5, 0.7, 0.9})


class MetricsTests(unittest.TestCase):
    def test_unsupported_predictions_count_as_errors(self):
        r = report(["other", "natural_disaster"], ["pharma_supply", "natural_disaster"], list(D.SUPPORTED_CATEGORIES))
        self.assertEqual(r["accuracy"], 0.5)
        self.assertEqual(r["per_class"]["other"]["recall"], 0.0)
        self.assertIn("pharma_supply", r["confusion"]["labels"])

    def test_confusion_counts(self):
        c = confusion(["a", "a", "b"], ["a", "b", "b"])
        self.assertEqual(c, {"labels": ["a", "b"], "matrix": [[1, 1], [0, 1]]})

    def test_bootstrap_is_seeded_and_paired(self):
        g = ["a", "b"] * 10
        systems = {"rules": ["a"] * 20, "model": g}
        one = bootstrap(g, systems, lambda x, y: sum(p == q for p, q in zip(x, y)) / len(x), n=200)
        two = bootstrap(g, systems, lambda x, y: sum(p == q for p, q in zip(x, y)) / len(x), n=200)
        self.assertEqual(one, two)
        low, high = one["paired_difference_vs_rules"]["model"]
        self.assertGreater(low, 0)


class TransformerGuardTests(unittest.TestCase):
    def test_missing_dependencies_raise_a_clear_error(self):
        if environment()["transformer_ready"]:
            self.skipTest("transformer stack installed")
        with self.assertRaises(MissingDependency):
            Transformer()


class TransformerSafetyTests(unittest.TestCase):
    def test_revision_is_pinned_and_loading_is_offline(self):
        self.assertEqual(M.TRANSFORMER_REVISION, "fb53ab8802853c8e4fbdbcd0529f21fc6f459b2b")
        self.assertEqual(M.load_kwargs(), {"revision": M.TRANSFORMER_REVISION, "local_files_only": True})

    def test_pinned_snapshot_detection_uses_the_hub_cache(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"HF_HUB_CACHE": tmp}):
            snap = M.pinned_snapshot()
            self.assertEqual(snap, Path(tmp) / "models--distilbert--distilroberta-base" / "snapshots" / M.TRANSFORMER_REVISION)
            self.assertFalse(M.environment()["transformer_weights_cached"])
            snap.mkdir(parents=True)
            for name in M.REQUIRED_FILES:
                (snap / name).write_text("x")
            self.assertTrue(M.environment()["transformer_weights_cached"])

    def test_laptop_safe_defaults(self):
        d = M.SAFE_DEFAULTS
        self.assertEqual((d["threads"], d["batch_size"], d["max_length"]), (4, 2, 256))
        self.assertGreaterEqual(d["grad_accum_steps"], 1)
        self.assertGreater(d["max_grad_norm"], 0)
        self.assertTrue(0 < d["warmup_ratio"] < 0.5)

    def test_unknown_settings_are_rejected(self):
        with self.assertRaises(ValueError):
            Transformer(seed=1, use_gpu=True)

    def test_ram_guard(self):
        with mock.patch.object(M, "free_ram_gb", return_value=2.0):
            with self.assertRaises(M.InsufficientResources):
                M.check_resources()
        with mock.patch.object(M, "free_ram_gb", return_value=None):
            with self.assertRaises(M.InsufficientResources):
                M.check_resources()
        with mock.patch.object(M, "free_ram_gb", return_value=5.0):
            self.assertEqual(M.check_resources(), 5.0)

    def test_free_ram_reading_is_plausible(self):
        free = M.free_ram_gb()
        self.assertTrue(free is None or 0 < free < 1024)

    def test_preflight_blocks_without_stack_or_ram(self):
        self.assertEqual(R.preflight("nb", 1), 0)
        if not environment()["transformer_ready"]:
            self.assertEqual(R.preflight("transformer", 1), 2)
        else:
            with mock.patch.object(R, "check_resources", side_effect=M.InsufficientResources("low RAM")):
                self.assertEqual(R.preflight("transformer", 1), 3)


class SeedTests(unittest.TestCase):
    def test_set_seed_is_reproducible(self):
        M.set_seed(7)
        a = [random.random() for _ in range(3)]
        M.set_seed(7)
        self.assertEqual(a, [random.random() for _ in range(3)])
        M.set_seed(8)
        self.assertNotEqual(a, [random.random() for _ in range(3)])

    def test_seed_is_in_the_run_id(self):
        self.assertIn("_seed13_", R.run_id_for("transformer", "confirmed_high", "category", 13))

    def test_seed_does_not_change_the_split(self):
        rows = [ex("a", "train"), ex("b", "validation"), ex("c", "test")]
        M.set_seed(1)
        first = [e.article_id for e in D.eligible(rows, "confirmed", "test")]
        M.set_seed(99)
        self.assertEqual(first, [e.article_id for e in D.eligible(rows, "confirmed", "test")])


@unittest.skipUnless(environment()["transformer_ready"], "transformer stack or pinned weights not available")
class OfflineLoadTests(unittest.TestCase):
    def test_pinned_model_loads_offline_on_cpu_with_trainable_head_and_encoder(self):
        model = Transformer(seed=1)
        with mock.patch.dict(os.environ, {"HF_HUB_OFFLINE": "1"}):
            model.load(num_labels=3)
        self.assertEqual(next(model.model.parameters()).device.type, "cpu")
        self.assertTrue(all(p.requires_grad for p in model.model.classifier.parameters()))
        self.assertTrue(all(p.requires_grad for p in model.model.roberta.encoder.parameters()))
        model.classes = ["natural_disaster", "other", "public_health"]
        probs = model.predict_proba(["Floods displaced families in Ratnapura District."])
        self.assertAlmostEqual(sum(probs[0].values()), 1.0, places=4)
        import torch
        self.assertEqual(torch.get_num_threads(), 4)

    @unittest.skipUnless(os.environ.get("EVENT_INTEL_HEAVY_TESTS") == "1", "writes a ~330 MB checkpoint; set EVENT_INTEL_HEAVY_TESTS=1")
    def test_checkpoint_round_trip_gives_identical_predictions(self):
        model = Transformer(seed=1)
        with mock.patch.dict(os.environ, {"HF_HUB_OFFLINE": "1"}):
            model.load(num_labels=3)
        model.classes = ["natural_disaster", "other", "public_health"]
        with tempfile.TemporaryDirectory() as tmp:
            info = model.save_checkpoint(Path(tmp) / "ckpt")
            self.assertGreater(info["megabytes"], 100)
            with self.assertRaises(FileExistsError):
                model.save_checkpoint(Path(tmp) / "ckpt")
            check = R.verify_checkpoint(model, Path(tmp) / "ckpt", ["Floods in Ratnapura.", "Dengue cases rise in Colombo."])
            self.assertTrue(check["passed"], check)


if __name__ == "__main__":
    unittest.main()
