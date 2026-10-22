"""Reproducible precision spot-check of the auto_mapped_v2 rules.

The verdicts below were recorded by the AI assistant (Claude) on 2026-10-21 by reading each sampled
record against guide v1.1. They are NOT human judgements; they decide only which rules may feed the
weak-label (silver) training experiments. Samples are drawn deterministically from the adapted files.

    python -m event_intel.external_experiments.spotcheck [--adapted data/external_experiments/v1/adapted]
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
import sys
from pathlib import Path

from . import sources as S

# rule -> (dataset, seed, n, indices judged INCORRECT for the mapped category, indices judged unclear)
VERDICTS = {
    "humaid_impact_label_during_natural_disaster_event": ("humaid", 2027, 50, [2, 11, 27, 34, 43, 47], []),
    "dt_real_disaster_natural_hazard_keyword_and_text": ("disaster_tweets", 99, 40,
        [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 16, 18, 19, 21, 22, 23, 24, 27, 28, 29, 31, 32, 34, 35, 36, 38], []),
    "dt_real_event_outside_categories (accident, fire, violence)": ("disaster_tweets", 99, 40, [0, 2, 4, 14, 17, 26, 28, 33, 34], [37]),
    "dt_not_real_disaster (figurative or unrelated; no specific event)": ("disaster_tweets", 99, 40, [15], []),
    "dt_real_disaster_outbreak_keyword_and_disease_text": ("disaster_tweets", 2026, 25, [], [3]),  # re-reviewed on the v2 rule
}
NOTES = {
    "humaid_impact_label_during_natural_disaster_event": "errors: advice, sarcasm, product promotion, climate commentary, a projection",
    "dt_real_disaster_natural_hazard_keyword_and_text": "jokes, quotes, insurance, warnings and forecasts dominate",
    "dt_real_event_outside_categories (accident, fire, violence)": "includes typhoon (natural_disaster) and road/tram/aviation disruption (logistics)",
    "dt_not_real_disaster (figurative or unrelated; no specific event)": "one error: food destruction under counter-sanctions (geopolitical_trade)",
    "dt_real_disaster_outbreak_keyword_and_disease_text": "v2 rule (named disease required). 24/25 about real outbreaks, 1 sarcastic (unclear); almost all near-duplicates of one Legionnaires' story (2-3 distinct events)",
}


def wilson(k: int, n: int, z: float = 1.96) -> list[float]:
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(c - h, 3), round(c + h, 3)]


def sample(adapted: Path, dataset: str, rule: str, seed: int, n: int) -> list[dict]:
    with (adapted / f"{dataset}_adapted_{S.VERSION}.csv").open(encoding="utf-8", newline="") as f:
        rows = [r for r in csv.DictReader(f) if r["mapping_rule"] == rule]
    random.Random(seed).shuffle(rows)
    return rows[:n]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapted", type=Path, default=S.OUT / S.VERSION / "adapted")
    ap.add_argument("--out", type=Path, default=S.OUT / S.VERSION / f"mapping_spot_check_{S.VERSION}.json")
    args = ap.parse_args(argv)
    result = {"reviewer": "AI assistant (Claude); not a human review", "bar_for_training": "precision >= 0.80", "rules": {}}
    for rule, (ds, seed, n, wrong, unclear) in VERDICTS.items():
        rows = sample(args.adapted, ds, rule, seed, n)
        k = n - len(wrong) - len(unclear)
        result["rules"][rule] = {
            "dataset": ds, "sample_seed": seed, "n": n, "correct": k, "incorrect": len(wrong), "unclear": len(unclear),
            "precision": round(k / n, 3), "wilson_95ci": wilson(k, n), "note": NOTES[rule],
            "accepted_for_training": k / n >= 0.8,
            "items": [{"index": i, "source_row": r["source_row"], "verdict": "incorrect" if i in wrong else "unclear" if i in unclear else "correct"}
                      for i, r in enumerate(rows)],
        }
    args.out.open("x", encoding="utf-8").write(json.dumps(result, indent=1) + "\n")
    print({k: (v["precision"], v["accepted_for_training"]) for k, v in result["rules"].items()})
    return 0


if __name__ == "__main__":
    sys.exit(main())
