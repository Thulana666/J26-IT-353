"""Event-intelligence inference: frozen rules + fine-tuned DistilRoBERTa category + hybrid decision.

Configuration (environment variables; nothing is hard-coded to a machine):
  EVENT_INTEL_MODEL_DIR          checkpoint directory written by Transformer.save_checkpoint
                                 (model.safetensors, config.json, tokenizer files, classifier_meta.json)
  EVENT_INTEL_MODEL_SHA256       optional: expected SHA-256 of model.safetensors; a mismatch is rejected
  EVENT_INTEL_HYBRID_THRESHOLD   optional: hybrid confidence threshold. Default: the validation-selected
                                 threshold in the training run's run.json next to the checkpoint
  EVENT_INTEL_REVIEW_MIN_CONFIDENCE  optional: review-budget policy, default 0.9 (provisional, not a
                                 validated cutoff). Lower model confidence asks for human review; it
                                 never changes the category or the hybrid decision.

review.needs_review is true exactly when review.reasons is non-empty. Reason codes: rules_review,
hybrid_<method>, model_unavailable, rules_model_disagree, low_model_confidence.

The checkpoint is validated (three supported classes in the trained order, pinned base model and
revision, required files) and loaded lazily, once per process, offline on CPU with the existing
Transformer.from_checkpoint API. If it is not configured, invalid or fails to load, the response
says so (model.status = "unavailable", hybrid method "rules_only_no_model"); with require_model
the router answers 501 instead. A model result is never reported without a loaded model.

The model predicts only the category among natural_disaster / public_health / other. Relevance,
scope, entities, evidence keywords, text quality and the three supply-chain categories come only
from the frozen rules baseline.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import logging
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path

from ..classifier import RULES_NAME, RULES_VERSION, classify_article
from ..experiments.data import SUPPORTED_CATEGORIES, UNSUPPORTED_CATEGORIES, model_text
from ..experiments.hybrid import decide
from ..experiments.models import TRANSFORMER_ID, TRANSFORMER_REVISION, Transformer

log = logging.getLogger(__name__)

MODEL_DIR_ENV = "EVENT_INTEL_MODEL_DIR"
MODEL_SHA_ENV = "EVENT_INTEL_MODEL_SHA256"
THRESHOLD_ENV = "EVENT_INTEL_HYBRID_THRESHOLD"
# Review-budget policy (provisional, not validated; separate from the hybrid threshold): see review_confidence().
REVIEW_CONFIDENCE_ENV = "EVENT_INTEL_REVIEW_MIN_CONFIDENCE"
DEFAULT_REVIEW_CONFIDENCE = 0.9
EXPECTED_CLASSES = sorted(SUPPORTED_CATEGORIES)  # the order Transformer.fit stores: ['natural_disaster', 'other', 'public_health']
REQUIRED_FILES = ("model.safetensors", "config.json", "tokenizer.json", "tokenizer_config.json", "classifier_meta.json")
NOT_PREDICTED_BY_MODEL = ("relevance", "event_scope", "entities", "diseases", "severity", *UNSUPPORTED_CATEGORIES)
SERVICE_VERSION = "1.0"


class ModelUnavailableError(RuntimeError):
    def __init__(self, reason: str, detail: str):
        super().__init__(f"{reason}: {detail}")
        self.reason, self.detail = reason, detail


@dataclass
class LoadedModel:
    model: object
    directory: Path
    meta: dict
    sha256: str
    threshold: float
    threshold_source: str
    run_id: str | None = None
    version: dict = field(default_factory=dict)


_lock = threading.Lock()
_cache: dict = {}


def reset() -> None:
    """Forget the cached model (tests, or after changing the configuration)."""
    with _lock:
        _cache.clear()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_checkpoint(directory: Path) -> dict:
    """Return the checkpoint metadata, or raise ModelUnavailableError('invalid_checkpoint', ...)."""
    missing = [f for f in REQUIRED_FILES if not (directory / f).exists()]
    if missing:
        raise ModelUnavailableError("invalid_checkpoint", f"missing files: {', '.join(missing)}")
    try:
        meta = json.loads((directory / "classifier_meta.json").read_text(encoding="utf-8"))
        config = json.loads((directory / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ModelUnavailableError("invalid_checkpoint", f"unreadable metadata: {error}") from error
    problems = []
    if meta.get("classes") != EXPECTED_CLASSES:
        problems.append(f"classes {meta.get('classes')} != expected {EXPECTED_CLASSES}")
    if meta.get("class_type") != "str":
        problems.append(f"class_type {meta.get('class_type')!r} != 'str' (category model expected)")
    if meta.get("base_model") != TRANSFORMER_ID:
        problems.append(f"base_model {meta.get('base_model')!r} != {TRANSFORMER_ID!r}")
    if meta.get("base_revision") != TRANSFORMER_REVISION:
        problems.append(f"base_revision {meta.get('base_revision')!r} != pinned {TRANSFORMER_REVISION!r}")
    if len(config.get("id2label", {})) != len(EXPECTED_CLASSES):
        problems.append(f"config has {len(config.get('id2label', {}))} labels, expected {len(EXPECTED_CLASSES)}")
    if problems:
        raise ModelUnavailableError("invalid_checkpoint", "; ".join(problems))
    return meta


def _threshold(directory: Path) -> tuple[float, str, str | None]:
    if os.environ.get(THRESHOLD_ENV):
        try:
            value = float(os.environ[THRESHOLD_ENV])
        except ValueError as error:
            raise ModelUnavailableError("invalid_configuration", f"{THRESHOLD_ENV} is not a number") from error
        if not 0.0 <= value <= 1.0:
            raise ModelUnavailableError("invalid_configuration", f"{THRESHOLD_ENV} must be between 0 and 1")
        return value, f"environment {THRESHOLD_ENV}", None
    run_json = directory.parent / "run.json"
    if run_json.exists():
        try:
            run = json.loads(run_json.read_text(encoding="utf-8"))
            return float(run["category"]["hybrid_threshold"]), "validation-selected (run.json)", run.get("run_id")
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise ModelUnavailableError("invalid_checkpoint", f"run.json has no usable hybrid_threshold: {error}") from error
    return 0.0, "default 0.0 (no validation-selected threshold found)", None


def _load(directory: Path) -> LoadedModel:
    if not directory.is_dir():
        raise ModelUnavailableError("not_found", f"{MODEL_DIR_ENV} does not point to a directory")
    meta = validate_checkpoint(directory)
    sha = file_sha256(directory / "model.safetensors")
    expected = os.environ.get(MODEL_SHA_ENV, "").strip().lower()
    if expected and expected != sha:
        raise ModelUnavailableError("invalid_checkpoint", f"model.safetensors SHA-256 {sha} != {MODEL_SHA_ENV}")
    threshold, source, run_id = _threshold(directory)
    missing = [m for m in ("torch", "transformers") if importlib.util.find_spec(m) is None]
    if missing:
        raise ModelUnavailableError("dependencies_missing", f"not installed: {', '.join(missing)} (requirements-event-model.txt)")
    try:
        model = Transformer.from_checkpoint(directory)  # offline, CPU, 4 threads (see experiments/models.py)
    except Exception as error:  # noqa: BLE001 - any loading failure means the model is unavailable
        raise ModelUnavailableError("load_error", f"{type(error).__name__}: {error}") from error
    if list(model.classes) != EXPECTED_CLASSES:
        raise ModelUnavailableError("invalid_checkpoint", f"loaded classes {model.classes} != {EXPECTED_CLASSES}")
    version = {"base_model": TRANSFORMER_ID, "base_revision": TRANSFORMER_REVISION, "checkpoint_sha256": sha,
               "run_id": run_id, "seed": meta.get("seed"), "best_epoch": meta.get("best_epoch"),
               "max_length": (meta.get("settings") or {}).get("max_length")}
    return LoadedModel(model, directory, meta, sha, threshold, source, run_id, version)


def get_model() -> LoadedModel:
    """The configured model, loaded once per process (failures are cached too, so a broken
    checkpoint is not re-read on every request; call reset() after fixing the configuration)."""
    raw = os.environ.get(MODEL_DIR_ENV, "").strip()
    if not raw:
        raise ModelUnavailableError("not_configured", f"{MODEL_DIR_ENV} is not set")
    key = (str(Path(raw).resolve()), os.environ.get(MODEL_SHA_ENV, ""), os.environ.get(THRESHOLD_ENV, ""))
    with _lock:
        if key not in _cache:
            try:
                _cache[key] = _load(Path(raw))
            except ModelUnavailableError as error:
                log.warning("Event model unavailable: %s", error)
                _cache[key] = error
        cached = _cache[key]
    if isinstance(cached, ModelUnavailableError):
        raise cached
    return cached


def status() -> dict:
    try:
        m = get_model()
    except ModelUnavailableError as error:
        return {"status": "unavailable", "reason": error.reason, "detail": error.detail}
    return {"status": "ok", "version": m.version, "hybrid_threshold": m.threshold, "threshold_source": m.threshold_source}


def _rules_block(rules) -> dict:
    out = rules.to_dict()
    out["name"], out["version"] = RULES_NAME, RULES_VERSION
    return out


def review_confidence() -> float:
    """Review-budget policy: model confidence below this asks for human review. PROVISIONAL: 0.9 is a
    review-load choice (3 of 71 seed-13 validation articles fall below it), NOT a validated confidence
    cutoff, and it is separate from the hybrid fallback threshold, which it never changes."""
    raw = os.environ.get(REVIEW_CONFIDENCE_ENV, "").strip()
    if not raw:
        return DEFAULT_REVIEW_CONFIDENCE
    try:
        value = float(raw)
    except ValueError:
        value = None
    if value is None or not 0.0 <= value <= 1.0:
        log.warning("%s=%r is not a number in [0, 1]; using %s", REVIEW_CONFIDENCE_ENV, raw, DEFAULT_REVIEW_CONFIDENCE)
        return DEFAULT_REVIEW_CONFIDENCE
    return value


def fallback_active(threshold: float | None) -> bool:
    """Whether the hybrid's confidence fallback can ever trigger. With 3 classes the top probability
    is always >= 1/3, so any threshold <= 1/3 (e.g. seed 13's validation-selected 0.0) means the model
    is always used when available. False when no model is loaded."""
    return threshold is not None and threshold > 1 / len(EXPECTED_CLASSES)


def review_reasons(rules, decision, model_block: dict, min_confidence: float) -> list[dict]:
    """Review reasons as {code, messages}, one entry per code, in a fixed order."""
    found: dict[str, list[str]] = {}

    def add(code: str, message: str) -> None:
        messages = found.setdefault(code, [])
        if message not in messages:
            messages.append(message)

    for message in rules.review_reasons:
        add("rules_review", message)
    if rules.processing_status != "classified" and "rules_review" not in found:
        add("rules_review", f"Rules status: {rules.processing_status}.")
    if decision.needs_review:
        add(f"hybrid_{decision.method}", decision.explanation)
    if model_block["status"] != "ok":
        add("model_unavailable", f"Rules-only result: model {model_block['reason']} ({model_block['detail']}).")
    else:
        if rules.category != model_block["predicted_category"]:
            add("rules_model_disagree", f"Rules say {rules.category}, model says {model_block['predicted_category']}.")
        if model_block["confidence"] < min_confidence:
            add("low_model_confidence",
                f"Model confidence {model_block['confidence']:.3f} < review policy {min_confidence} (provisional).")
    return [{"code": code, "messages": messages} for code, messages in found.items()]


def classify(request, require_model: bool = False) -> dict:
    """Classify one article. Raises ModelUnavailableError only when require_model is true."""
    record = request.record()
    rules = classify_article(record)
    try:
        loaded = get_model()
    except ModelUnavailableError as error:
        if require_model:
            raise
        loaded, unavailable = None, error

    if loaded is None:
        decision = decide(record, None, 0.0, rules)
        model_block = {"status": "unavailable", "reason": unavailable.reason, "detail": unavailable.detail}
        threshold, threshold_source = None, None
    else:
        probs = loaded.model.predict_proba([model_text(record)])[0]
        predicted = max(probs, key=probs.get)
        decision = decide(record, probs, loaded.threshold, rules)
        model_block = {"status": "ok", "predicted_category": predicted, "confidence": round(probs[predicted], 6),
                       "probabilities": {k: round(v, 6) for k, v in probs.items()},
                       "supported_categories": EXPECTED_CLASSES, "version": loaded.version}
        threshold, threshold_source = loaded.threshold, loaded.threshold_source

    reasons = review_reasons(rules, decision, model_block, review_confidence())
    return {
        "article_id": request.article_id,
        "rules": _rules_block(rules),
        "model": model_block,
        "hybrid": {**decision.to_dict(), "threshold": threshold, "threshold_source": threshold_source,
                   "fallback_active": fallback_active(threshold)},
        # review.needs_review is the authoritative flag (hybrid.needs_review covers only the hybrid's own paths).
        # Flags only request human review; nothing is approved or rejected here.
        "review": {"needs_review": bool(reasons), "reasons": reasons},
        "not_predicted_by_model": list(NOT_PREDICTED_BY_MODEL),
        "versions": {"service": SERVICE_VERSION, "rules": {"name": RULES_NAME, "version": RULES_VERSION},
                     "model": model_block.get("version")},
    }
