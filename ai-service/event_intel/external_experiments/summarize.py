"""Aggregate external-experiment runs and apply the pre-registered decision rule (validation first).

    python -m event_intel.external_experiments.summarize

Writes data/external_experiments/summary/summary_<UTC>.json and .md (never overwrites). Transformer plan A
reuses the existing accepted-tier 3-seed runs in data/experiments/ when no new plan-A run exists.
"""

from __future__ import annotations

import csv
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

from ..dataset.common import utc_now
from . import sources as S
from .train_eval import LABELS, RUNS, SEEDS

BASELINE_DIR = S.DATA / "experiments"
SETS = ("test_all_reference", "test_human_confirmed", "test_accepted_ai")


def _load(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def _preds(run_dir: Path) -> dict:
    for name in ("predictions_test.csv", "predictions_category_test.csv"):
        p = run_dir / name
        if p.exists():
            with p.open(encoding="utf-8", newline="") as f:
                return {(r["evaluation_set"], r["article_id"]): r for r in csv.DictReader(f)}
    return {}


def collect() -> dict:
    """(model_kind, plan) -> {seed: run record}; latest non-smoke run per seed."""
    runs = defaultdict(dict)
    if RUNS.exists():
        for d in sorted(RUNS.iterdir()):
            if not (d / "run.json").exists():
                continue
            r = _load(d / "run.json")
            if r.get("smoke") or "plan" not in r or r["plan"].startswith("X_"):
                continue
            runs[(r["model_kind"], r["plan"])][r["seed"]] = {
                "dir": d, "source": "external_experiments", "val": _load(d / "metrics_validation.json")["validation_accepted"],
                "test": _load(d / "metrics_test.json"), "selected": r.get("selected"), "seconds": r.get("total_seconds")}
    if not runs.get(("transformer", "A_news_only")):
        for d in sorted(BASELINE_DIR.glob("transformer_accepted_category_seed*_*")):
            if not d.is_dir() or not (d / "metrics_test.json").exists():
                continue
            r = _load(d / "run.json")
            runs[("transformer", "A_news_only")][r["seed"]] = {
                "dir": d, "source": "reused existing baseline (data/experiments)",
                "val": _load(d / "metrics_validation.json")["category"]["validation_accepted"],
                "test": _load(d / "metrics_test.json")["category"], "selected": "epoch on validation", "seconds": r.get("total_seconds")}
    return runs


def stats(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    return {"mean": round(statistics.mean(xs), 4), "sd": round(statistics.stdev(xs), 4) if len(xs) > 1 else 0.0,
            "min": round(min(xs), 4), "max": round(max(xs), 4), "n_seeds": len(xs)}


def plan_summary(seed_runs: dict) -> dict:
    out = {"seeds": sorted(seed_runs), "source": sorted({v["source"] for v in seed_runs.values()}),
           "validation_macro_f1_model": stats([v["val"]["systems"]["model"]["macro"]["f1"] for v in seed_runs.values()]),
           "validation_per_class_f1_model": {c: stats([v["val"]["systems"]["model"]["per_class"][c]["f1"] for v in seed_runs.values()]) for c in LABELS}}
    for s in SETS:
        for system in ("model", "hybrid"):
            out[f"{s}_{system}_macro_f1"] = stats([v["test"][s]["systems"][system]["macro"]["f1"] for v in seed_runs.values() if s in v["test"]])
            out[f"{s}_{system}_accuracy"] = stats([v["test"][s]["systems"][system]["accuracy"] for v in seed_runs.values() if s in v["test"]])
    out["rules_test_all_macro_f1"] = next(iter(seed_runs.values()))["test"]["test_all_reference"]["systems"]["rules"]["macro"]["f1"]
    out["pilot11_model_errors_by_seed"] = {seed: round(11 - 11 * v["test"]["test_human_confirmed"]["systems"]["model"]["accuracy"])
                                          for seed, v in seed_runs.items()}
    out["selected_by_seed"] = {seed: v["selected"] for seed, v in seed_runs.items()}
    return out


def paired(a_runs: dict, b_runs: dict) -> dict:
    """Per shared seed: test articles the plan gets right and the baseline wrong, and vice versa (model)."""
    out = {}
    for seed in sorted(set(a_runs) & set(b_runs)):
        pa, pb = _preds(a_runs[seed]["dir"]), _preds(b_runs[seed]["dir"])
        keys = [k for k in pb if k[0] == "test_all_reference" and k in pa]
        out[seed] = {"compared": len(keys),
                     "plan_right_baseline_wrong": sum(1 for k in keys if pa[k]["model"] == pa[k]["gold"] and pb[k]["model"] != pb[k]["gold"]),
                     "plan_wrong_baseline_right": sum(1 for k in keys if pa[k]["model"] != pa[k]["gold"] and pb[k]["model"] == pb[k]["gold"])}
    return out


def decide(base: dict, cand: dict) -> dict:
    """Pre-registered rule (PREREGISTERED_DECISION_RULE_v1.md)."""
    if not base or not cand or not cand["validation_macro_f1_model"]:
        return {"verdict": "not_evaluated"}
    v_gain = cand["validation_macro_f1_model"]["mean"] - base["validation_macro_f1_model"]["mean"]
    drops = {c: round(base["validation_per_class_f1_model"][c]["mean"] - cand["validation_per_class_f1_model"][c]["mean"], 4) for c in LABELS}
    t_delta = cand["test_all_reference_model_macro_f1"]["mean"] - base["test_all_reference_model_macro_f1"]["mean"]
    shared = set(cand["pilot11_model_errors_by_seed"]) & set(base["pilot11_model_errors_by_seed"])
    worse_pilot = sum(1 for s in shared if cand["pilot11_model_errors_by_seed"][s] > base["pilot11_model_errors_by_seed"][s])
    checks = {"validation_gain_ge_0.01": v_gain >= 0.01 - 1e-9, "no_class_drop_gt_0.03": max(drops.values()) <= 0.03 + 1e-9,
              "test_not_worse_than_0.01": t_delta >= -0.01 - 1e-9, "pilot_no_extra_error_majority": worse_pilot <= len(shared) // 2}
    return {"validation_gain": round(v_gain, 4), "validation_class_drops": drops, "test_all_delta": round(t_delta, 4),
            "pilot_seeds_with_extra_error": worse_pilot, "checks": checks,
            "verdict": "worth_retaining" if all(checks.values()) else "not_retained"}


def own_tasks() -> dict:
    out = {}
    if RUNS.exists():
        for d in sorted(RUNS.iterdir()):
            if (d / "run.json").exists():
                r = _load(d / "run.json")
                if r.get("plan", "").startswith("X_"):
                    t = _load(d / "metrics_test.json")
                    out[r["plan"]] = {"run": d.name, "dataset": r["dataset"], "split": r["split"], "counts": r["counts"],
                                      "test_macro_f1": t["report"]["macro"]["f1"], "test_accuracy": t["report"]["accuracy"],
                                      "test_macro_f1_ci95": t["bootstrap_macro_f1"]["ci95"]["model"],
                                      "per_class_f1": {k: v["f1"] for k, v in t["report"]["per_class"].items()}}
                elif r.get("model_kind") == "transformer" and not r.get("smoke"):
                    it = (r.get("model_config") or {}).get("intermediate_task")
                    if it and it.get("external_test"):
                        out.setdefault(f"intermediate_{it['task']}", {})[r["seed"]] = {
                            "external_test_macro_f1": it["external_test"]["report"]["macro"]["f1"], "n": it["external_test"]["n"]}
    return out


def main(argv=None) -> int:
    runs = collect()
    plans = {f"{k}:{p}": plan_summary(v) for (k, p), v in sorted(runs.items())}
    decisions, pairs = {}, {}
    for (kind, plan), v in sorted(runs.items()):
        if plan != "A_news_only" and (kind, "A_news_only") in runs:
            decisions[f"{kind}:{plan}"] = decide(plans[f"{kind}:A_news_only"], plans[f"{kind}:{plan}"])
            pairs[f"{kind}:{plan}"] = paired(v, runs[(kind, "A_news_only")])
    missing = {f"transformer:{p}": [s for s in SEEDS if s not in runs.get(("transformer", p), {})]
               for p in ("B_humaid_intermediate", "C_dt_intermediate", "D_bbc_intermediate", "E1_news_plus_humaid_mapped",
                         "E2_news_plus_dt_mapped", "E3_news_plus_all_mapped")}
    result = {"created_at": utc_now(), "decision_rule": "PREREGISTERED_DECISION_RULE_v1.md", "plans": plans,
              "decisions": decisions, "paired_test_differences": pairs, "external_tasks": own_tasks(),
              "transformer_runs_missing": {k: v for k, v in missing.items() if v}}
    out = S.OUT / "summary"
    out.mkdir(parents=True, exist_ok=True)
    stamp = utc_now().replace(":", "").replace("-", "")
    (out / f"summary_{stamp}.json").open("x", encoding="utf-8").write(json.dumps(result, indent=1, default=str) + "\n")
    lines = [f"# External experiments summary ({result['created_at']})", "",
             "Model macro-F1, mean ± sd over seeds. Test = frozen news split: all 72; pilot 11 (human-confirmed); "
             "accepted 61 (researcher-accepted AI labels).", "",
             "| Model:plan | Seeds | Validation (71) | Test all 72 | Pilot 11 | Accepted 61 | Hybrid test 72 | Pilot errors by seed | Verdict |",
             "|---|---|---|---|---|---|---|---|---|"]
    fmt = lambda s: f"{s['mean']:.3f} ± {s['sd']:.3f}" if s else "–"
    for key, p in plans.items():
        lines.append(f"| {key} | {len(p['seeds'])} | {fmt(p['validation_macro_f1_model'])} | {fmt(p['test_all_reference_model_macro_f1'])} | "
                     f"{fmt(p['test_human_confirmed_model_macro_f1'])} | {fmt(p['test_accepted_ai_model_macro_f1'])} | "
                     f"{fmt(p['test_all_reference_hybrid_macro_f1'])} | {p['pilot11_model_errors_by_seed']} | "
                     f"{decisions.get(key, {}).get('verdict', 'baseline' if key.endswith('A_news_only') else '–')} |")
    (out / f"summary_{stamp}.md").open("x", encoding="utf-8").write("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(json.dumps({"decisions": decisions, "external_tasks": result["external_tasks"], "missing": result["transformer_runs_missing"]}, indent=1, default=str)[:4000])
    return 0


if __name__ == "__main__":
    sys.exit(main())
