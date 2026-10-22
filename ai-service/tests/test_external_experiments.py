"""Tests for event_intel.external_experiments: mappings, exclusions, leakage guards, reproducibility
and offline model loading. Data-dependent checks are skipped when the git-ignored outputs are absent."""

import csv
import importlib.machinery
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from event_intel.external_experiments import mapping as M
from event_intel.external_experiments import prepare as P
from event_intel.external_experiments import sources as S
from event_intel.external_experiments import spotcheck as SC
from event_intel.external_experiments import train_eval as T

V1 = S.OUT / S.VERSION


def humaid(label="injured_or_dead_people", text="Death toll rises to 40 after the earthquake", block="ecuador_earthquake_2016", dedup="keep"):
    return {"class_label": label, "text_clean": text, "inferred_event_block": block, "dedup_recommendation": dedup}


def tweet(target="1", kw="flood", text="Flood waters destroyed 20 homes in the valley", dedup="keep"):
    return {"target": target, "keyword_decoded": kw, "text_clean": text, "dedup_recommendation": dedup}


class HumaidMappingTests(unittest.TestCase):
    def test_impact_labels_map_to_natural_disaster(self):
        for label in M.HUMAID_TO_NATURAL_DISASTER:
            self.assertEqual(M.map_humaid(humaid(label))[0], "natural_disaster")

    def test_other_information_types_are_excluded_not_forced(self):
        for label in M.HUMAID_EXCLUDED:
            cat, rule = M.map_humaid(humaid(label))
            self.assertIsNone(cat)
            self.assertTrue(rule.startswith("excluded"))

    def test_wildfire_events_forecasts_and_duplicates_are_excluded(self):
        self.assertIsNone(M.map_humaid(humaid(block="california_wildfires_2018"))[0])
        self.assertIsNone(M.map_humaid(humaid(text="Irma will cause huge damage in Florida"))[0])
        self.assertIsNone(M.map_humaid(humaid(dedup="review_conflicting_label_duplicate"))[0])


class DisasterTweetMappingTests(unittest.TestCase):
    def test_transport_incidents_and_unlisted_hazards_are_excluded(self):
        self.assertEqual(M.map_disaster_tweet(tweet(kw="derailment", text="Train derailed"))[1], "excluded_possible_logistics_or_accident")
        self.assertEqual(M.map_disaster_tweet(tweet(kw="wildfire", text="Wildfire spreads"))[1], "excluded_hazard_not_in_guide")

    def test_rules(self):
        self.assertEqual(M.map_disaster_tweet(tweet())[0], "natural_disaster")
        self.assertEqual(M.map_disaster_tweet(tweet(kw="flood", text="So much love flooding in"))[1], "dt_real_disaster_natural_hazard_keyword_and_text")
        self.assertEqual(M.map_disaster_tweet(tweet(kw="outbreak", text="Legionnaires outbreak kills 8"))[0], "public_health")
        self.assertIsNone(M.map_disaster_tweet(tweet(kw="outbreak", text="Outbreak of violence downtown"))[0])
        self.assertEqual(M.map_disaster_tweet(tweet(target="0", kw="ablaze", text="My heart is ablaze"))[0], "other")
        self.assertIsNone(M.map_disaster_tweet(tweet(target="0", kw="", text="I have the flu again"))[0])
        self.assertIsNone(M.map_disaster_tweet(tweet(dedup="exclude_exact_duplicate_same_label"))[0])

    def test_bbc_is_never_mapped(self):
        self.assertEqual(M.map_bbc({"Category": "business"}), (None, "not_mapped_topic_label"))


class AcceptedRulesTests(unittest.TestCase):
    def test_accepted_rules_match_the_recorded_spot_check(self):
        for rule, (_, _, n, wrong, unclear) in SC.VERDICTS.items():
            precision = (n - len(wrong) - len(unclear)) / n
            self.assertEqual(rule in M.ACCEPTED_RULES, precision >= 0.8, rule)
        self.assertFalse(M.ACCEPTED_RULES & set(M.REJECTED_RULES))

    def test_wilson_interval(self):
        lo, hi = SC.wilson(44, 50)
        self.assertTrue(0.75 < lo < 0.80 and 0.93 < hi < 0.96)


