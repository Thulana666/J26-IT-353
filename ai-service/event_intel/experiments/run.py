"""Run one reproducible experiment: rules baseline vs trained classifier vs hybrid.

    python -m event_intel.experiments.run --audit-only
    python -m event_intel.experiments.run --model nb --tier confirmed_high
    .venv/Scripts/python.exe -m event_intel.experiments.run --model transformer --tier confirmed_high --task category --seed 42

One process, one seed, one model at a time (no parallel jobs). The transformer runs on CPU only,
offline from the pinned revision, and refuses to start with less than 3 GB of free RAM.

Fit on train, select hyperparameters and the hybrid threshold on validation (same tier), then
evaluate ONCE on test. Test results are reported separately for human-confirmed labels (ground
truth) and for AI-proposed silver labels (not ground truth). Outputs go to
data/experiments/<run_id>/ (git-ignored): run.json, metrics.json, predictions_*.csv (no article text).
"""

from __future__ import annotations

import argparse
import csv
import json
import platform
import subprocess
import sys
import time
from pathlib import Path

from ..classifier import RULES_NAME, RULES_VERSION, classify_article
from ..dataset.common import file_sha256, utc_now
from ..dataset.schema import GUIDE_VERSION
from . import data as D
from .hybrid import decide, select_threshold
from .metrics import accuracy, bootstrap, macro_f1, report
from .models import (InsufficientResources, MissingDependency, NaiveBayes, Transformer, check_resources,
                     environment, package_versions, set_seed)

ROOT = Path(__file__).resolve().parents[2]
DATASET = ROOT / "data/dataset_v1/event_dataset_v1.csv"
PROPOSALS = ROOT / "data/dataset_v1/ai_proposed_labels_v1.csv"
SPLIT = ROOT / "data/dataset_v1/split_prelim_v1.json"
SNAPSHOT = ROOT / "data/snapshots/articles_20261018T122253Z.jsonl"
OUT = ROOT / "data/experiments"
NB_ALPHAS = (0.1, 0.3, 1.0)
RULES_RELEVANCE_BINARY = {"relevant": 1, "possibly_relevant": 1, "uncertain": 1, "not_relevant": 0, "insufficient_evidence": 0}
MIN_TEST_PER_CLASS = 30  # below this per class, results are descriptive only


def git_state() -> dict:
    def run(*args):
        r = subprocess.run(["git", *args], capture_output=True, text=True, cwd=ROOT)
        return r.stdout.strip() if r.returncode == 0 else None
    return {"commit": run("rev-parse", "HEAD"), "dirty": bool(run("status", "--porcelain"))}


def build_model(kind: str, alpha: float | None = None, seed: int = 42):
    if kind == "nb":
        return NaiveBayes(alpha=alpha if alpha is not None else 1.0)
    return Transformer(seed=seed)


def run_id_for(model: str, tier: str, task: str, seed: int) -> str:
    return f"{model}_{tier}_{task}_seed{seed}_{utc_now().replace(':', '').replace('-', '')}"


def fit_and_select(kind, train, val, field, labels, seed: int = 42):
    """Choose NB alpha, or the transformer's best epoch, on VALIDATION only. Returns (model, val probs, log)."""
    texts, ys = [e.text for e in train], [D.gold(e, field) for e in train]
    vtexts, vys = [e.text for e in val], [D.gold(e, field) for e in val]
    score = macro_f1(labels)
    log, best = {}, None
    for alpha in (NB_ALPHAS if kind == "nb" else (None,)):
        set_seed(seed)
        t0 = time.perf_counter()
        model = build_model(kind, alpha, seed)
        if kind == "nb":
            model.fit(texts, ys)
        else:
            model.fit(texts, ys, vtexts, vys, score)  # best epoch chosen on validation inside fit
        seconds = time.perf_counter() - t0
        probs = model.predict_proba(vtexts)
        pred = [max(p, key=p.get) for p in probs]
        s = score(vys, pred)
        log[str(alpha)] = {"validation_macro_f1": round(s, 4), "fit_seconds": round(seconds, 3)}
        if best is None or s > best[0]:
            best = (s, model, probs)
    return best[1], best[2], log


