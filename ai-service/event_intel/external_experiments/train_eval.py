"""Stage 3: controlled experiments. One process, one plan, one seed at a time (no parallel jobs).

    python -m event_intel.external_experiments.train_eval --model nb --plan all
    .venv/Scripts/python.exe -m event_intel.external_experiments.train_eval --model transformer --plan B_humaid_intermediate --seed 42
    .venv/Scripts/python.exe -m event_intel.external_experiments.train_eval --model transformer --plan B_humaid_intermediate --seed 42 --smoke

News plans (all evaluated on the SAME frozen news split, accepted tier; validation for every choice, test once):
  A_news_only                news train only (baseline; for the transformer the existing 3-seed runs are reused)
  B_humaid_intermediate      transformer: HumAID 10-class (original labels) -> news          [transformer only]
  C_dt_intermediate          transformer: Disaster Tweets binary (original labels) -> news   [transformer only]
  D_bbc_intermediate         transformer: BBC 5 topics (original labels) -> news             [transformer only]
  E1_news_plus_humaid_mapped news + HumAID impact tweets mapped to natural_disaster (auto_mapped_v2)
  E2_news_plus_dt_mapped     news + Disaster Tweets mapped to other / public_health (auto_mapped_v2)
  E3_news_plus_all_mapped    news + E1 + E2 mapped records
External own-task plans (original labels, own splits, reported separately from news results):
  X_humaid_own_task          HumAID 10-class, inferred event-held-out split                  [nb]
  X_dt_own_task              Disaster Tweets real-disaster binary, group split                [nb]
Outputs: data/external_experiments/runs/<run_id>/ (run.json, metrics_validation.json, metrics_test.json,
predictions_*.csv without text, and checkpoint_category/ for transformer runs).
"""

from __future__ import annotations

import argparse
import csv
import json
import platform
import random
import re
import sys
import time
from collections import Counter
from pathlib import Path

from ..classifier import classify_article
from ..dataset.common import stored_text, utc_now
from ..experiments import data as D
from ..experiments.hybrid import decide, select_threshold
from ..experiments.metrics import accuracy, bootstrap, macro_f1, report
from ..experiments.models import (InsufficientResources, MissingDependency, NaiveBayes, Transformer, check_resources,
                                  environment, package_versions, set_seed)
from ..experiments.run import ACCEPTED_LABELS, DATASET, SNAPSHOT, SPLIT, git_state, verify_checkpoint
from . import mapping as M
from . import sources as S

ADAPTED = S.OUT / S.VERSION / "adapted"
RUNS = S.OUT / "runs"
TIER = "accepted"
LABELS = list(D.SUPPORTED_CATEGORIES)
NB_ALPHAS = (0.1, 0.3, 1.0)
CAPS = (100, 300, 1000)
TRANSFORMER_CAP = 300          # fixed a priori for transformer E plans (no per-seed cap search: CPU cost)
SEEDS = (42, 13, 7)
NEWS_PLANS = ("A_news_only", "B_humaid_intermediate", "C_dt_intermediate", "D_bbc_intermediate",
              "E1_news_plus_humaid_mapped", "E2_news_plus_dt_mapped", "E3_news_plus_all_mapped")
OWN_PLANS = ("X_humaid_own_task", "X_dt_own_task")
EXTRA_SOURCES = {"E1_news_plus_humaid_mapped": ("humaid",), "E2_news_plus_dt_mapped": ("disaster_tweets",),
                 "E3_news_plus_all_mapped": ("humaid", "disaster_tweets")}
INTERMEDIATE = {"B_humaid_intermediate": ("humaid", "tweets", 4000, 1000, 2000),
                "C_dt_intermediate": ("disaster_tweets", "tweets", None, None, None),
                "D_bbc_intermediate": ("bbc_news", "articles", None, None, None)}
SMOKE = {"news_train": 24, "news_val": 12, "external": 32, "settings": {"epochs": 1, "max_length": 64}}


