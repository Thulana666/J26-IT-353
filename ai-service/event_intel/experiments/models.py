"""Text classifiers behind one interface: fit(texts, labels) and predict_proba(texts).

NaiveBayes   pure-Python multinomial Naive Bayes (unigrams + bigrams). Deterministic, no packages.
             An interim lexical stand-in so the pipeline runs end to end. It is NOT a transformer.
Transformer  DistilRoBERTa fine-tuning on CPU only, from a pinned, offline-cached revision.
             Laptop-safe defaults (4 threads, batch 2 with gradient accumulation, 256 tokens) and a
             free-RAM guard. Best epoch chosen on validation only; best weights kept in memory.
"""

from __future__ import annotations

import ctypes
import importlib.util
import math
import os
import random
import re
import shutil
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

TOKEN = re.compile(r"[a-z][a-z0-9'-]+")
TRANSFORMER_ID = "distilbert/distilroberta-base"
TRANSFORMER_REVISION = "fb53ab8802853c8e4fbdbcd0529f21fc6f459b2b"  # pinned; verified offline 2026-10-19
MIN_FREE_RAM_GB = 3.0
ABORT_FREE_RAM_GB = 1.5  # stop between epochs if free RAM falls this low

# Conservative defaults for a 15 GB laptop on CPU.
SAFE_DEFAULTS = {"epochs": 4, "lr": 2e-5, "batch_size": 2, "grad_accum_steps": 4, "max_length": 256,
                 "warmup_ratio": 0.1, "max_grad_norm": 1.0, "weight_decay": 0.01, "threads": 4}


class MissingDependency(RuntimeError):
    pass


class InsufficientResources(RuntimeError):
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


def set_seed(seed: int) -> None:
    """Seed Python and (if installed) NumPy and PyTorch. The dataset split is fixed separately and never reseeded."""
    random.seed(seed)
    if importlib.util.find_spec("numpy"):
        import numpy
        numpy.random.seed(seed)
    if importlib.util.find_spec("torch"):
        import torch
        torch.manual_seed(seed)


def free_ram_gb() -> float | None:
    """Free physical memory in GB (Windows API, or /proc/meminfo); None if unknown."""
    if sys.platform == "win32":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        status = MemoryStatus()
        status.dwLength = ctypes.sizeof(MemoryStatus)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return round(status.ullAvailPhys / 1024**3, 2)
        return None
    try:
        with open("/proc/meminfo") as f:
            info = dict(line.split(":", 1) for line in f)
        return round(int(info["MemAvailable"].split()[0]) / 1024**2, 2)
    except (OSError, KeyError, ValueError):
        return None