class LanguageTests(unittest.TestCase):
    def test_english_screen(self):
        self.assertTrue(M.english_likely("The flood damaged the bridge"))
        self.assertFalse(M.english_likely("ভূমিকম্পে ক্ষতিগ্রস্ত এলাকা"))
        self.assertTrue(M.english_likely("Storm damage in the city ὤἿ"))  # corrupted-emoji artefacts ignored


def pool_row(i, src="humaid", cat="natural_disaster", group=None, split="train", eligible="1"):
    return {"source_dataset": src, "source_row": str(i), "mapped_category": cat, "global_leakage_group": group or f"G{i}",
            "own_task_split": split, "training_eligible_mapped": eligible, "mapping_rule": "humaid_impact_label_during_natural_disaster_event",
            "duplicates_news_article": "", "text": f"tweet number {i} about flood damage"}


class SamplingAndLeakageTests(unittest.TestCase):
    def test_sampling_is_seeded_capped_and_one_per_group(self):
        pool = [pool_row(i, group="G1" if i < 5 else None) for i in range(50)]
        a, b = T.sample_extra(pool, 10, 42), T.sample_extra(pool, 10, 42)
        self.assertEqual([r["source_row"] for r in a], [r["source_row"] for r in b])
        self.assertEqual(len(a), 10)
        self.assertLessEqual(sum(1 for r in T.sample_extra(pool, 100, 7) if r["global_leakage_group"] == "G1"), 1)
        self.assertNotEqual([r["source_row"] for r in a], [r["source_row"] for r in T.sample_extra(pool, 10, 13)])

    def test_external_pool_keeps_only_eligible_training_rows(self):
        with tempfile.TemporaryDirectory() as d:
            rows = [pool_row(1), pool_row(2, eligible="0"), pool_row(3, split="test", eligible="0")]
            with (Path(d) / f"humaid_adapted_{S.VERSION}.csv").open("w", encoding="utf-8", newline="") as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0]))
                w.writeheader()
                w.writerows(rows)
            with mock.patch.object(T, "ADAPTED", Path(d)):
                self.assertEqual([r["source_row"] for r in T.external_pool(("humaid",))], ["1"])

    def test_external_text_equal_to_held_out_news_is_rejected(self):
        held = types.SimpleNamespace(text="Floods hit Colombo", record={"content": "Floods hit Colombo", "summary": ""})
        with self.assertRaises(T.D.LeakageError):
            T.assert_extra_disjoint([{"source_row": "1", "text": "floods hit colombo!"}], [held])
        T.assert_extra_disjoint([{"source_row": "2", "text": "unrelated"}], [held])

    def test_news_duplicate_detection(self):
        key = P.norm_key("Heavy rain caused severe floods in Colombo and Gampaha districts today")
        idx = {"exact": {key: "a1"}, "inv": {}, "k": 4}
        self.assertEqual(P.news_match(key, idx), ("a1", "exact"))
        long_key = P.norm_key("officials said heavy rain caused severe floods in colombo and gampaha districts on monday")
        tweet_key = P.norm_key("heavy rain caused severe floods in colombo and gampaha districts")
        idx = {"exact": {}, "inv": {}, "k": 4}
        for h in P.shingle_hashes(long_key, 4):
            idx["inv"].setdefault(h, set()).add("a2")
        self.assertEqual(P.news_match(tweet_key, idx)[0], "a2")

    def test_cross_dataset_exact_duplicates_share_a_group(self):
        data = {"humaid": [{"source_row": "1", "leakage_group": "r_1", "text_clean": "Bridge collapsed after the flood"}],
                "disaster_tweets": [{"source_row": "9", "leakage_group": "r_9", "text_clean": "bridge collapsed after the flood!!"}],
                "bbc_news": [{"source_row": "3", "leakage_group": "r_3", "text_clean": "unrelated article"}]}
        cross = P.cross_dataset_groups(data)
        self.assertEqual(cross["find"]("humaid:1"), cross["find"]("disaster_tweets:9"))
        self.assertNotEqual(cross["find"]("humaid:1"), cross["find"]("bbc_news:3"))