def _norm(text: str) -> str:
    return re.sub(r"\W+", " ", text.casefold()).strip()


def read_adapted(name: str) -> list[dict]:
    with (ADAPTED / f"{name}_adapted_{S.VERSION}.csv").open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def external_pool(sources: tuple[str, ...]) -> list[dict]:
    """Mapped records allowed for training: accepted rule, English-likely, not duplicating news, train split only."""
    pool = []
    for name in sources:
        for r in read_adapted(name):
            if r["training_eligible_mapped"] == "1":
                assert r["mapping_rule"] in M.ACCEPTED_RULES and r["own_task_split"] == "train" and not r["duplicates_news_article"]
                pool.append(r)
    return pool


def sample_extra(pool: list[dict], cap: int, seed: int) -> list[dict]:
    """At most `cap` records per (source, mapped category); one record per global leakage group; seeded."""
    out = []
    keys = sorted({(r["source_dataset"], r["mapped_category"]) for r in pool})
    for key in keys:
        rows = sorted((r for r in pool if (r["source_dataset"], r["mapped_category"]) == key), key=lambda r: int(r["source_row"]))
        seen, uniq = set(), []
        for r in rows:
            if r["global_leakage_group"] not in seen:
                seen.add(r["global_leakage_group"])
                uniq.append(r)
        random.Random(f"{seed}:{key[0]}:{key[1]}").shuffle(uniq)
        out += uniq[:cap]
    return out


def assert_extra_disjoint(extra: list[dict], held_out: list) -> None:
    """No external training text may equal a news validation/test text (normalised)."""
    held = {_norm(e.text) for e in held_out} | {_norm(stored_text(e.record)) for e in held_out}
    clash = [r["source_row"] for r in extra if _norm(r["text"]) in held]
    if clash:
        raise D.LeakageError(f"external rows equal held-out news texts: {clash[:5]}")


def news_sets(examples, smoke: bool):
    train, val = D.eligible(examples, TIER, "train"), D.eligible(examples, TIER, "validation")
    test_human = D.eligible(examples, "confirmed", "test")
    test_acc = [e for e in D.eligible(examples, TIER, "test") if e.label_kind == D.ACCEPTED]
    if smoke:
        train, val = train[:SMOKE["news_train"]], val[:SMOKE["news_val"]]
    D.assert_disjoint(train, val)
    D.assert_disjoint(train + val, test_human + test_acc)
    return train, val, test_human, test_acc


def own_task_data(name: str, kind_cap=(None, None, None), seed: int = 42, smoke: bool = False) -> dict:
    """External task with ORIGINAL labels on its own split (stratified seeded subsample when capped)."""
    rows = [r for r in read_adapted(name) if r["own_task_split"] in ("train", "validation", "test")
            and r["dedup_recommendation"] == "keep" and r["text"].strip()]
    out = {}
    for split, cap in zip(("train", "validation", "test"), kind_cap):
        part = sorted((r for r in rows if r["own_task_split"] == split), key=lambda r: int(r["source_row"]))
        if smoke:
            cap = SMOKE["external"]
        if cap and len(part) > cap:
            by = {}
            for r in part:
                by.setdefault(r["original_label"], []).append(r)
            rng = random.Random(f"{seed}:{name}:{split}")
            share = cap / len(part)
            chosen = []
            for lab in sorted(by):
                grp = by[lab][:]
                rng.shuffle(grp)
                chosen += grp[:max(1, round(len(grp) * share))]
            part = sorted(chosen, key=lambda r: int(r["source_row"]))
        out[split] = part
    return out


