"""Text classifiers behind one interface: fit(texts, labels) and predict_proba(texts).

NaiveBayes   pure-Python multinomial Naive Bayes (unigrams + bigrams). Deterministic, no packages.
             An interim lexical stand-in so the pipeline runs end to end. It is NOT a transformer.
Transformer  DistilRoBERTa fine-tuning. Needs torch + transformers and the model weights; it is
             not installed in this environment, so it raises MissingDependency instead of running.
"""

from __future__ import annotations

import importlib.util
import math
import re
import shutil
from collections import Counter, defaultdict
from pathlib import Path

TOKEN = re.compile(r"[a-z][a-z0-9'-]+")
TRANSFORMER_ID = "distilbert/distilroberta-base"


class MissingDependency(RuntimeError):
    pass


def tokens(text: str) -> list[str]:
    words = TOKEN.findall(text.lower())
    return words + [f"{a}_{b}" for a, b in zip(words, words[1:])]


class NaiveBayes:
    name = "naive_bayes_unigram_bigram"

    def __init__(self, alpha: float = 1.0):
        self.alpha = alpha

    def fit(self, texts: list[str], labels: list) -> "NaiveBayes":
        if not texts:
            raise ValueError("no training examples")
        self.classes = sorted(set(labels), key=str)
        counts = defaultdict(Counter)
        for text, label in zip(texts, labels):
            counts[label].update(tokens(text))
        self.vocab = sorted({t for c in counts.values() for t in c})
        size = len(self.vocab)
        prior = Counter(labels)
        self.log_prior = {c: math.log(prior[c] / len(labels)) for c in self.classes}
        self.log_lik, self.log_unseen = {}, {}
        for c in self.classes:
            total = sum(counts[c].values()) + self.alpha * size
            self.log_lik[c] = {t: math.log((n + self.alpha) / total) for t, n in counts[c].items()}
            self.log_unseen[c] = math.log(self.alpha / total)
        self.vocab_set = set(self.vocab)
        return self

    def predict_proba(self, texts: list[str]) -> list[dict]:
        out = []
        for text in texts:
            toks = [t for t in tokens(text) if t in self.vocab_set]
            scores = {c: self.log_prior[c] + sum(self.log_lik[c].get(t, self.log_unseen[c]) for t in toks)
                      for c in self.classes}
            top = max(scores.values())
            exp = {c: math.exp(s - top) for c, s in scores.items()}
            z = sum(exp.values())
            out.append({c: v / z for c, v in exp.items()})
        return out

    def config(self) -> dict:
        return {"model": self.name, "alpha": self.alpha, "vocabulary_size": len(self.vocab), "tokenizer": "regex [a-z][a-z0-9'-]+ lowercase, + bigrams"}


def environment() -> dict:
    """What a transformer run would need, checked without importing heavy packages or downloading."""
    packages = {m: importlib.util.find_spec(m) is not None
                for m in ("torch", "transformers", "tokenizers", "accelerate", "sklearn", "numpy")}
    hf_cache = Path.home() / ".cache" / "huggingface" / "hub"
    cached = hf_cache.exists() and any("distilroberta" in p.name for p in hf_cache.iterdir())
    gpu = shutil.which("nvidia-smi") is not None
    free_gb = round(shutil.disk_usage(Path.cwd().anchor or ".").free / 1e9, 1)
    ready = packages["torch"] and packages["transformers"] and cached
    return {"packages": packages, "transformer_weights_cached": cached, "nvidia_smi_present": gpu,
            "free_disk_gb_current_drive": free_gb, "transformer_ready": ready, "transformer_id": TRANSFORMER_ID}


class Transformer:
    """DistilRoBERTa sequence classifier. Written for the approved plan; NOT executed in this environment."""

    name = TRANSFORMER_ID

    def __init__(self, epochs: int = 4, lr: float = 2e-5, batch_size: int = 8, max_length: int = 512, seed: int = 42):
        env = environment()
        if not env["transformer_ready"]:
            missing = [m for m in ("torch", "transformers") if not env["packages"][m]]
            raise MissingDependency(
                f"Transformer backend unavailable: missing packages {missing or 'none'}, "
                f"weights cached={env['transformer_weights_cached']}. Install and download need approval.")
        self.epochs, self.lr, self.batch_size, self.max_length, self.seed = epochs, lr, batch_size, max_length, seed

    def fit(self, texts, labels):  # pragma: no cover - requires torch/transformers
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        torch.manual_seed(self.seed)
        self.classes = sorted(set(labels), key=str)
        index = {c: i for i, c in enumerate(self.classes)}
        self.tokenizer = AutoTokenizer.from_pretrained(TRANSFORMER_ID)
        self.model = AutoModelForSequenceClassification.from_pretrained(TRANSFORMER_ID, num_labels=len(self.classes))
        device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model.to(device)
        counts = Counter(labels)
        weights = torch.tensor([len(labels) / (len(self.classes) * counts[c]) for c in self.classes], device=device)
        optimiser = torch.optim.AdamW(self.model.parameters(), lr=self.lr, weight_decay=0.01)
        generator = torch.Generator().manual_seed(self.seed)
        y = torch.tensor([index[l] for l in labels])
        for _ in range(self.epochs):
            self.model.train()
            for batch in torch.randperm(len(texts), generator=generator).split(self.batch_size):
                enc = self.tokenizer([texts[i] for i in batch], truncation=True, max_length=self.max_length,
                                     padding=True, return_tensors="pt").to(device)
                logits = self.model(**enc).logits
                loss = torch.nn.functional.cross_entropy(logits, y[batch].to(device), weight=weights)
                loss.backward()
                optimiser.step()
                optimiser.zero_grad()
        return self

    def predict_proba(self, texts):  # pragma: no cover - requires torch/transformers
        import torch
        self.model.eval()
        out = []
        with torch.no_grad():
            for i in range(0, len(texts), self.batch_size):
                enc = self.tokenizer(texts[i:i + self.batch_size], truncation=True, max_length=self.max_length,
                                     padding=True, return_tensors="pt").to(self.model.device)
                for row in torch.softmax(self.model(**enc).logits, dim=-1).tolist():
                    out.append(dict(zip(self.classes, row)))
        return out

    def config(self) -> dict:
        return {"model": self.name, "epochs": self.epochs, "lr": self.lr, "batch_size": self.batch_size,
                "max_length": self.max_length, "seed": self.seed, "class_weighted_loss": True}