def fake_ml_modules(calls):
    try:  # import numpy before patching sys.modules so it is not dropped and re-imported afterwards
        import numpy  # noqa: F401
    except ImportError:
        pass
    torch = types.ModuleType("torch")
    torch.__spec__ = importlib.machinery.ModuleSpec("torch", None)
    torch.set_num_threads = lambda n: None
    torch.manual_seed = lambda s: None
    transformers = types.ModuleType("transformers")
    transformers.__spec__ = importlib.machinery.ModuleSpec("transformers", None)

    class _Model:
        def to(self, device):
            return self

    class AutoModelForSequenceClassification:
        @staticmethod
        def from_pretrained(name, **kw):
            calls.append(("model", name, kw))
            return _Model()

    class AutoTokenizer:
        @staticmethod
        def from_pretrained(name, **kw):
            calls.append(("tokenizer", name, kw))
            return object()

    transformers.AutoModelForSequenceClassification = AutoModelForSequenceClassification
    transformers.AutoTokenizer = AutoTokenizer
    return {"torch": torch, "transformers": transformers}


class OfflineLoadingTests(unittest.TestCase):
    def test_encoder_init_loads_offline_from_the_local_encoder_and_pinned_tokenizer(self):
        from event_intel.experiments import models
        from event_intel.external_experiments.transfer import EncoderInitTransformer
        calls = []
        ready = {"transformer_ready": True, "packages": {"torch": True, "transformers": True}, "transformer_weights_cached": True}
        with mock.patch.dict(sys.modules, fake_ml_modules(calls)), mock.patch.object(models, "environment", return_value=ready):
            with tempfile.TemporaryDirectory() as d:
                EncoderInitTransformer(seed=1, init_dir=Path(d)).load(3)
                tok = [c for c in calls if c[0] == "tokenizer"][-1]
                mdl = [c for c in calls if c[0] == "model"][-1]
                self.assertEqual(tok[1], models.TRANSFORMER_ID)
                self.assertEqual(tok[2], {"revision": models.TRANSFORMER_REVISION, "local_files_only": True})
                self.assertEqual(mdl[1], str(Path(d)))
                self.assertEqual(mdl[2], {"num_labels": 3, "local_files_only": True})
                calls.clear()
                EncoderInitTransformer(seed=1).load(3)  # no init dir: the pinned base model, offline
                mdl = [c for c in calls if c[0] == "model"][-1]
                self.assertEqual(mdl[1], models.TRANSFORMER_ID)
                self.assertTrue(mdl[2]["local_files_only"])
                self.assertEqual(mdl[2]["revision"], models.TRANSFORMER_REVISION)

    def test_intermediate_plans_require_the_transformer(self):
        with self.assertRaises(ValueError):
            T.run_news_plan([], "nb", "B_humaid_intermediate", 42, Path(tempfile.gettempdir()))


