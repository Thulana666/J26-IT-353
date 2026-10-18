"""Precision, recall and F1 for comparing classifiers on the same labelled articles.

    precision  of the articles predicted as class X, the share that really are X
    recall     of the articles that really are X, the share that were predicted as X
    F1         harmonic mean of precision and recall (high only if both are high)

Macro average = plain mean over classes (every class counts equally, which
matters when classes are imbalanced).
"""

from __future__ import annotations


def _safe_div(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def classification_report(gold: list[str], predicted: list[str], labels: list[str] | None = None) -> dict:
    """Per-class and macro-averaged precision/recall/F1, plus accuracy."""
    if len(gold) != len(predicted):
        raise ValueError("gold and predicted must have the same length")
    labels = labels or sorted(set(gold) | set(predicted))
    per_class = {}
    for label in labels:
        tp = sum(1 for g, p in zip(gold, predicted) if g == label and p == label)
        fp = sum(1 for g, p in zip(gold, predicted) if g != label and p == label)
        fn = sum(1 for g, p in zip(gold, predicted) if g == label and p != label)
        precision, recall = _safe_div(tp, tp + fp), _safe_div(tp, tp + fn)
        per_class[label] = {
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(_safe_div(2 * precision * recall, precision + recall), 4),
            "support": tp + fn,
        }
    macro = {
        metric: round(sum(c[metric] for c in per_class.values()) / len(per_class), 4) if per_class else 0.0
        for metric in ("precision", "recall", "f1")
    }
    accuracy = _safe_div(sum(1 for g, p in zip(gold, predicted) if g == p), len(gold))
    return {"per_class": per_class, "macro": macro, "accuracy": round(accuracy, 4), "count": len(gold)}


def binary_report(gold: list[bool], predicted: list[bool]) -> dict:
    """Precision/recall/F1 for a yes/no decision (e.g. "relevant to Sri Lanka")."""
    report = classification_report(["yes" if g else "no" for g in gold], ["yes" if p else "no" for p in predicted], ["yes", "no"])
    return {**report["per_class"]["yes"], "accuracy": report["accuracy"], "count": report["count"]}
