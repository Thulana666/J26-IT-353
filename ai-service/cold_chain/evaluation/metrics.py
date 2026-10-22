"""Binary-classification metrics for the risk models, computed from the
predictions (never assumed). A metric that is undefined for the data (e.g.
recall without positives, ROC-AUC with one class) is None, not 0 or 1.

sample_weight (optional) weights the samples, e.g. so that every trip counts
the same however many snapshots it has ("trip-balanced" metrics).
"""

from __future__ import annotations

import numpy as np


def _ratio(numerator: float, denominator: float) -> float | None:
    return float(numerator / denominator) if denominator else None


def _weights(y, sample_weight) -> np.ndarray:
    return np.ones(len(y)) if sample_weight is None else np.asarray(sample_weight, dtype=float)


def binary_metrics(y_true, scores, threshold: float = 0.5, sample_weight=None) -> dict:
    y = np.asarray(y_true).astype(int)
    s = np.asarray(scores, dtype=float)
    if len(y) == 0:
        return {"samples": 0}
    from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

    w = _weights(y, sample_weight)
    predicted = (s >= threshold).astype(int)
    tp, fp = w[(predicted == 1) & (y == 1)].sum(), w[(predicted == 1) & (y == 0)].sum()
    fn, tn = w[(predicted == 0) & (y == 1)].sum(), w[(predicted == 0) & (y == 0)].sum()
    positives = int(y.sum())
    both = 0 < positives < len(y)
    recall = _ratio(tp, tp + fn)
    specificity = _ratio(tn, tn + fp)
    count = (lambda v: int(v)) if sample_weight is None else (lambda v: round(float(v), 4))
    return {
        "samples": int(len(y)),
        "positives": positives,
        "weighted": sample_weight is not None,
        "threshold": float(threshold),
        "accuracy": float((tp + tn) / w.sum()),
        "balanced_accuracy": (recall + specificity) / 2 if both else None,
        "precision": _ratio(tp, tp + fp),
        "recall": recall,
        "f1": _ratio(2 * tp, 2 * tp + fp + fn),
        "specificity": specificity,
        "roc_auc": float(roc_auc_score(y, s, sample_weight=sample_weight)) if both else None,
        "pr_auc": float(average_precision_score(y, s, sample_weight=sample_weight)) if positives else None,
        "brier": float(brier_score_loss(y, s, sample_weight=sample_weight, pos_label=1)) if both else None,
        "confusion_matrix": {"tn": count(tn), "fp": count(fp), "fn": count(fn), "tp": count(tp)},
    }


def tune_threshold(y_true, scores, *, min_recall: float | None = None, sample_weight=None) -> tuple[float, dict]:
    """Decision threshold chosen on the VALIDATION set: the highest F1 (ties:
    closest to 0.5), or with min_recall the highest threshold whose recall
    reaches it (fewest false alarms at that recall). 0.5 when undefined."""
    y = np.asarray(y_true).astype(int)
    s = np.asarray(scores, dtype=float)
    if len(y) == 0 or y.sum() in (0, len(y)):
        return 0.5, {"source": "default", "reason": "the validation set does not contain both classes"}
    w = _weights(y, sample_weight)
    total_positive = w[y == 1].sum()
    best = None
    for t in np.unique(s):
        predicted = s >= t
        tp = w[predicted & (y == 1)].sum()
        fp = w[predicted & (y == 0)].sum()
        fn = total_positive - tp
        recall = float(tp / total_positive)
        f1 = float(2 * tp / (2 * tp + fp + fn))
        if min_recall is not None:
            if recall >= min_recall and (best is None or t > best[0]):
                best = (float(t), {"recall": recall, "f1": f1})
        elif best is None or (f1, -abs(t - 0.5)) > (best[1]["f1"], -abs(best[0] - 0.5)):
            best = (float(t), {"recall": recall, "f1": f1})
    if best is None:
        return 0.5, {"source": "default", "reason": f"no threshold reaches recall {min_recall}"}
    rule = f"highest threshold with recall >= {min_recall}" if min_recall is not None else "maximum F1"
    return best[0], {"source": "validation", "rule": rule, "weighted": sample_weight is not None, **best[1]}
