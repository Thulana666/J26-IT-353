"""Hybrid category decision: frozen rules safeguards + a trained classifier for supported categories.

Order (first match wins), all transparent and recorded in `method`:
1. rules_insufficient_text   rules text gate says the text is too thin -> rules result, needs review
2. rules_structured_alert    GDACS-style structured alert -> rules result (deterministic fields)
3. rules_unsupported_category  rules find pharma_supply / geopolitical_trade / logistics, which the
                             model cannot predict (not enough data) -> rules result, needs review
4. rules_only_no_model       no model available -> rules result
5. model                     model confidence >= threshold (threshold chosen on validation only)
6. rules_fallback            low model confidence and the rules give a supported category -> rules,
                             needs review
7. model_low_confidence      otherwise the model's top class, needs review
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from ..classifier import SUFFICIENT_QUALITY, ClassificationResult, classify_article
from .data import SUPPORTED_CATEGORIES, UNSUPPORTED_CATEGORIES


@dataclass
class HybridDecision:
    category: str
    confidence: float | None
    method: str
    needs_review: bool
    rules_category: str
    model_category: str | None
    explanation: str
    evidence: list[str]

    def to_dict(self) -> dict:
        return asdict(self)


def _evidence(rules: ClassificationResult, category: str) -> list[str]:
    return [k.get("term", "") for k in rules.matched_keywords.get(category, [])][:5]


def decide(record: dict, model_probs: dict | None, threshold: float,
           rules: ClassificationResult | None = None) -> HybridDecision:
    rules = rules or classify_article(record)
    level = rules.text_quality.level
    model_top = max(model_probs, key=model_probs.get) if model_probs else None
    model_p = model_probs[model_top] if model_probs else None

    def from_rules(method: str, review: bool, why: str) -> HybridDecision:
        return HybridDecision(rules.category, model_p, method, review, rules.category, model_top, why,
                              _evidence(rules, rules.category))

    if level not in SUFFICIENT_QUALITY:
        return from_rules("rules_insufficient_text", True, f"Text quality '{level}': rules result kept for review.")
    if level == "structured_alert":
        return from_rules("rules_structured_alert", False, "Structured alert fields decide the category.")
    if rules.category in UNSUPPORTED_CATEGORIES:
        return from_rules("rules_unsupported_category", True,
                          f"Rules found '{rules.category}', which the model cannot predict (insufficient data).")
    if not model_probs:
        return from_rules("rules_only_no_model", rules.processing_status != "classified", "No model available.")
    if model_p >= threshold:
        return HybridDecision(model_top, model_p, "model", False, rules.category, model_top,
                              f"Model confidence {model_p:.2f} >= threshold {threshold:.2f}.", _evidence(rules, model_top))
    if rules.category in SUPPORTED_CATEGORIES:
        return from_rules("rules_fallback", True, f"Model confidence {model_p:.2f} < threshold {threshold:.2f}; rules used.")
    return HybridDecision(model_top, model_p, "model_low_confidence", True, rules.category, model_top,
                          f"Low model confidence {model_p:.2f}; no usable rules category.", _evidence(rules, model_top))


def select_threshold(records: list[dict], probs: list[dict], gold: list[str], score_fn,
                     grid=(0.0, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95)) -> tuple[float, dict]:
    """Pick the threshold with the best score on VALIDATION data; ties go to the lowest threshold."""
    rules = [classify_article(r) for r in records]
    results = {}
    for t in grid:
        pred = [decide(rec, p, t, ru).category for rec, p, ru in zip(records, probs, rules)]
        results[t] = score_fn(gold, pred)
    best = max(grid, key=lambda t: (results[t], -t))
    return best, results
