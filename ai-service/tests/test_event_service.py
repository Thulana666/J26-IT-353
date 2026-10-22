"""Tests for the event-intelligence API (POST /event-intel/classify). Run from ai-service/ with the
virtual environment: .venv/Scripts/python -m unittest discover tests

Routine tests use a fake checkpoint folder and a mocked model; the real 317 MB checkpoint is loaded
only by the optional test at the end (EVENT_INTEL_HEAVY_TESTS=1 and EVENT_INTEL_MODEL_DIR set).
The articles are synthetic fixtures, not research data.
"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

try:
    from fastapi import HTTPException
    from pydantic import ValidationError

    from event_intel.experiments.models import TRANSFORMER_ID, TRANSFORMER_REVISION
    from event_intel.service import inference
    from event_intel.service import router as service_router
    from event_intel.service.schemas import MAX_CONTENT_CHARS, MAX_TITLE_CHARS, ClassifyRequest
except ImportError:  # pragma: no cover - pure-logic tests elsewhere still run
    ClassifyRequest = None

CLASSES = ["natural_disaster", "other", "public_health"]
FLOOD = {"articleId": "a1", "title": "Floods in Ratnapura District displace families",
         "content": "Heavy rain caused floods and landslides in Ratnapura District; hundreds of families were displaced "
                    "and relief teams distributed supplies. " * 6,
         "sourceName": "ReliefWeb (UN OCHA)", "sourceType": "api", "language": "en", "countryCode": "LK"}


class FakeModel:
    def __init__(self, probs=None):
        self.classes = list(CLASSES)
        self.probs = probs or {"natural_disaster": 0.9, "other": 0.07, "public_health": 0.03}
        self.calls = 0

    def predict_proba(self, texts):
        self.calls += 1
        return [dict(self.probs) for _ in texts]


def make_checkpoint(root: Path, classes=CLASSES, revision=TRANSFORMER_REVISION if ClassifyRequest else "", threshold=0.0,
                    drop=None, labels=3):
    ckpt = root / "run" / "checkpoint_category"
    ckpt.mkdir(parents=True)
    (ckpt / "model.safetensors").write_bytes(b"fake weights")
    (ckpt / "tokenizer.json").write_text("{}")
    (ckpt / "tokenizer_config.json").write_text("{}")
    (ckpt / "config.json").write_text(json.dumps({"id2label": {str(i): f"LABEL_{i}" for i in range(labels)}}))
    (ckpt / "classifier_meta.json").write_text(json.dumps({
        "classes": classes, "class_type": "str", "base_model": TRANSFORMER_ID, "base_revision": revision,
        "seed": 13, "settings": {"max_length": 256}, "best_epoch": 4}))
    (root / "run" / "run.json").write_text(json.dumps({"run_id": "test_run", "category": {"hybrid_threshold": threshold}}))
    if drop:
        (ckpt / drop).unlink()
    return ckpt


@unittest.skipIf(ClassifyRequest is None, "fastapi/pydantic not installed")
class EventServiceTests(unittest.TestCase):
    def setUp(self):
        inference.reset()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {}, clear=False)
        self.env.start()
        for key in (inference.MODEL_DIR_ENV, inference.MODEL_SHA_ENV, inference.THRESHOLD_ENV):
            os.environ.pop(key, None)

    def tearDown(self):
        self.env.stop()
        inference.reset()
        self.tmp.cleanup()

    def configure(self, **kwargs):
        self.n = getattr(self, "n", 0) + 1  # a fresh fake checkpoint folder per call
        os.environ[inference.MODEL_DIR_ENV] = str(make_checkpoint(self.root / str(self.n), **kwargs))

    def classify(self, body=FLOOD):
        return service_router.classify(ClassifyRequest.model_validate(body))

    # --- input validation ----------------------------------------------------------------------
    def test_empty_input_is_rejected(self):
        for body in ({}, {"title": "  "}, {"title": "", "content": "   ", "summary": ""}):
            with self.assertRaises(ValidationError):
                ClassifyRequest.model_validate(body)

    def test_oversized_input_is_rejected(self):
        with self.assertRaises(ValidationError):
            ClassifyRequest.model_validate({"title": "x" * (MAX_TITLE_CHARS + 1)})
        with self.assertRaises(ValidationError):
            ClassifyRequest.model_validate({"title": "t", "content": "x" * (MAX_CONTENT_CHARS + 1)})

    def test_unknown_fields_are_rejected(self):
        with self.assertRaises(ValidationError):
            ClassifyRequest.model_validate({"title": "t", "severity": "high"})

    # --- valid prediction with a mocked model ---------------------------------------------------
    def test_valid_prediction_structure(self):
        self.configure()
        fake = FakeModel()
        with mock.patch.object(inference.Transformer, "from_checkpoint", return_value=fake):
            out = self.classify()
        self.assertEqual(out["model"]["status"], "ok")
        self.assertEqual(out["model"]["predicted_category"], "natural_disaster")
        self.assertEqual(set(out["model"]["probabilities"]), set(CLASSES))
        self.assertEqual(out["model"]["version"]["checkpoint_sha256"], inference.file_sha256(
            Path(os.environ[inference.MODEL_DIR_ENV]) / "model.safetensors"))
        self.assertEqual(out["model"]["version"]["run_id"], "test_run")
        self.assertEqual(out["hybrid"]["method"], "model")
        self.assertEqual(out["hybrid"]["threshold_source"], "validation-selected (run.json)")
        # Rules output is separate and carries the fields the model does not predict.
        for key in ("category", "relevance", "event_scope", "entities", "matched_keywords", "text_quality", "version"):
            self.assertIn(key, out["rules"])
        self.assertIn("relevance", out["not_predicted_by_model"])
        self.assertNotIn("relevance", out["model"])
        self.assertEqual(out["versions"]["rules"]["version"], "0.1.0")

    def test_model_is_loaded_once_per_process(self):
        self.configure()
        with mock.patch.object(inference.Transformer, "from_checkpoint", return_value=FakeModel()) as loader:
            self.classify()
            self.classify()
        self.assertEqual(loader.call_count, 1)

    def test_low_confidence_falls_back_to_rules_with_review(self):
        self.configure(threshold=0.95)
        fake = FakeModel({"natural_disaster": 0.2, "other": 0.5, "public_health": 0.3})
        with mock.patch.object(inference.Transformer, "from_checkpoint", return_value=fake):
            out = self.classify()
        self.assertEqual(out["hybrid"]["method"], "rules_fallback")
        self.assertTrue(out["review"]["needs_review"])
        self.assertEqual(out["model"]["predicted_category"], "other")  # model output still reported as-is

    # --- unavailable model ----------------------------------------------------------------------
    def test_not_configured_gives_documented_rules_only_result(self):
        out = self.classify()
        self.assertEqual(out["model"], {"status": "unavailable", "reason": "not_configured",
                                        "detail": f"{inference.MODEL_DIR_ENV} is not set"})
        self.assertEqual(out["hybrid"]["method"], "rules_only_no_model")
        self.assertEqual(out["hybrid"]["category"], out["rules"]["category"])
        self.assertIsNone(out["versions"]["model"])

    def test_require_model_answers_501(self):
        with self.assertRaises(HTTPException) as ctx:
            self.classify({**FLOOD, "requireModel": True})
        self.assertEqual(ctx.exception.status_code, 501)
        self.assertEqual(ctx.exception.detail["reason"], "not_configured")

    def test_missing_directory_is_unavailable(self):
        os.environ[inference.MODEL_DIR_ENV] = str(self.root / "nowhere")
        self.assertEqual(self.classify()["model"]["reason"], "not_found")

    # --- metadata and class-order validation -------------------------------------------------------
    def test_wrong_class_order_is_rejected(self):
        self.configure(classes=["other", "natural_disaster", "public_health"])
        with mock.patch.object(inference.Transformer, "from_checkpoint") as loader:
            out = self.classify()
        loader.assert_not_called()
        self.assertEqual(out["model"]["reason"], "invalid_checkpoint")
        self.assertIn("classes", out["model"]["detail"])

    def test_wrong_base_revision_label_count_and_missing_files_are_rejected(self):
        for kwargs, needle in (({"revision": "deadbeef"}, "base_revision"), ({"labels": 4}, "labels"),
                               ({"drop": "tokenizer.json"}, "tokenizer.json")):
            inference.reset()
            with tempfile.TemporaryDirectory() as tmp:
                os.environ[inference.MODEL_DIR_ENV] = str(make_checkpoint(Path(tmp), **kwargs))
                out = self.classify()
            self.assertEqual(out["model"]["reason"], "invalid_checkpoint", kwargs)
            self.assertIn(needle, out["model"]["detail"])

    def test_sha256_pin_mismatch_is_rejected(self):
        self.configure()
        os.environ[inference.MODEL_SHA_ENV] = "0" * 64
        self.assertEqual(self.classify()["model"]["reason"], "invalid_checkpoint")

    def test_loaded_class_mismatch_is_rejected(self):
        self.configure()
        fake = FakeModel()
        fake.classes = ["public_health", "other", "natural_disaster"]
        with mock.patch.object(inference.Transformer, "from_checkpoint", return_value=fake):
            self.assertEqual(self.classify()["model"]["reason"], "invalid_checkpoint")

    # --- loading errors -------------------------------------------------------------------------
    def test_loading_error_is_reported_and_cached(self):
        self.configure()
        with mock.patch.object(inference.Transformer, "from_checkpoint", side_effect=OSError("corrupt weights")) as loader:
            first, second = self.classify(), self.classify()
        self.assertEqual(first["model"]["reason"], "load_error")
        self.assertIn("corrupt weights", first["model"]["detail"])
        self.assertEqual(second["model"]["reason"], "load_error")
        self.assertEqual(loader.call_count, 1)

    def test_missing_ml_packages_are_reported(self):
        self.configure()
        real = inference.importlib.util.find_spec
        with mock.patch.object(inference.importlib.util, "find_spec", side_effect=lambda m: None if m == "torch" else real(m)):
            out = self.classify()
        self.assertEqual(out["model"]["reason"], "dependencies_missing")

    def test_status_endpoint(self):
        self.assertEqual(service_router.status()["reason"], "not_configured")
        self.configure()
        with mock.patch.object(inference.Transformer, "from_checkpoint", return_value=FakeModel()):
            self.assertEqual(service_router.status()["status"], "ok")

    # --- review policy -------------------------------------------------------------------------
    def codes(self, out):
        return [r["code"] for r in out["review"]["reasons"]]

    def run_with(self, probs, body=FLOOD, **kwargs):
        self.configure(**kwargs)
        with mock.patch.object(inference.Transformer, "from_checkpoint", return_value=FakeModel(probs)):
            return self.classify(body)

    def test_disagreement_triggers_review_without_changing_category(self):
        out = self.run_with({"natural_disaster": 0.01, "other": 0.98, "public_health": 0.01})
        self.assertEqual(out["rules"]["category"], "natural_disaster")
        self.assertIn("rules_model_disagree", self.codes(out))
        self.assertEqual((out["model"]["predicted_category"], out["hybrid"]["category"]), ("other", "other"))

    def test_low_confidence_boundary(self):
        below = self.run_with({"natural_disaster": 0.89, "other": 0.06, "public_health": 0.05})
        self.assertIn("low_model_confidence", self.codes(below))
        inference.reset()
        exact = self.run_with({"natural_disaster": 0.9, "other": 0.05, "public_health": 0.05})
        self.assertNotIn("low_model_confidence", self.codes(exact))
        self.assertEqual(below["hybrid"]["category"], exact["hybrid"]["category"])  # review never changes category

    def test_review_confidence_is_separately_configurable(self):
        os.environ[inference.REVIEW_CONFIDENCE_ENV] = "0.95"
        out = self.run_with({"natural_disaster": 0.93, "other": 0.04, "public_health": 0.03})
        self.assertIn("low_model_confidence", self.codes(out))
        self.assertEqual(out["hybrid"]["threshold"], 0.0)  # hybrid threshold unaffected

    def test_invalid_review_confidence_falls_back_to_default_with_warning(self):
        for raw in ("abc", "-1", "1.5", "nan"):
            os.environ[inference.REVIEW_CONFIDENCE_ENV] = raw
            with self.assertLogs(inference.log, level="WARNING"):
                self.assertEqual(inference.review_confidence(), inference.DEFAULT_REVIEW_CONFIDENCE)
        os.environ[inference.REVIEW_CONFIDENCE_ENV] = "0.8"
        self.assertEqual(inference.review_confidence(), 0.8)

    def test_rules_only_result_always_requires_review(self):
        out = self.classify()
        self.assertTrue(out["review"]["needs_review"])
        self.assertIn("model_unavailable", self.codes(out))
        self.assertFalse(out["hybrid"]["fallback_active"])

    def test_confident_agreeing_classified_article_needs_no_review(self):
        out = self.run_with({"natural_disaster": 0.95, "other": 0.03, "public_health": 0.02})
        self.assertEqual(out["rules"]["processing_status"], "classified")
        self.assertEqual(out["review"], {"needs_review": False, "reasons": []})

    def test_existing_rules_and_hybrid_reasons_are_kept(self):
        foreign = {"title": "Cholera outbreak declared in Bangladesh",
                   "content": "The Ministry of Health confirmed cholera cases in Dhaka." * 3}
        out = self.run_with({"natural_disaster": 0.01, "other": 0.01, "public_health": 0.98}, body=foreign)
        rules_entry = [r for r in out["review"]["reasons"] if r["code"] == "rules_review"][0]
        self.assertEqual(rules_entry["messages"], out["rules"]["review_reasons"])
        inference.reset()
        meta = {"title": "Situation map", "content": "Format: Map\nThemes: Health\nAttachment: https://example.org/x.pdf"}
        out = self.run_with({"natural_disaster": 0.01, "other": 0.01, "public_health": 0.98}, body=meta)
        self.assertIn("hybrid_rules_insufficient_text", self.codes(out))

    def test_reason_codes_are_unique_and_flag_matches_reasons(self):
        bodies = [FLOOD, {"title": "Cholera outbreak declared in Bangladesh", "content": "Cholera cases in Dhaka." * 3},
                  {"title": "Situation map", "content": "Format: Map\nAttachment: https://example.org/x.pdf"}]
        for probs in ({"natural_disaster": 0.5, "other": 0.3, "public_health": 0.2},
                      {"natural_disaster": 0.99, "other": 0.005, "public_health": 0.005}):
            for body in bodies:
                inference.reset()
                with tempfile.TemporaryDirectory() as tmp:
                    os.environ[inference.MODEL_DIR_ENV] = str(make_checkpoint(Path(tmp)))
                    with mock.patch.object(inference.Transformer, "from_checkpoint", return_value=FakeModel(probs)):
                        out = self.classify(body)
                codes = self.codes(out)
                self.assertEqual(len(codes), len(set(codes)))
                self.assertEqual(out["review"]["needs_review"], bool(codes))

    def test_fallback_active_reflects_threshold(self):
        self.assertFalse(self.run_with(None)["hybrid"]["fallback_active"])  # seed-13 value 0.0
        self.assertFalse(inference.fallback_active(1 / 3))
        self.assertTrue(inference.fallback_active(0.6))
        self.assertFalse(inference.fallback_active(None))
        inference.reset()
        out = self.run_with(None, threshold=0.6)
        self.assertTrue(out["hybrid"]["fallback_active"])
        self.assertEqual(out["hybrid"]["threshold"], 0.6)

    def test_app_mounts_event_and_cold_chain_routes(self):
        import main
        paths = set(main.app.openapi()["paths"])
        self.assertTrue({"/event-intel/classify", "/event-intel/status", "/cold-chain/predict"} <= paths)


@unittest.skipUnless(ClassifyRequest is not None and os.environ.get("EVENT_INTEL_HEAVY_TESTS") == "1"
                     and os.environ.get("EVENT_INTEL_MODEL_DIR"), "set EVENT_INTEL_HEAVY_TESTS=1 and EVENT_INTEL_MODEL_DIR")
class RealCheckpointTest(unittest.TestCase):
    def test_real_checkpoint_classifies_offline_on_cpu(self):
        inference.reset()
        with mock.patch.dict(os.environ, {"HF_HUB_OFFLINE": "1"}):
            out = service_router.classify(ClassifyRequest.model_validate({**FLOOD, "requireModel": True}))
        self.assertEqual(out["model"]["status"], "ok")
        self.assertEqual(set(out["model"]["probabilities"]), set(CLASSES))
        self.assertAlmostEqual(sum(out["model"]["probabilities"].values()), 1.0, places=4)
        self.assertEqual(out["model"]["version"]["seed"], 13)
        self.assertFalse(out["hybrid"]["fallback_active"])  # seed 13: validation-selected threshold 0.0
        reasons = out["review"]["reasons"]
        self.assertTrue(all(set(r) == {"code", "messages"} and r["messages"] for r in reasons))
        self.assertEqual(out["review"]["needs_review"], bool(reasons))
        self.assertEqual(out["hybrid"]["category"], out["model"]["predicted_category"])


if __name__ == "__main__":
    unittest.main()
