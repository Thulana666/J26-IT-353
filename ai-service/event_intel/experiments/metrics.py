"""Metrics on top of event_intel.evaluate: confusion matrix and paired bootstrap intervals."""

from __future__ import annotations

import random
from collections import Counter

from ..evaluate import classification_report


def report(gold: list, pred: list, labels: list) -> dict:
    """Per-class P/R/F1 over `labels` (macro over them); predictions outside `labels` count as errors."""
    r = classification_report(gold, pred, labels=labels)
    r["gold_distribution"] = dict(Counter(gold))
    r["pred_distribution"] = dict(Counter(pred))
    r["confusion"] = confusion(gold, pred)
    return r


def confusion(gold: list, pred: list) -> dict:
    rows = sorted(set(gold) | set(pred), key=str)
    return {"labels": [str(x) for x in rows],
            "matrix": [[sum(1 for g, p in zip(gold, pred) if g == a and p == b) for b in rows] for a in rows]}


def macro_f1(labels):
    return lambda g, p: classification_report(g, p, labels=labels)["macro"]["f1"]


def accuracy(g, p):
    return sum(1 for a, b in zip(g, p) if a == b) / len(g) if g else 0.0


def bootstrap(gold: list, systems: dict[str, list], metric, n: int = 2000, seed: int = 2026) -> dict:
    """Percentile 95% intervals per system and for paired differences against the first system."""
    rng = random.Random(seed)
    names = list(systems)
    samples = {k: [] for k in names}
    diffs = {k: [] for k in names[1:]}
    size = len(gold)
    for _ in range(n):
        idx = [rng.randrange(size) for _ in range(size)]
        g = [gold[i] for i in idx]
        vals = {k: metric(g, [systems[k][i] for i in idx]) for k in names}
        for k in names:
            samples[k].append(vals[k])
        for k in names[1:]:
            diffs[k].append(vals[k] - vals[names[0]])

    def ci(xs):
        xs = sorted(xs)
        return [round(xs[int(0.025 * len(xs))], 4), round(xs[min(len(xs) - 1, int(0.975 * len(xs)))], 4)]

    return {"n_resamples": n, "seed": seed, "sample_size": size,
            "ci95": {k: ci(v) for k, v in samples.items()},
            "paired_difference_vs_" + names[0]: {k: ci(v) for k, v in diffs.items()}}