@unittest.skipUnless((V1 / f"prepare_run_{S.VERSION}.json").exists(), "prepared outputs are git-ignored and not present")
class PreparedOutputTests(unittest.TestCase):
    def test_outputs_match_recorded_hashes(self):
        run = json.loads((V1 / f"prepare_run_{S.VERSION}.json").read_text(encoding="utf-8"))
        for rel, digest in run["outputs"].items():
            self.assertEqual(S.sha256(S.ROOT / rel), digest, rel)

    def test_splits_have_no_leakage_and_training_rows_are_clean(self):
        for name in S.DATASETS:
            audit = json.loads((V1 / "splits" / f"{name}_splits_{S.VERSION}.json").read_text(encoding="utf-8"))
            self.assertEqual(audit["within_dataset_leakage_groups_spanning_splits"], 0, name)
            self.assertEqual(audit["rows_duplicating_news_validation_or_test"], 0, name)
            with (V1 / "adapted" / f"{name}_adapted_{S.VERSION}.csv").open(encoding="utf-8", newline="") as f:
                for r in csv.DictReader(f):
                    if r["training_eligible_mapped"] == "1":
                        self.assertEqual(r["own_task_split"], "train")
                        self.assertIn(r["mapping_rule"], M.ACCEPTED_RULES)
                        self.assertEqual(r["duplicates_news_article"], "")
                        self.assertEqual(r["label_source_mapped"], M.MAPPING_VERSION)
                    self.assertEqual(r["label_source_original"], "original_dataset_label")

    def test_original_labels_are_preserved(self):
        for name, cfg in S.DATASETS.items():
            with cfg["clean"].open(encoding="utf-8", newline="") as f:
                orig = {r["source_row"]: r[cfg["label"]] for r in csv.DictReader(f)}
            with (V1 / "adapted" / f"{name}_adapted_{S.VERSION}.csv").open(encoding="utf-8", newline="") as f:
                for r in csv.DictReader(f):
                    self.assertEqual(r["original_label"], orig[r["source_row"]])


if __name__ == "__main__":
    unittest.main()


class SummaryTests(unittest.TestCase):
    def test_paired_counts_are_oriented_plan_versus_baseline(self):
        from event_intel.external_experiments import summarize as Z
        with tempfile.TemporaryDirectory() as d:
            plan, base = Path(d) / "plan", Path(d) / "base"
            for folder, preds in ((plan, ["a", "a"]), (base, ["b", "a"])):
                folder.mkdir()
                with (folder / "predictions_test.csv").open("w", encoding="utf-8", newline="") as f:
                    w = csv.DictWriter(f, fieldnames=["evaluation_set", "article_id", "gold", "model"])
                    w.writeheader()
                    for i, p in enumerate(preds):
                        w.writerow({"evaluation_set": "test_all_reference", "article_id": str(i), "gold": "a", "model": p})
            out = Z.paired({1: {"dir": plan}}, {1: {"dir": base}})[1]
            self.assertEqual((out["plan_right_baseline_wrong"], out["plan_wrong_baseline_right"]), (1, 0))

    def test_decision_rule_requires_validation_gain_and_no_regression(self):
        from event_intel.external_experiments import summarize as Z
        def plan(v, t, pc, pilot):
            return {"validation_macro_f1_model": {"mean": v}, "validation_per_class_f1_model": {c: {"mean": pc} for c in T.LABELS},
                    "test_all_reference_model_macro_f1": {"mean": t}, "pilot11_model_errors_by_seed": pilot}
        base = plan(0.95, 0.95, 0.95, {42: 1, 13: 1, 7: 1})
        self.assertEqual(Z.decide(base, plan(0.97, 0.95, 0.96, {42: 1, 13: 1, 7: 1}))["verdict"], "worth_retaining")
        self.assertEqual(Z.decide(base, plan(0.955, 0.99, 0.96, {42: 0, 13: 0, 7: 0}))["verdict"], "not_retained")  # test gain alone never counts
        self.assertEqual(Z.decide(base, plan(0.97, 0.90, 0.96, {42: 1, 13: 1, 7: 1}))["verdict"], "not_retained")
        self.assertEqual(Z.decide(base, plan(0.97, 0.95, 0.96, {42: 2, 13: 2, 7: 1}))["verdict"], "not_retained")