def evaluate_category(examples, kind, tier, seed=42):
    labels = list(D.SUPPORTED_CATEGORIES)
    train, val = D.eligible(examples, tier, "train"), D.eligible(examples, tier, "validation")
    test_human = D.eligible(examples, "confirmed", "test")
    test_silver = [e for e in D.eligible(examples, tier, "test") if e.label_kind == D.SILVER]
    D.assert_disjoint(train, val)
    D.assert_disjoint(train + val, test_human + test_silver)

    model, val_probs, selection = fit_and_select(kind, train, val, "category", labels, seed)
    threshold, threshold_log = select_threshold([e.record for e in val], val_probs,
                                                [e.category for e in val], macro_f1(labels))
    results, predictions = {}, []
    for name, rows in (("validation_" + tier, val), ("test_human_confirmed", test_human), ("test_ai_silver", test_silver)):
        if not rows:
            results[name] = {"n": 0}
            continue
        probs = model.predict_proba([e.text for e in rows])
        rules = [classify_article(e.record) for e in rows]
        hyb = [decide(e.record, p, threshold, r) for e, p, r in zip(rows, probs, rules)]
        g = [e.category for e in rows]
        systems = {"rules": [r.category for r in rules], "model": [max(p, key=p.get) for p in probs],
                   "hybrid": [h.category for h in hyb]}
        results[name] = {
            "n": len(rows), "label_kind": sorted({e.label_kind for e in rows}),
            "systems": {k: report(g, v, labels) for k, v in systems.items()},
            "hybrid_methods": {m: sum(1 for h in hyb if h.method == m) for m in sorted({h.method for h in hyb})},
            "bootstrap_macro_f1": bootstrap(g, systems, macro_f1(labels)),
            "bootstrap_accuracy": bootstrap(g, systems, accuracy),
            "descriptive_only": min(g.count(c) for c in labels) < MIN_TEST_PER_CLASS,
        }
        for e, r, p, h in zip(rows, rules, probs, hyb):
            predictions.append({"evaluation_set": name, "article_id": e.article_id, "split": e.split,
                                "label_kind": e.label_kind, "label_status": e.label_status, "gold": e.category,
                                "rules": r.category, "model": max(p, key=p.get), "model_confidence": round(max(p.values()), 4),
                                "hybrid": h.category, "hybrid_method": h.method, "hybrid_needs_review": h.needs_review,
                                "hybrid_evidence": "; ".join(h.evidence)})
    meta = {"train_n": len(train), "train_label_kind": dict(_kinds(train)), "train_distribution": _dist(train, "category"),
            "validation_n": len(val), "selection": selection, "model_config": model.config(),
            "hybrid_threshold": threshold, "threshold_validation_macro_f1": {str(k): round(v, 4) for k, v in threshold_log.items()}}
    return meta, results, predictions


def evaluate_relevance(examples, kind, tier, seed=42):
    labels = [1, 0]
    train, val = D.eligible(examples, tier, "train", "relevance"), D.eligible(examples, tier, "validation", "relevance")
    test_human = D.eligible(examples, "confirmed", "test", "relevance")
    test_silver = [e for e in D.eligible(examples, tier, "test", "relevance") if e.label_kind == D.SILVER]
    D.assert_disjoint(train + val, test_human + test_silver)
    model, _, selection = fit_and_select(kind, train, val, "relevance", labels, seed)
    results, predictions = {}, []
    for name, rows in (("validation_" + tier, val), ("test_human_confirmed", test_human), ("test_ai_silver", test_silver)):
        if not rows:
            results[name] = {"n": 0}
            continue
        probs = model.predict_proba([e.text for e in rows])
        g = [D.gold(e, "relevance") for e in rows]
        rules = [RULES_RELEVANCE_BINARY[classify_article(e.record).relevance] for e in rows]
        systems = {"rules": rules, "model": [max(p, key=p.get) for p in probs]}
        results[name] = {"n": len(rows), "systems": {k: report(g, v, labels) for k, v in systems.items()},
                         "bootstrap_macro_f1": bootstrap(g, systems, macro_f1(labels))}
        for e, p, r in zip(rows, probs, rules):
            predictions.append({"evaluation_set": name, "article_id": e.article_id, "label_kind": e.label_kind,
                                "gold_investigate": D.gold(e, "relevance"), "rules": r, "model": max(p, key=p.get),
                                "model_confidence": round(max(p.values()), 4)})
    meta = {"train_n": len(train), "train_distribution": _dist(train, "relevance"), "validation_n": len(val),
            "selection": selection, "binary_mapping": "yes/possibly = 1 (investigate), no = 0, cannot_tell excluded",
            "rules_mapping": RULES_RELEVANCE_BINARY}
    return meta, results, predictions