def make_model(kind: str, plan: str, seed: int, alpha: float | None, smoke: bool):
    if kind == "nb":
        return NaiveBayes(alpha=alpha if alpha is not None else 1.0)
    overrides = dict(SMOKE["settings"]) if smoke else {}
    if plan in INTERMEDIATE:
        from .transfer import IntermediateTransformer
        name, ikind, *caps = INTERMEDIATE[plan]
        d = own_task_data(name, tuple(caps), seed, smoke)
        inter = {"name": name, "kind": ikind,
                 "train_texts": [r["text"] for r in d["train"]], "train_labels": [r["original_label"] for r in d["train"]],
                 "val_texts": [r["text"] for r in d["validation"]], "val_labels": [r["original_label"] for r in d["validation"]],
                 "test_texts": [r["text"] for r in d["test"]], "test_labels": [r["original_label"] for r in d["test"]]}
        return IntermediateTransformer(seed=seed, intermediate=inter, **overrides)
    return Transformer(seed=seed, **overrides)


def evaluate_news(model, val, tests: dict, threshold: float) -> tuple[dict, list]:
    results, preds = {}, []
    for name, rows in tests.items():
        if not rows:
            results[name] = {"n": 0}
            continue
        probs = model.predict_proba([e.text for e in rows])
        rules = [classify_article(e.record) for e in rows]
        hyb = [decide(e.record, p, threshold, r) for e, p, r in zip(rows, probs, rules)]
        g = [e.category for e in rows]
        systems = {"rules": [r.category for r in rules], "model": [max(p, key=p.get) for p in probs], "hybrid": [h.category for h in hyb]}
        results[name] = {"n": len(rows), "label_kind": dict(Counter(e.label_kind for e in rows)),
                         "systems": {k: report(g, v, LABELS) for k, v in systems.items()},
                         "bootstrap_macro_f1": bootstrap(g, systems, macro_f1(LABELS)),
                         "bootstrap_accuracy": bootstrap(g, systems, accuracy),
                         "descriptive_only": True}
        for e, r, p, h in zip(rows, rules, probs, hyb):
            preds.append({"evaluation_set": name, "article_id": e.article_id, "label_kind": e.label_kind, "gold": e.category,
                          "rules": r.category, "model": max(p, key=p.get), "model_confidence": round(max(p.values()), 4),
                          "hybrid": h.category, "hybrid_method": h.method})
    return results, preds