@unittest.skipUnless((V1 / f"prepare_run_{S.VERSION}.json").exists(), "prepared outputs are git-ignored and not present")
class TransformerWiringTests(unittest.TestCase):
    """The transformer code path with stub models (no torch): plan dispatch, data wiring, outputs."""

    def test_intermediate_plans_build_original_label_tasks(self):
        from event_intel.experiments import models
        from event_intel.external_experiments.transfer import IntermediateTransformer
        ready = {"transformer_ready": True, "packages": {"torch": True, "transformers": True}, "transformer_weights_cached": True}
        with mock.patch.object(models, "environment", return_value=ready):
            for plan, n_labels in (("B_humaid_intermediate", 10), ("C_dt_intermediate", 2), ("D_bbc_intermediate", 5)):
                m = T.make_model("transformer", plan, 42, None, smoke=True)
                self.assertIsInstance(m, IntermediateTransformer)
                it = m.intermediate
                self.assertEqual(len(set(it["train_labels"])), n_labels, plan)
                self.assertTrue(it["train_texts"] and it["val_texts"] and it["test_texts"])
                self.assertFalse(set(it["train_texts"]) & set(it["test_texts"]))
            full = T.own_task_data("humaid", (4000, 1000, 2000), seed=42)
            self.assertLessEqual(abs(len(full["train"]) - 4000), 10)
            self.assertEqual([r["source_row"] for r in full["train"]],
                             [r["source_row"] for r in T.own_task_data("humaid", (4000, 1000, 2000), seed=42)["train"]])

    def test_run_news_plan_writes_outputs_with_stub_transformer(self):
        class Stub:
            classes = list(T.LABELS)
            intermediate_result = {"task": "disaster_tweets"}

            def fit(self, texts, labels, vt=None, vl=None, score=None):
                self.n = len(texts)
                return self

            def predict_proba(self, texts):
                return [{"natural_disaster": 0.8, "public_health": 0.1, "other": 0.1} for _ in texts]

            def save_checkpoint(self, directory):
                Path(directory).mkdir(parents=True)
                (Path(directory) / "classifier_meta.json").write_text(json.dumps({"classes": self.classes}), encoding="utf-8")
                return {"path": str(directory), "megabytes": 0.0}

            def config(self):
                return {"model": "stub", "trained_on": self.n}

        examples = T.D.load_examples(T.DATASET, T.SNAPSHOT, T.ACCEPTED_LABELS)
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(T, "make_model", lambda *a, **k: Stub()), \
                mock.patch.object(T, "verify_checkpoint", return_value={"passed": True}):
            out = T.run_news_plan(examples, "transformer", "E2_news_plus_dt_mapped", 42, Path(d), smoke=True)
            run = json.loads((out / "run.json").read_text(encoding="utf-8"))
            self.assertEqual(run["plan"], "E2_news_plus_dt_mapped")
            self.assertTrue(run["smoke"])
            self.assertEqual(run["label_sources"]["external_train"]["label_source"], M.MAPPING_VERSION)
            meta = json.loads((out / "checkpoint_category" / "classifier_meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["experiment_plan"], "E2_news_plus_dt_mapped")
            test = json.loads((out / "metrics_test.json").read_text(encoding="utf-8"))
            self.assertEqual(set(test), {"test_human_confirmed", "test_accepted_ai", "test_all_reference"})
            self.assertTrue((out / "predictions_test.csv").exists() and (out / "predictions_validation.csv").exists())


class DeviceSettingTests(unittest.TestCase):
    def test_device_defaults_to_cpu_and_rejects_unknown_values(self):
        from event_intel.experiments import models as MD
        with mock.patch.dict("os.environ", {}, clear=False) as env:
            env.pop(MD.DEVICE_ENV, None)
            self.assertEqual(MD.requested_device(), "cpu")
            for value in ("cpu", "CUDA", "auto"):
                env[MD.DEVICE_ENV] = value
                self.assertEqual(MD.requested_device(), value.lower())
            env[MD.DEVICE_ENV] = "tpu"
            with self.assertRaises(ValueError):
                MD.requested_device()