def _kinds(rows):
    from collections import Counter
    return Counter(e.label_kind for e in rows)


def _dist(rows, field):
    from collections import Counter
    return dict(Counter(str(D.gold(e, field)) for e in rows))


def write_csv(path, rows):
    if not rows:
        return
    with path.open("x", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


def preflight(model: str, seed: int) -> int:
    """0 when the run may start; 2 = transformer stack/weights missing, 3 = not enough free RAM."""
    if model != "transformer":
        return 0
    try:
        Transformer(seed=seed)
        check_resources()
    except MissingDependency as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 2
    except InsufficientResources as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 3
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--model", choices=("nb", "transformer"), default="nb")
    ap.add_argument("--tier", choices=tuple(D.TIERS), default="confirmed_high")
    ap.add_argument("--seed", type=int, default=42, help="training seed; the dataset split is fixed and unaffected")
    ap.add_argument("--task", choices=("category", "relevance", "both"), default="both")
    ap.add_argument("--audit-only", action="store_true")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args(argv)

    env = environment()
    examples = D.load_examples(DATASET, SNAPSHOT)
    audit = D.audit(examples)  # raises LeakageError on any cross-split overlap
    if args.audit_only:
        print(json.dumps({"environment": env, "audit": audit}, indent=1))
        return 0
    blocked = preflight(args.model, args.seed)
    if blocked:
        return blocked
    set_seed(args.seed)

    run_id = run_id_for(args.model, args.tier, args.task, args.seed)
    out = args.out / run_id
    out.mkdir(parents=True, exist_ok=False)
    t0 = time.perf_counter()
    cat_meta = cat_results = rel_meta = rel_results = None
    cat_pred, rel_pred = [], []
    if args.task in ("category", "both"):
        cat_meta, cat_results, cat_pred = evaluate_category(examples, args.model, args.tier, args.seed)
    if args.task in ("relevance", "both"):
        rel_meta, rel_results, rel_pred = evaluate_relevance(examples, args.model, args.tier, args.seed)
    run = {
        "run_id": run_id, "created_at": utc_now(), "model_kind": args.model, "tier": args.tier,
        "task": args.task, "seed": args.seed,
        "tier_label_statuses": D.TIERS[args.tier],
        "training_labels_note": ("human-confirmed only" if args.tier == "confirmed" else
                                 "SILVER-LABEL EXPERIMENT: training includes AI-proposed labels that are not human-confirmed"),
        "supported_categories": D.SUPPORTED_CATEGORIES, "unsupported_categories_not_trained": D.UNSUPPORTED_CATEGORIES,
        "rules_baseline": {"name": RULES_NAME, "version": RULES_VERSION}, "guide_version": GUIDE_VERSION,
        "inputs": {p.name: file_sha256(p) for p in (DATASET, PROPOSALS, SPLIT, SNAPSHOT)},
        "environment": {**env, "platform": platform.platform()}, "package_versions": package_versions(),
        "git": git_state(),
        "seeds": {"training": args.seed, "bootstrap": 2026, "split": "fixed: split_prelim_v1.json (seed 42), not reseeded"},
        "category": cat_meta, "relevance": rel_meta, "total_seconds": round(time.perf_counter() - t0, 2),
    }
    (out / "run.json").write_text(json.dumps(run, indent=1), encoding="utf-8")
    (out / "metrics.json").write_text(json.dumps({"seed": args.seed, "audit": audit, "category": cat_results,
                                                  "relevance": rel_results}, indent=1), encoding="utf-8")
    write_csv(out / "predictions_category.csv", cat_pred)
    write_csv(out / "predictions_relevance.csv", rel_pred)
    print(f"{run_id}: {round(time.perf_counter() - t0, 1)} s -> {out}")
    for name, res in (cat_results or {}).items():
        if res.get("n"):
            print(f"  category {name} (n={res['n']}): " + ", ".join(
                f"{k} macroF1 {v['macro']['f1']:.3f} acc {v['accuracy']:.3f}" for k, v in res["systems"].items()))
    for name, res in (rel_results or {}).items():
        if res.get("n"):
            print(f"  relevance {name} (n={res['n']}): " + ", ".join(
                f"{k} macroF1 {v['macro']['f1']:.3f}" for k, v in res["systems"].items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
