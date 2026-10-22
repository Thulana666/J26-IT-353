"""Intermediate-task transfer for DistilRoBERTa: fine-tune on an external task with its ORIGINAL
labels, keep only the encoder, then fine-tune a fresh 3-class head on the news articles.

No label is mapped: the external head is discarded. Offline and CPU-only like experiments.models.Transformer;
the base model is the same pinned revision. Requires torch + transformers (the project's Windows venv).
"""

from __future__ import annotations

import gc
import shutil
import tempfile
from pathlib import Path

from ..experiments.metrics import macro_f1, report
from ..experiments.models import TRANSFORMER_ID, Transformer, load_kwargs

# Settings for the intermediate stage (one pass; tweets are short).
INTERMEDIATE_SETTINGS = {
    "tweets": {"epochs": 1, "max_length": 64, "batch_size": 8, "grad_accum_steps": 1},
    "articles": {"epochs": 1, "max_length": 256, "batch_size": 2, "grad_accum_steps": 4},
}


class EncoderInitTransformer(Transformer):
    """A Transformer whose encoder is initialised from a local directory instead of the base checkpoint."""

    def __init__(self, seed: int = 42, init_dir: Path | None = None, **overrides):
        super().__init__(seed=seed, **overrides)
        self.init_dir = Path(init_dir) if init_dir else None

    def load(self, num_labels: int):
        if self.init_dir is None:
            return super().load(num_labels)
        torch = self._setup()
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        self.tokenizer = AutoTokenizer.from_pretrained(TRANSFORMER_ID, **load_kwargs())   # same pinned tokenizer
        self.model = AutoModelForSequenceClassification.from_pretrained(
            str(self.init_dir), num_labels=num_labels, local_files_only=True).to(self.device)  # new head, adapted encoder
        return torch


class IntermediateTransformer(EncoderInitTransformer):
    """fit() = intermediate external task (original labels) -> encoder only -> news fine-tuning."""

    def __init__(self, seed: int, intermediate: dict, **overrides):
        super().__init__(seed=seed, init_dir=None, **overrides)
        self.intermediate = intermediate          # name, kind, train/val/test texts+labels
        self.intermediate_result: dict | None = None

    def run_intermediate(self) -> Path:
        it = self.intermediate
        stage = Transformer(seed=self.seed, threads=self.settings["threads"], **INTERMEDIATE_SETTINGS[it["kind"]])
        labels = sorted(set(it["train_labels"]), key=str)
        score = macro_f1(labels)
        stage.fit(it["train_texts"], it["train_labels"], it["val_texts"], it["val_labels"], score)
        result = {"task": it["name"], "labels": labels, "settings": stage.settings, "history": stage.history,
                  "train_n": len(it["train_texts"]), "validation_n": len(it["val_texts"]), "train_seconds": stage.train_seconds}
        if it.get("test_texts"):
            pred = [max(p, key=p.get) for p in stage.predict_proba(it["test_texts"])]
            result["external_test"] = {"n": len(pred), "report": report(it["test_labels"], pred, labels)}
        tmp = Path(tempfile.mkdtemp(prefix=f"intermediate_{it['name']}_"))
        stage.model.base_model.save_pretrained(tmp)   # encoder only; the external head is discarded
        self.intermediate_result = result
        del stage
        gc.collect()
        return tmp

    def fit(self, texts, labels, val_texts=None, val_labels=None, score_fn=None):  # pragma: no cover - trains
        self.init_dir = self.run_intermediate()
        try:
            return super().fit(texts, labels, val_texts, val_labels, score_fn)
        finally:
            shutil.rmtree(self.init_dir, ignore_errors=True)

    def config(self) -> dict:
        return {**super().config(), "intermediate_task": self.intermediate_result,
                "transfer": "intermediate fine-tuning on external ORIGINAL labels; external head discarded; "
                            "fresh 3-class head trained on news"}