def run_news_plan(examples, kind: str, plan: str, seed: int, out_root: Path, smoke: bool = False, save_checkpoint: bool = True) -> Path:
    if kind == "nb" and plan in INTERMEDIATE:
        raise ValueError(f"{plan} needs the transformer (intermediate-task transfer)")
    train, val, test_human, test_acc = news_sets(examples, smoke)
    score = macro_f1(LABELS)
    sources = EXTRA_SOURCES.get(plan, ())
    pool = external_pool(sources) if sources else []
    caps = (None,) if not sources else (CAPS if kind == "nb" else (TRANSFORMER_CAP,))
    if smoke and sources:
        caps = (8,)
    alphas = NB_ALPHAS if kind == "nb" else (None,)
    selection, best = {}, None
    t0 = time.perf_counter()
    for cap in caps:
        extra = sample_extra(pool, cap, seed) if cap else []
        assert_extra_disjoint(extra, val + test_human + test_acc)
        texts = [e.text for e in train] + [r["text"] for r in extra]
        labels = [e.category for e in train] + [r["mapped_category"] for r in extra]
        for alpha in alphas:
            set_seed(seed)
            t = time.perf_counter()
            model = make_model(kind, plan, seed, alpha, smoke)
            if kind == "nb":
                model.fit(texts, labels)
            else:
                model.fit(texts, labels, [e.text for e in val], [e.category for e in val], score)
            vprobs = model.predict_proba([e.text for e in val])
            s = score([e.category for e in val], [max(p, key=p.get) for p in vprobs])
            key = f"cap={cap},alpha={alpha}"
            selection[key] = {"validation_macro_f1": round(s, 4), "fit_seconds": round(time.perf_counter() - t, 2),
                              "extra_n": len(extra), "extra_by_source_category": dict(Counter(f"{r['source_dataset']}:{r['mapped_category']}" for r in extra))}
            # ties keep the earlier (smaller cap, smaller alpha) configuration
            if best is None or s > best[0]:
                best = (s, key, model, vprobs, extra)
    s, key, model, vprobs, extra = best
    threshold, tlog = select_threshold([e.record for e in val], vprobs, [e.category for e in val], score)
    run_id = f"{kind}_{plan}_seed{seed}{'_smoke' if smoke else ''}_{utc_now().replace(':', '').replace('-', '')}"
    out = out_root / run_id
    out.mkdir(parents=True, exist_ok=False)
    checkpoint = None
    if kind == "transformer" and save_checkpoint:
        checkpoint = model.save_checkpoint(out / "checkpoint_category")
        meta_path = out / "checkpoint_category" / "classifier_meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta.update({"experiment_plan": plan, "external_training": selection[key]["extra_by_source_category"],
                     "intermediate_task": (model.intermediate_result or {}).get("task") if hasattr(model, "intermediate_result") else None})
        meta_path.write_text(json.dumps(meta, indent=1), encoding="utf-8")
        checkpoint["verification"] = verify_checkpoint(model, out / "checkpoint_category", [e.text for e in val[:8]])
    val_res, val_pred = evaluate_news(model, val, {"validation_accepted": val}, threshold)
    test_res, test_pred = evaluate_news(model, val, {"test_human_confirmed": test_human, "test_accepted_ai": test_acc,
                                                     "test_all_reference": test_human + test_acc}, threshold)
    run = {"run_id": run_id, "created_at": utc_now(), "model_kind": kind, "plan": plan, "seed": seed, "smoke": smoke,
           "tier": TIER, "supported_categories": LABELS,
           "label_sources": {"news_train": dict(Counter(e.label_kind for e in train)),
                             "external_train": {"label_source": M.MAPPING_VERSION if extra else None,
                                                "counts": dict(Counter(f"{r['source_dataset']}:{r['mapped_category']}" for r in extra))}},
           "selected": key, "selection_on_validation": selection,
           "hybrid_threshold": threshold, "threshold_validation_macro_f1": {str(k): round(v, 4) for k, v in tlog.items()},
           "model_config": model.config(), "checkpoint": checkpoint,
           "inputs": {p.name: S.sha256(p) for p in (DATASET, ACCEPTED_LABELS, SPLIT, SNAPSHOT)}
                     | {f"adapted/{n}": S.sha256(ADAPTED / f"{n}_adapted_{S.VERSION}.csv") for n in S.DATASETS},
           "mapping_version": M.MAPPING_VERSION, "environment": {**environment(), "platform": platform.platform()},
           "package_versions": package_versions(), "git": git_state(), "total_seconds": round(time.perf_counter() - t0, 1)}
    (out / "run.json").write_text(json.dumps(run, indent=1), encoding="utf-8")
    (out / "metrics_validation.json").write_text(json.dumps(val_res, indent=1), encoding="utf-8")
    (out / "metrics_test.json").write_text(json.dumps(test_res, indent=1), encoding="utf-8")
    for part, rows in (("validation", val_pred), ("test", test_pred)):
        with (out / f"predictions_{part}.csv").open("x", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
    print(f"{run_id}: selected {key}; validation macro-F1 model {val_res['validation_accepted']['systems']['model']['macro']['f1']:.3f} "
          f"({run['total_seconds']} s); test written to metrics_test.json")
    return out


def run_own_task(kind: str, plan: str, seed: int, out_root: Path) -> Path:
    if kind != "nb":
        raise ValueError("own-task transformer results come from the intermediate stage of plans B/C (run.json)")
    name = {"X_humaid_own_task": "humaid", "X_dt_own_task": "disaster_tweets"}[plan]
    d = own_task_data(name)
    labels = sorted({r["original_label"] for r in d["train"]})
    score = macro_f1(labels)
    t0 = time.perf_counter()
    tr = ([r["text"] for r in d["train"]], [r["original_label"] for r in d["train"]])
    best, selection = None, {}
    for alpha in NB_ALPHAS:
        m = NaiveBayes(alpha).fit(*tr)
        s = score([r["original_label"] for r in d["validation"]], [max(p, key=p.get) for p in m.predict_proba([r["text"] for r in d["validation"]])])
        selection[str(alpha)] = round(s, 4)
        if best is None or s > best[0]:
            best = (s, alpha, m)
    _, alpha, m = best
    res = {}
    for split in ("validation", "test"):
        g = [r["original_label"] for r in d[split]]
        p = [max(x, key=x.get) for x in m.predict_proba([r["text"] for r in d[split]])]
        res[split] = {"n": len(g), "report": report(g, p, labels), "bootstrap_macro_f1": bootstrap(g, {"model": p}, score, n=500)}
    run_id = f"nb_{plan}_seed{seed}_{utc_now().replace(':', '').replace('-', '')}"
    out = out_root / run_id
    out.mkdir(parents=True, exist_ok=False)
    (out / "run.json").write_text(json.dumps({
        "run_id": run_id, "plan": plan, "model_kind": "nb", "dataset": name, "labels": labels, "label_source": "original_dataset_label",
        "split": "HumAID inferred event-held-out blocks" if name == "humaid" else "Disaster Tweets group split proposal v1",
        "counts": {k: len(v) for k, v in d.items()}, "selected_alpha": alpha, "validation_selection": selection,
        "total_seconds": round(time.perf_counter() - t0, 1), "package_versions": package_versions(),
        "inputs": {f"adapted/{name}": S.sha256(ADAPTED / f"{name}_adapted_{S.VERSION}.csv")}}, indent=1), encoding="utf-8")
    (out / "metrics_validation.json").write_text(json.dumps(res["validation"], indent=1), encoding="utf-8")
    (out / "metrics_test.json").write_text(json.dumps(res["test"], indent=1), encoding="utf-8")
    print(f"{run_id}: alpha {alpha}; validation macro-F1 {res['validation']['report']['macro']['f1']:.3f}")
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--model", choices=("nb", "transformer"), required=True)
    ap.add_argument("--plan", required=True, help="a plan name, or 'all' (nb: A, E1-E3 and own tasks)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--all-seeds", action="store_true", help="run seeds 42, 13 and 7 sequentially")
    ap.add_argument("--smoke", action="store_true", help="tiny transformer run to check the code path (results are meaningless)")
    ap.add_argument("--no-checkpoint", action="store_true")
    ap.add_argument("--out", type=Path, default=RUNS)
    args = ap.parse_args(argv)
    if args.model == "transformer":
        try:
            Transformer(seed=args.seed)
            check_resources()
        except (MissingDependency, InsufficientResources) as exc:
            print(f"BLOCKED: {exc}", file=sys.stderr)
            return 2
    examples = D.load_examples(DATASET, SNAPSHOT, ACCEPTED_LABELS)
    D.audit(examples)  # raises on any news leakage
    plans = [args.plan]
    if args.plan == "all":
        plans = ["A_news_only", "E1_news_plus_humaid_mapped", "E2_news_plus_dt_mapped", "E3_news_plus_all_mapped", *OWN_PLANS] \
            if args.model == "nb" else [p for p in NEWS_PLANS if p != "A_news_only"]
    seeds = SEEDS if args.all_seeds else (args.seed,)
    for plan in plans:
        for seed in seeds:
            if plan in OWN_PLANS:
                run_own_task(args.model, plan, seed, args.out)
            else:
                run_news_plan(examples, args.model, plan, seed, args.out, smoke=args.smoke, save_checkpoint=not args.no_checkpoint)
    return 0


if __name__ == "__main__":
    sys.exit(main())