def peak_rss_mb() -> float | None:
    """Peak working set of this process in MB, where the platform reports it."""
    if sys.platform == "win32":
        class Counters(ctypes.Structure):
            _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                        ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
        counters = Counters()
        counters.cb = ctypes.sizeof(Counters)
        kernel32, psapi = ctypes.windll.kernel32, ctypes.windll.psapi
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
        if psapi.GetProcessMemoryInfo(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            return round(counters.PeakWorkingSetSize / 1024**2, 1)
        return None
    try:
        import resource
        return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
    except (ImportError, OSError):
        return None


def check_resources(min_free_gb: float = MIN_FREE_RAM_GB) -> float:
    """Abort before training when free RAM is below the safety margin."""
    free = free_ram_gb()
    if free is None:
        raise InsufficientResources("Could not read free RAM; refusing to train without a memory check.")
    if free < min_free_gb:
        raise InsufficientResources(
            f"Only {free} GB RAM free (need >= {min_free_gb} GB). Close browsers, IDEs and other heavy apps, then retry.")
    return free


def hf_hub_cache() -> Path:
    if os.environ.get("HF_HUB_CACHE"):
        return Path(os.environ["HF_HUB_CACHE"])
    if os.environ.get("HF_HOME"):
        return Path(os.environ["HF_HOME"]) / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def pinned_snapshot() -> Path:
    return hf_hub_cache() / ("models--" + TRANSFORMER_ID.replace("/", "--")) / "snapshots" / TRANSFORMER_REVISION


def load_kwargs() -> dict:
    """Every from_pretrained call uses the pinned revision and never touches the network."""
    return {"revision": TRANSFORMER_REVISION, "local_files_only": True}


REQUIRED_FILES = ("config.json", "model.safetensors", "tokenizer.json", "vocab.json", "merges.txt")


def environment() -> dict:
    """What a transformer run needs, checked without importing heavy packages or downloading."""
    packages = {m: importlib.util.find_spec(m) is not None
                for m in ("torch", "transformers", "tokenizers", "accelerate", "sklearn", "numpy")}
    cached = all((pinned_snapshot() / f).exists() for f in REQUIRED_FILES)
    ready = packages["torch"] and packages["transformers"] and cached
    return {"packages": packages, "transformer_id": TRANSFORMER_ID, "transformer_revision": TRANSFORMER_REVISION,
            "transformer_weights_cached": cached, "transformer_ready": ready,
            "nvidia_smi_present": shutil.which("nvidia-smi") is not None, "gpu_used": False,
            "free_disk_gb_current_drive": round(shutil.disk_usage(Path.cwd().anchor or ".").free / 1e9, 1),
            "free_ram_gb": free_ram_gb()}


def package_versions() -> dict:
    out = {"python": sys.version.split()[0]}
    for m in ("torch", "transformers", "tokenizers", "numpy"):
        if importlib.util.find_spec(m):
            out[m] = getattr(__import__(m), "__version__", "unknown")
    return out


class Transformer:
    """DistilRoBERTa sequence classifier: new classification head + full encoder fine-tuning, CPU only."""

    name = TRANSFORMER_ID

    def __init__(self, seed: int = 42, **overrides):
        unknown = set(overrides) - set(SAFE_DEFAULTS)
        if unknown:
            raise ValueError(f"unknown transformer settings: {sorted(unknown)}")
        env = environment()
        if not env["transformer_ready"]:
            missing = [m for m in ("torch", "transformers") if not env["packages"][m]]
            raise MissingDependency(
                f"Transformer backend unavailable: missing packages {missing or 'none'}, "
                f"pinned weights cached={env['transformer_weights_cached']} (revision {TRANSFORMER_REVISION}).")
        self.seed = seed
        self.settings = {**SAFE_DEFAULTS, **overrides}
        self.history: list[dict] = []
        self.best_epoch = None
        self.train_seconds = None

    def _setup(self):
        os.environ["HF_HUB_OFFLINE"] = "1"           # never reach the network
        os.environ["CUDA_VISIBLE_DEVICES"] = ""      # never touch the GPU
        os.environ["TOKENIZERS_PARALLELISM"] = "false"
        import torch
        torch.set_num_threads(self.settings["threads"])
        set_seed(self.seed)
        return torch

    def load(self, num_labels: int):
        """Load tokenizer and model offline from the pinned revision (no training)."""
        torch = self._setup()
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        self.tokenizer = AutoTokenizer.from_pretrained(TRANSFORMER_ID, **load_kwargs())
        self.model = AutoModelForSequenceClassification.from_pretrained(
            TRANSFORMER_ID, num_labels=num_labels, **load_kwargs()).to("cpu")
        return torch

    def fit(self, texts, labels, val_texts=None, val_labels=None, score_fn=None):  # pragma: no cover - trains
        check_resources()
        self.classes = sorted(set(labels), key=str)
        torch = self.load(len(self.classes))
        from transformers import get_linear_schedule_with_warmup
        s = self.settings
        index = {c: i for i, c in enumerate(self.classes)}
        counts = Counter(labels)
        weights = torch.tensor([len(labels) / (len(self.classes) * counts[c]) for c in self.classes])
        # All parameters (encoder + new classification head) are optimised: full fine-tuning.
        optimiser = torch.optim.AdamW(self.model.parameters(), lr=s["lr"], weight_decay=s["weight_decay"])
        steps_per_epoch = math.ceil(math.ceil(len(texts) / s["batch_size"]) / s["grad_accum_steps"])
        total_steps = steps_per_epoch * s["epochs"]
        scheduler = get_linear_schedule_with_warmup(optimiser, int(s["warmup_ratio"] * total_steps), total_steps)
        generator = torch.Generator().manual_seed(self.seed)
        y = torch.tensor([index[l] for l in labels])
        best_score, best_state = None, None
        t_start = time.perf_counter()
        for epoch in range(1, s["epochs"] + 1):
            t0, losses = time.perf_counter(), []
            self.model.train()
            batches = torch.randperm(len(texts), generator=generator).split(s["batch_size"])
            for step, batch in enumerate(batches, start=1):
                enc = self.tokenizer([texts[i] for i in batch], truncation=True, max_length=s["max_length"],
                                     padding=True, return_tensors="pt")
                loss = torch.nn.functional.cross_entropy(self.model(**enc).logits, y[batch], weight=weights)
                (loss / s["grad_accum_steps"]).backward()
                losses.append(loss.item())
                if step % s["grad_accum_steps"] == 0 or step == len(batches):
                    torch.nn.utils.clip_grad_norm_(self.model.parameters(), s["max_grad_norm"])
                    optimiser.step()
                    scheduler.step()
                    optimiser.zero_grad()
            entry = {"epoch": epoch, "train_loss": round(sum(losses) / len(losses), 4),
                     "seconds": round(time.perf_counter() - t0, 1)}
            if val_texts:
                probs = self.predict_proba(val_texts)
                entry["validation_score"] = round(score_fn(val_labels, [max(p, key=p.get) for p in probs]), 4)
                if best_score is None or entry["validation_score"] > best_score:  # ties keep the earlier epoch
                    best_score, self.best_epoch = entry["validation_score"], epoch
                    best_state = {k: v.detach().clone() for k, v in self.model.state_dict().items()}
            entry["free_ram_gb"], entry["peak_rss_mb"] = free_ram_gb(), peak_rss_mb()
            self.history.append(entry)
            if entry["free_ram_gb"] is not None and entry["free_ram_gb"] < ABORT_FREE_RAM_GB:
                raise InsufficientResources(f"Free RAM fell to {entry['free_ram_gb']} GB after epoch {epoch}; stopped safely.")
        if best_state is not None:
            self.model.load_state_dict(best_state)  # only the best validation epoch is kept
        else:
            self.best_epoch = s["epochs"]
        self.train_seconds = round(time.perf_counter() - t_start, 1)
        return self

    def predict_proba(self, texts):
        import torch
        self.model.eval()
        out = []
        with torch.no_grad():
            for i in range(0, len(texts), self.settings["batch_size"]):
                enc = self.tokenizer(texts[i:i + self.settings["batch_size"]], truncation=True,
                                     max_length=self.settings["max_length"], padding=True, return_tensors="pt")
                for row in torch.softmax(self.model(**enc).logits, dim=-1).tolist():
                    out.append(dict(zip(self.classes, row)))
        return out

    def save(self, path: Path) -> None:  # pragma: no cover - writes ~330 MB
        """Optional: write only the selected (best-epoch) weights."""
        import torch
        torch.save(self.model.state_dict(), path)

    def config(self) -> dict:
        s = self.settings
        return {"model": self.name, "revision": TRANSFORMER_REVISION, "offline": True, "device": "cpu", "seed": self.seed,
                **s, "effective_batch_size": s["batch_size"] * s["grad_accum_steps"], "class_weighted_loss": True,
                "fine_tuned_parameters": "all (encoder + classification head)",
                "scheduler": "linear warmup then linear decay", "gradient_clipping": s["max_grad_norm"],
                "epoch_selection": "best validation macro-F1; ties keep the earlier epoch",
                "best_epoch": self.best_epoch, "history": self.history, "train_seconds": self.train_seconds,
                "peak_rss_mb": peak_rss_mb()}
